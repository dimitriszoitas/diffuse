import {createJourneyRunner} from './journey-runner.mjs';
import {requestJourneyDecision} from './journey-ai.mjs';
import * as localStore from './journey-store.mjs';

export const JOURNEY_MESSAGES = new Set(['JOURNEY_START', 'JOURNEY_STATE', 'JOURNEY_HISTORY', 'JOURNEY_LOAD', 'JOURNEY_PAUSE', 'JOURNEY_RESUME', 'JOURNEY_STOP', 'JOURNEY_ACCEPT']);
const activeStatus = status => ['running', 'paused'].includes(status);
export function journeyInput(input = {}) {
  const clean = {};
  for (const [name, limit] of [['goal', 2000], ['successCriteria', 2000], ['testData', 4000]]) {
    if (input[name] !== undefined && (typeof input[name] !== 'string' || input[name].length > limit)) throw new Error(`Keep ${name === 'goal' ? 'the goal' : name === 'testData' ? 'test data' : 'success criteria'} under ${limit} characters.`);
    clean[name] = (input[name] || '').trim();
  }
  if (!clean.goal) throw new Error('Describe the task you want Diffuse to complete.');
  clean.maxSteps = input.maxSteps ?? 20;
  if (!Number.isInteger(clean.maxSteps) || clean.maxSteps < 5 || clean.maxSteps > 30) throw new Error('Choose a limit between 5 and 30 actions.');
  return clean;
}
export function journeyReproduction(run, until) {
  const lines = [`Goal: ${run.goal}`, `Start: ${run.startUrl}`];
  if (run.successCriteria) lines.push(`Expected result: ${run.successCriteria}`);
  for (const step of run.steps.filter(item => item.index < until && !['error', 'interrupted'].includes(item.executionStatus))) {
    const action = step.action || {};
    if (!action.type || action.type === 'finish') continue;
    const control = step.observation?.controls?.find(item => item.id === action.targetId);
    const target = control?.label || control?.role || '';
    const detail = action.type === 'type' ? `Enter ${JSON.stringify(action.text)} in ${target}`
      : action.type === 'select' ? `Choose ${JSON.stringify(action.value)} in ${target}`
      : action.type === 'click' ? `Click ${target}` : action.type === 'scroll' ? `Scroll ${action.direction}` : action.type === 'back' ? 'Go back' : 'Wait for the page';
    lines.push(`${step.index}. ${detail} (${step.observation?.url || ''})`);
  }
  lines.push('AI journey observation. Recheck the behavior in your current build.');
  return lines.join('\n').slice(0, 8000);
}

