// OpenAI Agents API contracts checked against the official agent/session/event
// references on 2026-10-25. Browser actions remain in Diffuse; hosted execution,
// delegation, web/MCP tools and programmatic tool calling are explicitly off.
import {ManagedAgentError} from './claude-agents-client.mjs';

export const OPENAI_AGENT_MODEL = 'gpt-6.1-sol';
export const OPENAI_AGENTS_BETA = 'agents=v1';
const BASE = 'https://api.openai.com/v1';
const REQUEST_LIMIT = 4 * 1024 * 1024 - 4096;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TOOL_LIMIT = 256 * 1024;
const PIN_PREFIX = 'diffuseOpenAIAgentPin:';
const SESSION_PREFIX = 'diffuseOpenAISession:';
const locks = new Map();
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{1,160}$/.test(value);
const validText = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const fail = (code, message) => { throw new ManagedAgentError(code, message); };
const cancelled = () => new ManagedAgentError('AGENT_ABORTED', 'The agent request was cancelled.');
const timeout = () => new ManagedAgentError('AGENT_TIMEOUT', 'The OpenAI agent did not respond in time. Check the session before continuing.');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function json(value, limit = REQUEST_LIMIT) {
  let result;
  try { result = JSON.stringify(value); } catch { fail('AGENT_CONFIG', 'The OpenAI agent request contains invalid data.'); }
  if (!result || new TextEncoder().encode(result).byteLength > limit) fail('AGENT_LIMIT', 'The OpenAI agent request is too large. Reduce the supplied evidence.');
  return result;
}
function keyValue(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim().length < 20 || apiKey.trim().length > 512 || /[^\x21-\x7e]/.test(apiKey.trim())) fail('AGENT_AUTH', 'Enter a valid OpenAI API key in AI settings.');
  return apiKey.trim();
}
export async function openAIAgentAccountFingerprint(apiKey) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`openai:${keyValue(apiKey)}`));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Accept the provider-neutral definitions already used by Diffuse. Never pass
// caller-supplied provider settings through to the API unchecked.
export function openAIAgentDefinition(definition) {
  if (!object(definition) || Object.keys(definition).some(key => !['name', 'description', 'model', 'system', 'tools', 'metadata'].includes(key)) || !validText(definition.name, 256) || !validText(definition.system, 250000)) fail('AGENT_CONFIG', 'Give the OpenAI agent a valid name and instructions.');
  if (!Array.isArray(definition.tools) || !definition.tools.length || definition.tools.length > 16) fail('AGENT_CONFIG', 'Define the limited functions available to this agent.');
  const names = new Set();
  const tools = definition.tools.map(tool => {
    if (!object(tool) || Object.keys(tool).some(key => !['type', 'name', 'description', 'input_schema'].includes(key)) || tool.type !== 'custom' || !/^(?:journey_step|journey_assessment|journey_answer|journey_evidence|review_assessment)$/.test(tool.name || '') || names.has(tool.name) || !validText(tool.description, 10000) || !object(tool.input_schema) || tool.input_schema.type !== 'object') fail('AGENT_CONFIG', 'Diffuse OpenAI agents can use only the explicit review and journey functions.');
    names.add(tool.name); json(tool.input_schema, 100000);
    return {type: 'function', name: tool.name, description: tool.description, parameters: structuredClone(tool.input_schema), defer_loading: false};
  });
  if (definition.metadata !== undefined && (!object(definition.metadata) || Object.keys(definition.metadata).length > 16 || Object.entries(definition.metadata).some(([key, value]) => !validText(key, 64) || !validText(value, 512, true)))) fail('AGENT_CONFIG', 'The OpenAI agent metadata is invalid.');
  return {name: definition.name, model: OPENAI_AGENT_MODEL, instructions: definition.system, reasoning: {effort: 'max'}, service_tier: 'default', multi_agent: {enabled: false},
    tools: [...tools, {type: 'programmatic_tool_calling', enabled: false}], metadata: {...definition.metadata}};
}

