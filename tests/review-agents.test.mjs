import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAgentDefinition, REVIEW_AGENT_REVISION, REVIEW_AGENT_MODEL, REVIEW_KNOWLEDGE_REVISION, REVIEW_KNOWLEDGE_RULES, REVIEW_KNOWLEDGE_SOURCES, REVIEW_AGENT_SYSTEM} from '../extension/review-agent-definitions.mjs';
import {readReviewAgent, setupReviewAgent, publicReviewAgentStatus, verifyReviewAgent} from '../extension/review-agent-config.mjs';
import {reviewScreensManaged, validateManagedReview} from '../extension/review-managed.mjs';
import {ManagedAgentError} from '../extension/claude-agents-client.mjs';

const KEY = 'sk-ant-review-fixture-123456789-not-a-real-key';
const OTHER_KEY = 'sk-ant-review-other-account-fixture-not-real';
const REGISTRY = 'diffuseReviewAgent';
const copy = value => structuredClone(value);
const NETWORK = {type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false};
const image = {width: 800, height: 600, dataUrl: 'data:image/png;base64,YWJjZA=='};
const uxRule = REVIEW_KNOWLEDGE_RULES.find(rule => rule.id.startsWith('ux-'));
const nonVisualRule = REVIEW_KNOWLEDGE_RULES.find(rule => rule.verification === 'dom');

function storage() {
  const values = {};
  return {values, async get(key) { return {[key]: copy(values[key])}; }, async set(value) { Object.assign(values, copy(value)); }};
}
function finding(update = {}) {
  return {category: 'ux-issue', title: 'Clarify the primary action', comment: 'The primary action says “Go”.', expected: 'Use a specific action label, then verify the result is understandable.',
    state: 'Current screen', component: 'Primary button', severity: 'minor', mismatchScore: 35, confidence: .8, region: {x: .1, y: .1, width: .2, height: .1}, prototypeRegion: null,
    ruleIds: [uxRule.id], assessment: 'heuristic', ...update};
}
const result = suggestion => ({summary: 'One visible clarity concern.', limitations: ['Only the supplied screen was reviewed.'], suggestions: [suggestion || finding()]});
function fixture() {
  const local = storage(), calls = [], agents = new Map(), environments = new Map();
  let next = 0;
  const record = (method, data = {}) => calls.push({method, ...data});
  const client = {
    async createAgent(definition) {
      record('createAgent', {definition: copy(definition)});
      const agent = {...copy(definition), id: `agent_fixture_${++next}`, version: 1, type: 'agent'};
      agents.set(agent.id, agent); return copy(agent);
    },
    async getAgent(id, options = {}) {
      record('getAgent', {id, options});
      if (!agents.has(id)) throw new ManagedAgentError('AGENT_NOT_FOUND', 'Missing fixture agent', {status: 404});
      return copy(agents.get(id));
    },
    async updateAgent(id, definition, options) {
      record('updateAgent', {id, definition: copy(definition), options});
      const prior = agents.get(id);
      if (prior.version !== options.version) throw new ManagedAgentError('AGENT_CONFLICT', 'Changed version', {status: 409});
      const agent = {...copy(definition), id, version: prior.version + 1, type: 'agent'};
      agents.set(id, agent); return copy(agent);
    },
    async createEnvironment() {
      record('createEnvironment');
      const env = {id: `env_fixture_${++next}`, type: 'environment', config: {type: 'cloud', networking: copy(NETWORK)}};
      environments.set(env.id, env); return copy(env);
    },
    async getEnvironment(id, options) {
      record('getEnvironment', {id, options});
      if (!environments.has(id)) throw new ManagedAgentError('AGENT_NOT_FOUND', 'Missing fixture environment', {status: 404});
      return copy(environments.get(id));
    },
    async createSession(options) { record('createSession', {options}); return {id: 'sesn_fixture_review', type: 'session'}; },
    async sendEvents(id, events, options) { record('sendEvents', {id, events: copy(events), options}); return {data: []}; },
    async waitForTool(id, options) { record('waitForTool', {id, options}); return {toolUseId: 'sevt_result', name: 'review_assessment', input: result()}; },
    async interrupt(id, options) { record('interrupt', {id, options}); },
  };
  return {local, calls, agents, environments, client, async setup() { return setupReviewAgent({apiKey: KEY, storage: local, client}); },
    async run(args = {}, options = {}) { return reviewScreensManaged({apiKey: KEY, production: image, mode: 'audit', ...args}, {storage: local, client, ...options}); }};
}

