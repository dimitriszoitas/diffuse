import test from 'node:test';
import assert from 'node:assert/strict';
import {createJourneyService, journeyInput, journeyReproduction} from '../extension/journey-service.mjs';
import {createJourneyRunner} from '../extension/journey-runner.mjs';
import {JOURNEY_DIMENSIONS} from '../extension/journey-ai.mjs';

const KEY = 'sk-ant-journey-service-not-real-key';
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const screenshot = {dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 1200, height: 800};
const finding = {title: 'Missing save feedback', comment: 'The saved list does not show a completion message.', expected: 'Confirm the save beside the new entry.', severity: 'minor', category: 'ux-issue', stepIndex: 2, confidence: 0.8};
function savedRun(extra = {}) {
  return {
    id: 'run-saved', reviewId: 'review-1', model: 'claude-sonnet-5', goal: 'Add Oat milk.', successCriteria: 'Find it in the list.', startUrl: 'https://example.test/',
    status: 'completed', summary: 'Ingredient saved.', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:02.000Z',
    findings: [finding], scores: [], metrics: {clicks: 1},
    steps: [
      {index: 1, action: {type: 'click', targetId: 'ingredients'}, executionStatus: 'complete', observation: {url: 'https://example.test/', controls: [{id: 'ingredients', label: 'Ingredients', role: 'link'}], screenshot}},
      {index: 2, action: {type: 'finish'}, observation: {url: 'https://example.test/ingredients', title: 'Ingredients', controls: [], screenshot, context: {viewport: {width: 1534, height: 1065, dpr: 2, visualScale: 1}, scroll: {x: 0, y: 200}}}},
    ], ...extra,
  };
}
function harness(overrides = {}) {
  let current = {id: 'session-1', reviewId: 'review-1', target: {title: 'Test app'}, mode: 'audit'};
  let run = null, runnerOptions, active;
  const records = new Map(), comments = [], drafts = [], calls = {cleanup: 0, publish: 0, refresh: 0, execute: 0, decisions: []};
  const store = {
    async putJourney(value) { records.set(value.id, copy(value)); return value; },
    async getJourney(id) { return records.has(id) ? copy(records.get(id)) : null; },
    async listJourneys(reviewId) { return [...records.values()].filter(item => item.reviewId === reviewId).map(copy); },
    ...overrides.store,
  };
  const service = createJourneyService({
    getSession: () => current,
    checkReady: async () => ({url: 'https://example.test/'}),
    createExecutor: async () => ({
      observe: async () => ({}), execute: async () => { calls.execute++; },
      cleanup: async () => { calls.cleanup++; },
    }),
    readConfig: async () => ({hasKey: true, apiKey: KEY, model: 'claude-sonnet-5'}),
    publish: async () => { calls.publish++; },
    refreshComments: async () => { calls.refresh++; },
    reviews: {
      async ensureReview() {},
      async getReview() { return {comments: copy(comments)}; },
      async putDraft(value) { drafts.push(copy(value)); },
      async addComment(id, value) {
        const draft = drafts.find(item => item.id === id);
        const comment = {...copy(value), ...copy(draft), id: `comment-${comments.length + 1}`};
        comments.push(comment); return {comment};
      },
    },
    store,
    decide: async args => { calls.decisions.push(args); return {action: {type: 'finish'}}; },
    runnerFactory(options) {
      runnerOptions = options;
      return {
        start(input) {
          run = {...input, status: 'running', steps: [], metrics: {}, findings: [], scores: [], createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z'};
          active = deferred();
          void options.onUpdate(copy(run)).catch(active.reject);
          return active.promise;
        },
        getState: () => copy(run),
        async pause() { run.status = 'paused'; await options.onUpdate(copy(run)); },
        async resume() { run.status = 'running'; await options.onUpdate(copy(run)); },
        async stop() { run.status = 'stopped'; await options.onUpdate(copy(run)); active.resolve(copy(run)); },
      };
    },
    ...overrides.service,
  });
  return {
    service, records, comments, drafts, calls, store,
    get current() { return current; },
    set current(value) { current = value; },
    get runnerOptions() { return runnerOptions; },
    async updateState(fields) { Object.assign(run, copy(fields)); await runnerOptions.onUpdate(copy(run)); },
    async finish(error) {
      if (error) active.reject(error);
      else { run.status = 'completed'; await runnerOptions.onUpdate(copy(run)); active.resolve(copy(run)); }
      await tick();
    },
    async start(input = {}) { return service.handle({type: 'JOURNEY_START', sessionId: current.id, input: {goal: 'Add Oat milk.', ...input}}); },
    async message(type, extra = {}) { return service.handle({type, sessionId: current.id, ...extra}); },
  };
}

test('journey fields are allowlisted and validated before starting', () => {
  assert.deepEqual(journeyInput({goal: ' Add Oat milk. ', maxSteps: 10, apiKey: KEY, tabId: 99, url: 'https://evil.test', id: 'injected'}), {goal: 'Add Oat milk.', successCriteria: '', testData: '', maxSteps: 10});
  for (const input of [{}, {goal: ''}, {goal: 'a'.repeat(2001)}, {goal: 'x', successCriteria: 'x'.repeat(2001)}, {goal: 'x', testData: 'x'.repeat(4001)}, {goal: 'x', maxSteps: 4}, {goal: 'x', maxSteps: 31}, {goal: 'x', maxSteps: '20'}, {goal: {text: 'x'}}]) assert.throws(() => journeyInput(input));
});

test('only active-session callers can start and stored state never contains AI credentials', async () => {
  const h = harness();
  await assert.rejects(h.service.handle({type: 'JOURNEY_START', sessionId: 'wrong', input: {goal: 'test'}}), /active review sidebar/);
  const result = await h.start({apiKey: 'not-used', goal: 'Add Oat milk.'});
  try {
    assert.equal(result.run.status, 'running');
    assert.equal(h.service.busy, true);
    await tick();
    await h.runnerOptions.decide({goal: 'Add Oat milk.', observation: {}});
    assert.equal(h.calls.decisions[0].apiKey, KEY);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(JSON.stringify([...h.records.values()]).includes(KEY), false);
    assert.equal(result.run.apiKey, undefined);
    await assert.rejects(h.start(), /Stop the current journey/);
  } finally { await h.service.interrupt(); }
  assert.equal(h.calls.cleanup, 1);
});

test('invalid configuration or accidentally pasted credential never starts a run', async () => {
  const h = harness();
  await assert.rejects(h.start({goal: `Use ${KEY}`}), /Remove your API key/);
  assert.equal(h.service.busy, false);
  assert.equal(h.records.size, 0);
  const noKey = harness({service: {readConfig: async () => ({hasKey: false})}});
  await assert.rejects(noKey.start(), /Add your Anthropic API key/);
  const wrongPage = harness({service: {checkReady: async () => ({url: 'chrome://extensions/'})}});
  await assert.rejects(wrongPage.start(), /website or local preview server/);
});

test('pause, resume and stop control the same run and clean up execution', async () => {
  const h = harness();
  await h.start();
  assert.equal((await h.message('JOURNEY_PAUSE')).run.status, 'paused');
  assert.equal((await h.message('JOURNEY_RESUME')).run.status, 'running');
  assert.equal((await h.message('JOURNEY_STOP')).run.status, 'stopped');
  await tick();
  assert.equal(h.service.busy, false);
  assert.equal(h.calls.cleanup, 1);
  assert.equal(h.current.aiRunning, false);
});

test('accept retains captured page context and creates one comment under concurrent duplicate requests', async () => {
  const h = harness();
  h.records.set('run-saved', savedRun());
  const [first, second] = await Promise.all([
    h.message('JOURNEY_ACCEPT', {runId: 'run-saved', findingIndex: 0}),
    h.message('JOURNEY_ACCEPT', {runId: 'run-saved', findingIndex: 0}),
  ]);
  assert.equal(h.comments.length, 1);
  assert.equal(h.drafts.length, 1);
  assert.equal(first.commentId, second.commentId);
  assert.equal(h.comments[0].comment, finding.comment);
  assert.equal(h.comments[0].evidence.production.dataUrl, screenshot.dataUrl);
  assert.equal(h.comments[0].context.production.url, 'https://example.test/ingredients');
  assert.equal(h.comments[0].context.production.scroll.y, 200);
  assert.match(h.comments[0].steps, /Goal: Add Oat milk/);
  assert.match(h.comments[0].steps, /Click Ingredients/);
  assert.match(h.comments[0].steps, /AI journey observation/);
  assert.equal(h.comments[0].ai.suggestionId, 'journey-run-saved-0');
  assert.equal(h.records.get('run-saved').findings[0].acceptedCommentId, first.commentId);
});

test('cross-review run IDs, missing evidence and invalid findings cannot create comments', async () => {
  const h = harness();
  h.records.set('other-review', savedRun({id: 'other-review', reviewId: 'review-2'}));
  h.records.set('run-saved', savedRun());
  for (const type of ['JOURNEY_LOAD', 'JOURNEY_STATE', 'JOURNEY_ACCEPT']) {
    await assert.rejects(h.message(type, {runId: 'other-review', findingIndex: 0}), /no longer available in this review/);
  }
  for (const findingIndex of [-1, 1, '0']) await assert.rejects(h.message('JOURNEY_ACCEPT', {runId: 'run-saved', findingIndex}), /Choose a finding/);
  const noShot = savedRun(); delete noShot.steps[1].observation.screenshot; h.records.set(noShot.id, noShot);
  await assert.rejects(h.message('JOURNEY_ACCEPT', {runId: 'run-saved', findingIndex: 0}), /screenshot was not retained/);
  assert.equal(h.comments.length, 0);
});

test('accept is unavailable while a journey is taking actions', async () => {
  const h = harness();
  h.records.set('run-saved', savedRun());
  await h.start();
  try { await assert.rejects(h.message('JOURNEY_ACCEPT', {runId: 'run-saved', findingIndex: 0}), /Stop the journey/); }
  finally { await h.service.interrupt(); }
});

test('worker restart recovery marks interrupted work inconclusive without inventing findings', async () => {
  const h = harness();
  h.records.set('run-saved', savedRun({status: 'running', findings: []}));
  h.current.journey = {id: 'run-saved', status: 'running'};
  h.current.aiRunning = true;
  await h.service.recover(h.current);
  assert.equal(h.records.get('run-saved').status, 'inconclusive');
  assert.equal(h.current.aiRunning, false);
  assert.deepEqual(h.records.get('run-saved').findings, []);
  assert.match(h.records.get('run-saved').summary, /Chrome interrupted/);
});

test('runner rejection records safe interrupted status and releases the executor for retry', async () => {
  const h = harness();
  const started = await h.start();
  await h.finish(new Error(`unsafe diagnostic ${KEY}`));
  assert.equal(h.service.busy, false);
  assert.equal(h.calls.cleanup, 1);
  assert.equal(h.records.get(started.run.id).status, 'inconclusive');
  assert.equal(JSON.stringify([...h.records.values()]).includes(KEY), false);
  await h.start(); await h.service.interrupt();
  assert.equal(h.calls.cleanup, 2);
});

test('history and unchanged-state reads are scoped to the current review', async () => {
  const h = harness();
  const run = savedRun();
  h.records.set(run.id, run);
  h.records.set('another', savedRun({id: 'another', reviewId: 'review-2'}));
  assert.equal((await h.message('JOURNEY_HISTORY')).runs.length, 1);
  assert.deepEqual(await h.message('JOURNEY_STATE', {runId: run.id, knownUpdatedAt: run.updatedAt}), {ok: true, unchanged: true});
});

test('reproduction reaches the evidence observation without adding the following action', () => {
  const run = savedRun();
  run.steps[1].action = {type: 'click', targetId: 'delete'};
  run.steps[1].observation.controls = [{id: 'delete', label: 'Delete ingredient'}];
  const steps = journeyReproduction(run, 2);
  assert.match(steps, /Click Ingredients/);
  assert.doesNotMatch(steps, /Delete ingredient/);
});

function recorderFixture({fail = ''} = {}) {
  const calls = {pause: 0, resume: 0, stop: 0};
  const video = {dataUrl: 'data:video/webm;base64,dmlkZW8=', mimeType: 'video/webm', bytes: 5, durationMs: 20000, kind: 'journey-recording'};
  const recorder = {
    id: null, startedAt: '2026-10-20T10:00:00.000Z',
    async pause() { calls.pause++; if (fail === 'pause') throw new Error('capture error'); },
    async resume() { calls.resume++; if (fail === 'resume') throw new Error('capture error'); },
    async stop() { calls.stop++; if (fail === 'stop') throw new Error('capture error'); return copy(video); },
  };
  const startRecording = async (current, id) => { recorder.id = id; return recorder; };
  return {recorder, calls, video, startRecording};
}

test('recording adapter pauses/resumes with the journey and stores one final movie on stop', async () => {
  const rec = recorderFixture();
  const h = harness({service: {startRecording: rec.startRecording}});
  const started = await h.start();
  assert.equal(started.run.recording.status, 'recording');
  assert.equal((await h.message('JOURNEY_PAUSE')).run.recording.status, 'paused');
  assert.equal(rec.calls.pause, 1);
  assert.equal((await h.message('JOURNEY_RESUME')).run.recording.status, 'recording');
  assert.equal(rec.calls.resume, 1);
  await h.message('JOURNEY_STOP'); await tick();
  const saved = h.records.get(started.run.id);
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.recording.status, 'saved');
  assert.deepEqual(saved.video, rec.video);
  assert.equal(rec.calls.stop, 1);
  assert.equal(h.calls.cleanup, 1);
  assert.equal(h.service.busy, false);
});

