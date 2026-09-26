import {DEFAULT_AI_MODEL} from './ai-client.mjs';

const KEY = 'anthropicApiKey';
const CONFIG = 'aiConfig';
let protection;

export function protectAIStorage() {
  if (!protection) protection = Promise.all([
    chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
    chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
  ]);
  return protection;
}

export async function readAISettings({includeKey = false} = {}) {
  await protectAIStorage();
  const local = await chrome.storage.local.get([KEY, CONFIG]);
  const temporary = await chrome.storage.session.get(KEY);
  const saved = local[CONFIG] || {};
  const apiKey = temporary[KEY] || local[KEY] || '';
  const config = {model: saved.model || DEFAULT_AI_MODEL, threshold: Number.isFinite(saved.threshold) ? saved.threshold : 35, rememberKey: !!saved.rememberKey, hasKey: !!apiKey};
  return includeKey ? {...config, apiKey} : config;
}

export async function saveAISettings(input = {}) {
  const current = await readAISettings({includeKey: true});
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : current.apiKey;
  if (apiKey && (!apiKey.startsWith('sk-ant-') || apiKey.length < 20 || apiKey.length > 512 || /\s/.test(apiKey))) throw new Error('Enter a valid Anthropic API key beginning with sk-ant-.');
  const model = typeof input.model === 'string' ? input.model.trim() : current.model;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model)) throw new Error('Enter a valid Anthropic model ID.');
  const threshold = Number(input.threshold ?? current.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('The minimum difference score must be between 0 and 100.');
  const config = {model, threshold: Math.round(threshold), rememberKey: input.rememberKey === true};
  if (config.rememberKey) {
    await chrome.storage.local.set({[KEY]: apiKey, [CONFIG]: config});
    await chrome.storage.session.remove(KEY);
  } else {
    await chrome.storage.session.set({[KEY]: apiKey});
    await chrome.storage.local.set({[CONFIG]: config});
    await chrome.storage.local.remove(KEY);
  }
  return readAISettings();
}

export async function clearAIKey() {
  await protectAIStorage();
  await Promise.all([chrome.storage.local.remove(KEY), chrome.storage.session.remove(KEY)]);
  return readAISettings();
}
