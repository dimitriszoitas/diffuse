import {extensionSettingsUrl} from './core.mjs';

const status = document.getElementById('file-access-status');
const feedback = document.getElementById('browser-feedback');
async function checkAccess() {
  try {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    status.textContent = allowed ? 'Allowed' : 'Not allowed';
    status.dataset.ready = String(allowed);
    feedback.hidden = true;
  } catch {
    status.textContent = 'Unavailable';
    feedback.textContent = 'Open Chrome’s extension settings to check local file access.';
    feedback.hidden = false;
  }
}
document.getElementById('check-access').addEventListener('click', checkAccess);
document.getElementById('browser-settings').addEventListener('click', async () => {
  try { await chrome.tabs.create({url: extensionSettingsUrl(chrome.runtime.id)}); }
  catch { feedback.textContent = 'Open chrome://extensions and choose Diffuse → Details.'; feedback.hidden = false; }
});
const links = [...document.querySelectorAll('.settings-nav a')];
function markCurrent() {
  for (const link of links) {
    if (link.hash === (location.hash || '#appearance')) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', markCurrent);
window.addEventListener('focus', checkAccess);
markCurrent();
checkAccess();

const themeChoices = [...document.querySelectorAll('input[name="appearance"]')];
const themeStatus = document.getElementById('appearance-status');
globalThis.DiffuseTheme?.subscribe(({preference}) => {
  for (const input of themeChoices) input.checked = input.value === preference;
});
for (const input of themeChoices) input.addEventListener('change', async () => {
  if (!input.checked) return;
  const hadFocus = document.activeElement === input;
  for (const choice of themeChoices) choice.disabled = true;
  try {
    await globalThis.DiffuseTheme.setPreference(input.value);
    const {preference} = globalThis.DiffuseTheme.getState();
    themeStatus.textContent = preference === 'system' ? 'Following your device appearance.' : `${preference === 'dark' ? 'Dark' : 'Light'} appearance saved.`;
  } catch (error) {
    const state = globalThis.DiffuseTheme?.getState();
    for (const choice of themeChoices) choice.checked = choice.value === state?.preference;
    themeStatus.textContent = error.message || 'Appearance could not be saved. Try again.';
  } finally {
    for (const choice of themeChoices) choice.disabled = false;
    if (hadFocus && document.activeElement === document.body) input.focus({preventScroll: true});
  }
});
