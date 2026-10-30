import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAIAgentsClient, openAIAgentDefinition, conservativeOpenAICost, pinOpenAIAgent, openAIAgentAccountFingerprint, OPENAI_AGENT_MODEL} from '../extension/openai-agents-client.mjs';
import {setupOpenAIJourneyAgents, setupOpenAIReviewAgent, readOpenAIJourneyAgents, readOpenAIReviewAgent, verifyOpenAIReviewAgent, publicOpenAIReviewAgentStatus, openAIJourneyAgentDefinitions, openAIReviewAgentDefinition, OPENAI_JOURNEY_AGENT_REVISION} from '../extension/openai-agent-config.mjs';

const apiKey = 'sk-test-openai-private-fixture-only';
const text = value => [{type: 'text', text: value}];
const usage = (input = 100, output = 30) => ({input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: output}});
const memory = () => {
  const data = {};
  return {data, async get(key) { return {[key]: structuredClone(data[key])}; }, async set(values) { Object.assign(data, structuredClone(values)); }};
};
function api() {
  const requests = [], agents = new Map(), sessions = new Map(); let sequence = 0, eventFailure = null, creationFailure = null;
  const response = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace(/^\/v1/, ''), body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({path, ...options, body});
    if (path === '/agents' && options.method === 'POST') {
      if (creationFailure) throw creationFailure;
      const value = {id: `agent_${++sequence}`, object: 'agent', ...body}; agents.set(value.id, value); return response(value);
    }
    if (/^\/agents\/agent_/.test(path)) {
      const value = agents.get(path.split('/').at(-1)); return value ? response(value) : new Response('{}', {status: 404});
    }
    if (path === '/agents/sessions') {
      const value = {id: `sess_${++sequence}`, object: 'agent.session', agent: {id: body.agent_id, name: agents.get(body.agent_id).name, ...body.agent}, environment: body.environment, vault_ids: body.vault_ids,
        status: 'in_progress', required_actions: [], usage: usage(), metadata: body.metadata};
      sessions.set(value.id, value); return response(value);
    }
    const id = path.split('/')[3], session = sessions.get(id);
    if (!session) return new Response('{}', {status: 404});
    if (path.endsWith('/events')) {
      if (eventFailure && body.events[0].type !== 'agent.session.input.cancel') throw eventFailure;
      session.status = body.events[0].type === 'agent.session.input.cancel' ? 'idle' : 'in_progress'; session.required_actions = [];
      return new Response(null, {status: 204});
    }
    return response(session);
  };
  return {requests, agents, sessions, fetchImpl, failEvents(value) { eventFailure = value; }, failCreation(value) { creationFailure = value; }};
}
async function connected() {
  const storage = memory(), remote = api(), client = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl, pollIntervalMs: 1});
  const definition = openAIJourneyAgentDefinitions().actor, agent = await client.createAgent(definition);
  return {storage, remote, client, agent, definition};
}
async function running({budgetUsd = 1} = {}) {
  const value = await connected();
  const session = await value.client.createSession({agentId: value.agent.id, budgetUsd, initialContent: text('Use the visible interface for this task.')});
  return {...value, session, raw: value.remote.sessions.get(session.id)};
}
function action(raw, {call = 'call_1', turn = 'turn_1', name = 'journey_step', input = {action: {type: 'click', targetId: 'c1'}}} = {}) {
  raw.status = 'requires_action'; raw.required_actions = [{type: 'function_call', turn_id: turn, call_id: call, name, arguments: input}];
}
const code = expected => error => error.name === 'ManagedAgentError' && error.code === expected;

test('OpenAI definitions retain actor/evaluator/reviewer prompts and schemas, with no hosted tools', () => {
  const definitions = {...openAIJourneyAgentDefinitions(), reviewer: openAIReviewAgentDefinition()};
  for (const definition of Object.values(definitions)) {
    const result = openAIAgentDefinition(definition);
    assert.equal(result.model, OPENAI_AGENT_MODEL); assert.equal(result.reasoning.effort, 'max'); assert.equal(result.service_tier, 'default');
    assert.deepEqual(result.multi_agent, {enabled: false}); assert.equal(result.instructions, definition.system);
    assert.deepEqual(result.tools.at(-1), {type: 'programmatic_tool_calling', enabled: false});
    assert.deepEqual(result.tools[0].parameters, definition.tools[0].input_schema);
    assert.equal(result.tools[0].defer_loading, false);
  }
  const bad = openAIJourneyAgentDefinitions().actor; bad.tools.push({type: 'web_search'});
  assert.throws(() => openAIAgentDefinition(bad), code('AGENT_CONFIG'));
});

