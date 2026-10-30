import test from 'node:test';
import assert from 'node:assert/strict';
import {agentAccountFingerprint, readJourneyAgents, setupJourneyAgents, publicJourneyAgentsStatus} from '../extension/journey-agent-config.mjs';
import {JOURNEY_AGENT_REVISION, JOURNEY_AGENT_MODEL} from '../extension/journey-agent-definitions.mjs';
import {createManagedAgentsClient, ManagedAgentError} from '../extension/claude-agents-client.mjs';

const KEY = 'sk-ant-first-account-fixture-not-real';
const OTHER_KEY = 'sk-ant-second-account-fixture-not-real';
const REGISTRY = 'diffuseJourneyAgents';
const LOCKED_NETWORK = {type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false};
function storage() {
  const values = {};
  return {
    values,
    async get(key) { return {[key]: structuredClone(values[key])}; },
    async set(value) { Object.assign(values, structuredClone(value)); },
  };
}
function fakeClient() {
  const calls = [], agents = new Map(), environments = new Map();
  let next = 0;
  const client = {
    calls, agents, environments,
    async createAgent(definition, options = {}) {
      calls.push({method: 'createAgent', definition: structuredClone(definition), options});
      const value = {...structuredClone(definition), id: `agent_fixture_${++next}`, type: 'agent', version: 1};
      agents.set(value.id, value); return structuredClone(value);
    },
    async getAgent(id, options = {}) {
      calls.push({method: 'getAgent', id, options});
      if (!agents.has(id)) throw new ManagedAgentError('AGENT_NOT_FOUND', 'Missing test agent', {status: 404});
      return structuredClone(agents.get(id));
    },
    async updateAgent(id, definition, options = {}) {
      calls.push({method: 'updateAgent', id, definition: structuredClone(definition), options});
      const current = agents.get(id);
      if (!current) throw new ManagedAgentError('AGENT_NOT_FOUND', 'Missing test agent', {status: 404});
      if (current.version !== options.version) throw new ManagedAgentError('AGENT_CONFLICT', 'Version changed', {status: 409});
      const value = {...structuredClone(definition), id, type: 'agent', version: current.version + 1};
      agents.set(id, value); return structuredClone(value);
    },
    async createEnvironment(options = {}) {
      calls.push({method: 'createEnvironment', options});
      const value = {id: `env_fixture_${++next}`, type: 'environment', config: {type: 'cloud', networking: LOCKED_NETWORK}};
      environments.set(value.id, value); return structuredClone(value);
    },
    async getEnvironment(id, options = {}) {
      calls.push({method: 'getEnvironment', id, options});
      if (!environments.has(id)) throw new ManagedAgentError('AGENT_NOT_FOUND', 'Missing test environment', {status: 404});
      return structuredClone(environments.get(id));
    },
    async createSession() { assert.fail('Agent setup must never start a paid inference session'); },
  };
  return client;
}
const creates = client => client.calls.filter(call => call.method === 'createAgent');

test('fresh setup creates only actor, evaluator and locked environment with Opus 5.5 Max', async () => {
  const local = storage(), calls = [];
  const client = createManagedAgentsClient({apiKey: KEY, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({url, method: init.method, body});
    if (url.endsWith('/agents')) return new Response(JSON.stringify({id: `agent_fixture_${calls.length}`, type: 'agent', version: 2}));
    if (url.endsWith('/environments')) return new Response(JSON.stringify({id: 'env_fixture', type: 'environment'}));
    assert.fail(`Provisioning attempted an unexpected API: ${url}`);
  }});
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.ready, true);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(call => call.url.endsWith('/agents')).length, 2);
  for (const call of calls.slice(0, 2)) {
    assert.deepEqual(call.body.model, {id: 'claude-opus-5-5', effort: {type: 'max'}});
    assert.ok(call.body.tools.every(tool => tool.type === 'custom'));
    assert.deepEqual(call.body.mcp_servers, []); assert.deepEqual(call.body.skills, []); assert.equal(call.body.multiagent, null);
    assert.equal(call.body.metadata.diffuse_revision, JOURNEY_AGENT_REVISION);
  }
  assert.equal(calls[0].body.metadata.diffuse_role, 'journey-user');
  assert.equal(calls[1].body.metadata.diffuse_role, 'evaluator');
  assert.deepEqual(calls[2].body.config, {type: 'cloud', networking: LOCKED_NETWORK});
  assert.equal(ready.actor.version, 2); assert.equal(ready.evaluator.version, 2);
  assert.equal(ready.model, JOURNEY_AGENT_MODEL);
  assert.equal(JSON.stringify(local.values).includes(KEY), false);
  assert.equal(JSON.stringify(calls).includes(KEY), false);
});

