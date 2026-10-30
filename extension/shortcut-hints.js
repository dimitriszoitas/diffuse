import './shortcuts.js';

const shortcuts = globalThis.DiffuseShortcuts;
shortcuts.subscribe(config => {
  document.getElementById('comment-shortcut-label').textContent = shortcuts.format(config.comment);
  document.getElementById('area-shortcut-label').textContent = shortcuts.format(config.area);
  const shared = shortcuts.format(config.comment) === shortcuts.format(config.area);
  document.getElementById('area-shortcut-join').textContent = shared ? '+' : 'then';
  document.getElementById('comment-shortcut-keys').hidden = !config.enabled;
  document.getElementById('shortcuts-disabled-help').hidden = config.enabled;
});
document.getElementById('customize-shortcuts').addEventListener('click', async () => {
  try {
    const result = await chrome.runtime.sendMessage({namespace:'diffuse', target:'worker', type:'OPEN_SETTINGS', section:'browser'});
    if (!result?.ok) throw new Error(result?.error || 'Could not open shortcut settings.');
  } catch (error) {
    const message = document.getElementById('shortcuts-disabled-help');
    message.textContent = error.message || 'Open Settings → Browser & shortcuts to customize your keys.';
    message.hidden = false;
  }
});
