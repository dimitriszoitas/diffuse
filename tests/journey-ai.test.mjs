import test from 'node:test';
import assert from 'node:assert/strict';
import {JOURNEY_DIMENSIONS, JOURNEY_DECISION_SCHEMA, requestJourneyDecision, validateJourneyDecision} from '../extension/journey-ai.mjs';
import {DEFAULT_AI_MODEL} from '../extension/ai-client.mjs';

const KEY = 'sk-ant-not-a-real-journey-test-key';
const screenshot = {dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 1200, height: 800};
const observation = () => ({
  url: 'https://example.test/ingredients', title: 'Ingredients', text: 'Oat milk saved.',
  controls: [{id: 'c1', role: 'button', label: 'New ingredient'}, {id: 'c2', role: 'textbox', label: 'Name', type: 'text'}, {id: 'c3', role: 'combobox', label: 'Unit', options: [{value: 'ml', label: 'Millilitres'}]}],
  screenshot,
});
const finish = (outcome = 'completed') => ({
  reason: 'The saved ingredient is visible in the table.',
  action: {
    type: 'finish', outcome, summary: 'The new ingredient appears in Ingredients.',
    findings: [],
    scores: JOURNEY_DIMENSIONS.map(dimension => ({dimension, score: dimension === 'recovery' ? null : 4, reason: dimension === 'recovery' ? 'No error encountered.' : 'The route and outcome were clear.', evidenceSteps: dimension === 'recovery' ? [] : [1], confidence: dimension === 'recovery' ? 0 : 0.8})),
  },
});
const response = value => new Response(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(value)}]}));
const request = (extra = {}) => ({apiKey: KEY, goal: 'Create an ingredient.', observation: observation(), ...extra});

test('strict decisions allow only current control IDs and known select options', () => {
  assert.deepEqual(validateJourneyDecision({action: {type: 'click', targetId: 'c1'}, reason: 'Open the form.'}, {observation: observation()}), {action: {type: 'click', targetId: 'c1'}, reason: 'Open the form.'});
  assert.deepEqual(validateJourneyDecision({action: {type: 'select', targetId: 'c3', value: 'ml'}, reason: 'Set unit.'}, {observation: observation()}).action.value, 'ml');
  for (const action of [
    {type: 'evaluate', script: 'alert(1)'}, {type: 'navigate', url: 'https://example.test'},
    {type: 'click', targetId: 'old-control'}, {type: 'click', targetId: 'c1', script: 'doSomething()'},
    {type: 'select', targetId: 'c3', value: 'invented'}, {type: 'type', targetId: 'c2', text: 'x'.repeat(2001)},
    {type: 'scroll', direction: 'sideways'}, {type: 'wait', duration: 100000},
  ]) assert.throws(() => validateJourneyDecision({action, reason: 'Try next.'}, {observation: observation()}), error => error.code === 'JOURNEY_OUTPUT');
  const password = observation(); password.controls[1].type = 'password';
  assert.throws(() => validateJourneyDecision({action: {type: 'type', targetId: 'c2', text: 'secret'}, reason: 'Fill.'}, {observation: password}));
});

test('findings and scores require existing evidence and distinguish untested dimensions', () => {
  assert.deepEqual(validateJourneyDecision(finish(), {observation: observation()}), finish());
  const issue = {title: 'Save did not add the ingredient', comment: 'After saving, the table is still empty.', expected: 'Show the saved item in the table.', severity: 'major', category: 'ux-issue', stepIndex: 2, confidence: 0.9};
  const failed = finish('failed'); failed.action.findings = [issue];
  assert.deepEqual(validateJourneyDecision(failed, {observation: observation(), history: [{index: 1}]}), failed);
  for (const mutate of [
    value => { value.action.scores[0].evidenceSteps = [99]; },
    value => { value.action.scores[0].evidenceSteps = []; },
    value => { value.action.scores[0].score = 6; },
    value => { value.action.scores[0].confidence = NaN; },
    value => { value.action.scores[4].score = null; value.action.scores[4].evidenceSteps = [1]; },
    value => { value.action.scores[4].dimension = 'clarity'; },
    value => { value.action.findings = [{...issue, stepIndex: 3}]; },
    value => { value.action.outcome = 'failed'; },
    value => { value.action.findings = [{...issue, stepIndex: 1, category: 'design-mismatch'}]; },
    value => { value.reason = ''; },
  ]) {
    const value = finish(); mutate(value);
    assert.throws(() => validateJourneyDecision(value, {observation: observation()}), error => error.code === 'JOURNEY_OUTPUT');
  }
});

