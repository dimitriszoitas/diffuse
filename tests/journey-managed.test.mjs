import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedJourneyDriver, requestManagedJourneyFollowUp} from '../extension/journey-managed.mjs';
import {journeyAgentDefinitions, JOURNEY_AGENT_MODEL, JOURNEY_AGENT_EFFORT} from '../extension/journey-agent-definitions.mjs';
import {agentAccountFingerprint} from '../extension/journey-agent-config.mjs';
import {JOURNEY_DIMENSIONS, JourneyError} from '../extension/journey-ai.mjs';
import {createJourneyService} from '../extension/journey-service.mjs';

const KEY = 'sk-ant-managed-journey-fixture-not-real';
const OTHER_KEY = 'sk-ant-different-managed-fixture-not-real';
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const image = {dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 1200, height: 800};
const observation = (text = 'Create ingredient') => ({url: 'https://example.test/ingredients', title: 'Ingredients', text,
  controls: [{id: 'control-1', role: 'button', label: 'Save', bounds: {x: 20, y: 30, width: 100, height: 40}}], screenshot: image,
  context: {documentId: 'doc-1', observationId: 'snapshot-1', viewport: {width: 1200, height: 800}}});
const args = (extra = {}) => ({goal: 'Create Oat milk.', successCriteria: 'The ingredient appears in the list.', testData: 'Name: Oat milk',
  observation: observation(), history: [], ...extra});
const scoreSet = (index, value = null) => JOURNEY_DIMENSIONS.map(dimension => ({dimension, score: value,
  reason: value === null ? 'This was not tested.' : 'The recorded screen supports this assessment.',
  confidence: value === null ? 0 : .8, evidenceSteps: value === null ? [] : [index]}));
const actor = (action, step = 1) => ({name: 'journey_step', input: {action, reason: 'Use the visible control.', observationStep: step}});
const actorFinish = (outcome = 'completed', step = 1) => actor({type: 'finish', outcome, summary: 'The recorded attempt ended.',
  ...(outcome === 'blocked' ? {helpQuestion: 'I cannot find an eligible ingredient. What should I try?'} : {})}, step);
const assessment = (outcome = 'completed', index = 1, extra = {}) => ({name: 'journey_assessment', input: {
  action: {type: 'finish', outcome, summary: 'The saved evidence supports the outcome.', findings: [], scores: scoreSet(index), ...extra}, reason: 'Checked the saved evidence.'}});
const answer = (text = 'The saved label explains the choice.', indexes = [1]) => ({name: 'journey_answer', input: {answer: text, evidenceSteps: indexes, routeSuggestion: null}});

async function harness({actorEvents = [], evaluatorEvents = [], budgetUsd = 2, onMetadata} = {}) {
  const account = await agentAccountFingerprint(KEY);
  const calls = {sessions: [], sent: [], waits: [], interrupts: [], metadata: []};
  let sequence = 0;
  const queues = {actor: [...actorEvents], evaluator: [...evaluatorEvents]};
  const client = {
    async createSession(options) {
      calls.sessions.push({...options});
      return {id: options.agentId === 'agent-actor' ? 'session-actor' : 'session-evaluator'};
    },
    async sendEvents(sessionId, events, options = {}) { calls.sent.push({sessionId, events: copy(events), signal: options.signal}); },
    async waitForTool(sessionId, options) {
      calls.waits.push({sessionId, ...options});
      const role = sessionId === 'session-actor' ? 'actor' : 'evaluator';
      let next = queues[role].shift();
      if (typeof next === 'function') next = await next(options);
      if (next instanceof Error) throw next;
      assert.ok(next, `Unexpected ${role} request`);
      if (role === 'actor' && next.name === 'journey_step' && next.input.observationToken === undefined) {
        const latest = calls.sent.findLast(call => call.sessionId === sessionId);
        const payload = latest?.events.flatMap(jsonBlocks).find(value => value.currentStep !== undefined);
        next = {...next, input: {...next.input, observationToken: payload?.observationToken}};
      }
      const id = `event-${++sequence}`;
      return {toolUseId: id, cursor: id, ...copy(next)};
    },
    async interrupt(sessionId) { calls.interrupts.push(sessionId); },
  };
  const driver = await createManagedJourneyDriver({config: {apiKey: KEY, model: 'some-other-direct-model', journeyBudgetUsd: budgetUsd},
    agents: {ready: true, account, actor: {id: 'agent-actor', version: 2}, evaluator: {id: 'agent-evaluator', version: 3}, environmentId: 'env-browser'},
    client, onMetadata: async value => { calls.metadata.push(copy(value)); await onMetadata?.(value); }});
  return {driver, client, calls, account, queues};
}

function runForFollowUp(account, extra = {}) {
  return {id: 'run-1', goal: 'Create Oat milk.', status: 'completed', summary: 'Created.', findings: [], scores: [], followUps: [],
    steps: [{index: 1, observation: observation(), action: {type: 'click', targetId: 'control-1'}, reason: 'Save the ingredient.', executionStatus: 'complete', result: {performed: true}}],
    managed: {engine: 'managed', account, evaluatorStatus: 'complete', evaluatorSessionId: 'session-evaluator', evaluatorCursor: 'earlier-event', evaluatorPendingToolId: 'previous-tool'}, ...extra};
}
const jsonBlocks = event => event.content.filter(block => block.type === 'text').flatMap(block => { try { return [JSON.parse(block.text)]; } catch { return []; } });

