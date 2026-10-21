import test from 'node:test';
import assert from 'node:assert/strict';
import {createJourneyRunner} from '../extension/journey-runner.mjs';
import {JOURNEY_DIMENSIONS, JourneyError} from '../extension/journey-ai.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const input = (extra = {}) => ({id: 'journey-test', goal: 'Create Oat milk in Ingredients.', startUrl: 'https://example.test/', ...extra});
const screen = (page = 'dashboard') => ({url: `https://example.test/${page}`, title: page, text: `Page ${page}`, controls: [{id: 'go', role: 'button', label: 'Next'}, {id: 'name', role: 'textbox', label: 'Name', type: 'text'}], screenshot: {dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 100, height: 100}});
const click = () => ({action: {type: 'click', targetId: 'go'}, reason: 'Continue toward the goal.'});
const done = (index, outcome = 'completed') => ({
  action: {type: 'finish', outcome, summary: 'Oat milk appears in the saved list.', findings: [],
    scores: JOURNEY_DIMENSIONS.map(dimension => ({dimension, score: dimension === 'recovery' ? null : 4, reason: dimension === 'recovery' ? 'Not tested.' : 'The route was clear.', evidenceSteps: dimension === 'recovery' ? [] : [index], confidence: dimension === 'recovery' ? 0 : 0.8})),
  }, reason: 'The resulting list verifies the task.',
});

test('runs one goal across pages, observes the result and stores evidence before publishing completion', async () => {
  const pages = ['dashboard', 'inventory', 'ingredients', 'new-ingredient', 'ingredients-saved'];
  let position = 0;
  const states = [];
  const runner = createJourneyRunner({
    observe: async () => screen(pages[position]),
    execute: async action => { assert.equal(action.type, 'click'); position++; return {ok: true}; },
    decide: async ({goal, history, observation}) => {
      assert.equal(goal, input().goal);
      assert.equal(observation.title, pages[position]);
      assert.equal(history.length, position);
      return position === 4 ? done(5) : click();
    },
    onUpdate: async state => { await Promise.resolve(); states.push(state); },
  });
  const promise = runner.start(input());
  assert.equal(runner.getState().status, 'running');
  const result = await promise;
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 5);
  assert.equal(result.steps[4].action.type, 'finish');
  assert.equal(result.metrics.clicks, 4);
  assert.equal(result.metrics.navigations, 4);
  assert.equal(result.metrics.pagesVisited.length, 5);
  assert.equal(result.scores[0].evidenceSteps[0], 5);
  assert.equal(states.at(-1).status, 'completed');
  const snapshot = runner.getState(); snapshot.steps[0].observation.text = 'changed externally';
  assert.notEqual(runner.getState().steps[0].observation.text, snapshot.steps[0].observation.text);
});

test('pause cancels a stale decision; resume reobserves without executing it', async () => {
  const decisionReady = deferred(), obsolete = deferred();
  let reads = 0, decisions = 0, executions = 0;
  const runner = createJourneyRunner({
    observe: async () => screen(`page-${++reads}`),
    execute: async () => { executions++; },
    decide: async ({signal}) => {
      decisions++;
      if (decisions === 1) { decisionReady.resolve(signal); return obsolete.promise; }
      return done(1);
    },
  });
  const running = runner.start(input());
  const signal = await decisionReady.promise;
  assert.equal(runner.pause().status, 'paused');
  assert.equal(signal.aborted, true);
  obsolete.resolve(click());
  await Promise.resolve();
  assert.equal(runner.getState().status, 'paused');
  assert.equal(executions, 0);
  runner.resume();
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(reads, 2);
  assert.equal(executions, 0);
});

test('stop resolves a paused journey and an unresponsive decision without mislabelling an app failure', async () => {
  const ready = deferred();
  let executions = 0;
  const runner = createJourneyRunner({
    observe: async () => screen(),
    execute: async () => { executions++; },
    decide: async () => { ready.resolve(); return new Promise(() => {}); },
  });
  const promise = runner.start(input());
  await ready.promise; runner.pause(); runner.stop();
  assert.equal((await promise).status, 'stopped');
  assert.equal(executions, 0);
});