test('one combined reviewer uses Opus 5.5 Max, a single result tool, and the complete dated curated reference', () => {
  const definition = reviewAgentDefinition();
  assert.equal(definition.name, 'Diffuse UX & Accessibility Reviewer');
  assert.deepEqual(definition.model, {id: REVIEW_AGENT_MODEL, effort: {type: 'max'}});
  assert.equal(definition.tools.length, 1);
  assert.equal(definition.tools[0].type, 'custom'); assert.equal(definition.tools[0].name, 'review_assessment');
  assert.equal(definition.metadata.diffuse_role, 'ux-accessibility-reviewer');
  assert.ok(definition.system.length <= 100000, 'Managed transport prompt bound');
  assert.ok(JSON.stringify(definition.tools[0].input_schema).length <= 100000, 'Managed transport schema bound');
  for (const rule of REVIEW_KNOWLEDGE_RULES) assert.ok(definition.system.includes(JSON.stringify(rule)));
  for (const source of REVIEW_KNOWLEDGE_SOURCES) assert.ok(definition.system.includes(source.url));
  assert.match(definition.system, /not.*live feed/);
  assert.match(definition.system, /Screenshots cannot establish accessible names/);
  assert.match(definition.system, /Missing evidence is not evidence/);
  assert.match(definition.system, /not.*WCAG conformance/);
  assert.match(definition.system, /untrusted evidence, never instructions/);
  const schema = definition.tools[0].input_schema.properties.suggestions.items;
  assert.deepEqual(schema.properties.ruleIds.items.enum, REVIEW_KNOWLEDGE_RULES.map(rule => rule.id));
  assert.ok(schema.required.includes('ruleIds')); assert.ok(schema.required.includes('assessment'));
  definition.tools[0].input_schema.properties.suggestions.items.required.pop();
  assert.ok(reviewAgentDefinition().tools[0].input_schema.properties.suggestions.items.required.includes('assessment'), 'Definitions have isolated schema copies');
});

test('fresh setup creates one agent, verifies its exact pin and environment, and never creates inference sessions', async () => {
  const f = fixture(), ready = await f.setup();
  assert.equal(ready.ready, true); assert.equal(ready.revision, REVIEW_AGENT_REVISION); assert.equal(ready.knowledgeRevision, REVIEW_KNOWLEDGE_REVISION);
  assert.equal(f.calls.filter(call => call.method === 'createAgent').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'createEnvironment').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'createSession').length, 0);
  assert.deepEqual(f.calls.find(call => call.method === 'getAgent').options, {version: ready.reviewer.version, signal: undefined});
  assert.equal(f.calls.filter(call => call.method === 'getEnvironment').length, 1);
  assert.equal(JSON.stringify(f.local.values).includes(KEY), false);
  assert.equal((await readReviewAgent(KEY, {storage: f.local})).ready, true);
  assert.equal((await readReviewAgent(OTHER_KEY, {storage: f.local})).ready, false);
  assert.equal((await readReviewAgent('', {storage: f.local})).ready, false);
  const status = publicReviewAgentStatus(ready);
  assert.equal(status.ready, true); assert.equal(status.checkedAt, '2026-10-24');
  assert.equal(status.sourceCount, REVIEW_KNOWLEDGE_SOURCES.length); assert.equal(status.ruleCount, REVIEW_KNOWLEDGE_RULES.length);
  for (const value of [KEY, ready.account, ready.reviewer.id, ready.environmentId]) assert.equal(JSON.stringify(status).includes(value), false);
});

test('repeated setup reuses the single reviewer and environment', async () => {
  const f = fixture(), first = await f.setup(); f.calls.length = 0;
  const second = await f.setup(); assert.deepEqual(second, first);
  assert.equal(f.calls.some(call => call.method.startsWith('create')), false);
  assert.ok(f.calls.some(call => call.method === 'getAgent' && call.options.version === first.reviewer.version));
});

test('provider-added null geo and standard speed defaults preserve the verified configuration', async () => {
  for (const defaults of [{speed: null, inference_geo: null}, {speed: 'standard'}, {speed: 'standard', inference_geo: null}]) {
    const f = fixture(), saved = await f.setup();
    Object.assign(f.agents.get(saved.reviewer.id).model, defaults);
    assert.equal((await f.setup()).ready, true);
    const result = await f.run(); assert.equal(result.model, REVIEW_AGENT_MODEL);
    assert.equal(f.calls.filter(call => call.method === 'createAgent').length, 1);
  }
});