test('evaluator receives bounded parent context for a continuation without treating parent steps as new captures', async () => {
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [assessment()]});
  const priorJourney = {id: 'parent-run', goal: 'Create a project and add four recipes.', status: 'blocked', summary: 'Created the project; recipe selection remains.',
    steps: [{index: 1, observation: observation('Project created'), action: {type: 'click', targetId: 'control-1'}, executionStatus: 'complete'}]};
  await h.driver.decide(args({continuation: {parentRunId: 'parent-run', instructions: 'Continue with eligible recipes.'}, priorJourney}));
  const payload = jsonBlocks(h.calls.sent.find(call => call.sessionId === 'session-evaluator').events[0])[0];
  assert.equal(payload.priorJourney.id, 'parent-run');
  assert.match(payload.priorJourney.summary, /Created the project/);
  assert.equal(payload.continuation.instructions, 'Continue with eligible recipes.');
  assert.equal(payload.priorJourney.steps[0].observation.screenshot, undefined);
  assert.equal(payload.steps.length, 1);
  await h.driver.close();
});

test('definitions pin Opus 5.5 Max and separate actor tools from read-only evaluation', () => {
  const definitions = journeyAgentDefinitions();
  assert.equal(JOURNEY_AGENT_MODEL, 'claude-opus-5-5');
  assert.equal(JOURNEY_AGENT_EFFORT, 'max');
  for (const definition of Object.values(definitions)) {
    assert.deepEqual(definition.model, {id: 'claude-opus-5-5', effort: {type: 'max'}});
    assert.ok(definition.tools.every(tool => tool.type === 'custom'));
  }
  assert.deepEqual(definitions.actor.tools.map(tool => tool.name), ['journey_step']);
  assert.deepEqual(definitions.evaluator.tools.map(tool => tool.name), ['journey_assessment', 'journey_answer', 'journey_evidence']);
  const finish = definitions.actor.tools[0].input_schema.properties.action.anyOf.find(shape => shape.properties.type.const === 'finish');
  assert.equal(finish.properties.findings, undefined);
  assert.equal(finish.properties.scores, undefined);
  assert.deepEqual(finish.properties.outcome.enum, ['completed', 'blocked', 'inconclusive']);
  assert.ok(definitions.actor.tools[0].input_schema.required.includes('observationToken'));
  assert.equal(definitions.evaluator.tools[0].input_schema.properties.action.properties.type.const, 'finish');
});

test('actor actions stay in one session and return actual execution with a fresh observation', async () => {
  const h = await harness({actorEvents: [actor({type: 'click', targetId: 'control-1'}), actor({type: 'wait'}, 2)]});
  const first = await h.driver.decide(args());
  const history = [{index: 1, observation: observation(), ...first, executionStatus: 'complete', result: {performed: true, url: 'https://example.test/ingredients'}}];
  const second = await h.driver.decide(args({history, observation: observation('Oat milk saved; loading list')}));
  assert.equal(second.action.type, 'wait');
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].agentVersion, 2);
  assert.equal(h.calls.sessions[0].budgetUsd, 1.5);
  assert.equal(h.calls.sent[0].events[0].type, 'user.message');
  const result = h.calls.sent[1].events[0];
  assert.equal(result.type, 'user.custom_tool_result');
  assert.equal(result.custom_tool_use_id, h.calls.metadata.find(item => item.actorPendingToolId)?.actorPendingToolId);
  const texts = jsonBlocks(result);
  assert.equal(texts[0].previousProposal.executionStatus, 'complete');
  assert.equal(texts[0].previousProposal.result.performed, true);
  assert.equal(texts[1].currentStep, 2);
  assert.match(texts[1].observation.text, /Oat milk saved/);
  assert.equal(texts[1].history[0].observation.controls.length, 0);
  assert.ok(result.content.some(block => block.type === 'image'));
  assert.equal(JSON.stringify(h.calls.sent).includes(KEY), false);
});

test('a paused proposal is marked unexecuted before requesting a new action', async () => {
  const h = await harness({actorEvents: [actor({type: 'click', targetId: 'control-1'}), actor({type: 'wait'})]});
  await h.driver.decide(args());
  await h.driver.decide(args({observation: observation('Different page state after pause')}));
  const blocks = jsonBlocks(h.calls.sent[1].events[0]);
  assert.equal(blocks[0].previousProposal.executionStatus, 'not-executed');
  assert.match(blocks[1].observation.text, /Different page state/);
});

test('stale observation, fabricated control, and actor scores cannot produce an action', async t => {
  const cases = [
    actor({type: 'click', targetId: 'control-1'}, 99),
    actor({type: 'click', targetId: 'control-999'}),
    actor({type: 'finish', outcome: 'completed', summary: 'Done.', findings: [], scores: scoreSet(1, 5)}),
  ];
  for (const [index, invalid] of cases.entries()) await t.test(String(index), async () => {
    const h = await harness({actorEvents: [invalid]});
    await assert.rejects(h.driver.decide(args()), error => error.code === 'JOURNEY_OUTPUT');
    assert.equal(h.calls.sessions.length, 1);
    assert.equal(h.driver.metadata.evaluatorStatus, 'not-started');
  });
});

test('finish invokes a separate evaluator with the reserved budget and recorded evidence', async () => {
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [assessment('completed', 1, {scores: scoreSet(1, 4)})]});
  const result = await h.driver.decide(args());
  assert.equal(h.calls.sessions.length, 2);
  assert.equal(h.calls.sessions[1].agentId, 'agent-evaluator');
  assert.equal(h.calls.sessions[1].agentVersion, 3);
  assert.equal(h.calls.sessions[1].budgetUsd, .5);
  const event = h.calls.sent.find(call => call.sessionId === 'session-evaluator').events[0];
  const payload = jsonBlocks(event)[0];
  assert.equal(payload.steps[0].index, 1);
  assert.equal(payload.screenshotStep, 1);
  assert.equal(result.action.scores[0].score, 4);
  assert.equal(result.reason, 'Use the visible control.');
  assert.equal(h.driver.metadata.model, 'claude-opus-5-5');
  assert.equal(h.driver.metadata.effort, 'max');
  assert.equal(h.driver.metadata.evaluatorStatus, 'complete');
  assert.ok(h.driver.metadata.evaluatorPendingToolId);
});

