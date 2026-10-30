import {DEFAULT_AI_MODEL} from './ai-client.mjs';
import {AI_PROVIDERS, DEFAULT_OPENAI_MODEL, normalizeAIProvider, aiProviderName, aiManagedModel} from './ai-providers.mjs';

const KEYS = {anthropic:'anthropicApiKey',openai:'openaiApiKey'};
const CONFIG = 'aiConfig';
export const DEFAULT_JOURNEY_ENGINE = 'direct';
export const DEFAULT_JOURNEY_BUDGET_USD = 2;
export const DEFAULT_REVIEW_BUDGET_USD = 2;
const validBudget = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 20;
let protection, protectedLocal, protectedSession;

export function protectAIStorage() {
  if (!protection || protectedLocal !== chrome.storage.local || protectedSession !== chrome.storage.session) {
    protectedLocal = chrome.storage.local; protectedSession = chrome.storage.session;
    protection = Promise.all([
    chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
    chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
    ]).catch(error => { protection = undefined; throw error; });
  }
  return protection;
}

function providerProfile(saved, provider) {
  // Pre-provider settings belong to Anthropic. Never treat an OpenAI profile as
  // the old default when a user upgrades or switches back to Claude.
  const profile = saved.providers?.[provider] || (provider === 'anthropic' && !saved.providers ? saved : {});
  return {
    model: profile.model || (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_AI_MODEL),
    rememberKey: profile.rememberKey === true,
    reviewEngine: profile.reviewEngine === 'managed' ? 'managed' : 'direct',
    reviewBudgetUsd: validBudget(profile.reviewBudgetUsd) ? profile.reviewBudgetUsd : DEFAULT_REVIEW_BUDGET_USD,
    journeyEngine: profile.journeyEngine === 'managed' ? 'managed' : DEFAULT_JOURNEY_ENGINE,
    journeyBudgetUsd: validBudget(profile.journeyBudgetUsd) ? profile.journeyBudgetUsd : DEFAULT_JOURNEY_BUDGET_USD,
  };
}
function requireProvider(provider) {
  if (!AI_PROVIDERS.includes(provider)) throw new Error('Choose Anthropic or OpenAI.');
  return provider;
}
export async function readAISettings({includeKey = false, provider: requestedProvider} = {}) {
  await protectAIStorage();
  const local = await chrome.storage.local.get([...Object.values(KEYS), CONFIG]);
  const temporary = await chrome.storage.session.get(Object.values(KEYS));
  const saved = local[CONFIG] || {};
  const activeProvider = normalizeAIProvider(saved.provider);
  const provider = requestedProvider === undefined ? activeProvider : requireProvider(requestedProvider);
  const apiKey = temporary[KEYS[provider]] || local[KEYS[provider]] || '';
  const connections = Object.fromEntries(AI_PROVIDERS.map(name => [name, {...providerProfile(saved, name), hasKey: Boolean(temporary[KEYS[name]] || local[KEYS[name]])}]));
  const config = {
    ...connections[provider],
    provider, activeProvider, connections,
    managedModel: aiManagedModel(provider), managedAgentModel: aiManagedModel(provider), managedEffort: 'max',
    threshold: Number.isFinite(saved.threshold) ? saved.threshold : 35,
  };
  return includeKey ? {...config, apiKey} : config;
}

let saveQueue = Promise.resolve();
export function saveAISettings(input = {}) {
  const task = saveQueue.catch(() => {}).then(() => saveSelectedSettings(input));
  saveQueue = task;
  return task;
}
async function saveSelectedSettings(input) {
  const current = await readAISettings({includeKey: true, provider: input.provider});
  const provider = current.provider, KEY = KEYS[provider], name = aiProviderName(provider);
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  const validPrefix = provider === 'openai' ? apiKey.startsWith('sk-') && !apiKey.startsWith('sk-ant-') : apiKey.startsWith('sk-ant-');
  if (apiKey && (!validPrefix || apiKey.length < 20 || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey))) throw new Error(`Enter a valid ${name} API key beginning with ${provider === 'openai' ? 'sk-' : 'sk-ant-'}.`);
  const model = typeof input.model === 'string' ? input.model.trim() : current.model;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model) || (provider === 'openai' ? !model.startsWith('gpt-') : !model.startsWith('claude-'))) throw new Error(`Enter a valid ${name} model ID.`);
  const threshold = Number(input.threshold ?? current.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('The minimum difference score must be between 0 and 100.');
  const journeyEngine = input.journeyEngine === undefined ? current.journeyEngine : input.journeyEngine;
  if (!['direct', 'managed'].includes(journeyEngine)) throw new Error(`Choose Direct or ${provider === 'openai' ? 'OpenAI' : 'Claude'} agents for journey testing.`);
  const journeyBudgetUsd = input.journeyBudgetUsd === undefined ? current.journeyBudgetUsd : input.journeyBudgetUsd;
  if (!validBudget(journeyBudgetUsd)) throw new Error('Set the journey spending limit between $0.10 and $20 USD.');
  const reviewEngine = input.reviewEngine === undefined ? current.reviewEngine : input.reviewEngine;
  if (!['direct', 'managed'].includes(reviewEngine)) throw new Error('Choose Direct or UX & Accessibility Reviewer for screenshot reviews.');
  const reviewBudgetUsd = input.reviewBudgetUsd === undefined ? current.reviewBudgetUsd : input.reviewBudgetUsd;
  if (!validBudget(reviewBudgetUsd)) throw new Error('Set the review spending limit between $0.10 and $20 USD.');
  const profile = {
    model,
    rememberKey: input.rememberKey === undefined ? current.rememberKey : input.rememberKey === true,
    reviewEngine,
    reviewBudgetUsd: Math.round(reviewBudgetUsd * 100) / 100,
    journeyEngine,
    journeyBudgetUsd: Math.round(journeyBudgetUsd * 100) / 100,
  };
  const saved = (await chrome.storage.local.get(CONFIG))[CONFIG] || {};
  const profiles = Object.fromEntries(AI_PROVIDERS.map(name => [name, providerProfile(saved, name)]));
  const config = {provider, threshold:Math.round(threshold), providers:{...profiles,[provider]:profile}};
  if (profile.rememberKey) {
    await chrome.storage.local.set({[KEY]: apiKey, [CONFIG]: config});
    await chrome.storage.session.remove(KEY);
  } else {
    await chrome.storage.session.set({[KEY]: apiKey});
    await chrome.storage.local.set({[CONFIG]: config});
    await chrome.storage.local.remove(KEY);
  }
  return readAISettings();
}

export async function clearAIKey({provider: requestedProvider} = {}) {
  await protectAIStorage();
  const current = await readAISettings({provider: requestedProvider});
  const KEY = KEYS[current.provider];
  await Promise.all([chrome.storage.local.remove(KEY), chrome.storage.session.remove(KEY)]);
  return readAISettings({provider: current.provider});
}