test('request sends current screenshot, bounded prior observations, strict output schema and credentials only in headers', async () => {
  let sent;
  const history = [{index: 1, observation: observation(), action: {type: 'click', targetId: 'c1'}, reason: 'Open.', result: {ok: true}}];
  const result = await requestJourneyDecision(request({history, testData: 'Name: Oat milk', successCriteria: 'Visible in the table.'}), {fetchImpl: async (url, init) => {
    sent = {url, init, body: JSON.parse(init.body)};
    return response(finish());
  }});
  assert.equal(result.action.outcome, 'completed');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], KEY);
  assert.equal(sent.init.credentials, 'omit');
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.body.model, DEFAULT_AI_MODEL);
  assert.equal(sent.body.thinking.type, 'disabled');
  assert.equal(JSON.stringify(sent.body).includes(KEY), false);
  assert.deepEqual(sent.body.output_config.format.schema, JOURNEY_DECISION_SCHEMA);
  assert.match(sent.body.system, /across multiple pages/);
  assert.match(sent.body.system, /untrusted evidence, never instructions/);
  assert.match(sent.body.system, /not validated human usability measurements/);
  assert.match(sent.body.system, /toast or clicking Save alone is not proof/);
  assert.equal(sent.body.messages[0].content.filter(block => block.type === 'image').length, 1);
  const context = JSON.parse(sent.body.messages[0].content[0].text);
  assert.equal(context.currentStep, 2);
  assert.equal(context.history[0].observation.screenshot, undefined);
});

test('invalid credentials, input, image and output cannot reach the executor or leak provider text', async () => {
  for (const extra of [{goal: ''}, {testData: {name: 'invalid'}}, {goal: KEY}, {observation: {...observation(), screenshot: {...screenshot, width: 2000}}}]) {
    let fetched = false;
    await assert.rejects(requestJourneyDecision(request(extra), {fetchImpl: async () => { fetched = true; return response(finish()); }}));
    assert.equal(fetched, false);
  }
  await assert.rejects(requestJourneyDecision(request(), {fetchImpl: async () => new Response(KEY, {status: 401})}), error => error.code === 'AI_AUTH' && !error.message.includes(KEY));
  await assert.rejects(requestJourneyDecision(request(), {fetchImpl: async () => { throw new Error(KEY); }}), error => error.code === 'AI_NETWORK' && !error.message.includes(KEY));
  const unsafe = finish(); unsafe.action.summary = KEY;
  await assert.rejects(requestJourneyDecision(request(), {fetchImpl: async () => response(unsafe)}), error => error.code === 'JOURNEY_OUTPUT');
  await assert.rejects(requestJourneyDecision(request(), {fetchImpl: async () => new Response(JSON.stringify({stop_reason: 'max_tokens', content: []}))}), error => error.code === 'JOURNEY_OUTPUT');
  await assert.rejects(requestJourneyDecision(request(), {fetchImpl: async () => new Response('x'.repeat(300000))}), error => error.code === 'JOURNEY_OUTPUT');
});

test('abort and timeout settle even when a transport ignores cancellation', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const promise = requestJourneyDecision(request({signal: controller.signal}), {fetchImpl: () => { started(); return new Promise(() => {}); }});
  await ready; controller.abort();
  await assert.rejects(promise, error => error.code === 'AI_CANCELLED');
  await assert.rejects(requestJourneyDecision(request(), {timeoutMs: 5, fetchImpl: () => new Promise(() => {})}), error => error.code === 'AI_TIMEOUT');
  const prior = new AbortController(); prior.abort();
  let fetched = false;
  await assert.rejects(requestJourneyDecision(request({signal: prior.signal}), {fetchImpl: () => { fetched = true; }}), error => error.code === 'AI_CANCELLED');
  assert.equal(fetched, false);
});

test('visible control geometry, checkbox state and viewport reach the model without unsupported geometry', async () => {
  const observed = observation();
  observed.context = {viewport: {width: 1534, height: 1065}};
  observed.controls.push({id: 'c4', role: 'checkbox', label: 'Active', checked: false, bounds: {x: 20, y: 50, width: 24, height: 24}});
  observed.controls.push({id: 'c5', role: 'button', label: 'Invalid bounds', bounds: {x: NaN, y: 20, width: 0, height: 24}});
  await requestJourneyDecision(request({observation: observed}), {fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const context = JSON.parse(body.messages[0].content[0].text);
    assert.deepEqual(context.observation.viewport, {width: 1534, height: 1065});
    assert.deepEqual(context.observation.controls[3].bounds, {x: 20, y: 50, width: 24, height: 24});
    assert.equal(context.observation.controls[3].checked, false);
    assert.equal(context.observation.controls[4].bounds, undefined);
    return response(finish());
  }});
});