test('the evaluator can request a past screenshot but cannot perform browser actions', async () => {
  const prior = {index: 1, observation: observation('Before Save'), action: {type: 'click', targetId: 'control-1'}, reason: 'Save.', result: {performed: true}};
  const h = await harness({actorEvents: [actorFinish('completed', 2)], evaluatorEvents: [
    {name: 'journey_evidence', input: {stepIndex: 1}}, assessment('completed', 2),
  ]});
  await h.driver.decide(args({history: [prior], observation: observation('Saved list')}));
  const evidence = h.calls.sent.find(call => call.sessionId === 'session-evaluator' && call.events[0].type === 'user.custom_tool_result').events[0];
  assert.equal(jsonBlocks(evidence)[0].index, 1);
  assert.match(jsonBlocks(evidence)[0].observation.text, /Before Save/);
  assert.ok(evidence.content.some(block => block.type === 'image'));
  assert.deepEqual(h.calls.waits.filter(call => call.sessionId === 'session-evaluator')[0].toolNames, ['journey_assessment', 'journey_evidence']);
});

test('evaluation errors retain the actor outcome with unassessed scores and a safe diagnostic', async () => {
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [new Error(`Provider diagnostic containing ${KEY}`)]});
  const result = await h.driver.decide(args());
  assert.equal(result.action.outcome, 'completed');
  assert.deepEqual(result.action.findings, []);
  assert.ok(result.action.scores.every(score => score.score === null && score.confidence === 0 && !score.evidenceSteps.length));
  assert.equal(h.driver.metadata.evaluatorStatus, 'unavailable');
  assert.equal(JSON.stringify(h.driver.metadata).includes(KEY), false);
});

test('evaluation cannot turn a blocked journey into a completed one', async () => {
  const h = await harness({actorEvents: [actorFinish('blocked')], evaluatorEvents: [assessment('completed')]});
  const result = await h.driver.decide(args());
  assert.equal(result.action.outcome, 'blocked');
  assert.match(result.action.helpQuestion, /What should I try/);
  assert.equal(h.driver.metadata.evaluatorStatus, 'unavailable');
  assert.ok(result.action.scores.every(score => score.score === null));
});

test('unrecorded evaluator evidence is explicitly missing rather than fabricated', async () => {
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [
    {name: 'journey_evidence', input: {stepIndex: 29}}, assessment(),
  ]});
  await h.driver.decide(args());
  const reply = h.calls.sent.find(call => call.sessionId === 'session-evaluator' && call.events[0].type === 'user.custom_tool_result').events[0];
  assert.equal(reply.is_error, true);
  assert.match(jsonBlocks(reply)[0].error, /not recorded/);
  assert.equal(reply.content.some(block => block.type === 'image'), false);
});

test('new journeys do not inherit another journey session or pending tools', async () => {
  const h = await harness({actorEvents: [actor({type: 'wait'})]});
  await h.driver.decide(args());
  const next = await harness({actorEvents: [actor({type: 'wait'})]});
  await next.driver.decide(args());
  assert.equal(next.calls.sessions.length, 1);
  assert.equal(next.calls.sent[0].events[0].type, 'user.message');
  assert.equal(next.calls.waits[0].after, undefined);
});

test('a late actor reply after pause is saved but cannot escape as an executable decision', async () => {
  const late = deferred(), reached = deferred(), controller = new AbortController();
  const h = await harness({actorEvents: [async () => { reached.resolve(); return late.promise; }, actor({type: 'wait'})]});
  const pending = h.driver.decide(args({signal: controller.signal}));
  await reached.promise;
  controller.abort();
  late.resolve(actor({type: 'click', targetId: 'control-1'}));
  await assert.rejects(pending, error => error.code === 'AI_CANCELLED');
  await h.driver.decide(args());
  const result = h.calls.sent[1].events[0];
  assert.equal(result.type, 'user.custom_tool_result');
  assert.equal(jsonBlocks(result)[0].previousProposal.executionStatus, 'not-executed');
});

test('a duplicate old proposal after pause is rejected even when step and control IDs are reused', async () => {
  const late = deferred(), reached = deferred(), controller = new AbortController();
  const h = await harness({actorEvents: [async () => { reached.resolve(); return late.promise; }]});
  const pending = h.driver.decide(args({signal: controller.signal}));
  await reached.promise;
  const oldToken = jsonBlocks(h.calls.sent[0].events[0])[0].observationToken;
  assert.equal(typeof oldToken, 'string');
  controller.abort();
  late.resolve(actor({type: 'click', targetId: 'control-1'}));
  await assert.rejects(pending, error => error.code === 'AI_CANCELLED');
  const duplicate = actor({type: 'click', targetId: 'control-1'});
  duplicate.input.observationToken = oldToken;
  h.queues.actor.push(duplicate);
  await assert.rejects(h.driver.decide(args({observation: observation('control-1 now belongs to another visible button')})), error => error.code === 'JOURNEY_OUTPUT');
  const fresh = jsonBlocks(h.calls.sent[1].events[0]).find(value => value.currentStep !== undefined);
  assert.equal(fresh.currentStep, 1);
  assert.notEqual(fresh.observationToken, oldToken);
});

test('close cancels the transport lifetime and prevents future actions', async () => {
  const reached = deferred();
  const h = await harness({actorEvents: [options => new Promise((resolve, reject) => {
    reached.resolve();
    options.signal.addEventListener('abort', () => reject(new JourneyError('AI_CANCELLED', 'Cancelled.')), {once: true});
  })]});
  const pending = h.driver.decide(args());
  await reached.promise;
  const rejected = assert.rejects(pending, error => error.code === 'AI_CANCELLED');
  await h.driver.close();
  await rejected;
  assert.ok(h.calls.waits[0].signal.aborted);
  assert.ok(h.calls.interrupts.includes('session-actor'));
  await assert.rejects(h.driver.decide(args()), error => error.code === 'AI_CANCELLED');
});

