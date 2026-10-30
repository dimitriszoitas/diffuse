import {createManagedAgentsClient} from './claude-agents-client.mjs';
import {journeyAgentDefinitions, JOURNEY_AGENT_REVISION, JOURNEY_AGENT_MODEL} from './journey-agent-definitions.mjs';
import {validateAPIKey} from './ai-client.mjs';

const STORAGE_KEY = 'diffuseJourneyAgents';
let settingUp = null;
export async function agentAccountFingerprint(apiKey) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(validateAPIKey(apiKey)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function resourceReady(saved) {
  return Boolean(saved?.actor?.id && Number.isInteger(saved.actor.version) && saved.actor.version > 0 && saved?.evaluator?.id && Number.isInteger(saved.evaluator.version) && saved.evaluator.version > 0 && saved?.environmentId);
}
function pinnedRevision(saved) {
  return structuredClone(Object.fromEntries(['account', 'revision', 'model', 'actor', 'evaluator', 'environmentId'].filter(key => saved[key] !== undefined).map(key => [key, saved[key]])));
}
function revisionModel(saved) {
  if (typeof saved?.model === 'string' && saved.model) return saved.model;
  // Versions one and two were released only with Fable 5. Never relabel an
  // older saved session with the current release's model after an upgrade.
  if (['diffuse-journeys-1', 'diffuse-journeys-2'].includes(saved?.revision)) return 'claude-fable-5';
  return saved?.revision === JOURNEY_AGENT_REVISION ? JOURNEY_AGENT_MODEL : undefined;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function matchesDefinition(agent, definition) {
  const actual = Object.fromEntries(Object.keys(definition).map(key => [key, agent[key]]));
  if (actual.model && typeof actual.model === 'object' && !Array.isArray(actual.model)) {
    actual.model = {...actual.model};
    if (definition.model.speed === undefined && (actual.model.speed == null || actual.model.speed === 'standard')) delete actual.model.speed;
    if (definition.model.inference_geo === undefined && actual.model.inference_geo == null) delete actual.model.inference_geo;
  }
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(definition)) &&
    (!agent.mcp_servers || agent.mcp_servers.length === 0) && (!agent.skills || agent.skills.length === 0) && agent.multiagent == null;
}
export async function readJourneyAgents(apiKey, {storage = chrome.storage.local, revision = JOURNEY_AGENT_REVISION} = {}) {
  if (!apiKey) return {ready: false, reason: 'Save your Anthropic API key first.'};
  const account = await agentAccountFingerprint(apiKey);
  const saved = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved?.account !== account || typeof revision !== 'string') return {ready: false, reason: 'Set up the journey agents for this API key.'};
  // A partial upgrade must not expose a mix of old and new pinned definitions.
  // Older saved runs explicitly request the preserved revision they used.
  const selected = saved.revision === revision && !saved.pendingRevision ? saved
    : Object.hasOwn(saved.previousRevisions || {}, revision) ? saved.previousRevisions[revision] : null;
  if (!selected || selected.account !== account || selected.revision !== revision) return {ready: false, reason: 'Check journey agents in AI settings to finish updating their definitions.'};
  const ready = resourceReady(selected);
  return {...selected, ready, model: revisionModel(selected), reason: ready ? '' : 'Complete the journey agent setup.'};
}