/** Browser identity and side-panel authorization are enforced by the caller. */
export function createJourneyService({getSession, checkReady, createExecutor, readConfig, publish, refreshComments, reviews, startRecording,
  store = localStore, runnerFactory = createJourneyRunner, decide = requestJourneyDecision}) {
  let job = null;
  let starting = false;
  let generation = 0;
  let lastRun = null;
  let mutation = Promise.resolve();
  const same = current => getSession() === current;
  const assertCurrent = current => { if (!same(current)) throw new Error('This review has ended. Reopen it to see its journey history.'); };
  const serialize = task => { const operation = mutation.catch(() => {}).then(task); mutation = operation.catch(() => {}); return operation; };
  async function read(current, runId) {
    const id = runId || current.journey?.id;
    if (!id) return null;
    let run = await store.getJourney(id).catch(error => {
      if (lastRun?.id === id) return lastRun;
      throw error;
    });
    // A failed write can leave a readable but stale Running record in storage.
    // Keep the terminal result (and its recording) available in this session.
    if (lastRun?.id === id && lastRun.reviewId === current.reviewId &&
      (!run || Date.parse(lastRun.updatedAt) > Date.parse(run.updatedAt) ||
        (!activeStatus(lastRun.status) && activeStatus(run.status)))) run = lastRun;
    if (!run || run.reviewId !== current.reviewId) throw new Error('This journey is no longer available in this review.');
    return run;
  }
  async function accept(current, message) {
    if (job || starting) throw new Error('Stop the journey before adding findings to the review.');
    const run = await read(current, message.runId);
    const finding = run?.findings?.[message.findingIndex];
    if (!Number.isInteger(message.findingIndex) || !finding) throw new Error('Choose a finding from this journey.');
    const evidenceStep = run.steps.find(step => step.index === finding.stepIndex);
    const shot = evidenceStep?.observation?.screenshot;
    if (!shot?.dataUrl) throw new Error('This step’s screenshot was not retained. Rerun the journey to capture fresh evidence.');
    assertCurrent(current);
    const existing = await reviews.getReview(current.reviewId);
    const suggestionId = `journey-${run.id}-${message.findingIndex}`;
    let saved = existing?.comments.find(comment => comment.ai?.suggestionId === suggestionId);
    if (!saved) {
      const observed = evidenceStep.observation;
      const context = observed.context || {url: observed.url, title: observed.title, viewport: {width: shot.width, height: shot.height, dpr: 1, visualScale: 1}, scroll: {x: 0, y: 0}};
      const draft = {id: suggestionId, reviewId: current.reviewId, mode: 'audit', createdAt: run.createdAt,
        selection: null, context: {production: {...context, url: observed.url}, alignment: {}},
        evidence: {production: {...shot, capturedAt: shot.capturedAt || run.createdAt}},
        ai: {provider: 'anthropic', model: run.model, runId: run.id, suggestionId, confidence: finding.confidence, mismatchScore: finding.severity === 'critical' ? 90 : finding.severity === 'major' ? 65 : 35,
          mode: 'audit', reason: `Journey: ${run.goal}. Evidence: step ${finding.stepIndex}.`, acceptedAt: new Date().toISOString()}};
      assertCurrent(current);
      await reviews.putDraft(draft, {id: current.reviewId, mode: 'audit', title: `${current.target?.title || 'App'} — journey review`, createdAt: run.createdAt, updatedAt: run.updatedAt, productionUrl: run.startUrl});
      assertCurrent(current);
      saved = (await reviews.addComment(draft.id, {...finding, state: 'Journey observation', component: '', steps: journeyReproduction(run, finding.stepIndex)})).comment;
    }
    finding.acceptedCommentId = saved.id;
    run.updatedAt = new Date().toISOString();
    await store.putJourney(run);
    if (same(current)) { await refreshComments(current); await publish(); }
    return {ok: true, run, commentId: saved.id};
  }
  async function start(current, input) {
    if (job || starting) throw new Error('Stop the current journey before starting another.');
    starting = true;
    const version = ++generation;
    const assertStarting = () => { assertCurrent(current); if (version !== generation) throw new Error('The journey was cancelled before it started.'); };
    let executor, keepAlive, recorder;
    try {
      const fields = journeyInput(input);
      const tab = await checkReady(current);
      const start = new URL(tab.url);
      if (!['http:', 'https:'].includes(start.protocol) || start.username || start.password || start.href.length > 2048) throw new Error('Open a website or local preview server with a supported address to test a journey.');
      const config = await readConfig();
      if (!config.hasKey) throw new Error('Add your Anthropic API key in Settings before testing a journey.');
      if (JSON.stringify(fields).includes(config.apiKey)) throw new Error('Remove your API key from the goal or test data.');
      if ((await checkReady(current)).url !== start.href) throw new Error('The starting page changed. Start the journey again from the intended page.');
      assertStarting();
      const now = new Date().toISOString();
      await reviews.ensureReview({id: current.reviewId, mode: current.mode || 'audit', title: `${current.target?.title || 'App'} — journey review`, createdAt: current.startedAt || now, updatedAt: now, productionUrl: start.href});
      assertStarting();
      const entry = {current, id: crypto.randomUUID(), runner: null, executor: null, done: null, pauses: [], recordingEnded: false};
      if (startRecording) recorder = await startRecording(current, entry.id);
      assertStarting();
      entry.recorder = recorder;
      executor = await createExecutor(current, start.href);
      assertStarting();
      entry.executor = executor;
      const decorate = state => {
        const run = {...state, ...fields, reviewId: current.reviewId, model: config.model};
        if (recorder) {
          run.recording = {startedAt: recorder.startedAt, status: state.status === 'paused' ? 'paused' : state.status === 'running' ? 'recording' : 'processing'};
          run.steps = state.steps.map(step => {
            const at = Date.parse(step.observation?.screenshot?.capturedAt || step.createdAt);
            const paused = entry.pauses.reduce((total, pause) => total + Math.max(0, Math.min(at, pause.end ?? at) - pause.start), 0);
            return {...step, videoOffsetMs: Math.max(0, at - Date.parse(recorder.startedAt) - paused - 300)};
          });
        }
        if (entry.recordingEnded) { run.status = 'inconclusive'; run.summary = 'The recording ended before the journey finished. Review the captured steps and video; the task outcome was not verified.'; }
        if (entry.blocked) { run.status = 'blocked'; run.summary = entry.blocked; }
        return run;
      };
      entry.decorate = decorate;
      const runner = runnerFactory({
        observe: options => executor.observe(options),
        execute: (action, observation, options) => executor.execute(action, observation, options),
        decide: args => decide({...args, apiKey: config.apiKey, model: config.model}),
        onUpdate: async state => {
          const run = decorate(state);
          lastRun = run;
          await store.putJourney(run);
          if (same(current)) {
            current.journey = {id: run.id, status: run.status, updatedAt: run.updatedAt};
            current.aiRunning = activeStatus(run.status) || Boolean(recorder);
            await publish();
          }
        },
      });
      entry.runner = runner; job = entry;
      // Calls Chrome periodically only during this finite, explicitly requested run.
      keepAlive = setInterval(() => { if (same(current)) void publish().catch(() => {}); }, 20000);
      entry.done = runner.start({id: entry.id, ...fields, startUrl: start.href}).catch(async error => {
        const run = runner.getState();
        if (run) await store.putJourney({...decorate(run), status: 'inconclusive', summary: error.code === 'JOURNEY_STORAGE' ? run.summary : 'The journey was interrupted. Its saved steps remain available.', updatedAt: new Date().toISOString()}).catch(() => {});
      }).finally(async () => {
        clearInterval(keepAlive);
        let run = decorate(runner.getState());
        if (activeStatus(run.status)) { run.status = 'inconclusive'; run.summary = 'The journey was interrupted. Its task outcome was not verified.'; }
        if (recorder) {
          try {
            run.video = await recorder.stop();
            run.recording = {startedAt: recorder.startedAt, status: run.video?.dataUrl ? 'saved' : 'unavailable'};
            if (!run.video?.dataUrl) run.recordingError = 'The recording is unavailable. Captured screenshots and notes remain.';
          } catch {
            run.recording = {startedAt: recorder.startedAt, status: 'unavailable'};
            run.recordingError = 'The recording could not be saved. Captured screenshots and notes remain.';
          }
          run.updatedAt = new Date().toISOString();
          await store.putJourney(run).catch(() => {});
        }
        lastRun = run;
        await executor.cleanup().catch(() => {});
        if (job === entry) job = null;
        if (same(current)) {
          current.aiRunning = false;
          if (run) current.journey = {id: run.id, status: run.status, updatedAt: run.updatedAt};
          await publish().catch(() => {});
        }
      }).catch(() => {});
      // Runner.start publishes its initial state before asking the model. Return
      // that state immediately; do not tie the run to a long message channel.
      return {ok: true, run: decorate(runner.getState())};
    } catch (error) {
      clearInterval(keepAlive);
      if (!job) {
        await recorder?.stop().catch(() => {});
        await executor?.cleanup().catch(() => {});
      }
      throw error;
    } finally { starting = false; }
  }
  return {
    get busy() { return starting || Boolean(job); },
    async interrupt() {
      generation++;
      if (!job) return;
      const entry = job;
      await entry.runner.stop();
      await entry.done;
    },
    async recordingEnded(recordingId) {
      if (job?.recorder?.id !== recordingId) return;
      job.recordingEnded = true;
      job.runner.stop();
    },
    async blocked(reason = 'The journey needs your attention before continuing.') {
      if (!job) return;
      job.blocked = String(reason).slice(0, 500);
      job.runner.stop();
      // Stop capture immediately, even if an outstanding model call is ending.
      // The recorder adapter's stop is idempotent; finalization retrieves it.
      await job.recorder?.stop().catch(() => {});
    },
    async routeChanged(url) {
      if (!job) return;
      try {
        if (new URL(url).origin === new URL(job.runner.getState().startUrl).origin) return;
      } catch {}
      await this.blocked('The journey left the selected website. Recording and AI actions were stopped.');
    },
    async recover(current) {
      const run = await read(current).catch(() => null);
      if (run && activeStatus(run.status)) {
        run.status = 'inconclusive'; run.summary = 'Chrome interrupted this journey. Review its saved steps, then start a new run.'; run.updatedAt = new Date().toISOString();
        await store.putJourney(run);
        current.journey = {id: run.id, status: run.status, updatedAt: run.updatedAt};
        current.aiRunning = false;
      }
    },
    async handle(message) {
      const current = getSession();
      if (!current || current.id !== message.sessionId) throw new Error('Open the active review sidebar to test a journey.');
      if (message.type === 'JOURNEY_START') return start(current, message.input);
      if (message.type === 'JOURNEY_HISTORY') return {ok: true, runs: await store.listJourneys(current.reviewId)};
      if (message.type === 'JOURNEY_ACCEPT') return serialize(() => accept(current, message));
      if (message.type === 'JOURNEY_LOAD' || message.type === 'JOURNEY_STATE') {
        const run = await read(current, message.runId);
        return run && message.knownUpdatedAt === run.updatedAt ? {ok: true, unchanged: true} : {ok: true, run};
      }
      if (!job || job.current !== current) throw new Error('This journey has ended. Start a new run to continue.');
      const entry = job;
      if (message.type === 'JOURNEY_PAUSE') {
        await entry.runner.pause();
        if (entry.recorder && !entry.pauses.some(item => !item.end)) {
          entry.pauses.push({start: Date.now()});
          try { await entry.recorder.pause(); } catch { entry.recordingEnded = true; entry.runner.stop(); }
        }
      }
      else if (message.type === 'JOURNEY_RESUME') {
        await checkReady(current, {resume: true});
        if (entry.recorder) {
          await entry.recorder.resume();
          const pause = entry.pauses.find(item => !item.end);
          if (pause) pause.end = Date.now();
        }
        await entry.runner.resume();
      }
      else if (message.type === 'JOURNEY_STOP') await entry.runner.stop();
      else throw new Error('Unknown journey command.');
      return {ok: true, run: entry.decorate(entry.runner.getState())};
    },
  };
}