test('fingerprints bind setup to a key without exposing the key in public readiness', async () => {
  const fingerprint = await agentAccountFingerprint(KEY);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await agentAccountFingerprint(`  ${KEY}  `), fingerprint);
  assert.notEqual(await agentAccountFingerprint(OTHER_KEY), fingerprint);
  const local = storage(), client = fakeClient();
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.deepEqual(publicJourneyAgentsStatus(ready), {ready: true, model: 'claude-opus-5-5', effort: 'max', reason: ''});
  const publicText = JSON.stringify(publicJourneyAgentsStatus(ready));
  for (const privateValue of [KEY, fingerprint, ready.actor.id, ready.evaluator.id, ready.environmentId]) assert.equal(publicText.includes(privateValue), false);
});

test('readiness checks are local and never contact Claude or create sessions', async () => {
  const local = storage(), client = fakeClient();
  assert.equal((await readJourneyAgents('', {storage: local})).ready, false);
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  await setupJourneyAgents({apiKey: KEY, storage: local, client});
  const originalFetch = globalThis.fetch, originalCalls = client.calls.length;
  globalThis.fetch = async () => assert.fail('Reading agent readiness must stay local');
  try {
    assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, true);
    assert.equal((await readJourneyAgents(OTHER_KEY, {storage: local})).ready, false);
    local.values[REGISTRY].revision = 'outdated-definition';
    assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
    assert.equal(client.calls.length, originalCalls);
  } finally { globalThis.fetch = originalFetch; }
});

test('repeated setup revalidates both pinned agents and environment without duplicating them', async () => {
  const local = storage(), client = fakeClient(), signal = new AbortController().signal;
  const first = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  client.calls.length = 0;
  const second = await setupJourneyAgents({apiKey: KEY, storage: local, client, signal});
  assert.deepEqual(second, first);
  assert.equal(creates(client).length, 0);
  assert.equal(client.calls.some(call => call.method === 'createEnvironment'), false);
  const agentReads = client.calls.filter(call => call.method === 'getAgent');
  assert.deepEqual(agentReads.map(call => ({id: call.id, version: call.options.version})), [{id: first.actor.id, version: first.actor.version}, {id: first.evaluator.id, version: first.evaluator.version}]);
  assert.ok(agentReads.every(call => call.options.signal === signal));
  const environmentRead = client.calls.find(call => call.method === 'getEnvironment');
  assert.equal(environmentRead.id, first.environmentId); assert.equal(environmentRead.options.signal, signal);
});

test('partial setup recovers a saved actor after evaluator creation fails', async () => {
  const local = storage(), client = fakeClient(), create = client.createAgent;
  let failEvaluator = true;
  client.createAgent = async function (definition, options) {
    if (definition.metadata.diffuse_role === 'evaluator' && failEvaluator) {
      failEvaluator = false; throw new ManagedAgentError('AGENT_RATE_LIMIT', 'Retry after rate limit', {status: 429});
    }
    return create.call(this, definition, options);
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_RATE_LIMIT'});
  const actorId = local.values[REGISTRY].actor.id;
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.ready, true); assert.equal(ready.actor.id, actorId);
  assert.equal(creates(client).filter(call => call.definition.metadata.diffuse_role === 'journey-user').length, 1);
  assert.equal(creates(client).filter(call => call.definition.metadata.diffuse_role === 'evaluator').length, 1);
  assert.ok(client.calls.some(call => call.method === 'getAgent' && call.id === actorId));
});

test('partial environment failure reuses both saved agents on retry', async () => {
  const local = storage(), client = fakeClient(), create = client.createEnvironment;
  let failOnce = true;
  client.createEnvironment = async function (options) {
    if (failOnce) { failOnce = false; throw new ManagedAgentError('AGENT_UNAVAILABLE', 'Try again later', {status: 503}); }
    return create.call(this, options);
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_UNAVAILABLE'});
  const {actor, evaluator} = local.values[REGISTRY];
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.ready, true); assert.deepEqual(ready.actor, actor); assert.deepEqual(ready.evaluator, evaluator);
  assert.equal(creates(client).length, 2);
});

