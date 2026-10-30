import {sanitizeAIConfig, validateAPIKey} from './ai-client.mjs';
import {AI_PROVIDERS, normalizeAIProvider, aiProviderName, aiProviderOrigin, aiManagedModel, aiModelLabel} from './ai-providers.mjs';

const el = id => document.getElementById(id);
let hasKey = false;
let busy = false;
let selectedProvider = 'anthropic';
let activeProvider = 'anthropic';
let connections = {};
// Only newly entered values live here, for this settings tab's lifetime.
const drafts = Object.create(null);
let savedJourneyEngine = 'direct';
let agentsReady = false;
let agentStatusReason = '';
let savedReviewEngine = 'direct';
let reviewerReady = false;
let reviewerStatusReason = '';
const selectedReviewEngine = () => el('review-engine-managed').checked ? 'managed' : 'direct';
const selectedJourneyEngine = () => el('journey-engine-managed').checked ? 'managed' : 'direct';
const providerName = () => aiProviderName(selectedProvider);
const keyStatus = profile => profile?.hasKey ? (profile.rememberKey ? 'Key remembered' : 'Key ready for this session') : 'No key connected';
function renderProvider() {
  const name = providerName();
  for (const provider of AI_PROVIDERS) {
    el(`provider-${provider}`).checked = selectedProvider === provider;
    const entered = provider === selectedProvider ? el('api-key').value.trim() : drafts[provider]?.apiKey?.trim();
    el(`${provider}-connection-state`).textContent = entered ? 'New key · not saved yet' : keyStatus(connections[provider]);
  }
  el('ai-active-provider').textContent = `Using ${aiProviderName(activeProvider)}`;
  el('ai-provider-help').textContent = selectedProvider === activeProvider
    ? 'Save the selected provider to use it for new AI reviews, journey tests, and agents. Each connection keeps its own key and settings.'
    : `${name} is selected. Save settings or set up its agents to use it for new AI tasks. ${aiProviderName(activeProvider)} remains in use until then.`;
  el('ai-connection-heading').textContent = `${name} connection`;
  document.querySelector('label[for="api-key"]').textContent = `${name} API key`;
  el('model-label').textContent = selectedProvider === 'openai' ? 'OpenAI model' : 'Claude model';
  const modelLink = document.createElement('a');
  modelLink.href = selectedProvider === 'openai' ? 'https://developers.openai.com/api/docs/models' : 'https://platform.claude.com/docs/en/models/overview';
  modelLink.target = '_blank'; modelLink.rel = 'noopener noreferrer'; modelLink.textContent = 'See available models ↗';
  el('model-help').replaceChildren(document.createTextNode(`Use an ${name} model ID with vision and structured output support. `), modelLink);
  el('review-direct-description').textContent = `Review screenshots using your chosen ${selectedProvider === 'openai' ? 'OpenAI' : 'Claude'} model.`;
  el('journey-direct-description').textContent = `Diffuse manages the journey using your chosen ${selectedProvider === 'openai' ? 'OpenAI' : 'Claude'} model.`;
  el('journey-managed-label').textContent = `${selectedProvider === 'openai' ? 'OpenAI' : 'Claude'} agents`;
  const model = `${aiModelLabel(aiManagedModel(selectedProvider))} · Max effort`;
  el('review-managed-model').textContent = model;
  el('journey-managed-model').textContent = model;
  el('review-agent-notice').textContent = `${name} receives the review’s screenshots, instructions, and linked design context. API charges apply only when you run a review.`;
  el('journey-agent-notice').textContent = `${name} receives the journey’s conversation and evidence. API charges apply. Keep Chrome and the reviewed tab open while the journey runs.`;
  const estimated = selectedProvider === 'openai';
  document.querySelector('label[for="review-budget"]').textContent = estimated ? 'Estimated spending guard per review (USD)' : 'Spending limit per review (USD)';
  document.querySelector('label[for="journey-budget"]').textContent = estimated ? 'Estimated journey spending guard (USD)' : 'Journey spending limit (USD)';
  el('review-budget-help').textContent = estimated
    ? 'Diffuse checks reported usage between requests. A request already running can exceed this amount.'
    : 'Applies to each screenshot review. Usage may exceed the limit by the final request already in progress.';
  el('journey-budget-help').textContent = estimated
    ? 'Shared between the journey agent (75%) and evaluator (25%). Diffuse checks reported usage between requests. A request already running can exceed this amount.'
    : 'Shared between the journey agent (75%) and evaluator (25%). Usage may exceed the limit by the final request already in progress.';
  el('clear-key').textContent = `Remove ${name} key`;
  const consoleLink = el('provider-console-link');
  if (consoleLink) {
    consoleLink.href = estimated ? 'https://platform.openai.com/api-keys' : 'https://platform.claude.com/settings/keys';
    consoleLink.textContent = `Manage ${name} API keys ↗`;
  }
}
function renderReviewSettings() {
  const managed = selectedReviewEngine() === 'managed';
  const hasNewKey = !!el('api-key').value.trim();
  el('review-agent-options').hidden = !managed;
  el('review-budget').disabled = busy || !managed;
  el('setup-review-agent').disabled = busy || !(hasKey || hasNewKey);
  el('setup-review-agent').textContent = reviewerReady && !hasNewKey ? 'Check reviewer' : 'Set up reviewer';
  el('review-agent-status').textContent = !managed ? 'Direct' : reviewerReady && !hasNewKey ? 'Reviewer ready' : 'Setup needed';
  el('review-agent-status').dataset.ready = String(managed && reviewerReady && !hasNewKey);
  el('review-agent-help').textContent = hasNewKey
    ? 'Set up the reviewer with this key before using it. Your key is saved using the preference above.'
    : reviewerStatusReason || (reviewerReady
      ? 'Your reviewer is ready. Save settings to use your selected engine and spending limit.'
      : `Diffuse creates one reviewer in your ${selectedProvider === 'openai' ? 'OpenAI' : 'Claude'} account. Setup does not start a review.`);
}
function renderAgentSettings() {
  renderProvider();
  renderReviewSettings();
  const managed = selectedJourneyEngine() === 'managed';
  const hasNewKey = !!el('api-key').value.trim();
  el('journey-agent-options').hidden = !managed;
  el('journey-budget').disabled = busy || !managed;
  el('setup-journey-agents').disabled = busy || !(hasKey || hasNewKey);
  el('setup-journey-agents').textContent = agentsReady && !hasNewKey ? 'Check journey agents' : 'Set up journey agents';
  el('journey-agent-status').textContent = !managed ? 'Direct' : agentsReady && !hasNewKey ? 'Agents ready' : 'Setup needed';
  el('journey-agent-status').dataset.ready = String(managed && agentsReady && !hasNewKey);
  el('journey-agent-help').textContent = hasNewKey
    ? 'Set up the agents with this key before using them. Your key is saved using the preference above.'
    : agentStatusReason || (agentsReady
      ? 'Both agents are ready. Save settings to use your selected engine and spending limit.'
      : 'Use your existing API key. Diffuse sets up both agents for you; no console setup is needed. Setup does not start a journey.');
}
function hideEnteredKey() {
  el('api-key').value = '';
  el('api-key').type = 'password';
  el('toggle-key').textContent = 'Show';
  el('toggle-key').setAttribute('aria-label', 'Show entered API key');
  el('toggle-key').setAttribute('aria-pressed', 'false');
}
function setThreshold(value) {
  el('threshold').value = String(value);
  el('threshold-value').textContent = `${el('threshold').value} / 100`;
  el('threshold').setAttribute('aria-valuetext', `${el('threshold').value} out of 100`);
}
function rememberDraft() {
  drafts[selectedProvider] = {apiKey: el('api-key').value, model: el('model').value, threshold: el('threshold').value,
    rememberKey: el('remember-key').checked, reviewEngine: selectedReviewEngine(), journeyEngine: selectedJourneyEngine(),
    reviewBudgetUsd: el('review-budget').value, journeyBudgetUsd: el('journey-budget').value};
}
function restoreDraft(provider) {
  const draft = drafts[provider];
  if (!draft) return;
  el('api-key').value = draft.apiKey;
  el('model').value = draft.model;
  setThreshold(draft.threshold);
  el('remember-key').checked = draft.rememberKey;
  el('review-engine-direct').checked = draft.reviewEngine === 'direct';
  el('review-engine-managed').checked = draft.reviewEngine === 'managed';
  el('journey-engine-direct').checked = draft.journeyEngine === 'direct';
  el('journey-engine-managed').checked = draft.journeyEngine === 'managed';
  el('review-budget').value = draft.reviewBudgetUsd;
  el('journey-budget').value = draft.journeyBudgetUsd;
}
function formSettings() {
  const config = sanitizeAIConfig({provider: selectedProvider, model: el('model').value.trim(), threshold: Number(el('threshold').value), rememberKey: el('remember-key').checked});
  const apiKey = el('api-key').value.trim();
  if (apiKey) {
    try {
      validateAPIKey(apiKey, selectedProvider);
      const prefixMatches = selectedProvider === 'openai' ? apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-') : apiKey.startsWith('sk-ant-');
      if (!prefixMatches) throw new Error(`Enter a valid ${providerName()} API key beginning with ${selectedProvider === 'openai' ? 'sk-' : 'sk-ant-'}.`);
    } catch (error) { el('api-key').setAttribute('aria-invalid', 'true'); throw error; }
  }
  if (!apiKey && !hasKey) { el('api-key').setAttribute('aria-invalid', 'true'); throw new Error(`Paste your ${providerName()} API key to connect ${selectedProvider === 'openai' ? 'OpenAI' : 'Claude'}.`); }
  const journeyBudgetUsd = Number(el('journey-budget').value);
  if (!Number.isFinite(journeyBudgetUsd) || journeyBudgetUsd < 0.1 || journeyBudgetUsd > 20) {
    el('journey-budget').setAttribute('aria-invalid', 'true');
    throw new Error('Set the journey spending amount between $0.10 and $20 USD.');
  }
  const reviewBudgetUsd = Number(el('review-budget').value);
  if (!Number.isFinite(reviewBudgetUsd) || reviewBudgetUsd < 0.1 || reviewBudgetUsd > 20) {
    el('review-budget').setAttribute('aria-invalid', 'true');
    throw new Error('Set the review spending amount between $0.10 and $20 USD.');
  }
  return {...config, provider: selectedProvider, apiKey, journeyEngine: selectedJourneyEngine(), journeyBudgetUsd, reviewEngine: selectedReviewEngine(), reviewBudgetUsd};
}
const send = async (type, data = {}) => {
  let result;
  try { result = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, ...data}); }
  catch (error) {
    if (/receiving end does not exist|could not establish connection|message port closed|extension context invalidated/i.test(error?.message || '')) throw new Error('Diffuse could not connect. Reload this settings page and try again.');
    throw error;
  }
  if (!result?.ok) throw new Error(result?.error || 'Could not update AI settings. Try again.');
  return result;
};
function feedback(message, error = false) {
  el('ai-feedback').setAttribute('role', error ? 'alert' : 'status');
  el('ai-feedback').setAttribute('aria-live', error ? 'assertive' : 'polite');
  el('ai-feedback').textContent = message;
  el('ai-feedback').dataset.error = String(error);
  el('ai-feedback').hidden = !message;
  if (message && error) el('ai-feedback').focus();
}
function setBusy(value) {
  busy = value;
  el('ai-settings-form').setAttribute('aria-busy', String(value));
  el('save').disabled = value;
  el('clear-key').disabled = value || !hasKey;
  for (const id of ['provider-anthropic', 'provider-openai', 'api-key', 'toggle-key', 'remember-key', 'model', 'threshold', 'journey-engine-direct', 'journey-engine-managed', 'review-engine-direct', 'review-engine-managed']) el(id).disabled = value;
  renderAgentSettings();
}
function applyConfig(config, requestedProvider) {
  selectedProvider = normalizeAIProvider(config.provider ?? requestedProvider ?? selectedProvider);
  activeProvider = normalizeAIProvider(config.activeProvider ?? config.provider ?? activeProvider);
  const safe = sanitizeAIConfig({...config, provider: selectedProvider});
  hasKey = config.hasKey === true;
  connections = {...connections, ...config.connections, [selectedProvider]: {...safe, hasKey}};
  el('model').value = safe.model;
  setThreshold(safe.threshold);
  el('remember-key').checked = safe.rememberKey;
  el('key-status').textContent = keyStatus({...safe, hasKey});
  el('key-status').dataset.ready = String(hasKey);
  el('clear-key').disabled = busy || !hasKey;
  savedReviewEngine = config.reviewEngine === 'managed' ? 'managed' : 'direct';
  el('review-engine-direct').checked = savedReviewEngine === 'direct';
  el('review-engine-managed').checked = savedReviewEngine === 'managed';
  el('review-budget').value = String(Number.isFinite(config.reviewBudgetUsd) ? config.reviewBudgetUsd : 2);
  savedJourneyEngine = config.journeyEngine === 'managed' ? 'managed' : 'direct';
  el('journey-engine-direct').checked = savedJourneyEngine === 'direct';
  el('journey-engine-managed').checked = savedJourneyEngine === 'managed';
  el('journey-budget').value = String(Number.isFinite(config.journeyBudgetUsd) ? config.journeyBudgetUsd : 2);
  agentsReady = config.agentsReady === true;
  reviewerReady = config.reviewerReady === true;
  agentStatusReason = '';
  reviewerStatusReason = '';
  renderAgentSettings();
}
async function load(provider, {keepDraft = false} = {}) {
  const result = await send('GET_AI_CONFIG', provider ? {provider} : {});
  hideEnteredKey();
  for (const id of ['api-key', 'review-budget', 'journey-budget']) el(id).removeAttribute('aria-invalid');
  applyConfig(result.config, provider);
  if (keepDraft) restoreDraft(selectedProvider);
  if (hasKey) {
    const statuses = await Promise.allSettled([
      send('GET_JOURNEY_AGENTS_STATUS', {provider: selectedProvider}),
      send('GET_REVIEW_AGENT_STATUS', {provider: selectedProvider}),
    ]);
    if (statuses[0].status === 'fulfilled') {
      agentsReady = statuses[0].value.agents?.ready === true;
      agentStatusReason = statuses[0].value.agents?.reason || '';
    } else { agentsReady = false; agentStatusReason = `Could not check journey agents. ${statuses[0].reason.message}`; }
    if (statuses[1].status === 'fulfilled') {
      reviewerReady = statuses[1].value.agent?.ready === true;
      reviewerStatusReason = statuses[1].value.agent?.reason || '';
    } else { reviewerReady = false; reviewerStatusReason = `Could not check reviewer. ${statuses[1].reason.message}`; }
  }
  renderAgentSettings();
}
for (const provider of AI_PROVIDERS) el(`provider-${provider}`).addEventListener('change', async () => {
  if (busy || provider === selectedProvider) return;
  rememberDraft();
  setBusy(true); feedback('');
  try { await load(provider, {keepDraft: true}); }
  catch (error) { feedback(error.message, true); }
  finally { setBusy(false); }
});
el('threshold').addEventListener('input', () => setThreshold(el('threshold').value));
el('api-key').addEventListener('input', () => { el('api-key').removeAttribute('aria-invalid'); renderAgentSettings(); });
el('review-budget').addEventListener('input', () => el('review-budget').removeAttribute('aria-invalid'));
el('journey-budget').addEventListener('input', () => el('journey-budget').removeAttribute('aria-invalid'));
for (const id of ['journey-engine-direct', 'journey-engine-managed', 'review-engine-direct', 'review-engine-managed']) el(id).addEventListener('change', renderAgentSettings);
el('toggle-key').addEventListener('click', () => {
  const visible = el('api-key').type === 'password';
  el('api-key').type = visible ? 'text' : 'password';
  el('toggle-key').textContent = visible ? 'Hide' : 'Show';
  el('toggle-key').setAttribute('aria-label', visible ? 'Hide entered API key' : 'Show entered API key');
  el('toggle-key').setAttribute('aria-pressed', String(visible));
});
el('ai-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  try {
    const config = formSettings();
    if (config.journeyEngine === 'managed' && (!agentsReady || config.apiKey)) throw new Error('Choose “Set up journey agents” to prepare both agents with your API key before saving this engine.');
    if (config.reviewEngine === 'managed' && (!reviewerReady || config.apiKey)) throw new Error('Choose “Set up reviewer” to prepare your UX & Accessibility Reviewer before saving this engine.');
    // Request directly in the Save gesture, before any await loses activation.
    const permission = chrome.permissions.request({origins: [aiProviderOrigin(config.provider)]});
    setBusy(true); feedback('');
    if (!(await permission)) throw new Error(`Allow the ${providerName()} connection to use AI review. Your key was not saved.`);
    await send('SAVE_AI_CONFIG', config);
    delete drafts[config.provider];
    hideEnteredKey();
    await load(config.provider);
    feedback('AI settings saved.');
  } catch (error) { feedback(error.message, true); }
  finally { setBusy(false); }
});
el('setup-journey-agents').addEventListener('click', async () => {
  if (busy) return;
  let setupSucceeded = false;
  try {
    const config = formSettings();
    const permission = chrome.permissions.request({origins: [aiProviderOrigin(config.provider)]});
    setBusy(true); feedback('Setting up your journey agent and evaluator…');
    if (!(await permission)) throw new Error(`Allow the ${providerName()} connection to set up journey agents. Your key was not saved.`);
    // Only the worker enables managed journeys after both agents are ready.
    const engineBeforeSetup = config.apiKey ? 'direct' : savedJourneyEngine;
    const saved = await send('SAVE_AI_CONFIG', {...config, journeyEngine: engineBeforeSetup, reviewEngine: config.apiKey ? 'direct' : savedReviewEngine});
    if (config.apiKey) { agentsReady = false; reviewerReady = false; reviewerStatusReason = ''; }
    applyConfig(saved.config, config.provider);
    savedJourneyEngine = engineBeforeSetup;
    hasKey = saved.config?.hasKey === true || !!config.apiKey || hasKey;
    el('key-status').textContent = keyStatus({hasKey, rememberKey: config.rememberKey});
    el('key-status').dataset.ready = String(hasKey);
    delete drafts[config.provider];
    hideEnteredKey();
    const result = await send('SETUP_JOURNEY_AGENTS', {provider: config.provider});
    if (result.agents?.ready !== true) throw new Error(result.agents?.reason || 'The agents are not ready yet. Try setting them up again.');
    setupSucceeded = true;
    await load(config.provider);
    if (!agentsReady || savedJourneyEngine !== 'managed') throw new Error('The agents were set up, but readiness could not be confirmed. Reload settings to check again.');
    feedback('Journey agents are ready and enabled. You can start a journey from the Diffuse sidebar.');
  } catch (error) {
    agentsReady = false;
    agentStatusReason = setupSucceeded ? 'Setup finished, but the connection could not be checked. Reload settings to check again.' : 'Setup was not completed. Check the message below, then try again.';
    feedback(error.message, true);
  } finally { setBusy(false); }
});
el('setup-review-agent').addEventListener('click', async () => {
  if (busy) return;
  try {
    const config = formSettings();
    const permission = chrome.permissions.request({origins: [aiProviderOrigin(config.provider)]});
    setBusy(true); feedback('Setting up your UX & Accessibility Reviewer…');
    if (!(await permission)) throw new Error(`Allow the ${providerName()} connection to set up your reviewer. Your key was not saved.`);
    const saved = await send('SAVE_AI_CONFIG', {...config, reviewEngine: config.apiKey ? 'direct' : savedReviewEngine, journeyEngine: config.apiKey ? 'direct' : savedJourneyEngine});
    if (config.apiKey) { agentsReady = false; reviewerReady = false; reviewerStatusReason = ''; }
    applyConfig(saved.config, config.provider);
    hasKey = saved.config?.hasKey === true;
    delete drafts[config.provider];
    hideEnteredKey();
    const result = await send('SETUP_REVIEW_AGENT', {provider: config.provider});
    if (result.agent?.ready !== true) throw new Error(result.agent?.reason || 'The reviewer is not ready yet. Check setup again.');
    await load(config.provider);
    if (!reviewerReady || savedReviewEngine !== 'managed') throw new Error('Setup finished, but readiness could not be confirmed. Reload settings to check again.');
    feedback('UX & Accessibility Reviewer is ready and enabled. Choose Review with AI in the Diffuse sidebar.');
  } catch (error) {
    reviewerReady = false;
    reviewerStatusReason = 'Setup could not be confirmed. Check the message below before retrying.';
    feedback(error.message, true);
  } finally { setBusy(false); }
});
el('clear-key').addEventListener('click', async () => {
  if (busy) return;
  const provider = selectedProvider;
  setBusy(true); feedback('');
  try {
    await send('CLEAR_AI_KEY', {provider});
    delete drafts[provider];
    hideEnteredKey();
    await load(provider);
    feedback(`Your ${aiProviderName(provider)} API key has been removed from Diffuse. The other connection is unchanged.`);
  } catch (error) { feedback(error.message, true); }
  finally { setBusy(false); }
});
setBusy(true);
load().catch(error => { el('key-status').textContent = 'Connection unavailable'; feedback(error.message, true); }).finally(() => setBusy(false));
