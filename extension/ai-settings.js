import {sanitizeAIConfig, validateAPIKey} from './ai-client.mjs';

const el = id => document.getElementById(id);
let hasKey = false;
let busy = false;
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
  for (const id of ['api-key', 'toggle-key', 'remember-key', 'model', 'threshold']) el(id).disabled = value;
}
function applyConfig(config) {
  const safe = sanitizeAIConfig(config);
  hasKey = config.hasKey === true;
  el('model').value = safe.model;
  el('threshold').value = String(safe.threshold);
  el('threshold-value').textContent = `${safe.threshold} / 100`;
  el('threshold').setAttribute('aria-valuetext', `${safe.threshold} out of 100`);
  el('remember-key').checked = safe.rememberKey;
  el('key-status').textContent = hasKey ? (safe.rememberKey ? 'Key remembered' : 'Key ready for this session') : 'No key connected';
  el('key-status').dataset.ready = String(hasKey);
  el('clear-key').disabled = busy || !hasKey;
}
async function load() {
  const result = await send('GET_AI_CONFIG');
  applyConfig(result.config);
}
el('threshold').addEventListener('input', () => {
  el('threshold-value').textContent = `${el('threshold').value} / 100`;
  el('threshold').setAttribute('aria-valuetext', `${el('threshold').value} out of 100`);
});
el('api-key').addEventListener('input', () => el('api-key').removeAttribute('aria-invalid'));
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
    const config = sanitizeAIConfig({model: el('model').value.trim(), threshold: Number(el('threshold').value), rememberKey: el('remember-key').checked});
    const apiKey = el('api-key').value.trim();
    if (apiKey) {
      try { validateAPIKey(apiKey); }
      catch (error) { el('api-key').setAttribute('aria-invalid', 'true'); throw error; }
    }
    if (!apiKey && !hasKey) { el('api-key').setAttribute('aria-invalid', 'true'); throw new Error('Paste your Anthropic API key to connect Claude.'); }
    // Request directly in the Save gesture, before any await loses activation.
    const permission = chrome.permissions.request({origins: ['https://api.anthropic.com/*']});
    setBusy(true); feedback('');
    if (!(await permission)) throw new Error('Allow the Anthropic connection to use AI review. Your key was not saved.');
    await send('SAVE_AI_CONFIG', {...config, apiKey});
    el('api-key').value = '';
    el('api-key').type = 'password';
    el('toggle-key').textContent = 'Show';
    el('toggle-key').setAttribute('aria-label', 'Show entered API key');
    el('toggle-key').setAttribute('aria-pressed', 'false');
    await load();
    feedback('AI settings saved.');
  } catch (error) { feedback(error.message, true); }
  finally { setBusy(false); }
});
el('clear-key').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); feedback('');
  try {
    await send('CLEAR_AI_KEY');
    el('api-key').value = '';
    await load();
    feedback('Your API key has been removed from Diffuse.');
  } catch (error) { feedback(error.message, true); }
  finally { setBusy(false); }
});
setBusy(true);
load().catch(error => { el('key-status').textContent = 'Connection unavailable'; feedback(error.message, true); }).finally(() => setBusy(false));