function comparableConfig(agent) {
  if (!object(agent)) return null;
  const tools = Array.isArray(agent.tools) ? agent.tools.map(tool => {
    if (tool.type === 'function') return {...tool, defer_loading: tool.defer_loading ?? false};
    return tool;
  }) : agent.tools;
  const reasoning = object(agent.reasoning) ? {...agent.reasoning} : agent.reasoning;
  if (reasoning?.summary == null) delete reasoning?.summary;
  const multi = object(agent.multi_agent) ? {...agent.multi_agent} : agent.multi_agent;
  if (multi?.enabled === false && (multi.max_concurrent_subagents == null || multi.max_concurrent_subagents === 6)) delete multi.max_concurrent_subagents;
  return {model: agent.model, instructions: agent.instructions, reasoning, service_tier: agent.service_tier, multi_agent: multi, tools};
}
export function matchesOpenAIAgentDefinition(agent, definition) {
  const expected = openAIAgentDefinition(definition);
  return agent?.name === expected.name && same(agent.metadata || {}, expected.metadata) && same(comparableConfig(agent), comparableConfig(expected));
}
export async function pinOpenAIAgent({apiKey, agentId, definition, storage = globalThis.chrome?.storage?.local} = {}) {
  if (!identifier(agentId) || !storage?.get || !storage?.set) fail('AGENT_CONFIG', 'OpenAI agent setup needs local extension storage.');
  const account = await openAIAgentAccountFingerprint(apiKey), config = openAIAgentDefinition(definition), key = `${PIN_PREFIX}${account}:${agentId}`;
  const previous = (await storage.get(key))[key];
  if (previous && !same(previous.config, config)) fail('AGENT_CONFIG_CHANGED', 'This OpenAI agent is pinned to an earlier definition. Create a new agent revision instead of replacing it.');
  await storage.set({[key]: {account, agentId, provider: 'openai', version: 1, config}});
}

function contentBlocks(content) {
  if (!Array.isArray(content) || !content.length || content.length > 32) fail('AGENT_CONFIG', 'The OpenAI agent message needs valid content.');
  return content.map(block => {
    if (object(block) && block.type === 'text' && Object.keys(block).every(key => ['type', 'text'].includes(key)) && validText(block.text, 1048576, true)) return {type: 'input_text', text: block.text};
    const source = block?.source;
    if (object(block) && block.type === 'image' && Object.keys(block).every(key => ['type', 'source'].includes(key)) && object(source) && Object.keys(source).every(key => ['type', 'media_type', 'data'].includes(key)) && source.type === 'base64' && ['image/png', 'image/jpeg', 'image/webp'].includes(source.media_type) && typeof source.data === 'string' && source.data.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
      const url = `data:${source.media_type};base64,${source.data}`;
      if (url.length <= 1048576) return {type: 'input_image', image_url: url};
      fail('AGENT_LIMIT', 'A screenshot is too large for the OpenAI agent. Reduce its size before continuing.');
    }
    fail('AGENT_CONFIG', 'The OpenAI agent message contains unsupported content.');
  });
}
function toolPair(value) {
  if (typeof value !== 'string') fail('AGENT_CONFIG', 'The saved OpenAI tool call is invalid.');
  const [marker, turn_id, call_id, extra] = value.split(':');
  if (marker !== 'oa' || extra !== undefined || !identifier(turn_id) || !identifier(call_id)) fail('AGENT_CONFIG', 'The saved OpenAI tool call is invalid.');
  return {turn_id, call_id};
}
const toolId = action => `oa:${action.turn_id}:${action.call_id}`;
function outbound(events) {
  if (!Array.isArray(events) || !events.length || events.length > 2) fail('AGENT_CONFIG', 'Send a bounded set of OpenAI agent events.');
  return events.map(event => {
    if (!object(event)) fail('AGENT_CONFIG', 'The OpenAI agent event is invalid.');
    if (event.type === 'user.message' && Object.keys(event).every(key => ['type', 'content'].includes(key))) return {type: 'agent.session.input.message', input: [{role: 'user', content: contentBlocks(event.content)}]};
    if (event.type === 'user.custom_tool_result' && Object.keys(event).every(key => ['type', 'custom_tool_use_id', 'content', 'is_error'].includes(key)) && (event.is_error === undefined || typeof event.is_error === 'boolean')) {
      const pair = toolPair(event.custom_tool_use_id), content = contentBlocks(event.content);
      if (event.is_error) {
        if (content.some(block => block.type !== 'input_text')) fail('AGENT_CONFIG', 'An unsuccessful tool result must explain the error in text.');
        return {type: 'agent.session.input.tool_result', ...pair, success: false, error: content.map(block => block.text).join('\n')};
      }
      return {type: 'agent.session.input.tool_result', ...pair, success: true, output: content};
    }
    if (event.type === 'user.interrupt' && Object.keys(event).length === 1) return {type: 'agent.session.input.cancel'};
    fail('AGENT_CONFIG', 'This OpenAI agent event is not supported by Diffuse.');
  });
}
function cursorValue(value) {
  if (value == null) return {seenIds: []};
  if (!object(value) || Object.keys(value).some(key => key !== 'seenIds') || !Array.isArray(value.seenIds) || value.seenIds.length > 1000) fail('AGENT_CURSOR', 'The saved OpenAI event cursor is invalid.');
  for (const seen of value.seenIds) toolPair(seen);
  return {seenIds: [...new Set(value.seenIds)]};
}