test('explicit geography, premium speed, changed effort and unknown model configuration remain blocked', async () => {
  for (const change of [{speed: 'fast'}, {inference_geo: 'us'}, {inference_geo: 'global'}, {effort: {type: 'low'}}, {new_setting: null}]) {
    const f = fixture(), saved = await f.setup();
    Object.assign(f.agents.get(saved.reviewer.id).model, change);
    await assert.rejects(f.run(), {code: 'REVIEW_CONFIG_CHANGED'});
    assert.equal(f.calls.filter(call => call.method === 'createSession').length, 0);
  }
});

test('remote prompt, capabilities and environment drift prevent ready status and paid execution', async t => {
  for (const change of ['system', 'tools', 'mcp', 'network']) await t.test(change, async () => {
    const f = fixture(), saved = await f.setup(), agent = f.agents.get(saved.reviewer.id);
    if (change === 'system') agent.system = 'Changed instructions';
    if (change === 'tools') agent.tools.push({type: 'builtin', name: 'bash'});
    if (change === 'mcp') agent.mcp_servers = [{url: 'https://example.test'}];
    if (change === 'network') f.environments.get(saved.environmentId).config.networking.allowed_hosts.push('example.test');
    await assert.rejects(f.run(), {code: 'REVIEW_CONFIG_CHANGED'});
    await assert.rejects(f.setup(), {code: 'REVIEW_CONFIG_CHANGED'});
    assert.equal((await readReviewAgent(KEY, {storage: f.local})).ready, false);
    assert.equal(f.calls.filter(call => call.method === 'createSession').length, 0);
  });
});

test('upgrades preserve the agent ID, use latest optimistic version and recover a lost update response', async () => {
  const f = fixture(), saved = await f.setup();
  f.local.values[REGISTRY].revision = 'older';
  const prior = f.agents.get(saved.reviewer.id); prior.system = 'Old reviewer'; prior.version = 3;
  const update = f.client.updateAgent;
  f.client.updateAgent = async (...args) => { await update(...args); throw new ManagedAgentError('AGENT_NETWORK', 'Lost update response', {ambiguous: true}); };
  await assert.rejects(f.setup(), {code: 'AGENT_NETWORK'});
  assert.equal((await readReviewAgent(KEY, {storage: f.local})).ready, false);
  f.client.updateAgent = update;
  const ready = await f.setup();
  assert.deepEqual(ready.reviewer, {id: saved.reviewer.id, version: 4});
  assert.equal(f.calls.filter(call => call.method === 'createAgent').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'updateAgent').length, 1);
  assert.equal(f.calls.find(call => call.method === 'updateAgent').options.version, 3);
});

test('unconfirmed creation persists a reservation and never creates duplicates on retry', async t => {
  for (const method of ['createAgent', 'createEnvironment']) await t.test(method, async () => {
    const f = fixture(), create = f.client[method];
    f.client[method] = async (...args) => { await create(...args); throw new ManagedAgentError('AGENT_NETWORK', 'Lost creation response', {ambiguous: true}); };
    await assert.rejects(f.setup(), {code: 'REVIEW_SETUP_UNCERTAIN'});
    const before = f.calls.length;
    await assert.rejects(f.setup(), {code: 'REVIEW_SETUP_UNCERTAIN'});
    assert.equal(f.calls.length, before);
    assert.equal((await readReviewAgent(KEY, {storage: f.local})).ready, false);
    assert.match((await readReviewAgent(KEY, {storage: f.local})).reason, /not created a duplicate/);
  });
});

test('a definite environment rejection is resumable without replacing the confirmed reviewer', async () => {
  const f = fixture(), create = f.client.createEnvironment;
  f.client.createEnvironment = async () => { throw new ManagedAgentError('AGENT_RATE_LIMIT', 'Try later', {status: 429}); };
  await assert.rejects(f.setup(), {code: 'AGENT_RATE_LIMIT'});
  const savedId = f.local.values[REGISTRY].reviewer.id;
  assert.equal(f.local.values[REGISTRY].pendingCreation, undefined);
  f.client.createEnvironment = create;
  const ready = await f.setup(); assert.equal(ready.reviewer.id, savedId);
  assert.equal(f.calls.filter(call => call.method === 'createAgent').length, 1);
});

