import {VIEWPORT_LABELS, viewportKey, commentMatchesViewport} from './viewport-profile.mjs';

const section = document.createElement('section');
section.id = 'panel-viewport';
section.className = 'viewport-panel';
section.setAttribute('aria-label', 'Review viewport');
section.innerHTML = `<div class="viewport-heading"><strong>Viewport</strong><button type="button" id="viewport-native" hidden>Use window size</button></div><div class="viewport-segments" role="group" aria-label="Change responsive viewport"><button type="button" data-preset="desktop" aria-pressed="false">Desktop</button><button type="button" data-preset="tablet" aria-pressed="false">Laptop / tablet</button><button type="button" data-preset="phone" aria-pressed="false">Phone</button></div><p id="viewport-size" class="muted" role="status"></p><details><summary>About viewport modes</summary><p>Changes the page’s responsive layout. Comments are kept separately for each view. Chrome shows its debugging notice while a preset is active. This does not simulate a phone’s operating system or touch behavior.</p></details><p id="viewport-error" role="alert" hidden></p>`;
document.getElementById('panel-controls').prepend(section);
let snapshot = null, changing = false;
const controls = [...section.querySelectorAll('button')];
function render() {
  const current = snapshot?.session;
  if (!current) return;
  const state = snapshot?.state;
  const key = current.viewportPreset || viewportKey(current.targetViewport?.width);
  const locked = changing || snapshot.busy || state?.active === false || state?.available === false || state?.captureBusy || state?.commentSaving || state?.recordingBusy || state?.recording || state?.comment || state?.aiBusy || state?.aiOperationBusy || current.aiRunning || current.viewportChanging;
  for (const button of controls) { button.disabled = Boolean(locked); if(button.dataset.preset)button.setAttribute('aria-pressed', String(button.dataset.preset === key)); }
  document.getElementById('viewport-native').hidden = !current.viewportPreset;
  const size = current.targetViewport;
  const count = (current.comments || []).filter(item => commentMatchesViewport(item, key)).length;
  document.getElementById('viewport-size').textContent = changing ? 'Changing viewport…' : `${size?.width || '—'} × ${size?.height || '—'} · ${count} comment${count === 1 ? '' : 's'} in ${VIEWPORT_LABELS[key] || 'this view'}${current.viewportPreset ? '' : ' · Window size'}`;
}
window.addEventListener('diffuse-panel-state', event => { snapshot = event.detail; render(); });
for (const button of controls) button.addEventListener('click', async () => {
  if (!snapshot?.session || changing) return;
  const sessionId = snapshot.session.id;
  const error = document.getElementById('viewport-error');
  changing = true; error.hidden = true; render();
  try {
    const browserWindow = await chrome.windows.getCurrent();
    const result = await chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type:'VIEWPORT_PRESET',sessionId,windowId:browserWindow.id,preset:button.dataset.preset || null});
    if (!result?.ok) throw new Error(result?.error || 'The viewport could not be changed.');
    globalThis.dispatchEvent(new Event('diffuse-refresh'));
  } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  finally { changing = false; render(); }
});