test('bounded execution allows final verification but never another action over the limit', async () => {
  for (const finishAtLimit of [false, true]) {
    let executions = 0;
    const runner = createJourneyRunner({
      observe: async () => screen(`step-${executions}`),
      execute: async () => { executions++; },
      decide: async () => finishAtLimit && executions === 5 ? done(6) : click(),
    });
    const result = await runner.start(input({maxSteps: 5}));
    assert.equal(executions, 5);
    assert.equal(result.status, finishAtLimit ? 'completed' : 'inconclusive');
    assert.equal(result.steps.length, 6);
    assert.ok(result.steps[5].observation.screenshot);
  }
});

test('no-progress actions terminate with uncertainty rather than a fabricated issue', async () => {
  let executions = 0;
  const runner = createJourneyRunner({observe: async () => screen(), execute: async () => { executions++; }, decide: async () => click()});
  const result = await runner.start(input());
  assert.equal(executions, 3);
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary, /without an observed page change/);
});

test('model, observer and executor failures are inconclusive; explicit guards are blocked', async () => {
  for (const phase of ['observe', 'decide', 'execute']) {
    const runner = createJourneyRunner({
      observe: async () => { if (phase === 'observe') throw new Error('private page data'); return screen(); },
      decide: async () => { if (phase === 'decide') return {action: {type: 'javascript'}, reason: 'Invalid'}; return click(); },
      execute: async () => { if (phase === 'execute') throw new Error('private page data'); },
    });
    const result = await runner.start(input());
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.summary.includes('private page data'), false);
    assert.deepEqual(result.findings, []);
  }
  const guarded = createJourneyRunner({observe: async () => screen(), decide: async () => click(), execute: async () => { throw new JourneyError('JOURNEY_BLOCKED', 'This action needs the reviewer.'); }});
  assert.equal((await guarded.start(input())).status, 'blocked');
});

test('wall-clock limit interrupts stuck observation and preserves an inconclusive outcome', async () => {
  const runner = createJourneyRunner({observe: () => new Promise(() => {}), decide: async () => click(), execute: async () => {}, maxDurationMs: 5});
  const result = await runner.start(input());
  assert.equal(result.status, 'inconclusive');
  assert.match(result.summary, /time limit/);
});

test('rejects oversized instructions and bounds before touching the page; cannot run twice concurrently', async () => {
  let reads = 0;
  const runner = createJourneyRunner({observe: async () => { reads++; return screen(); }, decide: async () => new Promise(() => {}), execute: async () => {}});
  for (const extra of [{maxSteps: 31}, {maxSteps: 4}, {maxSteps: '20'}, {goal: ''}, {goal: 'a'.repeat(4001)}, {startUrl: 'javascript:alert(1)'}]) await assert.rejects(runner.start(input(extra)), error => error.code === 'JOURNEY_INPUT');
  assert.equal(reads, 0);
  const promise = runner.start(input());
  await assert.rejects(runner.start(input()), error => error.code === 'JOURNEY_RUNNING');
  runner.stop(); await promise;
});

test('a later run starts fresh and page evidence cannot retain password values', async () => {
  const runner = createJourneyRunner({
    observe: async () => ({...screen(), controls: [{id: 'secret', role: 'textbox', label: 'Password', type: 'password', value: 'never retain this'}]}),
    execute: async () => {},
    decide: async ({observation}) => { assert.equal(observation.controls[0].value, undefined); return done(1); },
  });
  await runner.start(input());
  const result = await runner.start(input({id: 'second'}));
  assert.equal(result.id, 'second');
  assert.equal(result.steps.length, 1);
  assert.equal(JSON.stringify(result).includes('never retain this'), false);
});

test('screenshot retention stays bounded while preserving the observation record', async () => {
  let executions = 0;
  const runner = createJourneyRunner({
    observe: async () => ({...screen(`step-${executions}`), screenshot: {dataUrl: `data:image/png;base64,${'x'.repeat(7 * 1024 * 1024)}`, width: 100, height: 100}}),
    execute: async () => { executions++; },
    decide: async () => executions === 5 ? done(6) : click(),
  });
  const result = await runner.start(input({maxSteps: 5}));
  assert.ok(result.steps[0].evidenceOmitted);
  assert.ok(result.steps.at(-1).observation.screenshot);
  assert.ok(result.steps.reduce((sum, step) => sum + (step.observation.screenshot?.dataUrl.length || 0), 0) <= 24 * 1024 * 1024);
  assert.equal(result.steps.length, 6);
});