test('a changed key provisions isolated reviewer resources', async () => {
  const f = fixture(), first = await f.setup();
  const second = await setupReviewAgent({apiKey: OTHER_KEY, storage: f.local, client: f.client});
  assert.notEqual(second.reviewer.id, first.reviewer.id); assert.notEqual(second.environmentId, first.environmentId);
  assert.notEqual(second.account, first.account); assert.equal((await readReviewAgent(KEY, {storage: f.local})).ready, false);
});

test('run uses the verified reviewer pin and bounded session budget, returns controlled citations, and interrupts without another paid turn', async () => {
  const f = fixture(), ready = await f.setup(); f.calls.length = 0;
  const output = await f.run({budgetUsd: 1.25});
  assert.equal(output.model, REVIEW_AGENT_MODEL); assert.equal(output.mode, 'audit'); assert.equal(output.checkedAt, '2026-10-24');
  assert.equal(output.knowledgeRevision, REVIEW_KNOWLEDGE_REVISION); assert.equal(output.sessionId, 'sesn_fixture_review');
  const create = f.calls.find(call => call.method === 'createSession');
  assert.equal(create.options.budgetUsd, 1.25); assert.equal(create.options.agentId, ready.reviewer.id); assert.equal(create.options.agentVersion, ready.reviewer.version);
  assert.equal(create.options.environmentId, ready.environmentId);
  assert.ok(f.calls.findIndex(call => call.method === 'getEnvironment') < f.calls.indexOf(create));
  const sends = f.calls.filter(call => call.method === 'sendEvents'); assert.equal(sends.length, 1);
  assert.equal(sends[0].events[0].type, 'user.message'); assert.ok(sends[0].events[0].content.some(block => block.type === 'image'));
  assert.equal(JSON.stringify(sends).includes(KEY), false);
  assert.equal(f.calls.at(-1).method, 'interrupt'); assert.equal(f.calls.at(-1).options.signal.aborted, false);
  const expectedSources = uxRule.sourceIds.map(id => { const source = REVIEW_KNOWLEDGE_SOURCES.find(item => item.id === id); return {title: source.title, url: source.url}; });
  assert.deepEqual(output.suggestions[0].sources, expectedSources);
  assert.match(output.limitations.at(-1), /not a WCAG conformance audit/);
});

test('invalid credentials, images, budgets and limits never create paid sessions', async () => {
  for (const args of [{apiKey: 'bad'}, {production: {width: 9000, height: 600, dataUrl: image.dataUrl}}, {budgetUsd: 0}, {budgetUsd: 20.01}, {budgetUsd: .125}, {instructions: KEY}, {designReference: {url: `https://example.test/${KEY}`, text: 'Design context', images: []}}]) {
    const f = fixture(); await f.setup(); await assert.rejects(f.run(args));
    assert.equal(f.calls.filter(call => call.method === 'createSession').length, 0);
  }
  const f = fixture(); await f.setup(); await assert.rejects(f.run({}, {timeoutMs: 240001}), {code: 'AI_CONFIG'});
});

test('unconfigured reviewer does not provision itself or fall back to another API', async () => {
  const f = fixture(); await assert.rejects(f.run(), {code: 'REVIEW_SETUP'}); assert.deepEqual(f.calls, []);
});

test('unknown or malformed rule citations, unsupported fields and invalid review shape are rejected', async t => {
  for (const update of [{ruleIds: ['https://evil.test/claim']}, {ruleIds: []}, {ruleIds: [uxRule.id, uxRule.id]}, {ruleIds: [null]}, {assessment: 'WCAG-passed'}, {sources: [{url: 'https://evil.test'}]}, {confidence: 2}]) await t.test(JSON.stringify(update), async () => {
    assert.throws(() => validateManagedReview(result(finding(update)), 'audit'), {code: 'AI_OUTPUT'});
  });
  assert.throws(() => validateManagedReview({...result(), extra: 'unexpected'}, 'audit'), {code: 'AI_OUTPUT'});
  assert.throws(() => validateManagedReview(result(finding({comment: KEY})), 'audit', {apiKey: KEY}), {code: 'AI_OUTPUT'});
});

