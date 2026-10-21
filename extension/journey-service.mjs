import {createJourneyRunner} from './journey-runner.mjs';
import {JourneyError, requestJourneyDecision, requestJourneyFollowUp, validateJourneyFollowUp} from './journey-ai.mjs';
import * as localStore from './journey-store.mjs';
import {normalizeJourneyPersona, journeyPersonaSummary} from './journey-persona.mjs';
import {normalizeJourneySettings, JOURNEY_FOCUS_CHECKS} from './journey-settings.mjs';
import {normalizeJourneyHelpResponse, withJourneyAssistance, journeyAssistance} from './journey-assistance.mjs';

export const JOURNEY_MESSAGES = new Set(['JOURNEY_START', 'JOURNEY_STATE', 'JOURNEY_HISTORY', 'JOURNEY_LOAD', 'JOURNEY_PAUSE', 'JOURNEY_RESUME', 'JOURNEY_STOP', 'JOURNEY_ACCEPT', 'JOURNEY_ASK', 'JOURNEY_RESPOND']);
const activeStatus = status => ['running', 'paused'].includes(status);
const terminalStatus = status => ['completed', 'failed', 'blocked', 'inconclusive', 'stopped'].includes(status);
export function journeyInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Describe the task you want Diffuse to complete.');
  const clean = {};
  if (input.fork !== undefined && input.continuation !== undefined) throw new Error('Choose either another route from the start or a continuation from the current page.');
  if (input.fork !== undefined) {
    const fork = input.fork;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork) || typeof fork.parentRunId !== 'string' || !fork.parentRunId.trim() || fork.parentRunId.length > 120 ||
        typeof fork.instructions !== 'string' || !fork.instructions.trim() || fork.instructions.length > 2000 ||
        (fork.stepIndex !== undefined && (!Number.isInteger(fork.stepIndex) || fork.stepIndex < 1 || fork.stepIndex > 31))) throw new Error('Choose a saved journey and describe the alternative route in under 2,000 characters.');
    clean.fork = {parentRunId: fork.parentRunId.trim(), ...(fork.stepIndex !== undefined ? {stepIndex: fork.stepIndex} : {}), instructions: fork.instructions.trim()};
  }
  if (input.continuation !== undefined) {
    const continuation = input.continuation;
    if (!continuation || typeof continuation !== 'object' || Array.isArray(continuation) ||
        typeof continuation.parentRunId !== 'string' || !continuation.parentRunId.trim() || continuation.parentRunId.length > 120 ||
        typeof continuation.instructions !== 'string' || !continuation.instructions.trim() || continuation.instructions.length > 2000 ||
        (continuation.assistanceResponseId !== undefined && (typeof continuation.assistanceResponseId !== 'string' || !continuation.assistanceResponseId.trim() || continuation.assistanceResponseId.length > 120))) throw new Error('Choose a saved journey and describe how to continue in under 2,000 characters.');
    clean.continuation = {parentRunId: continuation.parentRunId.trim(), instructions: continuation.instructions.trim(),
      ...(continuation.assistanceResponseId !== undefined ? {assistanceResponseId: continuation.assistanceResponseId.trim()} : {})};
  }
  for (const [name, limit] of [['goal', 2000], ['successCriteria', 2000], ['testData', 4000]]) {
    if (input[name] !== undefined && (typeof input[name] !== 'string' || input[name].length > limit)) throw new Error(`Keep ${name === 'goal' ? 'the goal' : name === 'testData' ? 'test data' : 'success criteria'} under ${limit} characters.`);
    clean[name] = (input[name] || '').trim();
  }
  if (!clean.goal && ((!clean.fork && !clean.continuation) || input.goal !== undefined)) throw new Error('Describe the task you want Diffuse to complete.');
  clean.maxSteps = input.maxSteps ?? 20;
  if (!Number.isInteger(clean.maxSteps) || clean.maxSteps < 5 || clean.maxSteps > 30) throw new Error('Choose a limit between 5 and 30 actions.');
  clean.persona = normalizeJourneyPersona(input.persona);
  Object.assign(clean, normalizeJourneySettings(input));
  return clean;
}
export function journeyReproduction(run, until) {
  const lines = [`Goal: ${run.goal}`, `Start: ${run.startUrl}`];
  lines.push(run.persona === undefined ? 'Persona: No persona was recorded for this saved run.' : `Persona: ${journeyPersonaSummary(run.persona)}`);
  if (run.continuation) lines.push(`Continuation of journey ${run.continuation.parentRunId}. These steps begin from the existing application state at the address above.`);
  if (run.focusChecks) lines.push(`Requested checks: ${run.focusChecks.map(key => JOURNEY_FOCUS_CHECKS.find(item => item.key === key)?.label || key).join(', ')}. Only recorded observations establish which checks were performed.`);
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
export function createJourneyService({getSession, checkReady, createExecutor, readConfig, publish, refreshComments, reviews, startRecording, prepareFork,
  store = localStore, runnerFactory = createJourneyRunner, decide = requestJourneyDecision, followUp = requestJourneyFollowUp}) {
  let job = null;
  let starting = false;
  let startupController = null;
  let asking = null;
  let responding = null;
  let generation = 0;
  let lastRun = null;
  let mutation = Promise.resolve();
  const same = current => getSession() === current;
  const assertCurrent = current => { if (!same(current)) throw new Error('This review has ended. Reopen it to see its journey history.'); };
  const serialize = task => {
    const requestedGeneration = generation;
    const operation = mutation.catch(() => {}).then(() => {
      if (requestedGeneration !== generation) throw new Error('The journey action was cancelled.');
      return task();
    });
    mutation = operation.catch(() => {});
    return operation;
  };
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
    return withJourneyAssistance(run);
  }
  async function accept(current, message) {
    assertCurrent(current);
    if (job || starting || asking || responding) throw new Error('Stop the journey before adding findings to the review.');
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
  async function ask(current, message) {
    assertCurrent(current);
    if (job || starting || asking || responding) throw new Error('Wait for the current journey action before asking about the saved run.');
    if (typeof message.runId !== 'string' || !message.runId || message.runId.length > 120 || typeof message.question !== 'string' || !message.question.trim() || message.question.length > 2000) throw new Error('Ask a question under 2,000 characters about a saved journey.');
    const pending = {controller: new AbortController(), version: generation};
    asking = pending;
    let keepAlive;
    const assertAsking = () => { assertCurrent(current); if (pending.version !== generation || pending.controller.signal.aborted) throw new Error('The journey question was cancelled.'); };
    try {
      const run = await read(current, message.runId);
      if (!terminalStatus(run.status)) throw new Error('Finish or stop this journey before asking about it.');
      if (message.stepIndex !== undefined && (!Number.isInteger(message.stepIndex) || !run.steps.some(step => step.index === message.stepIndex))) throw new Error('Choose an existing step from this journey.');
      if ((run.followUps || []).length >= 20) throw new Error('This journey has reached its limit of 20 follow-up questions.');
      const config = await readConfig();
      if (!config.hasKey) throw new Error('Add your Anthropic API key in Settings before asking a journey question.');
      if (message.question.includes(config.apiKey)) throw new Error('Remove your API key from the question.');
      assertAsking();
      let result;
      keepAlive = setInterval(() => { if (same(current)) void publish().catch(() => {}); }, 20000);
      try {
        result = await followUp({apiKey: config.apiKey, model: config.model, run, question: message.question.trim(), stepIndex: message.stepIndex, signal: pending.controller.signal});
      } catch (error) {
        if (error instanceof JourneyError) throw error;
        throw new Error('Diffuse could not answer this journey question. Try again.');
      }
      assertAsking();
      result = validateJourneyFollowUp(result, run);
      if (JSON.stringify(result).includes(config.apiKey)) throw new Error('The journey answer could not be saved. Try again.');
      const now = new Date().toISOString();
      const updated = {...run, updatedAt: now, followUps: [...(run.followUps || []), {id: crypto.randomUUID(), ...(message.stepIndex !== undefined ? {stepIndex: message.stepIndex} : {}), question: message.question.trim(), ...result, createdAt: now}]};
      await store.putJourney(updated);
      assertAsking();
      lastRun = updated;
      if (current.journey?.id === updated.id) current.journey.updatedAt = updated.updatedAt;
      await publish();
      return {ok: true, run: updated};
    } finally { clearInterval(keepAlive); if (asking === pending) asking = null; }
  }
  async function respond(current, message) {
    assertCurrent(current);
    if (typeof message.runId !== 'string' || !message.runId.trim() || message.runId.length > 120) throw new Error('Choose a blocked journey to answer.');
    const response = normalizeJourneyHelpResponse(message.response);
    if (starting || asking || responding) throw new Error('Wait for the current journey action before replying.');
    const pending = {version: generation}; responding = pending;
    const assertResponding = () => { assertCurrent(current); if (generation !== pending.version) throw new Error('The journey reply was cancelled.'); };
    try {
      if (job) {
        if (job.current !== current || job.id !== message.runId || activeStatus(job.runner.getState()?.status)) throw new Error('Wait until this journey is blocked before replying.');
        // Final recording persistence must finish before a reply can be saved.
        await job.done;
      }
      assertResponding();
      const run = await read(current, message.runId);
      assertResponding();
      if (run.status !== 'blocked') throw new Error('Only a blocked journey can receive a help reply.');
      const assistance = journeyAssistance(run);
      if (assistance.response) {
        if (['text', 'classification', 'decision'].every(key => assistance.response[key] === response[key])) return {ok: true, run};
        throw new Error('This blocker already has a saved reply. Continue with that reply or start a separate journey.');
      }
      const now = new Date().toISOString();
      const updated = {...run, updatedAt: now, assistance: {...assistance, response: {id: crypto.randomUUID(), ...response, createdAt: now}}};
      assertResponding();
      await store.putJourney(updated);
      assertResponding();
      lastRun = updated;
      if (current.journey?.id === updated.id) current.journey.updatedAt = updated.updatedAt;
      await publish();
      return {ok: true, run: updated};
    } finally { if (responding === pending) responding = null; }
  }
  async function start(current, input) {
    const linkedResponse = input?.continuation?.assistanceResponseId;
    if (job?.current === current && linkedResponse && job.responseId === linkedResponse && job.parentRunId === input.continuation.parentRunId && job.instructions === input.continuation.instructions?.trim()) return {ok: true, run: job.decorate(job.runner.getState())};
    if (job || starting || asking || responding) throw new Error('Stop the current journey before starting another.');
    starting = true;
    const version = ++generation;
    const startup = new AbortController(); startupController = startup;
    const assertStarting = () => { assertCurrent(current); if (version !== generation) throw new Error('The journey was cancelled before it started.'); };
    let executor, keepAlive, recorder;
    try {
      let fields = journeyInput(input);
      const tab = await checkReady(current);
      assertStarting();
      let parent = null;
      if (fields.fork || fields.continuation) {
        parent = await read(current, (fields.fork || fields.continuation).parentRunId);
        if (fields.continuation && !['stopped', 'blocked', 'inconclusive'].includes(parent.status)) throw new Error('Only a stopped, blocked or inconclusive journey can continue from the current page.');
        if (fields.fork && !terminalStatus(parent.status)) throw new Error('Finish or stop the original journey before trying another route.');
        if (fields.fork?.stepIndex !== undefined && !parent.steps.some(step => step.index === fields.fork.stepIndex)) throw new Error('Choose an existing step from the original journey.');
        fields = journeyInput({...fields, ...Object.fromEntries(['goal', 'successCriteria', 'testData', 'maxSteps', 'persona', 'exploration', 'allowRecordMoves', 'extraInstructions', 'focusChecks'].filter(key => input[key] === undefined).map(key => [key, parent[key]]))});
      }
      if (fields.continuation?.assistanceResponseId) {
        const response = journeyAssistance(parent)?.response;
        if (!response || response.id !== fields.continuation.assistanceResponseId || response.decision !== 'continue' || response.text !== fields.continuation.instructions) throw new Error('Continue using the guidance saved for this blocker.');
        if (response.continuationRunId) {
          const existing = await read(current, response.continuationRunId).catch(() => null);
          assertStarting();
          if (!existing) throw new Error('This reply already started a continuation that is no longer retained. Start a separate journey to try again.');
          return {ok: true, run: existing};
        }
        const previous = (await store.listJourneys(current.reviewId)).find(run => run.continuation?.parentRunId === parent.id && run.continuation.assistanceResponseId === response.id);
        assertStarting();
        if (previous) { const existing = await read(current, previous.id); assertStarting(); return {ok: true, run: existing}; }
      }
      const start = new URL(fields.fork ? parent.startUrl : tab.url);
      if (!['http:', 'https:'].includes(start.protocol) || start.username || start.password || start.href.length > 2048) throw new Error('Open a website or local preview server with a supported address to test a journey.');
      if (parent && new URL(parent.startUrl).origin !== new URL(tab.url).origin) throw new Error('Open the original journey’s website before trying another route or continuing.');
      const config = await readConfig();
      if (!config.hasKey) throw new Error('Add your Anthropic API key in Settings before testing a journey.');
      if (JSON.stringify(fields).includes(config.apiKey)) throw new Error('Remove your API key from the goal or test data.');
      assertStarting();
      if (fields.fork) {
        if (!prepareFork) throw new Error('Reopen the starting page before trying another route.');
        await prepareFork(current, parent, {signal: startup.signal});
        assertStarting();
      }
      if ((await checkReady(current)).url !== start.href) throw new Error('The starting page changed. Start the journey again from the intended page.');
      assertStarting();
      const now = new Date().toISOString();
      await reviews.ensureReview({id: current.reviewId, mode: current.mode || 'audit', title: `${current.target?.title || 'App'} — journey review`, createdAt: current.startedAt || now, updatedAt: now, productionUrl: start.href});
      assertStarting();
      const entry = {current, id: crypto.randomUUID(), runner: null, executor: null, done: null, pauses: [], recordingEnded: false,
        responseId: fields.continuation?.assistanceResponseId, parentRunId: fields.continuation?.parentRunId, instructions: fields.continuation?.instructions};
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
        return withJourneyAssistance(run);
      };
      entry.decorate = decorate;
      const runner = runnerFactory({
        observe: options => executor.observe(options),
        execute: (action, observation, options) => executor.execute(action, observation, options),
        decide: args => decide({...args, persona: fields.persona, exploration: fields.exploration, allowRecordMoves: fields.allowRecordMoves,
          extraInstructions: fields.extraInstructions, focusChecks: fields.focusChecks, routePreferences: fields.fork?.instructions || '',
          continuation: fields.continuation || null, priorJourney: fields.continuation ? parent : null, apiKey: config.apiKey, model: config.model}),
        onUpdate: async state => {
          const run = decorate(state);
          lastRun = run;
          await store.putJourney(run);
          if (entry.responseId && !entry.responseLinked) {
            const assistance = journeyAssistance(parent);
            parent = {...parent, assistance: {...assistance, response: {...assistance.response, continuationRunId: run.id}}};
            await store.putJourney(parent);
            entry.responseLinked = true;
          }
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
    } finally { starting = false; if (startupController === startup) startupController = null; }
  }
  return {
    get busy() { return starting || Boolean(job) || Boolean(asking) || Boolean(responding); },
    async interrupt() {
      generation++;
      startupController?.abort();
      asking?.controller.abort();
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
      if (message.type === 'JOURNEY_ASK') return serialize(() => ask(current, message));
      if (message.type === 'JOURNEY_RESPOND') return serialize(() => respond(current, message));
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