test('a changed key provisions isolated resources', async () => {
  const local = storage(), client = fakeClient();
  const first = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  const second = await setupJourneyAgents({apiKey: OTHER_KEY, storage: local, client});
  assert.notEqual(second.actor.id, first.actor.id); assert.notEqual(second.evaluator.id, first.evaluator.id); assert.notEqual(second.environmentId, first.environmentId);
  assert.notEqual(second.account, first.account);
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  assert.equal((await readJourneyAgents(OTHER_KEY, {storage: local})).ready, true);
  assert.equal(creates(client).length, 4);
  assert.equal(client.calls.filter(call => call.method.startsWith('get')).length, 0, 'Resources belonging to another key/revision are not looked up');
});

async function oldRegistry(revision = 'diffuse-journeys-2') {
  const local = storage(), client = fakeClient();
  const old = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  local.values[REGISTRY].revision = revision;
  local.values[REGISTRY].model = 'claude-fable-5';
  for (const role of ['actor', 'evaluator']) {
    const agent = client.agents.get(old[role].id);
    agent.model.id = 'claude-fable-5';
    agent.metadata.diffuse_revision = revision;
    agent.system = `Old ${role} instructions`;
  }
  client.calls.length = 0;
  return {local, client, old: {...old, revision, model: 'claude-fable-5'}, revision};
}

test('a definition upgrade keeps agent IDs, preserves historical pins and uses the latest version', async () => {
  const {local, client, old, revision} = await oldRegistry();
  client.agents.get(old.actor.id).version = 5;
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  assert.equal((await readJourneyAgents(KEY, {storage: local, revision})).ready, true);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.revision, JOURNEY_AGENT_REVISION);
  assert.equal(ready.ready, true);
  assert.equal(ready.model, 'claude-opus-5-5');
  assert.deepEqual(ready.actor, {id: old.actor.id, version: 6});
  assert.deepEqual(ready.evaluator, {id: old.evaluator.id, version: 2});
  assert.equal(ready.environmentId, old.environmentId);
  assert.equal(creates(client).length, 0);
  const updates = client.calls.filter(call => call.method === 'updateAgent');
  assert.deepEqual(updates.map(call => call.options.version), [5, 1]);
  assert.ok(client.calls.filter(call => call.method === 'getAgent').every(call => call.options.version === undefined));
  const historical = await readJourneyAgents(KEY, {storage: local, revision});
  assert.equal(historical.ready, true);
  assert.deepEqual(historical.actor, old.actor);
  assert.deepEqual(historical.evaluator, old.evaluator);
  assert.equal(historical.environmentId, old.environmentId);
  assert.equal(historical.revision, revision);
  assert.equal(historical.model, 'claude-fable-5');
  assert.equal(publicJourneyAgentsStatus(historical).model, 'claude-fable-5');
  assert.deepEqual(updates.map(call => call.definition.model), [
    {id: 'claude-opus-5-5', effort: {type: 'max'}}, {id: 'claude-opus-5-5', effort: {type: 'max'}},
  ]);
  assert.equal((await readJourneyAgents(OTHER_KEY, {storage: local, revision})).ready, false);
  assert.equal(JSON.stringify(local.values).includes(KEY), false);
});

test('historical revision one and two registries retain their original model when an older record omitted it', async () => {
  for (const revision of ['diffuse-journeys-1', 'diffuse-journeys-2']) {
    const {local, client, old} = await oldRegistry(revision);
    delete local.values[REGISTRY].model;
    assert.equal((await readJourneyAgents(KEY, {storage: local, revision})).model, 'claude-fable-5');
    await setupJourneyAgents({apiKey: KEY, storage: local, client});
    const historical = await readJourneyAgents(KEY, {storage: local, revision});
    assert.equal(historical.model, 'claude-fable-5');
    assert.deepEqual(historical.actor, old.actor); assert.deepEqual(historical.evaluator, old.evaluator);
    assert.equal((await readJourneyAgents(KEY, {storage: local})).model, 'claude-opus-5-5');
  }
});