test('setup creates visible OpenAI agents only, persists independent account/provider pins and rechecks idempotently', async () => {
  const storage = memory(), remote = api(), client = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl});
  const journey = await setupOpenAIJourneyAgents({apiKey, storage, client}), review = await setupOpenAIReviewAgent({apiKey, storage, client});
  assert.equal(journey.ready, true); assert.equal(journey.provider, 'openai'); assert.equal(journey.environmentId, 'none');
  assert.deepEqual(journey.actor, {id: 'agent_1', version: 1}); assert.equal(journey.revision, OPENAI_JOURNEY_AGENT_REVISION);
  assert.equal(review.ready, true); assert.equal(remote.agents.size, 3); assert.equal(remote.sessions.size, 0);
  assert.deepEqual([...remote.agents.values()].map(value => value.name), ['Diffuse Journey User', 'Diffuse Journey Evaluator', 'Diffuse UX & Accessibility Reviewer']);
  assert.equal((await readOpenAIJourneyAgents(apiKey, {storage})).ready, true);
  assert.equal((await readOpenAIReviewAgent(apiKey, {storage})).ready, true);
  assert.equal((await readOpenAIJourneyAgents(`${apiKey}-different`, {storage})).ready, false);
  const publicStatus = publicOpenAIReviewAgentStatus(review);
  assert.equal(publicStatus.spendingGuard, 'estimate'); assert.ok(publicStatus.sourceCount > 0); assert.equal(publicStatus.reviewer, undefined);
  await setupOpenAIJourneyAgents({apiKey, storage, client}); await setupOpenAIReviewAgent({apiKey, storage, client});
  assert.equal(remote.requests.filter(value => value.method === 'POST').length, 3);
  assert.ok(Object.keys(storage.data).filter(key => key.startsWith('diffuseOpenAIAgentPin:')).length === 3);
  assert.equal(JSON.stringify(storage.data).includes(apiKey), false);
});

test('unknown agent creation is durably reserved and never blindly retried', async () => {
  const storage = memory(), remote = api(); remote.failCreation(new Error('Network disappeared'));
  const client = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl});
  await assert.rejects(setupOpenAIJourneyAgents({apiKey, storage, client}), code('AGENT_SETUP_UNCERTAIN'));
  remote.failCreation(null);
  await assert.rejects(setupOpenAIJourneyAgents({apiKey, storage, client}), code('AGENT_SETUP_UNCERTAIN'));
  assert.equal(remote.requests.length, 1); assert.equal((await readOpenAIJourneyAgents(apiKey, {storage})).ready, false);
});

test('agent changes cannot silently broaden capabilities or replace immutable pins', async () => {
  const storage = memory(), remote = api(), client = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl});
  const saved = await setupOpenAIReviewAgent({apiKey, storage, client});
  remote.agents.get(saved.reviewer.id).tools.push({type: 'web_search'});
  await assert.rejects(verifyOpenAIReviewAgent(saved, {client}), code('AGENT_CONFIG_CHANGED'));
  await assert.rejects(setupOpenAIReviewAgent({apiKey, storage, client}), code('AGENT_CONFIG_CHANGED'));
  const changed = openAIReviewAgentDefinition(); changed.system += '\nChanged instructions.';
  await assert.rejects(pinOpenAIAgent({apiKey, agentId: saved.reviewer.id, definition: changed, storage}), code('AGENT_CONFIG_CHANGED'));
  assert.equal(remote.agents.size, 1);
});