test('close drains cancelled evaluation and its metadata writes before resolving', async () => {
  const evaluating = deferred(), saving = deferred(), releaseSave = deferred();
  let delayed = false, closed = false;
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [options => new Promise((resolve, reject) => {
    evaluating.resolve();
    options.signal.addEventListener('abort', () => reject(new JourneyError('AI_CANCELLED', 'Cancelled.')), {once: true});
  })], onMetadata: async metadata => {
    if (metadata.evaluatorStatus === 'unavailable' && !delayed) {
      delayed = true;
      saving.resolve();
      await releaseSave.promise;
    }
  }});
  const pending = h.driver.decide(args());
  const rejected = assert.rejects(pending, error => error.code === 'AI_CANCELLED');
  await evaluating.promise;
  const closing = h.driver.close().then(() => { closed = true; });
  await saving.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'close must not leave metadata writes running behind final recording persistence');
  releaseSave.resolve();
  await closing;
  await rejected;
  assert.equal(h.driver.metadata.evaluatorStatus, 'unavailable');
  const writes = h.calls.metadata.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.metadata.length, writes);
});

test('closing an unevaluated attempt makes its terminal assessment explicitly unavailable', async () => {
  const h = await harness({actorEvents: [actor({type: 'wait'})]});
  await h.driver.decide(args());
  await h.driver.close();
  assert.equal(h.driver.metadata.evaluatorStatus, 'unavailable');
  assert.match(h.driver.metadata.evaluatorError, /before.*evaluation|evaluation.*not/i);
  assert.equal(h.driver.metadata.evaluatorSessionId, undefined);
});

test('follow-up rejects a different key before touching the saved provider session', async () => {
  const h = await harness();
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: OTHER_KEY, run: runForFollowUp(h.account), question: 'Why?', client: h.client}), error => error.code === 'AGENT_SESSION');
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.waits.length, 0);
  assert.equal(h.calls.interrupts.length, 0);
});

test('new attempts reject old model or revision pins before creating a session', async () => {
  const h = await harness();
  const current = {ready: true, account: h.account, revision: 'diffuse-journeys-3', model: 'claude-opus-5-5',
    actor: {id: 'agent-actor', version: 5}, evaluator: {id: 'agent-evaluator', version: 6}, environmentId: 'env-browser'};
  for (const stale of [{revision: 'diffuse-journeys-2'}, {model: 'claude-fable-5'}]) {
    await assert.rejects(createManagedJourneyDriver({config: {apiKey: KEY, journeyBudgetUsd: 2},
      client: h.client, agents: {...current, ...stale}}), error => error.code === 'AGENT_SETUP');
  }
  assert.equal(h.calls.sessions.length, 0);
  assert.equal(h.calls.sent.length, 0);
  await h.driver.close();
});

test('historical Fable discussions keep their existing evaluator session and model identity after upgrade', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const run = runForFollowUp(h.account);
  Object.assign(run.managed, {revision: 'diffuse-journeys-2', model: 'claude-fable-5', effort: 'max'});
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why did you choose Save?', client: h.client,
    resolveAgents: async () => assert.fail('Existing sessions must not resolve the current agent model'),
    onMetadata: async metadata => { run.managed = copy(metadata); }});
  assert.equal(h.calls.sessions.length, 0);
  assert.equal(h.calls.sent[0].sessionId, 'session-evaluator');
  assert.equal(run.managed.model, 'claude-fable-5');
  assert.equal(run.managed.revision, 'diffuse-journeys-2');
  assert.equal(run.managed.effort, 'max');
  await h.driver.close();
});

test('historical unevaluated Fable attempts create only their original pinned evaluator', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const run = runForFollowUp(h.account, {status: 'stopped', managed: {engine: 'managed', account: h.account,
    revision: 'diffuse-journeys-2', model: 'claude-fable-5', effort: 'max', budgetUsd: 20,
    evaluatorStatus: 'unavailable', evaluatorReservationVersion: 1,
    evaluatorAgent: {id: 'agent-evaluator', version: 3}, environmentId: 'env-original'}});
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'What happened?', client: h.client,
    resolveAgents: async () => assert.fail('Saved exact pins must not be replaced by the upgraded registry'),
    onMetadata: async metadata => { run.managed = copy(metadata); }});
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].agentId, 'agent-evaluator');
  assert.equal(h.calls.sessions[0].agentVersion, 3);
  assert.equal(h.calls.sessions[0].environmentId, 'env-original');
  assert.equal(h.calls.sessions[0].budgetUsd, 5);
  assert.equal(h.calls.sessions[0].model, undefined, 'The pinned definition selects Fable; never override it with Opus');
  assert.equal(run.managed.model, 'claude-fable-5');
  assert.equal(run.managed.revision, 'diffuse-journeys-2');
  await h.driver.close();
});

test('a stopped attempt without an assessment can chat using its original reserved evaluator budget', async () => {
  const h = await harness({budgetUsd: 20, actorEvents: [actor({type: 'wait'})], evaluatorEvents: [answer('The browser stopped the action because its tab was inactive.'), answer('You can return to the original tab before continuing.')]});
  await h.driver.decide(args());
  await h.driver.close();
  const run = runForFollowUp(h.account, {status: 'blocked', managed: h.driver.metadata,
    stopReason: {source: 'browser', code: 'JOURNEY_BLOCKED', message: 'Return to the journey’s tab before continuing.', stepIndex: 1},
    assistance: {response: {decision: 'stop', text: 'Stop here for now.'}}});
  run.steps[0].executionStatus = 'failed';
  run.steps[0].executionError = {source: 'browser', code: 'JOURNEY_BLOCKED', message: run.stopReason.message};
  const save = async managed => { run.managed = copy(managed); };
  const first = await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why did you stop?', client: h.client, onMetadata: save});
  assert.match(first.answer, /tab was inactive/);
  assert.equal(h.calls.sessions.length, 2, 'Only one actor and one evaluator session');
  assert.equal(h.calls.sessions[1].budgetUsd, 5, 'Use 25% of the original $20, not the current default');
  assert.equal(h.calls.sessions[1].agentVersion, 3);
  const payload = jsonBlocks(h.calls.sent.find(call => call.sessionId === 'session-evaluator').events[0])[0];
  assert.deepEqual(payload.stopReason, run.stopReason);
  assert.deepEqual(payload.steps[0].executionError, run.steps[0].executionError);
  assert.equal(payload.evaluation.completed, false);
  assert.match(payload.evaluation.limitation, /do not invent scores or a missing stop reason/);
  assert.equal(run.managed.evaluatorStatus, 'unavailable', 'Discussion must not fabricate a completed assessment');
  assert.deepEqual(run.scores, []);
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'What next?', client: h.client, onMetadata: save});
  assert.equal(h.calls.sessions.length, 2, 'Follow-ups reuse the reserved budget');
  assert.equal(h.calls.sent.at(-1).events[0].type, 'user.custom_tool_result');
});