test('a partial role upgrade stays unavailable and retries only the remaining role', async () => {
  const {local, client, old, revision} = await oldRegistry();
  const update = client.updateAgent; let once = true;
  client.updateAgent = async function (id, definition, options) {
    if (id === old.evaluator.id && once) { once = false; throw new ManagedAgentError('AGENT_RATE_LIMIT', 'Try later', {status: 429}); }
    return update.call(this, id, definition, options);
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_RATE_LIMIT'});
  assert.equal(local.values[REGISTRY].revision, revision, 'Do not mark the mixed registry current.');
  assert.equal(local.values[REGISTRY].pendingRevision, JOURNEY_AGENT_REVISION);
  assert.equal(local.values[REGISTRY].actor.version, 2);
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  assert.deepEqual((await readJourneyAgents(KEY, {storage: local, revision})).actor, old.actor);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.ready, true);
  assert.equal(ready.actor.version, 2);
  assert.equal(ready.evaluator.version, 2);
  assert.equal(ready.pendingRevision, undefined);
  assert.equal(client.calls.filter(call => call.method === 'updateAgent' && call.id === old.actor.id).length, 1);
  assert.equal(creates(client).length, 0);
});

test('a lost update acknowledgement recovers the existing version without applying another update', async () => {
  const {local, client, old} = await oldRegistry();
  const update = client.updateAgent; let once = true;
  client.updateAgent = async function (id, definition, options) {
    const result = await update.call(this, id, definition, options);
    if (id === old.actor.id && once) { once = false; throw new ManagedAgentError('AGENT_NETWORK', 'Response lost', {ambiguous: true}); }
    return result;
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_NETWORK'});
  assert.equal(local.values[REGISTRY].actor.version, 1);
  assert.equal(client.agents.get(old.actor.id).version, 2);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.actor.version, 2);
  assert.equal(client.calls.filter(call => call.method === 'updateAgent' && call.id === old.actor.id).length, 1);
  assert.equal(creates(client).length, 0);
});

test('an upgrade version conflict is surfaced without automatic retry or replacing the agent', async () => {
  const {local, client, old} = await oldRegistry();
  const update = client.updateAgent; let once = true;
  client.updateAgent = async function (id, definition, options) {
    if (once) { once = false; client.agents.get(id).version++; }
    return update.call(this, id, definition, options);
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_CONFLICT'});
  assert.equal(client.calls.filter(call => call.method === 'updateAgent').length, 1);
  assert.equal(local.values[REGISTRY].actor.id, old.actor.id);
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.actor.version, 3);
  assert.equal(creates(client).length, 0);
});

test('the upgraded revision is not ready until its existing environment is checked', async () => {
  const {local, client, old, revision} = await oldRegistry();
  const read = client.getEnvironment; let once = true;
  client.getEnvironment = async function (id, options) {
    if (once) { once = false; throw new ManagedAgentError('AGENT_UNAVAILABLE', 'Try later', {status: 503}); }
    return read.call(this, id, options);
  };
  await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_UNAVAILABLE'});
  assert.equal(local.values[REGISTRY].revision, revision);
  assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
  assert.deepEqual((await readJourneyAgents(KEY, {storage: local, revision})).evaluator, old.evaluator);
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.equal(ready.ready, true);
  assert.equal(client.calls.filter(call => call.method === 'updateAgent').length, 2);
  assert.equal(ready.environmentId, old.environmentId);
});

test('a confirmed missing agent replaces only that role and keeps the other resource IDs', async () => {
  for (const role of ['actor', 'evaluator']) {
    const local = storage(), client = fakeClient();
    const first = await setupJourneyAgents({apiKey: KEY, storage: local, client});
    client.agents.delete(first[role].id); client.calls.length = 0;
    const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
    assert.equal(ready.ready, true); assert.notEqual(ready[role].id, first[role].id);
    const retained = role === 'actor' ? 'evaluator' : 'actor';
    assert.deepEqual(ready[retained], first[retained]); assert.equal(ready.environmentId, first.environmentId);
    assert.equal(creates(client).length, 1);
    assert.equal(client.calls.some(call => call.method === 'createEnvironment'), false);
  }
});