// Usage is best effort, with no cache-write count or per-call context lengths.
// Charge all reported input at the documented long-context cache-write ceiling
// ($5/M), and all output at the long-context ceiling ($15/M). This deliberately
// overestimates ordinary/cached usage. It is an estimate, NOT a provider cap.
export function conservativeOpenAICost(usage) {
  if (!object(usage) || !['input_tokens', 'output_tokens', 'total_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) || usage.total_tokens !== usage.input_tokens + usage.output_tokens) return null;
  return (usage.input_tokens * 5 + usage.output_tokens * 15) / 1000000;
}
async function locked(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task); locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
function deadline(signal, ms) {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  const failure = () => timedOut ? timeout() : cancelled();
  const race = promise => new Promise((resolve, reject) => {
    const stopped = () => { cleanup(); reject(failure()); }, cleanup = () => controller.signal.removeEventListener('abort', stopped);
    if (controller.signal.aborted) return reject(failure());
    controller.signal.addEventListener('abort', stopped, {once: true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  return {signal: controller.signal, failure, race, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }};
}
function cancelBody(stream) { try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch {} }
async function responseJSON(response, timer) {
  if (Number(response.headers?.get?.('content-length')) > RESPONSE_LIMIT) { cancelBody(response.body); fail('AGENT_RESPONSE', 'OpenAI returned an oversized agent response.'); }
  let raw = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0;
    try {
      while (true) {
        const {done, value} = await timer.race(reader.read()); if (done) break;
        size += value.byteLength; if (size > RESPONSE_LIMIT) fail('AGENT_RESPONSE', 'OpenAI returned an oversized agent response.');
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } finally { cancelBody(reader); }
  } else { raw = await timer.race(response.text()); if (new TextEncoder().encode(raw).byteLength > RESPONSE_LIMIT) fail('AGENT_RESPONSE', 'OpenAI returned an oversized agent response.'); }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { fail('AGENT_RESPONSE', 'OpenAI returned an unreadable agent response.'); }
}
function httpError(status, requestId) {
  const details = {status, requestId};
  const [code, message] = ({
    401: ['AGENT_AUTH', 'OpenAI rejected this API key. Update it in AI settings.'],
    402: ['AGENT_BILLING', 'Check API credit and billing in OpenAI Platform before continuing.'],
    403: ['AGENT_ACCESS', 'This key cannot use the OpenAI Agents API. Check project permissions and account access in OpenAI Platform.'],
    404: ['AGENT_NOT_FOUND', 'This OpenAI agent resource is unavailable for the selected project or key. Check OpenAI Platform before reconnecting.'],
    409: ['AGENT_CONFLICT', 'The OpenAI session changed during this request. Check its status before continuing.'],
    413: ['AGENT_LIMIT', 'OpenAI could not accept this much evidence. Reduce the supplied evidence.'],
    429: ['AGENT_RATE_LIMIT', 'OpenAI has temporarily limited requests or API credit is unavailable. Check usage before continuing.'],
  })[status] || (status >= 500 ? ['AGENT_UNAVAILABLE', 'OpenAI Agents is temporarily unavailable. Check the session before retrying.'] : ['AGENT_REQUEST', 'OpenAI rejected the agent request. Check the agent configuration and Agents API access in OpenAI Platform.']);
  return new ManagedAgentError(code, message, details);
}

export function createOpenAIAgentsClient({apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30000, pollIntervalMs = 1000, storage = globalThis.chrome?.storage?.local} = {}) {
  const key = keyValue(apiKey);
  if (typeof fetchImpl !== 'function' || !storage?.get || !storage?.set || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10000) fail('AGENT_CONFIG', 'The OpenAI agent connection needs valid local storage and connection settings.');
  const accountPromise = openAIAgentAccountFingerprint(key);
  async function request(path, {method = 'GET', body, signal} = {}) {
    if (signal?.aborted) throw cancelled();
    const serialized = body === undefined ? undefined : json(body), timer = deadline(signal, timeoutMs); let dispatched = false;
    try {
      dispatched = true;
      const response = await timer.race(fetchImpl(`${BASE}${path}`, {method, body: serialized, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {'content-type': 'application/json', authorization: `Bearer ${key}`, 'OpenAI-Beta': OPENAI_AGENTS_BETA}}));
      const candidate = response.headers?.get?.('x-request-id'), requestId = identifier(candidate) ? candidate : undefined;
      if (!response.ok) { cancelBody(response.body); throw httpError(response.status, requestId); }
      if (response.status === 204) return null;
      return await responseJSON(response, timer);
    } catch (error) {
      const safe = error instanceof ManagedAgentError ? error : timer.signal.aborted ? timer.failure() : new ManagedAgentError('AGENT_NETWORK', 'Could not reach OpenAI Agents. Check the connection and session status before continuing.');
      if (method !== 'GET' && dispatched && (!safe.status || safe.status >= 500)) safe.ambiguous = true;
      throw safe;
    } finally { timer.dispose(); }
  }
  const sessionPath = sessionId => { if (!identifier(sessionId)) fail('AGENT_CONFIG', 'The saved OpenAI session identifier is invalid.'); return `/agents/sessions/${encodeURIComponent(sessionId)}`; };
  const ledgerKey = async sessionId => { sessionPath(sessionId); return `${SESSION_PREFIX}${await accountPromise}:${sessionId}`; };
  async function readLedger(sessionId) {
    const key = await ledgerKey(sessionId), ledger = (await storage.get(key))[key];
    if (!object(ledger) || ledger.account !== await accountPromise || ledger.sessionId !== sessionId || ledger.model !== OPENAI_AGENT_MODEL || ledger.schema !== 1 || !Number.isFinite(ledger.budgetUsd) || ledger.budgetUsd < .01 || ledger.budgetUsd > 100 || !Number.isFinite(ledger.estimatedCostUsd) || ledger.estimatedCostUsd < 0 || !Array.isArray(ledger.acceptedTools)) fail('AGENT_BUDGET_UNKNOWN', 'This OpenAI session has no valid saved spending guard. It cannot be resumed safely; no new allowance was created.');
    return {key, ledger};
  }
  async function pin(agentId) {
    if (!identifier(agentId)) fail('AGENT_CONFIG', 'The saved OpenAI agent identifier is invalid.');
    const key = `${PIN_PREFIX}${await accountPromise}:${agentId}`, value = (await storage.get(key))[key];
    if (!value || value.account !== await accountPromise || value.agentId !== agentId || value.version !== 1 || value.config?.model !== OPENAI_AGENT_MODEL) fail('AGENT_CONFIG_CHANGED', 'The saved OpenAI agent definition is missing. Check its setup in AI settings.');
    return value.config;
  }
  function validateSession(raw, sessionId, config, agentId) {
    if (!object(raw) || raw.id !== sessionId || raw.object !== 'agent.session' || !['idle', 'in_progress', 'requires_action', 'failed'].includes(raw.status) || !Array.isArray(raw.required_actions) || raw.required_actions.length > 16) fail('AGENT_RESPONSE', 'OpenAI returned an invalid session.');
    if (raw.agent?.id !== agentId || raw.environment?.type !== 'none' || !Array.isArray(raw.vault_ids) || raw.vault_ids.length || !same(comparableConfig(raw.agent), comparableConfig(config))) fail('AGENT_CONFIG_CHANGED', 'The OpenAI session configuration changed. No browser action was performed.');
    return raw;
  }
  async function observe(sessionId, signal, {requireUsage = false} = {}) {
    const saved = await readLedger(sessionId), config = await pin(saved.ledger.agentId);
    const raw = validateSession(await request(sessionPath(sessionId), {signal}), sessionId, config, saved.ledger.agentId);
    const estimate = conservativeOpenAICost(raw.usage);
    if (estimate !== null) {
      // High-water values survive polling corrections, new clients and reloads.
      saved.ledger.inputTokens = Math.max(saved.ledger.inputTokens || 0, raw.usage.input_tokens);
      saved.ledger.outputTokens = Math.max(saved.ledger.outputTokens || 0, raw.usage.output_tokens);
      saved.ledger.estimatedCostUsd = Math.max(saved.ledger.estimatedCostUsd, (saved.ledger.inputTokens * 5 + saved.ledger.outputTokens * 15) / 1e6);
      saved.ledger.usageSeen = true;
      await storage.set({[saved.key]: saved.ledger});
    }
    if (saved.ledger.estimatedCostUsd >= saved.ledger.budgetUsd) fail('AGENT_BUDGET', 'This OpenAI session reached its estimated spending guard. The journey stopped; a request already in progress may add usage.');
    if (estimate === null && (requireUsage || ['requires_action', 'idle'].includes(raw.status))) fail('AGENT_BUDGET_UNKNOWN', 'OpenAI has not supplied usable session usage. Diffuse paused before another action or paid request; the existing allowance was kept.');
    return {...saved, raw};
  }
  const client = {
    provider: 'openai',
    async createAgent(definition, {signal} = {}) {
      const body = openAIAgentDefinition(definition), value = await request('/agents', {method: 'POST', body, signal});
      if (!object(value) || !identifier(value.id) || value.object !== 'agent' || !matchesOpenAIAgentDefinition(value, definition)) throw new ManagedAgentError('AGENT_RESPONSE', 'OpenAI did not confirm the expected agent definition. Check Agents in OpenAI Platform before reconnecting.', {ambiguous: true});
      await pinOpenAIAgent({apiKey: key, agentId: value.id, definition, storage});
      return {...value, version: 1};
    },
    async getAgent(agentId, {version, signal} = {}) {
      if (!identifier(agentId) || (version !== undefined && version !== 1)) fail('AGENT_CONFIG', 'The saved OpenAI agent pin is invalid.');
      const value = await request(`/agents/${encodeURIComponent(agentId)}`, {signal});
      if (!object(value) || value.id !== agentId || value.object !== 'agent') fail('AGENT_RESPONSE', 'OpenAI returned an invalid agent definition.');
      return {...value, version: 1};
    },
    async createSession({agentId, agentVersion = 1, environmentId = 'none', model, budgetUsd, initialContent, signal} = {}) {
      if (agentVersion !== 1 || environmentId !== 'none' || (model !== undefined && model !== OPENAI_AGENT_MODEL)) fail('AGENT_CONFIG', 'Use the pinned OpenAI agent with browser tools only.');
      if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd < .01 || budgetUsd > 100 || Math.abs(Math.round(budgetUsd * 100) - budgetUsd * 100) > 1e-6) fail('AGENT_CONFIG', 'Set an OpenAI session spending guard between $0.01 and $100, in whole cents.');
      const content = contentBlocks(initialContent), config = await pin(agentId), remote = await client.getAgent(agentId, {version: agentVersion, signal});
      if (!same(comparableConfig(remote), comparableConfig(config)) || remote.name !== config.name || !same(remote.metadata || {}, config.metadata)) fail('AGENT_CONFIG_CHANGED', 'The saved OpenAI agent was changed in Platform. Restore its Diffuse definition before starting it.');
      const {name: _name, metadata: _metadata, ...overrides} = config;
      const raw = await request('/agents/sessions', {method: 'POST', signal, body: {agent_id: agentId, agent: overrides, environment: {type: 'none'}, vault_ids: [], input: [{role: 'user', content}], metadata: {diffuse_spending_guard_usd: String(budgetUsd), diffuse_spending_guard: 'estimate-v1'}, stream: false}});
      if (!identifier(raw?.id)) throw new ManagedAgentError('AGENT_RESPONSE', 'OpenAI did not confirm session creation. Check Sessions in OpenAI Platform before retrying.', {ambiguous: true});
      try { validateSession(raw, raw.id, config, agentId); } catch (error) { error.ambiguous = true; throw error; }
      const account = await accountPromise, storageKey = await ledgerKey(raw.id);
      const previous = (await storage.get(storageKey))[storageKey];
      if (previous) throw new ManagedAgentError('AGENT_RESPONSE', 'OpenAI returned an existing session for a new request. No spending allowance was replaced.', {ambiguous: true});
      const estimate = conservativeOpenAICost(raw.usage);
      await storage.set({[storageKey]: {schema: 1, provider: 'openai', account, sessionId: raw.id, agentId, model: OPENAI_AGENT_MODEL, budgetUsd,
        estimatedCostUsd: estimate ?? 0, usageSeen: estimate !== null, inputTokens: estimate === null ? 0 : raw.usage.input_tokens, outputTokens: estimate === null ? 0 : raw.usage.output_tokens,
        pending: false, acceptedTools: []}});
      return {...raw, type: 'session', estimatedCostUsd: estimate};
    },
    async getSession(sessionId, {signal} = {}) {
      return locked(await ledgerKey(sessionId), async () => {
        const {raw, ledger} = await observe(sessionId, signal);
        return {...raw, type: 'session', estimatedCostUsd: ledger.estimatedCostUsd, spendingGuardUsd: ledger.budgetUsd, requestUncertain: ledger.pending === true};
      });
    },
    async sendEvents(sessionId, events, {signal} = {}) {
      const translated = outbound(events);
      if (translated.some(event => event.type === 'agent.session.input.cancel')) {
        if (translated.length !== 1) fail('AGENT_CONFIG', 'Cancel the OpenAI turn separately from other events.');
        return request(`${sessionPath(sessionId)}/events`, {method: 'POST', body: {events: translated}, signal});
      }
      return locked(await ledgerKey(sessionId), async () => {
        const {raw, key: storageKey, ledger} = await observe(sessionId, signal, {requireUsage: true});
        if (ledger.pending) fail('AGENT_REQUEST_UNCERTAIN', 'OpenAI has not confirmed a previous message. Check the session before continuing; Diffuse has not sent it again.');
        const results = translated.filter(event => event.type === 'agent.session.input.tool_result');
        if (results.length > 1 || (results.length && translated.length !== 1)) fail('AGENT_CONFIG', 'Send one OpenAI function result at a time.');
        if (results.length) {
          const result = results[0], id = toolId(result);
          if (ledger.acceptedTools.includes(id)) fail('AGENT_CONFLICT', 'This OpenAI tool result was already sent. No duplicate was submitted.');
          if (raw.status !== 'requires_action' || raw.required_actions.length !== 1 || raw.required_actions[0].type !== 'function_call' || toolId(raw.required_actions[0]) !== id) fail('AGENT_CONFLICT', 'The saved OpenAI tool call is no longer pending. No result was sent.');
        } else if (translated.length !== 1 || raw.status !== 'idle' || raw.required_actions.length) fail('AGENT_CONFLICT', 'The OpenAI session is still working or waiting for a tool result. No new message was sent.');
        ledger.pending = true; await storage.set({[storageKey]: ledger});
        try {
          const result = await request(`${sessionPath(sessionId)}/events`, {method: 'POST', body: {events: translated}, signal});
          ledger.pending = false;
          if (results.length) ledger.acceptedTools.push(toolId(results[0]));
          await storage.set({[storageKey]: ledger}); return result;
        } catch (error) {
          if (!error.ambiguous) { ledger.pending = false; await storage.set({[storageKey]: ledger}); }
          throw error;
        }
      });
    },
    interrupt(sessionId, {signal} = {}) { return client.sendEvents(sessionId, [{type: 'user.interrupt'}], {signal}); },
    async waitForTool(sessionId, {after, toolNames, signal, timeoutMs: waitTimeoutMs = 180000} = {}) {
      if (!Array.isArray(toolNames) || !toolNames.length || toolNames.length > 16 || toolNames.some(name => !/^[A-Za-z0-9_-]{1,128}$/.test(name)) || !Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600000) fail('AGENT_CONFIG', 'The expected OpenAI function configuration is invalid.');
      const cursor = cursorValue(after), timer = deadline(signal, waitTimeoutMs); let idlePolls = 0;
      try {
        while (true) {
          const session = await timer.race(client.getSession(sessionId, {signal: timer.signal}));
          if (session.requestUncertain) fail('AGENT_REQUEST_UNCERTAIN', 'OpenAI has not confirmed a previous message. Check the session before allowing another browser action.');
          if (session.status === 'failed') fail('AGENT_SESSION', 'OpenAI reported a session failure. Check Sessions in OpenAI Platform; no browser action was performed.');
          if (session.required_actions.length) {
            if (session.status !== 'requires_action' || session.required_actions.length !== 1) fail('AGENT_TOOL', 'The OpenAI agent requested parallel or unsupported actions. No browser action was performed.');
            const action = session.required_actions[0];
            if (action.type !== 'function_call' || !identifier(action.turn_id) || !identifier(action.call_id) || !toolNames.includes(action.name) || !object(action.arguments)) fail('AGENT_TOOL', 'The OpenAI agent requested an unexpected function or invalid arguments. No browser action was performed.');
            json(action.arguments, TOOL_LIMIT);
            const id = toolId(action);
            if (!cursor.seenIds.includes(id)) {
              if (cursor.seenIds.length >= 1000) fail('AGENT_LIMIT', 'This OpenAI session has too many saved calls to resume safely.');
              return {name: action.name, input: action.arguments, toolUseId: id, cursor: {seenIds: [...cursor.seenIds, id]}};
            }
          }
          // A freshly accepted input can briefly remain idle. Two consecutive
          // idle polls avoid confusing that transition with a completed turn.
          idlePolls = session.status === 'idle' ? idlePolls + 1 : 0;
          if (idlePolls >= 2) fail('AGENT_INCOMPLETE', 'The OpenAI agent finished without the expected result. The journey stopped.');
          await timer.race(new Promise(resolve => setTimeout(resolve, pollIntervalMs)));
        }
      } catch (error) { if (timer.signal.aborted) throw timer.failure(); throw error; }
      finally { timer.dispose(); }
    },
  };
  return Object.freeze(client);
}
