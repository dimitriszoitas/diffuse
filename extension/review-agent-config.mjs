import {createManagedAgentsClient, ManagedAgentError} from './claude-agents-client.mjs';
import {agentAccountFingerprint} from './journey-agent-config.mjs';
import {reviewAgentDefinition, REVIEW_AGENT_REVISION, REVIEW_AGENT_MODEL, REVIEW_KNOWLEDGE_REVISION, REVIEW_KNOWLEDGE_CHECKED_AT, REVIEW_KNOWLEDGE_SOURCES, REVIEW_KNOWLEDGE_RULES} from './review-agent-definitions.mjs';

const STORAGE_KEY = 'diffuseReviewAgent';
let settingUp = false;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identifier = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value);
const current = saved => saved?.revision === REVIEW_AGENT_REVISION && saved?.knowledgeRevision === REVIEW_KNOWLEDGE_REVISION;
const pinned = saved => identifier(saved?.reviewer?.id, 'agent') && Number.isInteger(saved.reviewer.version) && saved.reviewer.version > 0 && identifier(saved?.environmentId, 'env');
function matchesDefinition(agent, definition) {
  const actual = Object.fromEntries(Object.keys(definition).map(key => [key, agent[key]]));
  // Claude can return optional defaults that were omitted in the request.
  // Normalize only documented null/unset geo and ordinary inference speed;
  // explicit geo pins, premium speed and unknown model settings remain changes.
  if (actual.model && typeof actual.model === 'object' && !Array.isArray(actual.model)) {
    actual.model = {...actual.model};
    if (definition.model.speed === undefined && (actual.model.speed == null || actual.model.speed === 'standard')) delete actual.model.speed;
    if (definition.model.inference_geo === undefined && actual.model.inference_geo == null) delete actual.model.inference_geo;
  }
  return !agent.archived_at && JSON.stringify(canonical(actual)) === JSON.stringify(canonical(definition)) &&
    (!agent.mcp_servers || agent.mcp_servers.length === 0) && (!agent.skills || agent.skills.length === 0) && agent.multiagent == null;
}
function environmentRestricted(environment) {
  const network = environment?.config?.networking;
  return environment?.config?.type === 'cloud' && network?.type === 'limited' && Array.isArray(network.allowed_hosts) && network.allowed_hosts.length === 0 && network.allow_package_managers === false && network.allow_mcp_servers === false;
}
const error = (code, message) => new ManagedAgentError(code, message);
const unknownCreation = () => error('REVIEW_SETUP_UNCERTAIN', 'Claude did not confirm the last reviewer setup request. Check the agent or environment in Claude Console before reconnecting; Diffuse has not created a duplicate.');
const missing = cause => cause?.status === 404 || cause?.code === 'AGENT_NOT_FOUND';
const uncertain = cause => cause?.ambiguous === true || !Number.isInteger(cause?.status) || cause.status >= 500;

export async function readReviewAgent(apiKey, {storage = chrome.storage.local} = {}) {
  if (!apiKey) return {ready: false, reason: 'Save your Anthropic API key first.'};
  const account = await agentAccountFingerprint(apiKey);
  const saved = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved?.account !== account) return {ready: false, reason: 'Set up the UX & Accessibility Reviewer for this API key.'};
  const ready = current(saved) && pinned(saved) && saved.verified === true && !saved.pendingCreation && !saved.pendingUpdate;
  return {...saved, ready, model: REVIEW_AGENT_MODEL, reason: ready ? '' : saved.pendingCreation ? unknownCreation().message : 'Check the UX & Accessibility Reviewer in AI settings to finish setup.'};
}

// Verify the exact pinned definition and restricted environment before spending.
// No setup/update side effects or fallback inference are allowed here.
export async function verifyReviewAgent(saved, {client, signal} = {}) {
  if (!saved?.ready || !current(saved) || !pinned(saved)) throw error('REVIEW_SETUP', 'Set up the UX & Accessibility Reviewer in AI settings first.');
  const agent = await client.getAgent(saved.reviewer.id, {version: saved.reviewer.version, signal});
  if (agent.id !== saved.reviewer.id || agent.version !== saved.reviewer.version || !matchesDefinition(agent, reviewAgentDefinition())) {
    throw error('REVIEW_CONFIG_CHANGED', 'The saved reviewer definition has changed. Check the UX & Accessibility Reviewer in AI settings before running it.');
  }
  const environment = await client.getEnvironment(saved.environmentId, {signal});
  if (environment.id !== saved.environmentId || !environmentRestricted(environment)) throw error('REVIEW_CONFIG_CHANGED', 'The reviewer environment is no longer restricted. Restore its restricted network settings in Claude Console before checking again.');
  return saved;
}