// Only a deliberate settings action calls this function. No keys are stored in
// agent definitions, metadata, reports, or the provisioning record.
export async function setupJourneyAgents({apiKey, storage = chrome.storage.local, client = createManagedAgentsClient({apiKey}), signal} = {}) {
  if (settingUp) throw new Error('Journey agent setup is already in progress.');
  settingUp = true;
  try {
    const account = await agentAccountFingerprint(apiKey);
    const previous = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    const saved = previous?.account === account
      ? structuredClone(previous) : {account, revision: JOURNEY_AGENT_REVISION, model: JOURNEY_AGENT_MODEL};
    const persist = () => storage.set({[STORAGE_KEY]: saved});
    const definitions = journeyAgentDefinitions();
    if (saved.revision !== JOURNEY_AGENT_REVISION && saved.pendingRevision !== JOURNEY_AGENT_REVISION) {
      // Preserve exact historical pins before replacing either role. Agent IDs
      // stay the same; Claude retains the old versions for existing sessions.
      saved.previousRevisions = {...saved.previousRevisions,
        ...(!Object.hasOwn(saved.previousRevisions || {}, saved.revision) ? {[saved.revision]: pinnedRevision(saved)} : {})};
      saved.pendingRevision = JOURNEY_AGENT_REVISION;
      saved.roleRevisions = {actor: saved.revision, evaluator: saved.revision};
      await persist();
    }
    for (const role of ['actor', 'evaluator']) {
      if (saved[role]?.id) {
        try {
          const upgrading = saved.pendingRevision === JOURNEY_AGENT_REVISION && saved.roleRevisions?.[role] !== JOURNEY_AGENT_REVISION;
          const agent = await client.getAgent(saved[role].id, {...(upgrading ? {} : {version: saved[role].version}), signal});
          if (agent.archived_at) {
            // Archive is irreversible. The explicit setup gesture may replace
            // this unusable definition without touching its historical sessions.
            delete saved[role];
            await persist();
          } else {
            if (!upgrading && (agent.model?.id !== JOURNEY_AGENT_MODEL || agent.model?.effort?.type !== 'max')) throw new Error('The saved agent configuration has changed. Restore Claude Opus 5.5 with Max effort in Claude Console before checking again.');
            if (upgrading) {
              // Read latest before each update and use its version as the
              // optimistic concurrency check. A lost response is recovered by
              // rereading the desired definition, never by blind POST retry.
              const updated = matchesDefinition(agent, definitions[role]) ? agent
                : await client.updateAgent(agent.id, definitions[role], {version: agent.version, signal});
              if (updated.id !== saved[role].id || !Number.isInteger(updated.version) || updated.version < agent.version) throw new Error('Claude did not confirm the updated agent definition. Check Claude Console before retrying.');
              saved[role] = {id: updated.id, version: updated.version};
              saved.roleRevisions[role] = JOURNEY_AGENT_REVISION;
              await persist();
            }
            continue;
          }
        } catch (error) {
          if (error.status !== 404 && error.code !== 'AGENT_NOT_FOUND') throw error;
          delete saved[role];
          await persist();
        }
      }
      const agent = await client.createAgent(definitions[role], {signal});
      if (!Number.isInteger(agent.version) || agent.version < 1) throw new Error('Claude did not return a version for the new agent. Check your Claude Console before retrying setup.');
      saved[role] = {id: agent.id, version: agent.version};
      if (saved.pendingRevision) saved.roleRevisions[role] = JOURNEY_AGENT_REVISION;
      await persist();
    }
    if (saved.environmentId) {
      try {
        const environment = await client.getEnvironment(saved.environmentId, {signal});
        const network = environment.config?.networking;
        if (environment.config?.type !== 'cloud' || network?.type !== 'limited' || network.allowed_hosts?.length !== 0 || network.allow_package_managers !== false || network.allow_mcp_servers !== false) {
          throw new Error('The saved environment configuration has changed. Restore its restricted network settings in Claude Console before checking again.');
        }
      } catch (error) {
        if (error.status !== 404 && error.code !== 'AGENT_NOT_FOUND') throw error;
        delete saved.environmentId;
        await persist();
      }
    }
    if (!saved.environmentId) {
      const environment = await client.createEnvironment({signal});
      saved.environmentId = environment.id;
      await persist();
    }
    if (saved.pendingRevision) {
      saved.revision = JOURNEY_AGENT_REVISION;
      saved.model = JOURNEY_AGENT_MODEL;
      delete saved.pendingRevision;
      delete saved.roleRevisions;
      await persist();
    }
    return {...saved, ready: true};
  } finally { settingUp = null; }
}

export function publicJourneyAgentsStatus(agents) {
  return {ready: agents.ready === true, model: revisionModel(agents) || JOURNEY_AGENT_MODEL, effort: 'max', reason: agents.reason || ''};
}
