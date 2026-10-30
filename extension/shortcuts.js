/* Shared by extension views, the worker and isolated page scripts. */
(() => {
  if (globalThis.DiffuseShortcuts) return;
  const storageKey = 'diffuseShortcuts';
  const modifiers = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];
  const binding = code => ({code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false});
  const defaults = Object.freeze({enabled: true, comment: Object.freeze(binding('KeyC')), area: Object.freeze(binding('KeyC')), cancel: Object.freeze(binding('Escape'))});
  const copy = config => ({enabled: config.enabled, comment: {...config.comment}, area: {...config.area}, cancel: {...config.cancel}});
  const same = (a, b) => a.code === b.code && modifiers.every(key => a[key] === b[key]);
  function checkedBinding(value) {
    if (!value || typeof value !== 'object' || !/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Escape)$/.test(value.code || '')) throw new Error('Choose a letter, number, or function key. Escape can be used to cancel.');
    const next = {code: value.code};
    for (const key of modifiers) {
      if (value[key] != null && typeof value[key] !== 'boolean') throw new Error('Shortcut modifiers must be on or off.');
      next[key] = value[key] === true;
    }
    const primary = next.ctrlKey || next.metaKey;
    // Browser/system commands must keep their meaning. Alt + Shift + D/P are
    // already used by the comparison view, so do not assign them to comments.
    const reserved = next.ctrlKey && next.metaKey
      || next.code === 'Escape' && modifiers.some(key => next[key])
      || /^F(?:1|3|5|6|7|10|11|12)$/.test(next.code)
      || next.altKey && /^F\d+$/.test(next.code)
      || primary && /^Digit/.test(next.code)
      || primary && /^F\d+$/.test(next.code)
      || primary && !next.altKey && !next.shiftKey && /^Key[A-Z]$/.test(next.code)
      || primary && next.shiftKey && !next.altKey && /^Key[ABCDEFHIJKLMNOPQRSTVWXZ]$/.test(next.code)
      || next.altKey && !next.ctrlKey && !next.metaKey && /^(KeyD|KeyF|KeyE)$/.test(next.code)
      || next.altKey && next.shiftKey && /^(KeyD|KeyP)$/.test(next.code);
    if (reserved) throw new Error('That shortcut is reserved by the browser or Diffuse. Choose another combination.');
    return next;
  }
  function validate(value) {
    if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('Choose whether keyboard shortcuts are enabled.');
    const next = {enabled: value.enabled};
    for (const name of ['comment', 'area', 'cancel']) next[name] = checkedBinding(value[name]);
    if (next.comment.code === 'Escape' || next.area.code === 'Escape') throw new Error('Escape is reserved for cancelling a selection.');
    if (same(next.cancel, next.comment) || same(next.cancel, next.area)) throw new Error('Use a different shortcut for Cancel selection.');
    return next;
  }
  function normalize(value) {
    try { return validate(value); } catch { return copy(defaults); }
  }
  function fromEvent(event) {
    if (event?.isComposing || event?.keyCode === 229 || event?.getModifierState?.('AltGraph')) throw new Error('Finish typing, then choose a shortcut.');
    return checkedBinding(event);
  }
  function matches(event, value) {
    if (!event || !value || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return false;
    return event.code === value.code && modifiers.every(key => Boolean(event[key]) === value[key]);
  }
  function format(value) {
    const labels = [];
    if (value.ctrlKey) labels.push('Ctrl');
    if (value.altKey) labels.push('Alt');
    if (value.shiftKey) labels.push('Shift');
    if (value.metaKey) labels.push('Cmd');
    labels.push(value.code === 'Escape' ? 'Esc' : value.code.replace(/^(Key|Digit)/, ''));
    return labels.join(' + ');
  }
  let state = copy(defaults), revision = 0;
  const subscribers = new Set();
  const getState = () => copy(state);
  function apply(value) {
    state = normalize(value);
    for (const callback of subscribers) callback(getState());
  }
  function subscribe(callback) {
    subscribers.add(callback); callback(getState());
    return () => subscribers.delete(callback);
  }
  async function request(type, extra = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open Diffuse settings in Chrome to change shortcuts.');
    const response = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, ...extra});
    if (!response?.ok) throw new Error(response?.error || 'Keyboard shortcuts could not be loaded. Reopen Diffuse settings.');
    return normalize(response.config);
  }
  async function refresh() {
    const started = revision, config = await request('GET_SHORTCUTS');
    if (revision === started) apply(config);
    return getState();
  }
  async function save(value) {
    const config = validate(value), started = revision;
    const saved = await request('SAVE_SHORTCUTS', {config});
    if (revision === started) { revision++; apply(saved); }
    return getState();
  }
  globalThis.DiffuseShortcuts = Object.freeze({defaults, storageKey, normalize, validate, fromEvent, format, matches, getState, subscribe, refresh, save});
  // The service worker imports the pure helpers without starting a message loop.
  if (typeof document === 'undefined') return;
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[storageKey]) return;
    revision++; apply(changes[storageKey].newValue);
  });
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id || message?.namespace !== 'diffuse' || message.target || message.type !== 'SHORTCUTS_CHANGED') return;
    revision++; apply(message.config); respond?.({ok: true});
  });
  refresh().catch(() => {});
})();
