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
    if (link.hash === (location.hash || '#ai')) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', markCurrent);
window.addEventListener('focus', checkAccess);
markCurrent();
checkAccess();