test('initial evidence is atomic with session creation, and calls retain turn/call pairing through reload', async () => {
  const {client, remote, storage, agent} = await connected();
  const initialContent = [...text('Inspect this page'), {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'YWJj'}}];
  const session = await client.createSession({agentId: agent.id, agentVersion: 1, environmentId: 'none', budgetUsd: 1, initialContent});
  const request = remote.requests.at(-1);
  assert.equal(request.path, '/agents/sessions'); assert.equal(request.headers['OpenAI-Beta'], 'agents=v1'); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  assert.deepEqual(request.body.environment, {type: 'none'}); assert.deepEqual(request.body.vault_ids, []); assert.equal(request.body.budget, undefined);
  assert.equal(request.body.input[0].content[0].type, 'input_text'); assert.equal(request.body.input[0].content[1].image_url, 'data:image/png;base64,YWJj');
  assert.equal(request.body.agent.tools.at(-1).enabled, false);
  const raw = remote.sessions.get(session.id); action(raw);
  const tool = await client.waitForTool(session.id, {toolNames: ['journey_step']});
  assert.equal(tool.toolUseId, 'oa:turn_1:call_1'); assert.deepEqual(tool.cursor, {seenIds: ['oa:turn_1:call_1']});
  const reloaded = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl, pollIntervalMs: 1});
  await reloaded.sendEvents(session.id, [{type: 'user.custom_tool_result', custom_tool_use_id: tool.toolUseId, content: initialContent}]);
  assert.deepEqual(remote.requests.at(-1).body.events[0], {type: 'agent.session.input.tool_result', turn_id: 'turn_1', call_id: 'call_1', success: true, output: [{type: 'input_text', text: 'Inspect this page'}, {type: 'input_image', image_url: 'data:image/png;base64,YWJj'}]});
  action(raw);
  await assert.rejects(reloaded.sendEvents(session.id, [{type: 'user.custom_tool_result', custom_tool_use_id: tool.toolUseId, content: text('Again')}]), code('AGENT_CONFLICT'));
  assert.equal(remote.requests.filter(value => value.path.endsWith('/events')).length, 1);
});

test('session start refuses missing evidence, altered remote agent and missing local pins before inference', async () => {
  const {client, remote, storage, agent} = await connected();
  await assert.rejects(client.createSession({agentId: agent.id, budgetUsd: 1}), code('AGENT_CONFIG'));
  remote.agents.get(agent.id).instructions += ' Changed.';
  await assert.rejects(client.createSession({agentId: agent.id, budgetUsd: 1, initialContent: text('Task')}), code('AGENT_CONFIG_CHANGED'));
  for (const key of Object.keys(storage.data)) delete storage.data[key];
  await assert.rejects(client.createSession({agentId: agent.id, budgetUsd: 1, initialContent: text('Task')}), code('AGENT_CONFIG_CHANGED'));
  assert.equal(remote.sessions.size, 0);
});

test('unknown usage fails closed at action handoff; cancellation remains possible', async () => {
  const {client, remote, session, raw} = await running(); action(raw); raw.usage = null;
  await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_BUDGET_UNKNOWN'));
  await assert.rejects(client.sendEvents(session.id, [{type: 'user.custom_tool_result', custom_tool_use_id: 'oa:turn_1:call_1', content: text('Done')}]), code('AGENT_BUDGET_UNKNOWN'));
  await client.interrupt(session.id);
  assert.equal(remote.requests.filter(value => value.path.endsWith('/events')).length, 1);
  assert.deepEqual(remote.requests.at(-1).body.events, [{type: 'agent.session.input.cancel'}]);
});

test('estimated spending guard persists across reload and cannot be reset by lower usage reports', async () => {
  const {client, storage, remote, session, raw} = await running({budgetUsd: .1}); action(raw); raw.usage = usage(10000, 1000);
  const first = await client.getSession(session.id); assert.equal(first.estimatedCostUsd, .065);
  raw.usage = usage(1, 1);
  const reloaded = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl});
  assert.equal((await reloaded.getSession(session.id)).estimatedCostUsd, .065);
  raw.usage = usage(15000, 2000);
  await assert.rejects(reloaded.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_BUDGET'));
  raw.usage = usage(1, 1);
  await assert.rejects(client.getSession(session.id), code('AGENT_BUDGET'));
  assert.equal(remote.requests.filter(value => value.path.endsWith('/events')).length, 0);
  assert.equal(conservativeOpenAICost({input_tokens: 1, output_tokens: 2, total_tokens: 4}), null);
  assert.equal(conservativeOpenAICost(usage(1e6, 1e6)), 20);
});

test('missing ledger or changed session capabilities blocks resume without making another allowance', async () => {
  const {client, storage, session, raw} = await running();
  raw.agent.multi_agent.enabled = true;
  await assert.rejects(client.getSession(session.id), code('AGENT_CONFIG_CHANGED'));
  for (const key of Object.keys(storage.data)) if (key.startsWith('diffuseOpenAISession:')) delete storage.data[key];
  await assert.rejects(client.getSession(session.id), code('AGENT_BUDGET_UNKNOWN'));
});