// Provisioning requires the explicit settings action. Each confirmed resource is
// persisted separately; a lost creation response never triggers a blind retry.
export async function setupReviewAgent({apiKey, storage = chrome.storage.local, client = createManagedAgentsClient({apiKey}), signal} = {}) {
  if (settingUp) throw error('REVIEW_SETUP_BUSY', 'Reviewer setup is already in progress.');
  settingUp = true;
  try {
    const account = await agentAccountFingerprint(apiKey);
    const previous = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    const saved = previous?.account === account ? structuredClone(previous) : {account};
    if (saved.pendingCreation) throw unknownCreation();
    const definition = reviewAgentDefinition();
    const persist = () => storage.set({[STORAGE_KEY]: saved});
    saved.verified = false;
    await persist();
    if (saved.reviewer?.id) {
      try {
        const upgrading = !current(saved) || saved.pendingUpdate;
        const agent = await client.getAgent(saved.reviewer.id, {...(upgrading ? {} : {version: saved.reviewer.version}), signal});
        if (agent.archived_at) {
          delete saved.reviewer; await persist();
        } else if (upgrading) {
          saved.pendingUpdate = true; await persist();
          // If the previous update acknowledgement was lost, the desired latest
          // definition is already present and can be pinned without another POST.
          const updated = matchesDefinition(agent, definition) ? agent : await client.updateAgent(agent.id, definition, {version: agent.version, signal});
          if (updated.id !== saved.reviewer.id || !Number.isInteger(updated.version) || updated.version < agent.version) throw error('REVIEW_SETUP_UNCERTAIN', 'Claude did not confirm the updated reviewer version. Check its definition before retrying setup.');
          saved.reviewer = {id: updated.id, version: updated.version};
          saved.revision = REVIEW_AGENT_REVISION; saved.knowledgeRevision = REVIEW_KNOWLEDGE_REVISION;
          delete saved.pendingUpdate; await persist();
        } else if (!matchesDefinition(agent, definition)) {
          throw error('REVIEW_CONFIG_CHANGED', 'The saved reviewer configuration has changed. Restore its Diffuse definition in Claude Console before checking again.');
        }
      } catch (cause) {
        if (!missing(cause)) throw cause;
        delete saved.reviewer; delete saved.pendingUpdate; await persist();
      }
    }
    const create = async (kind, call, accept) => {
      saved.pendingCreation = kind; await persist();
      try {
        const value = await call();
        accept(value);
        delete saved.pendingCreation; await persist();
      } catch (cause) {
        if (!uncertain(cause)) { delete saved.pendingCreation; await persist(); throw cause; }
        // Keep the reservation even across extension reloads. It may represent
        // a real resource whose identifier was lost with the response.
        throw unknownCreation();
      }
    };
    if (!saved.reviewer) await create('reviewer', () => client.createAgent(definition, {signal}), agent => {
      if (!identifier(agent?.id, 'agent') || !Number.isInteger(agent.version) || agent.version < 1) throw unknownCreation();
      saved.reviewer = {id: agent.id, version: agent.version};
      saved.revision = REVIEW_AGENT_REVISION; saved.knowledgeRevision = REVIEW_KNOWLEDGE_REVISION;
    });
    if (saved.environmentId) {
      try {
        const environment = await client.getEnvironment(saved.environmentId, {signal});
        if (!environmentRestricted(environment)) throw error('REVIEW_CONFIG_CHANGED', 'The reviewer environment is no longer restricted. Restore its restricted network settings in Claude Console before checking again.');
      } catch (cause) {
        if (!missing(cause)) throw cause;
        delete saved.environmentId; await persist();
      }
    }
    if (!saved.environmentId) await create('environment', () => client.createEnvironment({signal}), environment => {
      if (!identifier(environment?.id, 'env')) throw unknownCreation();
      saved.environmentId = environment.id;
    });
    await verifyReviewAgent({...saved, ready: true}, {client, signal});
    Object.assign(saved, {verified: true, model: REVIEW_AGENT_MODEL, checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT});
    await persist();
    return {...saved, ready: true};
  } finally { settingUp = false; }
}

export function publicReviewAgentStatus(agent) {
  return {ready: agent?.ready === true, model: REVIEW_AGENT_MODEL, effort: 'max', reason: agent?.reason || '', checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT,
    knowledgeRevision: REVIEW_KNOWLEDGE_REVISION, sourceCount: REVIEW_KNOWLEDGE_SOURCES.length, ruleCount: REVIEW_KNOWLEDGE_RULES.length};
}
