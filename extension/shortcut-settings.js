import './shortcuts.js';

const shortcuts = globalThis.DiffuseShortcuts;
const enabled = document.getElementById('shortcuts-enabled');
const feedback = document.getElementById('shortcut-feedback');
const save = document.getElementById('save-shortcuts');
const reset = document.getElementById('reset-shortcuts');
const buttons = [...document.querySelectorAll('[data-shortcut]')];
let draft = shortcuts.getState(), saved = JSON.stringify(draft), recording = null, busy = false, loaded = false;

function status(message, error = false) {
  feedback.textContent = message;
  feedback.dataset.error = String(error);
}
function render() {
  enabled.checked = draft.enabled;
  enabled.disabled = busy || !loaded;
  for (const button of buttons) {
    const name = button.dataset.shortcut;
    button.textContent = recording === name ? 'Press keys…' : shortcuts.format(draft[name]);
    button.setAttribute('aria-pressed', String(recording === name));
    button.disabled = busy || !loaded || !draft.enabled;
  }
  const shared = shortcuts.format(draft.area) === shortcuts.format(draft.comment);
  document.getElementById('shortcut-area-help').textContent = shared ? 'Hold the shortcut while you click and drag.' : 'Press and release, then click and drag an area.';
  save.disabled = busy || !loaded || Boolean(recording) || JSON.stringify(draft) === saved;
  reset.disabled = busy || !loaded;
}
function stopCapture() { recording = null; render(); }
for (const button of buttons) {
  button.addEventListener('click', () => {
    recording = recording === button.dataset.shortcut ? null : button.dataset.shortcut;
    status(recording ? 'Press your shortcut. Tab leaves it unchanged.' : 'Shortcut unchanged.');
    render();
  });
  button.addEventListener('blur', () => { if (recording === button.dataset.shortcut) stopCapture(); });
  button.addEventListener('keydown', event => {
    if (recording !== button.dataset.shortcut || event.isComposing || event.repeat) return;
    if (event.key === 'Tab') { stopCapture(); return; }
    event.preventDefault(); event.stopPropagation();
    if (['Control','Alt','Shift','Meta','AltGraph'].includes(event.key)) return;
    if (event.key === 'Escape' && recording !== 'cancel') { stopCapture(); status('Shortcut unchanged.'); return; }
    try {
      const next = {...draft, [recording]: shortcuts.fromEvent(event)};
      draft = shortcuts.validate(next);
      stopCapture();
      status('Shortcut updated. Save to apply your changes.');
    } catch (error) { status(error.message || 'Choose another shortcut.', true); }
  });
}
enabled.addEventListener('change', () => {
  draft = {...draft, enabled: enabled.checked}; recording = null;
  status('Save to apply your changes.'); render();
});
reset.addEventListener('click', () => {
  draft = structuredClone(shortcuts.defaults); recording = null;
  status('Default shortcuts restored. Save to apply them.'); render();
});
save.addEventListener('click', async () => {
  try {
    draft = shortcuts.validate(draft); busy = true; render();
    draft = await shortcuts.save(draft); saved = JSON.stringify(draft);
    status(draft.enabled ? 'Shortcuts saved. They are ready on your reviewed pages.' : 'Keyboard shortcuts are off. Escape still cancels an active selection.');
  } catch (error) { status(error.message || 'Could not save shortcuts. Try again.', true); }
  finally { busy = false; render(); }
});
shortcuts.subscribe(config => {
  // Keep unsaved edits if another settings tab changes its preferences.
  if (!busy && (!loaded || (JSON.stringify(draft) === saved && !recording))) {
    draft = structuredClone(config); saved = JSON.stringify(draft); render();
  }
});
try { draft = await shortcuts.refresh(); saved = JSON.stringify(draft); loaded = true; }
catch { loaded = true; status('Could not load your shortcuts. Reopen Settings before changing them.', true); }
render();