test('legacy stopped attempts resolve only the same account and agent revision', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const managed = {engine: 'managed', account: h.account, revision: 'diffuse-journeys-1', budgetUsd: 2, evaluatorStatus: 'unavailable'};
  const run = runForFollowUp(h.account, {status: 'stopped', managed});
  const agents = {ready: true, account: h.account, revision: managed.revision, evaluator: {id: 'agent-evaluator', version: 3}, environmentId: 'env-browser'};
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client: h.client,
    resolveAgents: async () => ({...agents, revision: 'different-version'})}), error => error.code === 'AGENT_SETUP');
  assert.equal(h.calls.sessions.length, 0);
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client: h.client, resolveAgents: async () => agents});
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].budgetUsd, .5);
});

test('uncertain evaluator creation is journaled and cannot grant a duplicate budget', async () => {
  const h = await harness();
  const run = runForFollowUp(h.account, {status: 'stopped', managed: h.driver.metadata});
  let creates = 0;
  const client = {...h.client, createSession: async () => { creates++; throw Object.assign(new Error('Lost response'), {ambiguous: true}); }};
  const save = async managed => { run.managed = copy(managed); };
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client, onMetadata: save}));
  assert.equal(run.managed.evaluatorSessionCreationUncertain, true);
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Try again?', client, onMetadata: save}), error => error.code === 'AGENT_SESSION');
  assert.equal(creates, 1);
  assert.equal(h.calls.sent.length, 0);
});

test('an older attempted evaluation with a missing session ID cannot receive a second budget', async () => {
  const h = await harness();
  const managed = {engine: 'managed', account: h.account, revision: 'diffuse-journeys-1', budgetUsd: 2, evaluatorStatus: 'unavailable', actorOutcome: {type: 'finish', outcome: 'blocked'}};
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: runForFollowUp(h.account, {status: 'blocked', managed}), question: 'Why?', client: h.client,
    resolveAgents: async () => assert.fail('Do not recreate a potentially existing session')}), error => error.code === 'AGENT_SESSION');
  assert.equal(h.calls.sessions.length, 0);
});

test('failed intent persistence prevents evaluator creation', async () => {
  const h = await harness();
  const run = runForFollowUp(h.account, {status: 'stopped', managed: h.driver.metadata});
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client: h.client,
    onMetadata: async metadata => { run.managed = copy(metadata); if (metadata.evaluatorSessionCreationPending) throw new Error('Local storage full'); }}));
  assert.equal(h.calls.sessions.length, 0);
  assert.equal(run.managed.evaluatorSessionCreationPending, false);
});

test('definitive session creation rejection permits retry without changing the reserved budget', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const run = runForFollowUp(h.account, {status: 'stopped', managed: h.driver.metadata});
  const save = async managed => { run.managed = copy(managed); };
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client: {...h.client,
    createSession: async () => { throw Object.assign(new Error('Not authorized'), {status: 403}); }}, onMetadata: save}));
  assert.equal(run.managed.evaluatorSessionCreationUncertain, false);
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why?', client: h.client, onMetadata: save});
  assert.equal(h.calls.sessions.length, 1);
  assert.equal(h.calls.sessions[0].budgetUsd, .5);
});

test('unassessed idle evaluator is reused, while exhausted or uncertain sessions never restart', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const run = runForFollowUp(h.account);
  run.managed.evaluatorStatus = 'unavailable';
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'What was recorded?', client: h.client});
  assert.equal(h.calls.sessions.length, 0);
  for (const flag of ['evaluatorBudgetExhausted', 'evaluatorSessionCreationPending', 'evaluatorSessionCreationUncertain', 'evaluatorInterrupted', 'evaluatorRequestInFlight']) {
    await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: {...run, managed: {...run.managed, [flag]: true}}, question: 'Retry?', client: h.client}));
  }
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: {...run, managed: {...run.managed, evaluatorError: 'The evaluator reached its spending limit.'}}, question: 'Retry?', client: h.client}), error => error.code === 'AGENT_BUDGET');
  assert.equal(h.calls.sessions.length, 0);
  assert.equal(h.calls.sent.length, 1);
});

test('follow-ups reuse the evaluator budget and settle prior output with the new question', async () => {
  const h = await harness({evaluatorEvents: [answer()]});
  const updates = [];
  const result = await requestManagedJourneyFollowUp({apiKey: KEY, run: runForFollowUp(h.account), question: 'Why did you select Save?', stepIndex: 1,
    client: h.client, onMetadata: async metadata => updates.push(copy(metadata))});
  assert.equal(result.answer, 'The saved label explains the choice.');
  assert.equal(h.calls.sessions.length, 0);
  assert.ok(h.calls.sent.every(call => call.sessionId === 'session-evaluator'));
  assert.equal(h.calls.sent[0].events[0].type, 'user.custom_tool_result');
  assert.equal(h.calls.sent[0].events[0].custom_tool_use_id, 'previous-tool');
  assert.equal(h.calls.sent.length, 1);
  assert.equal(jsonBlocks(h.calls.sent[0].events[0])[0].selectedStep, 1);
  assert.ok(h.calls.sent[0].events[0].content.some(block => block.type === 'image'));
  assert.equal(updates[0].evaluatorPendingToolId, null);
  assert.equal(updates[0].evaluatorRequestInFlight, true);
  assert.ok(updates.at(-1).evaluatorPendingToolId);
  assert.equal(updates.at(-1).evaluatorRequestInFlight, false);
  assert.deepEqual(h.calls.interrupts, []);
});

