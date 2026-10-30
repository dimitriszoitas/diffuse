import {ManagedAgentError} from './claude-agents-client.mjs';
import {createOpenAIAgentsClient, OPENAI_AGENT_MODEL, matchesOpenAIAgentDefinition, openAIAgentAccountFingerprint, pinOpenAIAgent} from './openai-agents-client.mjs';
import {journeyAgentDefinitions, JOURNEY_AGENT_REVISION} from './journey-agent-definitions.mjs';
import {reviewAgentDefinition, REVIEW_AGENT_REVISION, REVIEW_KNOWLEDGE_REVISION, REVIEW_KNOWLEDGE_CHECKED_AT, REVIEW_KNOWLEDGE_SOURCES, REVIEW_KNOWLEDGE_RULES} from './review-agent-definitions.mjs';

export {OPENAI_AGENT_MODEL, openAIAgentAccountFingerprint};
export const OPENAI_JOURNEY_AGENT_REVISION = `${JOURNEY_AGENT_REVISION}-openai-1`;
export const OPENAI_REVIEW_AGENT_REVISION = `${REVIEW_AGENT_REVISION}-openai-1`;
const PREFIX = 'diffuseOpenAIAgents:';
const settingUp = new Set();
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{1,160}$/.test(value);
const error = (code, message) => new ManagedAgentError(code, message);
const unknown = () => error('AGENT_SETUP_UNCERTAIN', 'OpenAI did not confirm the last agent creation. Check Agents in OpenAI Platform before reconnecting; Diffuse has not created a duplicate.');
const uncertain = cause => cause?.ambiguous === true || !Number.isInteger(cause?.status) || cause.status >= 500;
const snapshot = saved => structuredClone(Object.fromEntries(['provider', 'account', 'revision', 'model', 'actor', 'evaluator', 'reviewer', 'environmentId', 'verified', 'knowledgeRevision', 'checkedAt'].filter(key => saved[key] !== undefined).map(key => [key, saved[key]])));
function details(kind) {
  if (kind === 'journey') return {revision: OPENAI_JOURNEY_AGENT_REVISION, roles: ['actor', 'evaluator'], definitions: journeyAgentDefinitions()};
  return {revision: OPENAI_REVIEW_AGENT_REVISION, roles: ['reviewer'], definitions: {reviewer: reviewAgentDefinition()}};
}
function definitionFor(kind, role) {
  const {definitions, revision} = details(kind), definition = structuredClone(definitions[role]);
  definition.model = {id: OPENAI_AGENT_MODEL, effort: {type: 'max'}};
  definition.metadata = {...definition.metadata, diffuse_revision: revision, diffuse_provider: 'openai'};
  return definition;
}
export function openAIJourneyAgentDefinitions() { return {actor: definitionFor('journey', 'actor'), evaluator: definitionFor('journey', 'evaluator')}; }
export function openAIReviewAgentDefinition() { return definitionFor('review', 'reviewer'); }
function pinned(saved, roles) {
  return saved?.provider === 'openai' && saved?.environmentId === 'none' && saved?.model === OPENAI_AGENT_MODEL && roles.every(role => identifier(saved[role]?.id) && saved[role].version === 1);
}
async function read(kind, apiKey, {storage = globalThis.chrome?.storage?.local, revision = details(kind).revision} = {}) {
  if (!apiKey) return {provider: 'openai', ready: false, reason: 'Save your OpenAI API key first.'};
  if (!storage?.get) throw error('AGENT_STORAGE', 'Local extension storage is unavailable.');
  const account = await openAIAgentAccountFingerprint(apiKey), key = `${PREFIX}${account}:${kind}`, latest = (await storage.get(key))[key];
  const saved = latest?.revision === revision ? latest : typeof revision === 'string' && Object.hasOwn(latest?.previousRevisions || {}, revision) ? latest.previousRevisions[revision] : null;
  if (!saved || saved.account !== account) return {provider: 'openai', ready: false, reason: `Set up the OpenAI ${kind === 'journey' ? 'journey agents' : 'UX & Accessibility Reviewer'} for this API key.`};
  const ready = pinned(saved, details(kind).roles) && saved.verified === true && !saved.pendingCreation && (kind !== 'review' || saved.knowledgeRevision === REVIEW_KNOWLEDGE_REVISION);
  return {...structuredClone(saved), ready, reason: ready ? '' : saved.pendingCreation ? unknown().message : 'Check the OpenAI agents in AI settings to finish setup.'};
}
export function readOpenAIJourneyAgents(apiKey, options) { return read('journey', apiKey, options); }
export function readOpenAIReviewAgent(apiKey, options) { return read('review', apiKey, options); }

