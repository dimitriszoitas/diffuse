// BYOK Managed Agents transport. Only the extension worker calls this module.
// REST contracts verified against platform.claude.com/docs/en/api/beta/{agents,
// environments,sessions} and managed-agents/events-and-streaming (2026-10-24).
// Mutations are never retried: a lost acknowledgement may already have taken effect.
export const MANAGED_AGENTS_API_VERSION = '2026-10-21';
export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
const BASE = 'https://api.anthropic.com/v1';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_LIMIT = 12 * 1024 * 1024;
const EVENT_ACK_LIMIT = REQUEST_LIMIT + 256 * 1024;
const TOOL_INPUT_LIMIT = 256 * 1024;
const MAX_EVENTS = 1000;
const MAX_PAGES = 20;
// Do not download screenshot-bearing user events or private thinking on every
// poll. Status events and structured calls are enough to drive the browser.
const TRACKED_TYPES = new Set(['agent.custom_tool_use', 'agent.tool_use', 'agent.mcp_tool_use', 'agent.message', 'session.status_running', 'session.status_idle', 'session.status_terminated', 'session.error']);
const BUILTIN_NAMES = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'web_search']);

export class ManagedAgentError extends Error {
  constructor(code, message, {status, requestId, ambiguous = false} = {}) {
    super(message); this.name = 'ManagedAgentError'; this.code = code;
    if (status !== undefined) this.status = status;
    if (requestId) this.requestId = requestId;
    this.ambiguous = ambiguous;
  }
}
const fail = (code, message) => { throw new ManagedAgentError(code, message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const id = (value, prefix) => typeof value === 'string' && value.length <= 128 && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);
const abortError = () => new ManagedAgentError('AGENT_ABORTED', 'The agent request was cancelled.');
const timeoutError = () => new ManagedAgentError('AGENT_TIMEOUT', 'The agent did not respond in time. The journey stopped; check its status before continuing.');

function json(value, limit = REQUEST_LIMIT) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('AGENT_CONFIG', 'The agent request contains invalid data.'); }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > limit) fail('AGENT_LIMIT', 'The agent request is too large. Reduce the supplied evidence and try again.');
  return serialized;
}
function modelConfig(value) {
  const result = typeof value === 'string' ? value : object(value) ? {...value} : null;
  const model = typeof result === 'string' ? result : result?.id;
  if (!/^claude-[a-z0-9][a-z0-9._-]{1,110}$/.test(model || '')) fail('AGENT_CONFIG', 'Choose a valid Claude model for the agents.');
  if (object(result)) {
    if (Object.keys(result).some(key => !['id', 'effort', 'speed', 'inference_geo'].includes(key))) fail('AGENT_CONFIG', 'The agent model configuration is invalid.');
    if (result.effort !== undefined && (!object(result.effort) || Object.keys(result.effort).length !== 1 || !['low', 'medium', 'high', 'xhigh', 'max'].includes(result.effort.type))) fail('AGENT_CONFIG', 'Choose a valid agent reasoning effort.');
    if (result.speed !== undefined && !['standard', 'fast'].includes(result.speed)) fail('AGENT_CONFIG', 'Choose a valid agent speed.');
    if (result.inference_geo !== undefined && !['us', 'global'].includes(result.inference_geo)) fail('AGENT_CONFIG', 'Choose a valid inference region.');
  }
  return result;
}
function agentDefinition(value) {
  if (!object(value) || Object.keys(value).some(key => !['name', 'model', 'system', 'description', 'tools', 'metadata'].includes(key))) fail('AGENT_CONFIG', 'The agent definition contains unsupported capabilities.');
  if (!text(value.name, 256) || !text(value.system, 100000) || (value.description !== undefined && !text(value.description, 2048, true))) fail('AGENT_CONFIG', 'Give the agent a name and valid instructions.');
  if (!Array.isArray(value.tools) || !value.tools.length || value.tools.length > 16) fail('AGENT_CONFIG', 'Define the limited tools available to this agent.');
  const names = new Set();
  const tools = value.tools.map(tool => {
    if (!object(tool) || Object.keys(tool).some(key => !['type', 'name', 'description', 'input_schema'].includes(key)) || tool.type !== 'custom' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name || '') || /^(?:mcp|ant)__/.test(tool.name) || BUILTIN_NAMES.has(tool.name) || names.has(tool.name) || !text(tool.description, 10000) || !object(tool.input_schema) || tool.input_schema.type !== 'object') fail('AGENT_CONFIG', 'Diffuse agents can use only explicitly defined custom tools.');
    names.add(tool.name); json(tool.input_schema, 100000); return tool;
  });
  if (value.metadata !== undefined && (!object(value.metadata) || Object.keys(value.metadata).length > 16 || Object.entries(value.metadata).some(([key, item]) => !text(key, 64) || !text(item, 256, true)))) fail('AGENT_CONFIG', 'The agent metadata is invalid.');
  // Omitting the builtin toolset disables all sandbox/web tools. Empty MCP and
  // skills arrays plus multiagent:null prevent unreviewed remote capabilities.
  return {...value, model: modelConfig(value.model), tools, mcp_servers: [], skills: [], multiagent: null};
}
function contentBlocks(content) {
  if (!Array.isArray(content) || !content.length || content.length > 32) fail('AGENT_CONFIG', 'The agent message needs valid content.');
  for (const block of content) {
    if (!object(block)) fail('AGENT_CONFIG', 'The agent message contains invalid content.');
    if (block.type === 'text') {
      if (Object.keys(block).some(key => !['type', 'text'].includes(key)) || !text(block.text, 1000000, true)) fail('AGENT_CONFIG', 'The agent message text is invalid.');
    } else if (block.type === 'image') {
      const source = block.source;
      if (Object.keys(block).some(key => !['type', 'source'].includes(key)) || !object(source) || Object.keys(source).some(key => !['type', 'media_type', 'data'].includes(key)) || source.type !== 'base64' || !['image/png', 'image/jpeg', 'image/webp'].includes(source.media_type) || typeof source.data !== 'string' || source.data.length > 8 * 1024 * 1024 || source.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) fail('AGENT_CONFIG', 'The agent screenshot is invalid. Capture it again.');
    } else fail('AGENT_CONFIG', 'The agent message contains an unsupported attachment.');
  }
}
function outboundEvents(events) {
  if (!Array.isArray(events) || !events.length || events.length > 16) fail('AGENT_CONFIG', 'Send a bounded set of agent events.');
  for (const event of events) {
    if (!object(event)) fail('AGENT_CONFIG', 'The agent event is invalid.');
    if (event.type === 'user.message') {
      if (Object.keys(event).some(key => !['type', 'content'].includes(key))) fail('AGENT_CONFIG', 'The agent message is invalid.');
      contentBlocks(event.content);
    } else if (event.type === 'user.custom_tool_result') {
      if (Object.keys(event).some(key => !['type', 'custom_tool_use_id', 'content', 'is_error'].includes(key)) || !id(event.custom_tool_use_id, 'sevt') || (event.is_error !== undefined && typeof event.is_error !== 'boolean')) fail('AGENT_CONFIG', 'The agent tool result is invalid.');
      contentBlocks(event.content);
    } else if (event.type === 'user.interrupt') {
      if (Object.keys(event).length !== 1) fail('AGENT_CONFIG', 'The agent interrupt is invalid.');
    } else fail('AGENT_CONFIG', 'This agent event is not supported by Diffuse.');
  }
  return events;
}
function httpError(status, requestId) {
  const details = {status, requestId};
  if (status === 401) return new ManagedAgentError('AGENT_AUTH', 'Anthropic rejected this API key. Update it in AI settings.', details);
  if (status === 402) return new ManagedAgentError('AGENT_BILLING', 'Anthropic requires available API credit. Check your Claude Console billing settings.', details);
  if (status === 403) return new ManagedAgentError('AGENT_ACCESS', 'This key cannot use Claude Managed Agents. Check its workspace permissions and Managed Agents access in Claude Console.', details);
  if (status === 404) return new ManagedAgentError('AGENT_NOT_FOUND', 'The saved agent resource is unavailable for this key. Check the workspace or reconnect the agents.', details);
  if (status === 409) return new ManagedAgentError('AGENT_CONFLICT', 'The agent session changed while this request was running. Check its status before continuing.', details);
  if (status === 413) return new ManagedAgentError('AGENT_LIMIT', 'Anthropic could not accept this much agent evidence. Reduce the supplied evidence.', details);
  if (status === 429) return new ManagedAgentError('AGENT_RATE_LIMIT', 'Anthropic has temporarily limited agent requests. Wait before continuing.', details);
  if (status >= 500) return new ManagedAgentError('AGENT_UNAVAILABLE', 'Claude Managed Agents is temporarily unavailable. Check the session before retrying.', details);
  return new ManagedAgentError('AGENT_REQUEST', 'Anthropic rejected the agent request. Check the selected model and Managed Agents configuration in Claude Console.', details);
}
function deadline(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const failure = () => timedOut ? timeoutError() : abortError();
  const race = promise => new Promise((resolve, reject) => {
    const stopped = () => { cleanup(); reject(failure()); };
    const cleanup = () => controller.signal.removeEventListener('abort', stopped);
    if (controller.signal.aborted) { reject(failure()); return; }
    controller.signal.addEventListener('abort', stopped, {once: true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  return {signal: controller.signal, failure, race, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }};
}
function cancelBody(stream) {
  // Cleanup must not make an already timed-out request wait on a stalled stream.
  try { Promise.resolve(stream?.cancel()).catch(() => {}); } catch {}
}
async function responseJSON(response, timer, limit = RESPONSE_LIMIT) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > limit) { cancelBody(response.body); fail('AGENT_RESPONSE', 'Claude returned an oversized agent response.'); }
  let raw = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0;
    try {
      while (true) {
        const {done, value} = await timer.race(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > limit) fail('AGENT_RESPONSE', 'Claude returned an oversized agent response.');
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } finally { cancelBody(reader); }
  } else {
    raw = await timer.race(response.text());
    if (new TextEncoder().encode(raw).byteLength > limit) fail('AGENT_RESPONSE', 'Claude returned an oversized agent response.');
  }
  try { return JSON.parse(raw); } catch { fail('AGENT_RESPONSE', 'Claude returned an unreadable agent response.'); }
}
function cursorValue(value) {
  if (value == null) return {processedAt: null, seenIds: []};
  if (!object(value) || Object.keys(value).some(key => !['processedAt', 'seenIds'].includes(key)) || (value.processedAt !== null && (typeof value.processedAt !== 'string' || value.processedAt.length > 40 || !Number.isFinite(Date.parse(value.processedAt)))) || !Array.isArray(value.seenIds) || value.seenIds.length > MAX_EVENTS || value.seenIds.some(item => !id(item, 'sevt'))) fail('AGENT_CURSOR', 'The agent event cursor is invalid.');
  return {processedAt: value.processedAt, seenIds: [...new Set(value.seenIds)]};
}
function advanceCursor(cursor, event) {
  if (!event.processed_at) return cursor;
  const seenIds = [...new Set([...cursor.seenIds, event.id])];
  if (seenIds.length > MAX_EVENTS) fail('AGENT_LIMIT', 'The agent event history is too large to resume safely. Start a new agent session.');
  // processedAt is informational only. Cumulative IDs also recognize events
  // that become visible after a later event, with an earlier processed_at.
  const processedAt = !cursor.processedAt || Date.parse(event.processed_at) > Date.parse(cursor.processedAt) ? event.processed_at : cursor.processedAt;
  return {processedAt, seenIds};
}
function eventList(value, max = MAX_EVENTS) {
  if (!object(value) || !Array.isArray(value.data) || value.data.length > max) fail('AGENT_RESPONSE', 'Claude returned an invalid agent event list.');
  for (const event of value.data) {
    if (!object(event) || !id(event.id, 'sevt') || !text(event.type, 100) || (event.processed_at != null && (!text(event.processed_at, 40) || !Number.isFinite(Date.parse(event.processed_at))))) fail('AGENT_RESPONSE', 'Claude returned an invalid agent event.');
    if (event.type === 'agent.custom_tool_use' && (!text(event.name, 128) || !object(event.input) || !event.processed_at)) fail('AGENT_RESPONSE', 'Claude returned an invalid custom tool request.');
    if (event.type === 'agent.custom_tool_use') json(event.input, TOOL_INPUT_LIMIT);
  }
  return value;
}

export function createManagedAgentsClient({apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30000, pollIntervalMs = 1000} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length < 20 || apiKey.trim().length > 512 || /[^\x21-\x7e]/.test(apiKey.trim())) fail('AGENT_AUTH', 'Enter a valid Anthropic API key in AI settings.');
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10000) fail('AGENT_CONFIG', 'The agent connection configuration is invalid.');
  const key = apiKey.trim();
  async function request(path, {method = 'GET', body, signal, responseLimit = RESPONSE_LIMIT} = {}) {
    if (signal?.aborted) throw abortError();
    const serialized = body === undefined ? undefined : json(body);
    const timer = deadline(signal, timeoutMs); let dispatched = false;
    try {
      dispatched = true;
      const response = await timer.race(fetchImpl(`${BASE}${path}`, {method, body: serialized, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {'content-type': 'application/json', 'anthropic-version': MANAGED_AGENTS_API_VERSION, 'anthropic-beta': MANAGED_AGENTS_BETA, 'x-api-key': key, 'anthropic-dangerous-direct-browser-access': 'true'}}));
      const candidate = response.headers?.get?.('request-id');
      const requestId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : undefined;
      if (!response.ok) { cancelBody(response.body); throw httpError(response.status, requestId); }
      if (response.status === 204) return null;
      return await responseJSON(response, timer, responseLimit);
    } catch (error) {
      const safe = error instanceof ManagedAgentError ? error : timer.signal.aborted ? timer.failure() : new ManagedAgentError('AGENT_NETWORK', 'Could not reach Claude Managed Agents. Check your connection and the session status before continuing.');
      // A server error or lost response cannot establish whether a mutation was applied.
      if (method !== 'GET' && dispatched && (!safe.status || safe.status >= 500)) safe.ambiguous = true;
      throw safe;
    } finally { timer.dispose(); }
  }
  const sessionPath = sessionId => {
    if (!id(sessionId, 'sesn')) fail('AGENT_CONFIG', 'The saved agent session identifier is invalid.');
    return `/sessions/${encodeURIComponent(sessionId)}`;
  };
  const client = {
    async createAgent(definition, {signal} = {}) {
      const result = await request('/agents', {method: 'POST', body: agentDefinition(definition), signal});
      if (!object(result) || !id(result.id, 'agent') || result.type !== 'agent') throw new ManagedAgentError('AGENT_RESPONSE', 'Claude did not return a valid agent identifier. Check Claude Console before reconnecting.', {ambiguous: true});
      return result;
    },
    async getAgent(agentId, {version, signal} = {}) {
      if (!id(agentId, 'agent') || (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 2147483647))) fail('AGENT_CONFIG', 'The saved agent identifier or version is invalid.');
      const query = version === undefined ? '' : `?version=${version}`;
      const result = await request(`/agents/${encodeURIComponent(agentId)}${query}`, {signal});
      if (!object(result) || result.id !== agentId || result.type !== 'agent' || !Number.isInteger(result.version) || result.version < 1 || (version !== undefined && result.version !== version)) fail('AGENT_RESPONSE', 'Claude returned an invalid agent configuration.');
      return result;
    },
    async updateAgent(agentId, definition, {version, signal} = {}) {
      if (!id(agentId, 'agent') || !Number.isInteger(version) || version < 1 || version >= 2147483647) fail('AGENT_CONFIG', 'Read the latest agent version before updating its definition.');
      const result = await request(`/agents/${encodeURIComponent(agentId)}`, {method: 'POST', body: {...agentDefinition(definition), version}, signal});
      if (!object(result) || result.id !== agentId || result.type !== 'agent' || !Number.isInteger(result.version) || result.version <= version) {
        throw new ManagedAgentError('AGENT_RESPONSE', 'Claude did not confirm the updated agent version. Check the saved definition before retrying.', {ambiguous: true});
      }
      return result;
    },
    async createEnvironment({signal} = {}) {
      const result = await request('/environments', {method: 'POST', signal, body: {name: 'Diffuse browser tools', description: 'Browser actions run in the Diffuse extension. This sandbox has no network access or installed packages.', config: {type: 'cloud', networking: {type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false}}}});
      if (!object(result) || !id(result.id, 'env') || result.type !== 'environment') throw new ManagedAgentError('AGENT_RESPONSE', 'Claude did not return a valid environment identifier. Check Claude Console before reconnecting.', {ambiguous: true});
      return result;
    },
    async getEnvironment(environmentId, {signal} = {}) {
      if (!id(environmentId, 'env')) fail('AGENT_CONFIG', 'The saved agent environment identifier is invalid.');
      const result = await request(`/environments/${encodeURIComponent(environmentId)}`, {signal});
      if (!object(result) || result.id !== environmentId || result.type !== 'environment' || !object(result.config)) fail('AGENT_RESPONSE', 'Claude returned an invalid agent environment configuration.');
      return result;
    },
    async createSession({agentId, agentVersion, environmentId, model, budgetUsd, signal} = {}) {
      if (!id(agentId, 'agent') || !id(environmentId, 'env')) fail('AGENT_CONFIG', 'Connect the Diffuse agents before starting a session.');
      if (agentVersion !== undefined && (!Number.isInteger(agentVersion) || agentVersion < 1)) fail('AGENT_CONFIG', 'The saved agent version is invalid.');
      const cents = Math.round(budgetUsd * 100);
      if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd < 0.01 || budgetUsd > 100 || Math.abs(cents - budgetUsd * 100) > 1e-6) fail('AGENT_CONFIG', 'Set an agent session budget between $0.01 and $100, in whole cents.');
      const version = agentVersion === undefined ? {} : {version: agentVersion};
      const agent = model === undefined ? agentVersion === undefined ? agentId : {type: 'agent', id: agentId, ...version} : {type: 'agent_with_overrides', id: agentId, ...version, model: modelConfig(model)};
      const result = await request('/sessions', {method: 'POST', signal, body: {agent, environment_id: environmentId, budget: {type: 'limit', max_list_cost: {amount: String(cents), currency: 'USD'}}}});
      if (!object(result) || !id(result.id, 'sesn') || result.type !== 'session') throw new ManagedAgentError('AGENT_RESPONSE', 'Claude did not return a valid session identifier. Check Claude Console before retrying.', {ambiguous: true});
      return result;
    },
    async sendEvents(sessionId, events, {signal} = {}) {
      // The API echoes accepted events, including inline images. Permit one
      // bounded echo of our request without raising the smaller polling limit.
      const result = await request(`${sessionPath(sessionId)}/events`, {method: 'POST', body: {events: outboundEvents(events)}, signal, responseLimit: EVENT_ACK_LIMIT});
      try { return eventList(result, 16); }
      catch (error) { error.ambiguous = true; throw error; }
    },
    async listEvents(sessionId, {after, signal} = {}) {
      const original = cursorValue(after); let cursor = original; let page = null;
      const data = []; const seen = new Set(original.seenIds); const pages = new Set();
      for (let index = 0; index < MAX_PAGES; index++) {
        const query = new URLSearchParams({order: 'asc', limit: '100'});
        // The API's created_at filters compare processed_at, but a timestamp
        // cutoff can miss late-visible events. Read bounded filtered history
        // and deduplicate by stable IDs, including across page boundaries.
        for (const type of TRACKED_TYPES) query.append('types[]', type);
        if (page) query.set('page', page);
        const result = eventList(await request(`${sessionPath(sessionId)}/events?${query}`, {signal}));
        if (result.next_page != null && (!text(result.next_page, 2048) || pages.has(result.next_page))) fail('AGENT_RESPONSE', 'Claude returned an invalid event pagination cursor.');
        for (const event of result.data) {
          // Queued events have null processed_at and are returned once processed.
          if (!TRACKED_TYPES.has(event.type) || !event.processed_at || seen.has(event.id)) continue;
          if (data.length >= MAX_EVENTS) fail('AGENT_LIMIT', 'Too many agent events were returned at once. The journey stopped.');
          seen.add(event.id); data.push(event); cursor = advanceCursor(cursor, event);
        }
        if (!result.next_page) return {data, cursor};
        page = result.next_page; pages.add(page);
      }
      fail('AGENT_LIMIT', 'The agent event history is too large to read safely in one request.');
    },
    async getSession(sessionId, {signal} = {}) {
      const result = await request(sessionPath(sessionId), {signal});
      if (!object(result) || result.id !== sessionId || result.type !== 'session' || !['idle', 'running', 'rescheduling', 'terminated'].includes(result.status)) fail('AGENT_RESPONSE', 'Claude returned an invalid session status.');
      return result;
    },
    interrupt(sessionId, {signal} = {}) { return client.sendEvents(sessionId, [{type: 'user.interrupt'}], {signal}); },
    deleteSession(sessionId, {signal} = {}) { return request(sessionPath(sessionId), {method: 'DELETE', signal}); },
    async waitForTool(sessionId, {after, toolNames, signal, timeoutMs: waitTimeoutMs = 180000} = {}) {
      if (!Array.isArray(toolNames) || !toolNames.length || toolNames.length > 16 || toolNames.some(name => !/^[A-Za-z0-9_-]{1,128}$/.test(name)) || !Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 600000) fail('AGENT_CONFIG', 'The expected agent tool configuration is invalid.');
      let cursor = cursorValue(after); let observedWork = false; let processedCount = 0;
      const timer = deadline(signal, waitTimeoutMs);
      try {
        while (true) {
          const result = await timer.race(client.listEvents(sessionId, {after: cursor, signal: timer.signal}));
          let ended = false;
          for (const event of result.data) {
            if (++processedCount > MAX_EVENTS) fail('AGENT_LIMIT', 'The agent produced too many events without completing an action.');
            cursor = advanceCursor(cursor, event);
            if (event.type === 'session.error') fail('AGENT_SESSION', 'Claude reported an agent session error. The journey stopped; inspect the session in Claude Console.');
            if (event.type === 'session.status_terminated') fail('AGENT_TERMINATED', 'The Claude agent session has ended. Start a new session to continue.');
            if (event.type === 'session.status_idle' && event.stop_reason?.type === 'budget_reached') fail('AGENT_BUDGET', 'This agent session reached its spending limit. The journey stopped.');
            if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') fail('AGENT_TOOL', 'The agent requested a capability that is not enabled for this journey.');
            if (event.type === 'agent.custom_tool_use') {
              if (!toolNames.includes(event.name)) fail('AGENT_TOOL', 'The agent requested an unexpected browser tool. The journey stopped.');
              return {toolUseId: event.id, name: event.name, input: event.input, cursor};
            }
            if (['session.status_running', 'agent.message'].includes(event.type)) observedWork = true;
            if (event.type === 'session.status_idle' && event.stop_reason?.type === 'end_turn' && observedWork) ended = true;
            if (event.type === 'session.status_running') ended = false;
          }
          if (ended) {
            const session = await timer.race(client.getSession(sessionId, {signal: timer.signal}));
            if (session.status === 'idle') fail('AGENT_INCOMPLETE', 'The agent finished its turn without supplying the expected action. The journey stopped.');
            if (session.status === 'terminated') fail('AGENT_TERMINATED', 'The Claude agent session has ended. Start a new session to continue.');
          }
          await timer.race(new Promise(resolve => setTimeout(resolve, pollIntervalMs)));
        }
      } catch (error) { if (timer.signal.aborted) throw timer.failure(); throw error; }
      finally { timer.dispose(); }
    },
  };
  return Object.freeze(client);
}