test('normal completion keeps idle custom-tool handoffs intact for later conversation', async () => {
  const h = await harness({actorEvents: [actorFinish()], evaluatorEvents: [assessment()]});
  await h.driver.decide(args());
  const pending = h.driver.metadata.evaluatorPendingToolId;
  await h.driver.close();
  assert.deepEqual(h.calls.interrupts, []);
  assert.equal(h.driver.metadata.evaluatorPendingToolId, pending);
  assert.equal(h.driver.metadata.evaluatorStatus, 'complete');
});

test('pause during evaluation cannot create a second evaluator budget on resume', async () => {
  const late = deferred(), reached = deferred(), controller = new AbortController();
  const h = await harness({actorEvents: [actorFinish(), actorFinish()], evaluatorEvents: [
    async () => { reached.resolve(); return late.promise; }, assessment(),
  ]});
  const pending = h.driver.decide(args({signal: controller.signal}));
  await reached.promise;
  controller.abort();
  late.resolve(assessment());
  await assert.rejects(pending, error => error.code === 'AI_CANCELLED');
  assert.equal(h.driver.metadata.evaluatorStatus, 'complete');
  await h.driver.decide(args({observation: observation('Fresh observation after pause')}));
  assert.equal(h.calls.sessions.filter(call => call.agentId === 'agent-evaluator').length, 1);
  const evaluatorEvents = h.calls.sent.filter(call => call.sessionId === 'session-evaluator');
  assert.equal(evaluatorEvents[1].events[0].type, 'user.custom_tool_result');
  assert.deepEqual(h.calls.interrupts, []);
});

test('an uncertain follow-up send is interrupted and marked so it cannot be replayed', async () => {
  const h = await harness();
  let managed = runForFollowUp(h.account).managed;
  const failedClient = {...h.client, sendEvents: async () => { throw new Error('Connection lost after sending'); }};
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: runForFollowUp(h.account), question: 'Why?', client: failedClient,
    onMetadata: async value => { managed = copy(value); }}), error => error.code === 'AGENT_SERVICE');
  assert.equal(managed.evaluatorInterrupted, true);
  assert.equal(managed.evaluatorPendingToolId, null);
  assert.deepEqual(h.calls.interrupts, ['session-evaluator']);
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: runForFollowUp(h.account, {managed}), question: 'Retry?', client: h.client}), error => error.code === 'AGENT_SESSION');
  assert.equal(h.calls.sent.length, 0);
});

test('follow-up rejects unsupported evidence references instead of saving fabricated citations', async () => {
  const h = await harness({evaluatorEvents: [answer('This occurred at a missing step.', [7])]});
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run: runForFollowUp(h.account), question: 'Why?', client: h.client}), error => error.code === 'JOURNEY_OUTPUT');
  assert.equal(h.calls.sessions.length, 0);
});