async function verify(kind, saved, {client, signal} = {}) {
  const {roles, revision} = details(kind);
  if (!saved?.ready || !pinned(saved, roles) || saved.revision !== revision || (kind === 'review' && saved.knowledgeRevision !== REVIEW_KNOWLEDGE_REVISION)) throw error('AGENT_SETUP', 'Set up the OpenAI agents in AI settings first.');
  for (const role of roles) {
    const agent = await client.getAgent(saved[role].id, {version: 1, signal});
    if (agent.id !== saved[role].id || agent.version !== 1 || !matchesOpenAIAgentDefinition(agent, definitionFor(kind, role))) throw error('AGENT_CONFIG_CHANGED', 'A saved OpenAI agent definition changed in Platform. Restore its Diffuse configuration before running it.');
  }
  return saved;
}
export function verifyOpenAIJourneyAgents(saved, options) { return verify('journey', saved, options); }
export function verifyOpenAIReviewAgent(saved, options) { return verify('review', saved, options); }

// Provisioning is deliberately separate from inference and requires the settings
// setup gesture. Each confirmed agent is saved before creating the next one.
// OpenAI agents are mutable and do not expose versions, so a new Diffuse
// revision gets new IDs. Historical IDs and definitions remain pinned locally.
async function setup(kind, {apiKey, storage = globalThis.chrome?.storage?.local, client, signal} = {}) {
  if (!storage?.get || !storage?.set) throw error('AGENT_STORAGE', 'Local extension storage is unavailable.');
  const account = await openAIAgentAccountFingerprint(apiKey), key = `${PREFIX}${account}:${kind}`;
  if (settingUp.has(key)) throw error('AGENT_SETUP_BUSY', 'OpenAI agent setup is already in progress.');
  settingUp.add(key);
  try {
    client ||= createOpenAIAgentsClient({apiKey, storage});
    const {roles, revision} = details(kind), previous = (await storage.get(key))[key];
    let saved = previous?.account === account ? structuredClone(previous) : {provider: 'openai', account, revision, model: OPENAI_AGENT_MODEL, environmentId: 'none'};
    if (saved.pendingCreation) throw unknown();
    if (saved.revision !== revision) {
      const previousRevisions = {...saved.previousRevisions, [saved.revision]: snapshot(saved)};
      saved = {provider: 'openai', account, revision, model: OPENAI_AGENT_MODEL, environmentId: 'none', previousRevisions};
    }
    const persist = () => storage.set({[key]: saved});
    saved.verified = false; await persist();
    for (const role of roles) {
      const definition = definitionFor(kind, role);
      if (saved[role]?.id) {
        try {
          const agent = await client.getAgent(saved[role].id, {version: 1, signal});
          if (agent.version !== 1 || !matchesOpenAIAgentDefinition(agent, definition)) throw error('AGENT_CONFIG_CHANGED', 'A saved OpenAI agent definition changed in Platform. Restore its Diffuse configuration before checking again.');
        } catch (cause) {
          if (cause.status !== 404 && cause.code !== 'AGENT_NOT_FOUND') throw cause;
          delete saved[role]; await persist();
        }
      }
      if (!saved[role]) {
        saved.pendingCreation = role; await persist();
        try {
          const agent = await client.createAgent(definition, {signal});
          if (!identifier(agent?.id) || agent.version !== 1 || !matchesOpenAIAgentDefinition(agent, definition)) throw unknown();
          saved[role] = {id: agent.id, version: 1}; delete saved.pendingCreation; await persist();
        } catch (cause) {
          if (!uncertain(cause)) { delete saved.pendingCreation; await persist(); throw cause; }
          throw unknown();
        }
      }
      await pinOpenAIAgent({apiKey, agentId: saved[role].id, definition, storage});
    }
    if (kind === 'review') Object.assign(saved, {knowledgeRevision: REVIEW_KNOWLEDGE_REVISION, checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT});
    await verify(kind, {...saved, ready: true}, {client, signal});
    saved.verified = true; await persist();
    return {...saved, ready: true};
  } finally { settingUp.delete(key); }
}
export function setupOpenAIJourneyAgents(options) { return setup('journey', options); }
export function setupOpenAIReviewAgent(options) { return setup('review', options); }
export function publicOpenAIJourneyAgentsStatus(saved) {
  return {provider: 'openai', ready: saved?.ready === true, model: OPENAI_AGENT_MODEL, effort: 'max', spendingGuard: 'estimate', reason: saved?.reason || ''};
}
export function publicOpenAIReviewAgentStatus(saved) {
  return {...publicOpenAIJourneyAgentsStatus(saved), checkedAt: REVIEW_KNOWLEDGE_CHECKED_AT, knowledgeRevision: REVIEW_KNOWLEDGE_REVISION, sourceCount: REVIEW_KNOWLEDGE_SOURCES.length, ruleCount: REVIEW_KNOWLEDGE_RULES.length};
}
