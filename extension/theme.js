/* Appearance belongs to Diffuse only. Never theme the website being reviewed. */
(() => {
  if (globalThis.DiffuseTheme) return;
  const key = 'diffuseTheme';
  const extensionPage = location.protocol === 'chrome-extension:';
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const targets = new Map();
  const listeners = new Set();
  const normalize = value => ['light', 'dark', 'system'].includes(value) ? value : 'light';
  let preference = 'light';
  let revision = 0;
  const resolved = () => preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
  const snapshot = () => ({preference, theme: resolved()});
  function paint(target, root) {
    target.dataset.theme = resolved();
    target.dataset.themePreference = preference;
    globalThis.DiffuseSelect?.setTheme(root, resolved());
  }
  function apply(value) {
    preference = normalize(value);
    for (const [target, root] of targets) paint(target, root);
    for (const callback of listeners) callback(snapshot());
  }
  function attach(target, root = target.shadowRoot || document) {
    targets.set(target, root);
    paint(target, root);
    return () => targets.delete(target);
  }
  async function setPreference(value) {
    const next = normalize(value);
    if (!extensionPage || !globalThis.chrome?.storage?.local) throw new Error('Open Diffuse settings in Chrome to save appearance.');
    const started = revision;
    await chrome.storage.local.set({[key]: next});
    // Storage events are authoritative, including newer choices from another view.
    if (revision === started) { revision++; apply(next); }
  }
  function subscribe(callback) {
    listeners.add(callback);
    callback(snapshot());
    return () => listeners.delete(callback);
  }
  if (extensionPage) {
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[key]) return;
      revision++;
      apply(changes[key].newValue);
    });
  } else {
    // Credentials keep local storage restricted to trusted extension contexts.
    // The worker relays only this public preference to active review pages.
    globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || message?.namespace !== 'diffuse' || message.target || message.type !== 'APPEARANCE_CHANGED') return;
      revision++;
      apply(message.preference);
      respond?.({ok: true});
    });
  }
  media?.addEventListener('change', () => { if (preference === 'system') apply(preference); });
  globalThis.DiffuseTheme = Object.freeze({attach, setPreference, subscribe, getState: snapshot});
  if (extensionPage) attach(document.documentElement, document);
  const started = revision;
  (async () => {
    const value = extensionPage
      ? (await globalThis.chrome?.storage?.local?.get(key))?.[key]
      : (await globalThis.chrome?.runtime?.sendMessage({namespace: 'diffuse', target: 'worker', type: 'GET_APPEARANCE'}))?.preference;
    if (revision === started) apply(value);
  })().catch(() => {});
})();