test('a confirmed missing environment is replaced without duplicating agents', async () => {
  const local = storage(), client = fakeClient();
  const first = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  client.environments.delete(first.environmentId); client.calls.length = 0;
  const ready = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.notEqual(ready.environmentId, first.environmentId); assert.deepEqual(ready.actor, first.actor); assert.deepEqual(ready.evaluator, first.evaluator);
  assert.equal(creates(client).length, 0); assert.equal(client.calls.filter(call => call.method === 'createEnvironment').length, 1);
});

test('non-404 validation failures preserve stored IDs and do not create replacements', async () => {
  for (const method of ['getAgent', 'getEnvironment']) {
    const local = storage(), client = fakeClient();
    await setupJourneyAgents({apiKey: KEY, storage: local, client});
    const before = structuredClone(local.values);
    client.calls.length = 0;
    client[method] = async () => { throw new ManagedAgentError('AGENT_ACCESS', 'Workspace access denied', {status: 403}); };
    await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_ACCESS'});
    assert.deepEqual(local.values, before);
    assert.equal(creates(client).length, 0); assert.equal(client.calls.some(call => call.method === 'createEnvironment'), false);
  }
});

test('concurrent setup cannot duplicate definitions while the first creation is pending', async () => {
  const local = storage(), client = fakeClient(), create = client.createAgent;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  client.createAgent = async function (definition, options) {
    if (first) { first = false; enter(); await gate; }
    return create.call(this, definition, options);
  };
  const running = setupJourneyAgents({apiKey: KEY, storage: local, client});
  await entered;
  try { await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), /already in progress/); }
  finally { release(); }
  assert.equal((await running).ready, true);
  assert.equal(creates(client).length, 2);
  assert.equal(client.calls.filter(call => call.method === 'createEnvironment').length, 1);
});

test('missing resource IDs are cleared before a failed replacement so local readiness stays false', async () => {
  for (const resource of ['actor', 'environment']) {
    const local = storage(), client = fakeClient();
    const first = await setupJourneyAgents({apiKey: KEY, storage: local, client});
    if (resource === 'actor') {
      client.agents.delete(first.actor.id);
      client.createAgent = async () => { throw new ManagedAgentError('AGENT_UNAVAILABLE', 'Creation is unavailable', {status: 503}); };
    } else {
      client.environments.delete(first.environmentId);
      client.createEnvironment = async () => { throw new ManagedAgentError('AGENT_UNAVAILABLE', 'Creation is unavailable', {status: 503}); };
    }
    await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), {code: 'AGENT_UNAVAILABLE'});
    assert.equal(local.values[REGISTRY][resource === 'actor' ? 'actor' : 'environmentId'], undefined);
    assert.equal((await readJourneyAgents(KEY, {storage: local})).ready, false);
    assert.deepEqual(local.values[REGISTRY].evaluator, first.evaluator);
  }
});

test('changed model, effort or environment permissions fail closed without overwriting registry', async () => {
  for (const change of [
    (client, saved) => { client.agents.get(saved.actor.id).model.id = 'claude-other-model'; },
    (client, saved) => { client.agents.get(saved.evaluator.id).model.effort.type = 'low'; },
    (client, saved) => { client.environments.get(saved.environmentId).config.networking = {...LOCKED_NETWORK, allowed_hosts: ['example.test']}; },
  ]) {
    const local = storage(), client = fakeClient();
    const saved = await setupJourneyAgents({apiKey: KEY, storage: local, client});
    const before = structuredClone(local.values); change(client, saved); client.calls.length = 0;
    await assert.rejects(setupJourneyAgents({apiKey: KEY, storage: local, client}), /configuration has changed|archived/);
    assert.deepEqual(local.values, before);
    assert.equal(client.calls.some(call => call.method.startsWith('create')), false);
  }
});

test('explicit setup replaces an archived definition without changing its historical resources', async () => {
  const local = storage(), client = fakeClient();
  const saved = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  client.agents.get(saved.actor.id).archived_at = '2026-10-24T10:00:00Z';
  client.calls.length = 0;
  const updated = await setupJourneyAgents({apiKey: KEY, storage: local, client});
  assert.notEqual(updated.actor.id, saved.actor.id);
  assert.deepEqual(updated.evaluator, saved.evaluator);
  assert.equal(updated.environmentId, saved.environmentId);
  assert.equal(creates(client).length, 1);
  assert.ok(client.agents.get(saved.actor.id).archived_at);
});