test('the service routes saved managed discussions by the run engine after settings change', async () => {
  const account = await agentAccountFingerprint(KEY);
  let stored = {...runForFollowUp(account), reviewId: 'review-1'};
  let managedCalls = 0, directCalls = 0;
  const current = {id: 'review-session', reviewId: 'review-1'};
  const service = createJourneyService({getSession: () => current, checkReady: async () => ({}), createExecutor: async () => ({}),
    readConfig: async () => ({hasKey: true, apiKey: KEY, journeyEngine: 'direct', model: 'different-direct-model'}),
    publish: async () => {}, refreshComments: async () => {}, reviews: {},
    store: {getJourney: async () => copy(stored), putJourney: async run => { stored = copy(run); }, listJourneys: async () => [copy(stored)]},
    followUp: async () => { directCalls++; throw new Error('Unexpected direct-model fallback'); },
    managedFollowUp: async payload => {
      managedCalls++;
      await payload.onMetadata({...payload.run.managed, evaluatorCursor: 'new-evaluator-event'});
      return answer().input;
    }});
  const result = await service.handle({type: 'JOURNEY_ASK', sessionId: current.id, runId: 'run-1', question: 'Why Save?'});
  assert.equal(managedCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(result.run.followUps.length, 1);
  assert.equal(stored.managed.evaluatorCursor, 'new-evaluator-event');
  assert.equal(JSON.stringify(stored).includes(KEY), false);
});

test('the service pins managed run metadata and never falls back to the direct model', async () => {
  const current = {id: 'review-session', reviewId: 'review-1', target: {title: 'Ingredients'}};
  const records = new Map();
  let directCalls = 0, closed = 0, cleaned = 0;
  const service = createJourneyService({getSession: () => current,
    checkReady: async () => ({url: 'https://example.test/ingredients'}),
    createExecutor: async () => ({observe: async () => observation('Oat milk is in the list'), execute: async () => assert.fail('A completed fixture must not click'), cleanup: async () => { cleaned++; }}),
    readConfig: async () => ({hasKey: true, apiKey: KEY, journeyEngine: 'managed', journeyBudgetUsd: 2, model: 'different-direct-model'}),
    publish: async () => {}, refreshComments: async () => {}, reviews: {ensureReview: async () => {}},
    store: {getJourney: async id => copy(records.get(id)), putJourney: async run => { records.set(run.id, copy(run)); }, listJourneys: async () => [...records.values()].map(copy)},
    decide: async () => { directCalls++; throw new Error('No silent fallback'); },
    managedFactory: async ({config, onMetadata}) => {
      assert.equal(config.journeyBudgetUsd, 2);
      let metadata = {engine: 'managed', model: 'claude-opus-5-5', effort: 'max', evaluatorStatus: 'not-started'};
      return {get metadata() { return copy(metadata); }, decide: async () => {
        metadata = {...metadata, evaluatorStatus: 'complete', evaluatorSessionId: 'session-evaluator'};
        await onMetadata(metadata);
        return assessment().input;
      }, close: async () => { closed++; }};
    }});
  try {
    const result = await service.handle({type: 'JOURNEY_START', sessionId: current.id, input: {goal: 'Create Oat milk.'}});
    assert.equal(result.run.model, 'claude-opus-5-5');
    for (let i = 0; service.busy && i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.busy, false);
    assert.equal(records.get(result.run.id).status, 'completed');
    assert.equal(records.get(result.run.id).managed.evaluatorSessionId, 'session-evaluator');
    assert.equal(directCalls, 0);
    assert.equal(closed, 1);
    assert.equal(cleaned, 1);
    assert.equal(JSON.stringify([...records.values()]).includes(KEY), false);
  } finally { await service.interrupt(); }
});

test('service stops capture during provider cancellation and late metadata cannot replace the saved movie', async () => {
  const current = {id: 'review-session', reviewId: 'review-1', target: {title: 'Ingredients'}};
  const records = new Map();
  const deciding = deferred(), closing = deferred(), releaseClose = deferred(), recordingStopped = deferred();
  const movie = {dataUrl: 'data:video/webm;base64,bW92aWU=', mimeType: 'video/webm'};
  let updateMetadata, metadata = {engine: 'managed', model: 'claude-opus-5-5', effort: 'max', evaluatorStatus: 'reviewing'};
  const service = createJourneyService({getSession: () => current,
    checkReady: async () => ({url: 'https://example.test/ingredients'}),
    createExecutor: async () => ({observe: async () => observation(), execute: async () => assert.fail('No action should execute'), cleanup: async () => {}}),
    readConfig: async () => ({hasKey: true, apiKey: KEY, journeyEngine: 'managed', journeyBudgetUsd: 2, model: 'direct-model'}),
    publish: async () => {}, refreshComments: async () => {}, reviews: {ensureReview: async () => {}},
    store: {getJourney: async id => copy(records.get(id)), putJourney: async run => { records.set(run.id, copy(run)); }, listJourneys: async () => [...records.values()].map(copy)},
    startRecording: async () => ({startedAt: new Date().toISOString(), stop: async () => { recordingStopped.resolve(); return copy(movie); }}),
    managedFactory: async ({onMetadata}) => {
      updateMetadata = async value => { metadata = {...metadata, ...value}; await onMetadata(copy(metadata)); };
      return {get metadata() { return copy(metadata); }, decide: async ({signal}) => new Promise((resolve, reject) => {
        deciding.resolve();
        signal.addEventListener('abort', () => reject(new JourneyError('AI_CANCELLED', 'Cancelled.')), {once: true});
      }), close: async () => {
        closing.resolve();
        await releaseClose.promise;
        await updateMetadata({evaluatorStatus: 'unavailable', evaluatorInterrupted: true});
      }};
    }});
  try {
    const result = await service.handle({type: 'JOURNEY_START', sessionId: current.id, input: {goal: 'Create Oat milk.'}});
    await deciding.promise;
    await service.handle({type: 'JOURNEY_STOP', sessionId: current.id});
    await closing.promise;
    await recordingStopped.promise;
    assert.equal(service.busy, true, 'provider cancellation is still pending while capture has already stopped');
    releaseClose.resolve();
    for (let i = 0; service.busy && i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.busy, false);
    const saved = records.get(result.run.id);
    assert.equal(saved.status, 'stopped');
    assert.deepEqual(saved.video, movie);
    assert.equal(saved.recording.status, 'saved');
    assert.equal(saved.managed.evaluatorStatus, 'unavailable');
    await updateMetadata({evaluatorError: 'A delayed provider diagnostic.'});
    assert.deepEqual(records.get(result.run.id), saved, 'metadata after finalization must not overwrite the completed report or its movie');
  } finally {
    releaseClose.resolve();
    await service.interrupt();
  }
});

test('managed setup failure does not start recording, page actions, or direct fallback', async () => {
  const current = {id: 'review-session', reviewId: 'review-1'};
  let recordings = 0, executors = 0, directCalls = 0;
  const service = createJourneyService({getSession: () => current,
    checkReady: async () => ({url: 'https://example.test/ingredients'}), createExecutor: async () => { executors++; return {}; },
    readConfig: async () => ({hasKey: true, apiKey: KEY, journeyEngine: 'managed', model: 'direct-model'}),
    publish: async () => {}, refreshComments: async () => {}, reviews: {ensureReview: async () => {}}, store: {},
    startRecording: async () => { recordings++; return {}; },
    decide: async () => { directCalls++; },
    managedFactory: async () => { throw new JourneyError('AGENT_SETUP', 'Set up the agents first.'); }});
  await assert.rejects(service.handle({type: 'JOURNEY_START', sessionId: current.id, input: {goal: 'Create Oat milk.'}}), error => error.code === 'AGENT_SETUP');
  assert.equal(service.busy, false);
  assert.deepEqual({recordings, executors, directCalls}, {recordings: 0, executors: 0, directCalls: 0});
});

test('managed actor and evaluator support long journeys and compute target separately from usability', async () => {
  const history = Array.from({length: 80}, (_, i) => ({index: i + 1, observation: observation('Stage ' + (i + 1)), action: {type: 'click', targetId: 'control-1'}, reason: 'Continue.', executionStatus: 'complete'}));
  const h = await harness({actorEvents: [actorFinish('completed', 81)], evaluatorEvents: [assessment('completed', 81)]});
  const result = await h.driver.decide(args({history, actionTarget: 20}));
  const actorData = h.calls.sent.filter(call => call.sessionId === 'session-actor').flatMap(call => call.events.flatMap(jsonBlocks)).find(item => item.currentStep);
  const evaluatorData = h.calls.sent.filter(call => call.sessionId === 'session-evaluator').flatMap(call => call.events.flatMap(jsonBlocks)).find(item => item.steps);
  assert.equal(result.action.outcome, 'completed');
  assert.equal(actorData.currentStep, 81); assert.equal(actorData.history.length, 24);
  assert.equal(actorData.contextCoverage.omittedStepCount, 56);
  assert.equal(evaluatorData.steps.length, 40); assert.equal(evaluatorData.targetAssessment.efficiencyScore, 25);
  assert.ok(result.action.scores.every(item => item.score === null));
  await h.driver.close();
});

test('managed discussion includes recorder cause and can fetch omitted evidence beyond step thirty-one', async () => {
  const h = await harness({evaluatorEvents: [{name: 'journey_evidence', input: {stepIndex: 60}}, answer('The saved recording hit its size cap.', [60])]});
  const run = runForFollowUp(h.account, {status: 'inconclusive', summary: 'The recording ended before the journey finished.',
    video: {stopReason: 'size-limit', dataUrl: 'never-transmit-video'}, actionTarget: 20,
    steps: Array.from({length: 120}, (_, i) => ({index: i + 1, observation: observation(), action: {type: 'click', targetId: 'control-1'}, reason: 'Continue.', executionStatus: 'complete'}))});
  const result = await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Why did it stop?', client: h.client});
  const data = jsonBlocks(h.calls.sent[0].events[0])[0];
  assert.equal(data.stopReason.code, 'JOURNEY_RECORDING_SIZE_LIMIT');
  assert.equal(data.recording.stopReason, 'size-limit'); assert.equal(data.targetAssessment.efficiencyScore, null);
  assert.equal(data.steps.length, 40); assert.equal(data.contextCoverage.omittedStepCount, 80);
  assert.equal(data.steps.some(step => step.index === 60), false);
  assert.equal(jsonBlocks(h.calls.sent[1].events[0])[0].index, 60);
  assert.deepEqual(result.evidenceSteps, [60]);
  assert.equal(JSON.stringify(data).includes('never-transmit-video'), false);
  await h.driver.close();
});

const longEvidence = length => Array.from({length}, (_, index) => ({index: index + 1, observation: observation(`Stage ${index + 1}`), action: {type: 'click', targetId: 'control-1'}, reason: 'Continue.', executionStatus: 'complete'}));

test('managed assessment cannot score an omitted step until it retrieves its evidence', async () => {
  for (const retrieve of [false, true]) {
    const h = await harness({actorEvents: [actorFinish('completed', 101)], evaluatorEvents: [
      ...(retrieve ? [{name: 'journey_evidence', input: {stepIndex: 20}}] : []),
      assessment('completed', 20, {scores: scoreSet(20, 4)}),
    ]});
    const result = await h.driver.decide(args({history: longEvidence(100)}));
    const payload = h.calls.sent.filter(call => call.sessionId === 'session-evaluator').flatMap(call => call.events.flatMap(jsonBlocks)).find(value => value.steps);
    assert.equal(payload.steps.some(step => step.index === 20), false);
    assert.equal(h.driver.metadata.evaluatorEvidenceSteps.includes(20), retrieve);
    if (retrieve) {
      assert.equal(h.driver.metadata.evaluatorStatus, 'complete');
      assert.equal(result.action.scores[0].score, 4);
      assert.equal(h.driver.metadata.evaluatorEvidenceSessionId, 'session-evaluator');
    } else {
      assert.equal(h.driver.metadata.evaluatorStatus, 'unavailable');
      assert.ok(result.action.scores.every(score => score.score === null));
    }
    await h.driver.close();
  }
});

test('managed discussion of an old session rejects citations it has neither received nor retrieved', async () => {
  const h = await harness({evaluatorEvents: [answer('An unsupported observation.', [60])]});
  const run = runForFollowUp(h.account, {steps: longEvidence(120)});
  await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'What happened?', client: h.client}), error => error.code === 'JOURNEY_OUTPUT');
  assert.equal(jsonBlocks(h.calls.sent[0].events[0])[0].steps.some(step => step.index === 60), false);
  await h.driver.close();
});