test('video evidence timestamps use capture time and exclude pause duration', async t => {
  let now = Date.parse('2026-10-20T10:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const rec = recorderFixture();
  const h = harness({service: {startRecording: rec.startRecording}});
  const started = await h.start();
  try {
    now += 5000; await h.message('JOURNEY_PAUSE');
    now += 10000; await h.message('JOURNEY_RESUME');
    await h.updateState({steps: [{
      index: 1, createdAt: '2026-10-20T10:00:20.000Z',
      observation: {url: 'https://example.test/', screenshot: {...screenshot, capturedAt: '2026-10-20T10:00:17.000Z'}},
      action: {type: 'click', targetId: 'one'}, reason: 'Next',
    }]});
    const run = (await h.message('JOURNEY_STATE', {runId: started.run.id})).run;
    assert.equal(run.steps[0].videoOffsetMs, 6700, 'Seek to captured evidence at 17s, subtract 10s pause and 300ms context.');
  } finally { await h.service.interrupt(); }
});

test('automatic recording end stops the runner and preserves movie with an inconclusive outcome', async () => {
  const rec = recorderFixture();
  const h = harness({service: {startRecording: rec.startRecording}});
  const started = await h.start();
  await h.service.recordingEnded('other-recording');
  assert.equal(h.service.busy, true);
  await h.service.recordingEnded(rec.recorder.id);
  await tick();
  const saved = h.records.get(started.run.id);
  assert.equal(saved.status, 'inconclusive');
  assert.match(saved.summary, /recording ended before the journey finished/);
  assert.equal(saved.recording.status, 'saved');
  assert.deepEqual(saved.video, rec.video);
  assert.equal(h.service.busy, false);
  assert.equal(h.calls.cleanup, 1);
});

test('recording pause failure terminates the run; encoding failure still releases its executor', async () => {
  for (const fail of ['pause', 'stop']) {
    const rec = recorderFixture({fail});
    const h = harness({service: {startRecording: rec.startRecording}});
    const started = await h.start();
    if (fail === 'pause') await h.message('JOURNEY_PAUSE');
    else await h.service.interrupt();
    await tick();
    const saved = h.records.get(started.run.id);
    assert.equal(h.service.busy, false);
    assert.equal(h.calls.cleanup, 1);
    if (fail === 'pause') assert.equal(saved.status, 'inconclusive');
    else {
      assert.equal(saved.recording.status, 'unavailable');
      assert.match(saved.recordingError, /could not be saved/);
    }
  }
});

test('recording initialization failure leaves no running job or recorded run', async () => {
  const h = harness({service: {startRecording: async () => { throw new Error('Capture unavailable'); }}});
  await assert.rejects(h.start(), /Capture unavailable/);
  assert.equal(h.service.busy, false);
  assert.equal(h.records.size, 0);
});

test('cancelling while recording initializes disposes its eventual stream and never starts actions', async () => {
  const acquired = deferred(), entering = deferred();
  const rec = recorderFixture();
  const h = harness({service: {startRecording: async () => { entering.resolve(); return acquired.promise; }}});
  const starting = h.start();
  await entering.promise;
  await h.service.interrupt();
  acquired.resolve(rec.recorder);
  await assert.rejects(starting, /cancelled before it started/);
  assert.equal(rec.calls.stop, 1);
  assert.equal(h.service.busy, false);
  assert.equal(h.records.size, 0);
  assert.equal(h.calls.execute, 0);
});

test('a terminal save failure still exposes the terminal memory state instead of the stale stored running state', async () => {
  const records = new Map();
  let cleaned = 0;
  const rec = recorderFixture();
  const h = harness({
    store: {
      async putJourney(run) {
        if (run.status !== 'running') throw new Error('Storage unavailable');
        records.set(run.id, copy(run));
      },
      async getJourney(id) { return copy(records.get(id)); },
    },
    service: {
      runnerFactory: createJourneyRunner,
      startRecording: rec.startRecording,
      createExecutor: async () => ({
        observe: async () => ({url: 'https://example.test/', title: 'Ingredients', text: 'Saved Oat milk', controls: [], screenshot}),
        execute: async () => { throw new Error('No actions expected'); },
        cleanup: async () => { cleaned++; },
      }),
      decide: async () => ({
        action: {
          type: 'finish', outcome: 'completed', summary: 'The saved item is visible.', findings: [],
          scores: JOURNEY_DIMENSIONS.map(dimension => ({dimension, score: null, reason: 'Not tested.', evidenceSteps: [], confidence: 0})),
        }, reason: 'The result is already visible.',
      }),
    },
  });
  const started = await h.start();
  await tick();
  assert.equal(h.service.busy, false);
  assert.equal(cleaned, 1);
  assert.equal(rec.calls.stop, 1);
  assert.equal(records.get(started.run.id).status, 'running', 'Fixture intentionally retains only the last successfully saved state.');
  const result = await h.message('JOURNEY_STATE', {runId: started.run.id});
  assert.equal(result.run.status, 'inconclusive');
  assert.match(result.run.summary, /could not save/);
});