test('persistence failure stops before any further action and surfaces a fixed safe error', async () => {
  for (const failureAt of [1, 2, 3]) {
    let writes = 0, executions = 0;
    const runner = createJourneyRunner({
      observe: async () => screen(`step-${executions}`),
      execute: async () => { executions++; },
      decide: async () => click(),
      onUpdate: async () => { writes++; if (writes === failureAt) throw new Error('quota error with secret'); },
    });
    await assert.rejects(runner.start(input()), error => error.code === 'JOURNEY_STORAGE' && !error.message.includes('secret'));
    assert.equal(runner.getState().status, 'inconclusive');
    assert.match(runner.getState().summary, /could not save/);
    assert.equal(executions, failureAt === 3 ? 1 : 0);
    assert.equal(writes, failureAt, 'Must not loop retrying persistence or continue the journey.');
  }
});

test('known unavailable controls are retained for AI context and cannot execute', async () => {
  let executions = 0;
  const runner = createJourneyRunner({
    observe: async () => ({...screen(), controls: [{id: 'go', role: 'button', label: 'Delete everything', blockedReason: 'Destructive action'}]}),
    execute: async () => { executions++; },
    decide: async ({observation}) => { assert.equal(observation.controls[0].blockedReason, 'Destructive action'); return click(); },
  });
  const result = await runner.start(input());
  assert.equal(executions, 0);
  assert.equal(result.status, 'inconclusive');
});

test('checkbox changes remain visible to the model and count as observed progress', async () => {
  let actions = 0;
  const runner = createJourneyRunner({
    observe: async () => ({...screen(), controls: [{id: 'go', role: 'checkbox', label: 'Active', checked: actions % 2 === 1, bounds: {x: 10, y: 20, width: 24, height: 24}}]}),
    execute: async () => { actions++; },
    decide: async ({observation}) => {
      assert.equal(observation.controls[0].checked, actions % 2 === 1);
      assert.deepEqual(observation.controls[0].bounds, {x: 10, y: 20, width: 24, height: 24});
      return actions === 3 ? done(4) : click();
    },
  });
  const result = await runner.start(input());
  assert.equal(result.status, 'completed');
  assert.equal(actions, 3);
});

test('nested scroll offsets are retained and count as progress when the visible labels remain the same', async () => {
  let actions = 0;
  const runner = createJourneyRunner({
    observe: async () => ({...screen(), controls: [{id: 'recipes', role: 'scroll-region', label: 'Recipes', scroll: {x: 0, y: actions * 100, maxX: 0, maxY: 1000, canScrollDown: true, canScrollUp: actions > 0}}]}),
    execute: async action => { assert.equal(action.targetId, 'recipes'); actions++; return {performed: true}; },
    decide: async ({observation}) => {
      assert.equal(observation.controls[0].scroll.y, actions * 100);
      return actions === 4 ? done(5) : {action: {type: 'scroll', targetId: 'recipes', direction: 'down'}, reason: 'Inspect the next recipes.'};
    },
  });
  const result = await runner.start(input());
  assert.equal(result.status, 'completed');
  assert.equal(result.metrics.scrolls, 4);
  assert.equal(result.steps[4].observation.controls[0].scroll.y, 400);
});


test('blocked model and executor outcomes retain a help question without inventing findings', async () => {
  const decision = done(1, 'blocked'); decision.action.helpQuestion = 'I cannot find the picker. Where should I look?';
  const runner = createJourneyRunner({observe: async () => screen(), decide: async () => decision, execute: async () => { throw new Error('Must not execute a finish.'); }});
  const result = await runner.start(input());
  assert.equal(result.assistance.question, decision.action.helpQuestion);
  assert.equal(result.assistance.stepIndex, 1);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.scores, decision.action.scores);
  const guarded = createJourneyRunner({observe: async () => screen(), decide: async () => click(), execute: async () => { throw new JourneyError('JOURNEY_BLOCKED', 'This action needs the reviewer.'); }});
  const stopped = await guarded.start(input());
  assert.match(stopped.assistance.question, /This action needs the reviewer.*What should I do next/);
  assert.deepEqual(stopped.findings, []);
});