test('managed discussion retains actually retrieved evidence across later questions in the same session', async () => {
  const h = await harness({evaluatorEvents: [{name: 'journey_evidence', input: {stepIndex: 60}}, answer('Recorded step sixty.', [60]), answer('The same earlier observation.', [60])]});
  const run = runForFollowUp(h.account, {steps: longEvidence(120)});
  const onMetadata = async metadata => { run.managed = copy(metadata); };
  await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'What happened at the earlier point?', client: h.client, onMetadata});
  assert.ok(run.managed.evaluatorEvidenceSteps.includes(60));
  const firstSends = h.calls.sent.length;
  const result = await requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Explain that observation further.', client: h.client, onMetadata});
  assert.deepEqual(result.evidenceSteps, [60]);
  assert.equal(h.calls.sent.length, firstSends + 1, 'Previously delivered evidence does not require another lookup.');
  await h.driver.close();
});

test('evaluator evidence metadata cannot authorize absent indexes or indexes from another session', async () => {
  for (const saved of [
    {evaluatorEvidenceSessionId: 'different-session', evaluatorEvidenceSteps: [60]},
    {evaluatorEvidenceSessionId: 'session-evaluator', evaluatorEvidenceSteps: [999]},
  ]) {
    const cited = saved.evaluatorEvidenceSteps[0];
    const h = await harness({evaluatorEvents: [answer('Unsupported.', [cited])]});
    const run = runForFollowUp(h.account, {steps: longEvidence(120)});
    Object.assign(run.managed, saved);
    await assert.rejects(requestManagedJourneyFollowUp({apiKey: KEY, run, question: 'Explain.', client: h.client}), error => error.code === 'JOURNEY_OUTPUT');
    await h.driver.close();
  }
});