test('missing nonvisual evidence remains unverified; UX inference cannot become an observed result', () => {
  assert.ok(nonVisualRule);
  const nonvisual = validateManagedReview(result(finding({ruleIds: [nonVisualRule.id], assessment: 'observed'})), 'audit');
  assert.equal(nonvisual.suggestions[0].assessment, 'needs-verification');
  const heuristic = validateManagedReview(result(finding({assessment: 'observed'})), 'audit');
  assert.equal(heuristic.suggestions[0].assessment, 'heuristic');
  const reference = validateManagedReview(result(finding({category: 'design-mismatch', ruleIds: [], assessment: 'observed'})), 'comparison');
  assert.equal(reference.suggestions[0].assessment, 'observed'); assert.deepEqual(reference.suggestions[0].sources, []);
});

test('malformed agent output interrupts the session and does not start another inference', async () => {
  const f = fixture(); await f.setup();
  f.client.waitForTool = async () => ({name: 'review_assessment', input: result(finding({ruleIds: ['not-in-library']}))});
  await assert.rejects(f.run(), {code: 'AI_OUTPUT'});
  assert.equal(f.calls.filter(call => call.method === 'interrupt').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'createSession').length, 1);
});

test('unknown session creation is reported without an automatic paid retry', async () => {
  const f = fixture(); await f.setup(); let creates = 0;
  f.client.createSession = async () => { creates++; throw new ManagedAgentError('AGENT_NETWORK', 'Lost session response', {ambiguous: true}); };
  await assert.rejects(f.run(), {code: 'REVIEW_SESSION_UNCERTAIN'});
  assert.equal(creates, 1); assert.equal(f.calls.some(call => call.method === 'sendEvents'), false);
});

test('server error during creation keeps uncertainty explicit even without a transport ambiguity marker', async () => {
  const f = fixture(); await f.setup(); let creates = 0;
  f.client.createSession = async () => { creates++; throw new ManagedAgentError('AGENT_SERVICE', 'Server failure', {status: 503}); };
  await assert.rejects(f.run(), {code: 'REVIEW_SESSION_UNCERTAIN'});
  assert.equal(creates, 1);
});

test('cancelled-before-start requests perform no remote work', async () => {
  const f = fixture(); await f.setup(); f.calls.length = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({signal: controller.signal}), {code: 'AI_CANCELLED'}); assert.deepEqual(f.calls, []);
});

test('cancellation during inference interrupts using a fresh cleanup signal', async () => {
  const f = fixture(); await f.setup(); const controller = new AbortController();
  f.client.waitForTool = async () => { controller.abort(); return new Promise(() => {}); };
  await assert.rejects(f.run({signal: controller.signal}), {code: 'AI_CANCELLED'});
  const cleanup = f.calls.find(call => call.method === 'interrupt'); assert.ok(cleanup); assert.equal(cleanup.options.signal.aborted, false);
});

test('a timeout stops polling and interrupts the paid session', async () => {
  const f = fixture(); await f.setup(); f.client.waitForTool = async () => new Promise(() => {});
  await assert.rejects(f.run({}, {timeoutMs: 30}), {code: 'AI_TIMEOUT'});
  assert.equal(f.calls.filter(call => call.method === 'interrupt').length, 1);
});

test('a late session response after cancellation is interrupted without delivering screenshots', async () => {
  const f = fixture(); await f.setup(); const controller = new AbortController(); let resolveCreation;
  f.client.createSession = async () => { controller.abort(); return new Promise(resolve => { resolveCreation = resolve; }); };
  await assert.rejects(f.run({signal: controller.signal}), {code: 'AI_CANCELLED'});
  resolveCreation({id: 'sesn_late_fixture'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'interrupt').length, 1);
  assert.equal(f.calls.find(call => call.method === 'interrupt').id, 'sesn_late_fixture');
  assert.equal(f.calls.filter(call => call.method === 'sendEvents').length, 0);
});

test('provider failures are sanitized and still interrupt a created session', async () => {
  const f = fixture(); await f.setup();
  f.client.sendEvents = async () => { throw new Error(`Untrusted provider text ${KEY}`); };
  const error = await f.run().then(() => assert.fail('Expected failure'), cause => cause);
  assert.equal(error.code, 'AI_SERVICE'); assert.equal(error.message.includes(KEY), false);
  assert.equal(f.calls.filter(call => call.method === 'interrupt').length, 1);
});
