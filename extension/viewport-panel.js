import {VIEWPORT_LABELS, viewportKey, commentMatchesViewport} from './viewport-profile.mjs';

const section = document.createElement('section');
section.id = 'panel-viewport';
section.className = 'viewport-panel';
section.setAttribute('aria-label', 'Review viewport');
section.innerHTML = `<div class="viewport-heading"><div class="viewport-title"><strong>Viewport</strong><span class="viewport-help"><button type="button" class="viewport-info" aria-label="About viewport modes" aria-describedby="viewport-help-text"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg></button><span id="viewport-help-text" role="tooltip"><strong>Review every screen size</strong>Resize the page. Each viewport keeps its own comments.<small>Chrome shows a debugging notice while a preset is active. Presets change layout, not touch behavior.</small></span></span></div><button type="button" id="viewport-native" hidden>Use window size</button></div><div class="viewport-segments" role="group" aria-label="Change responsive viewport"><button type="button" data-preset="desktop" aria-pressed="false" aria-label="Desktop · 1440 × 900" title="Desktop · 1440 × 900"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></svg></button><button type="button" data-preset="laptop" aria-pressed="false" aria-label="Laptop · 1280 × 800" title="Laptop · 1280 × 800"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="11" rx="1.5"/><path d="m5 15-3 4a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1l-3-4H5Z"/></svg></button><button type="button" data-preset="tablet" aria-pressed="false" aria-label="Tablet · 1024 × 768" title="Tablet · 1024 × 768"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M10 18h4"/></svg></button><button type="button" data-preset="phone" aria-pressed="false" aria-label="Phone · 390 × 844" title="Phone · 390 × 844"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 18h4m-4-13h4"/></svg></button></div><p id="viewport-size" class="muted" role="status"></p><p id="viewport-error" role="alert" hidden></p>`;
document.getElementById('panel-controls').prepend(section);
let snapshot = null, changing = false;
const help = section.querySelector('.viewport-help');
const info = section.querySelector('.viewport-info');
const tooltip = section.querySelector('[role=tooltip]');
let hideHelpTimer;
function positionHelp() {
  if (!help.hasAttribute('data-open')) return;
  const margin = 12, bounds = info.getBoundingClientRect();
  const drawer = document.querySelector('.drawer-scroll')?.getBoundingClientRect();
  const leftEdge = Math.max(margin, (drawer?.left || 0) + 4);
  const rightEdge = Math.min(innerWidth - margin, (drawer?.right || innerWidth) - 4);
  const width = Math.max(160, Math.min(276, rightEdge - leftEdge));
  tooltip.style.width = `${width}px`;
  tooltip.style.maxHeight = `${Math.max(80, innerHeight - margin * 2)}px`;
  const height = tooltip.getBoundingClientRect().height;
  const left = Math.max(leftEdge, Math.min(bounds.left - 22, rightEdge - width));
  const below = bounds.bottom + 7;
  const top = below + height <= innerHeight - margin ? below : Math.max(margin, bounds.top - height - 7);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
function showHelp() { clearTimeout(hideHelpTimer); help.dataset.open = ''; positionHelp(); }
function hideHelp() { clearTimeout(hideHelpTimer); delete help.dataset.open; }
document.addEventListener('keydown', event => {
  if(event.key === 'Escape' && help.hasAttribute('data-open')) {
    hideHelp(); event.preventDefault(); event.stopPropagation();
  }
}, {capture:true});
for(const name of ['focusin','mouseenter'])help.addEventListener(name, showHelp);
help.addEventListener('mouseleave', () => {
  if (!help.contains(document.activeElement)) hideHelpTimer = setTimeout(hideHelp, 150);
});
help.addEventListener('focusout', event => { if (!help.contains(event.relatedTarget) && !help.matches(':hover')) hideHelp(); });
window.addEventListener('resize', positionHelp, {passive:true});
document.addEventListener('scroll', event => { if (help.hasAttribute('data-open') && !tooltip.contains(event.target)) hideHelp(); }, {capture:true,passive:true});
const controls = [...section.querySelectorAll('[data-preset], #viewport-native')];
for (const button of controls) button.disabled = true;
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