test('unacknowledged mutations stay blocked after reload and never replay a tool result', async () => {
  const {client, storage, remote, session, raw} = await running(); action(raw); remote.failEvents(new Error('Internal private detail'));
  const event = {type: 'user.custom_tool_result', custom_tool_use_id: 'oa:turn_1:call_1', content: text('Result')};
  await assert.rejects(client.sendEvents(session.id, [event]), error => error.code === 'AGENT_NETWORK' && error.ambiguous && !error.message.includes('private detail'));
  remote.failEvents(null);
  const reloaded = createOpenAIAgentsClient({apiKey, storage, fetchImpl: remote.fetchImpl});
  await assert.rejects(reloaded.sendEvents(session.id, [event]), code('AGENT_REQUEST_UNCERTAIN'));
  await assert.rejects(reloaded.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_REQUEST_UNCERTAIN'));
  assert.equal(remote.requests.filter(value => value.path.endsWith('/events')).length, 1);
  await reloaded.interrupt(session.id);
});

test('polling rejects unexpected, parallel, malformed or already delivered calls', async () => {
  const {client, session, raw} = await running();
  action(raw, {name: 'shell'}); await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_TOOL'));
  action(raw); raw.required_actions.push({...raw.required_actions[0], call_id: 'call_2'});
  await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_TOOL'));
  action(raw, {input: '{"action":{}}'}); await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_TOOL'));
  action(raw); await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step'], after: {seenIds: ['oa:turn_1:call_1']}, timeoutMs: 15}), code('AGENT_TIMEOUT'));
  raw.status = 'idle'; raw.required_actions = [];
  await assert.rejects(client.waitForTool(session.id, {toolNames: ['journey_step']}), code('AGENT_INCOMPLETE'));
});

test('OpenAI account fingerprints are provider-specific and keys never enter request paths or setup metadata', async () => {
  const fingerprint = await openAIAgentAccountFingerprint(apiKey);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const {remote} = await connected();
  for (const request of remote.requests) { assert.equal(request.path.includes(apiKey), false); assert.equal(JSON.stringify(request.body).includes(apiKey), false); }
});

test('unsafe paths, oversized evidence and invalid budgets fail before paid network requests', async () => {
  const {client, remote, agent} = await connected(), before = remote.requests.length;
  for (const budgetUsd of [undefined, null, NaN, Infinity, -1, 0, 101, .005, 1.001]) await assert.rejects(client.createSession({agentId: agent.id, budgetUsd, initialContent: text('Task')}), code('AGENT_CONFIG'));
  await assert.rejects(client.getAgent('../other?secret=value'), code('AGENT_CONFIG'));
  await assert.rejects(client.getSession('../other?secret=value'), code('AGENT_CONFIG'));
  await assert.rejects(client.createSession({agentId: agent.id, budgetUsd: 1, initialContent: [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'a'.repeat(1048576)}}]}), code('AGENT_LIMIT'));
  await assert.rejects(client.createSession({agentId: agent.id, budgetUsd: 1, initialContent: [{type: 'image', source: {type: 'url', url: 'https://example.test/private'}}]}), code('AGENT_CONFIG'));
  assert.equal(remote.requests.length, before);
});

test('HTTP failures expose safe errors without provider bodies or automatic retries', async () => {
  for (const [status, expected] of [[401, 'AGENT_AUTH'], [403, 'AGENT_ACCESS'], [404, 'AGENT_NOT_FOUND'], [409, 'AGENT_CONFLICT'], [429, 'AGENT_RATE_LIMIT'], [500, 'AGENT_UNAVAILABLE']]) {
    let calls = 0;
    const client = createOpenAIAgentsClient({apiKey, storage: memory(), fetchImpl: async () => { calls++; return new Response(`Sensitive provider detail ${apiKey}`, {status}); }});
    await assert.rejects(client.createAgent(openAIJourneyAgentDefinitions().actor), error => error.code === expected && error.status === status && error.ambiguous === (status >= 500) && !error.message.includes(apiKey));
    assert.equal(calls, 1);
  }
});

test('timeouts bound stalled fetch and response streams, with no automatic mutation retry', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({start() {}}))]) {
    const client = createOpenAIAgentsClient({apiKey, storage: memory(), timeoutMs: 15, fetchImpl});
    await assert.rejects(client.createAgent(openAIJourneyAgentDefinitions().actor), error => error.code === 'AGENT_TIMEOUT' && error.ambiguous);
  }
});
