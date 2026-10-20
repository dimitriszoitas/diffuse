/* Fixed, isolated-world browser actions. The model never supplies executable code. */
(() => {
  const KEY = '__diffuseJourneyPageV1';
  if (globalThis[KEY]) return;
  const namespace = 'diffuse-journey';
  const documentId = crypto.randomUUID();
  let snapshot = null;
  const compact = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const fail = (message, code = 'JOURNEY_BLOCKED') => Object.assign(new Error(message), {code});
  const parent = node => node.parentElement || node.getRootNode()?.host || null;
  const ignored = node => {
    for (let el = node; el; el = parent(el)) {
      if (el.matches?.('[data-diffuse-ui],diffuse-live-overlay,script,style,noscript,template,[hidden],[inert]')) return true;
    }
    return false;
  };
  const visible = el => {
    if (!el?.isConnected || ignored(el)) return false;
    const rect = el.getBoundingClientRect();
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let node = el; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      if (node !== el && node !== document.documentElement && node !== document.body) {
        const bounds = node.getBoundingClientRect();
        if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
    }
    return right > left && bottom > top;
  };
  function allElements() {
    const result = [];
    const visit = root => {
      if (result.length >= 12000) return;
      for (const el of root.children || []) {
        if (ignored(el)) continue;
        result.push(el);
        if (result.length >= 12000) return;
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document.documentElement);
    return result;
  }
  function labelText(node) {
    const parts = [];
    const visit = parentNode => {
      for (const child of parentNode.childNodes || []) {
        if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent);
        else if (!child.matches?.('input,select,textarea,button,[hidden],script,style')) visit(child);
      }
    };
    visit(node);
    return compact(parts.join(' '));
  }
  function label(el) {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => el.getRootNode().getElementById?.(id)).filter(Boolean)
      .map(node => compact(node.innerText || node.textContent)).join(' ');
    return compact(el.getAttribute('aria-label') || labelled ||
      [...(el.labels || [])].map(labelText).join(' ') ||
      (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '') ||
      (!el.isContentEditable && el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'));
  }
  function role(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    if (el instanceof HTMLAnchorElement) return 'link';
    if (el instanceof HTMLSelectElement) return 'combobox';
    if (el instanceof HTMLTextAreaElement || el.isContentEditable) return 'textbox';
    if (el instanceof HTMLInputElement) {
      if (['checkbox', 'radio'].includes(el.type)) return el.type;
      if (['button', 'submit', 'reset'].includes(el.type)) return 'button';
      return 'textbox';
    }
    return el.tagName === 'SUMMARY' ? 'button' : el.tagName.toLowerCase();
  }
  function blockReason(el) {
    const name = label(el);
    const hints = `${el.getAttribute('autocomplete') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${name}`;
    if (el instanceof HTMLInputElement && ['password', 'file', 'hidden'].includes(el.type)) return 'This field requires a person to continue.';
    if (/\b(password|passcode|one.time.code|otp|cvv|cvc|card.number|credit.card|security.code|api.key|access.token|secret.key)\b/i.test(hints) ||
      /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[-\w]+)(?:\s|$)/i.test(hints)) return 'Credential or payment fields require a person to continue.';
    if (/\b(delete|destroy|erase|wipe|remove|purchase|checkout|pay(?:ment)?|buy|place order|send money|transfer funds|grant access|authorize|publish|deploy|unsubscribe|revoke|sign out|log out)\b/i.test(name)) return 'This action needs a person because it may delete, publish, purchase, or change access.';
    if (/\b(sign in|log in|login|register|invite|send|allow notifications|enable notifications|accept all cookies|connect account|grant permission)\b/i.test(name)) return 'Sign-in, permission changes, and sending messages require a person to continue.';
    if (el.closest?.('form')) {
      const form = el.closest('form');
      if (form.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return 'Sign-in and payment forms require a person to continue.';
    }
    return '';
  }
  function descriptor(el, id) {
    const item = {id, role: role(el), label: label(el) || '(unlabelled control)'};
    const reason = blockReason(el);
    if (el.type) item.type = el.type;
    if (reason) item.blockedReason = reason;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (!reason && 'value' in el) item.value = compact(el.value, 500);
    if ('checked' in el) item.checked = Boolean(el.checked);
    if (el instanceof HTMLSelectElement) item.options = [...el.options].slice(0, 80).map(option => ({
      label: compact(option.label), value: compact(option.value), disabled: option.disabled,
    }));
    const rect = el.getBoundingClientRect();
    item.bounds = {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)};
    return item;
  }
  function signature(el) {
    return JSON.stringify([role(el), label(el), el.type, el.getAttribute('href'), el.getAttribute('formaction'),
      el.closest?.('form')?.getAttribute('action'), el.disabled, el.getAttribute('aria-disabled'), el.value, el.checked]);
  }
  function readText(elements) {
    const output = [];
    let size = 0;
    for (const el of elements) {
      if (!visible(el) || /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || el.isContentEditable) continue;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = compact(node.textContent, 600);
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= innerHeight || rect.width <= 0) continue;
        output.push(text); size += text.length;
        if (size >= 14000) return output.join('\n').slice(0, 14000);
      }
    }
    return output.join('\n');
  }
  function observe() {
    const elements = allElements();
    const observationId = crypto.randomUUID();
    const refs = new Map();
    const candidates = elements.filter(el => visible(el) && el.matches(
      'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="tab"],[role="menuitem"],[role="option"],[tabindex="0"]',
    )).slice(0, 180);
    const controls = candidates.map((el, i) => {
      const id = `control-${i + 1}`;
      refs.set(id, {el, signature: signature(el)});
      return descriptor(el, id);
    });
    snapshot = {observationId, url: location.href, refs, createdAt: Date.now()};
    return {
      url: location.href, title: compact(document.title, 300), text: readText(elements), controls,
      context: {
        documentId, observationId, url: location.href, title: compact(document.title, 300),
        viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1},
        scroll: {x: scrollX, y: scrollY},
        documentSize: {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight},
        limitations: elements.some(el => visible(el) && el.tagName === 'IFRAME') ? ['Embedded frames cannot be operated in this version.'] : [],
      },
    };
  }
  function validateContext(context) {
    if (!snapshot || context?.documentId !== documentId || context?.observationId !== snapshot.observationId ||
      snapshot.url !== location.href || Date.now() - snapshot.createdAt > 120000) {
      throw fail('The page changed since it was observed. Read the page again before acting.', 'JOURNEY_STALE');
    }
  }
  function targetFor(id) {
    const saved = snapshot?.refs.get(id);
    if (!saved || !visible(saved.el) || signature(saved.el) !== saved.signature) throw fail('The selected control changed. Read the page again.', 'JOURNEY_STALE');
    const el = saved.el;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw fail('The selected control is disabled.');
    const reason = blockReason(el);
    if (reason) throw fail(reason);
    return el;
  }
  function assertTargetNavigation(el, origin) {
    const link = el.closest('a[href]');
    if (link) {
      let url;
      try { url = new URL(link.getAttribute('href'), location.href); } catch { throw fail('The link has an unsupported destination.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw fail('This link leaves the approved website.');
      if (link.hasAttribute('download') || (link.target && !['_self', '_top', '_parent'].includes(link.target))) throw fail('Downloads and links opening another tab need a person.');
    }
    const form = el.closest('form');
    if (form) {
      let url;
      try { url = new URL(el.getAttribute('formaction') || form.getAttribute('action') || location.href, location.href); } catch { throw fail('The form has an unsupported destination.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw fail('This form submits outside the approved website.');
      if (form.target && !['_self', '_top', '_parent'].includes(form.target)) throw fail('This form opens another tab.');
    }
  }
  function unobstructed(el) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    for (let node = hit; node; node = parent(node)) if (node === el) return {x, y};
    throw fail('The control is covered by another element. Read the page again.', 'JOURNEY_STALE');
  }
  function setText(el, text) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.readOnly ||
      (el instanceof HTMLInputElement && !['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(el.type))) {
      throw fail('This field does not support safe text entry. A person needs to continue.');
    }
    el.focus({preventScroll: true});
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true, inputType: 'insertText', data: text}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    if (el.value !== text && el.type !== 'number') throw fail('The field did not retain the entered value.', 'JOURNEY_ACTION_FAILED');
  }
  function previewClick(message) {
    validateContext(message.context);
    if (location.origin !== message.origin) throw fail('This page is outside the approved website.');
    const el = targetFor(message.action?.targetId);
    assertTargetNavigation(el, message.origin);
    return {point: unobstructed(el)};
  }
  function execute(message) {
    validateContext(message.context);
    if (location.origin !== message.origin) throw fail('This page is outside the approved website.');
    const action = message.action;
    const el = action.targetId ? targetFor(action.targetId) : null;
    if (el) assertTargetNavigation(el, message.origin);
    if (action.type === 'click') {
      const point = unobstructed(el);
      if (message.point && (!Number.isFinite(message.point.x) || !Number.isFinite(message.point.y) ||
        Math.abs(message.point.x - point.x) > 3 || Math.abs(message.point.y - point.y) > 3)) {
        throw fail('The control moved before the click. Read the page again.', 'JOURNEY_STALE');
      }
      el.focus?.({preventScroll: true});
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const EventClass = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new EventClass(type, {bubbles: true, composed: true, button: 0, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: 'mouse'}));
      }
      el.click();
    } else if (action.type === 'type') {
      unobstructed(el); setText(el, action.text);
    } else if (action.type === 'select') {
      if (!(el instanceof HTMLSelectElement)) throw fail('This is not a native selection field. Open it and choose a visible option instead.');
      if (![...el.options].some(option => option.value === action.value && !option.disabled)) throw fail('That option is not available.');
      unobstructed(el);
      el.focus({preventScroll: true});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, action.value);
      el.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
    } else if (action.type === 'scroll') {
      const container = el || document.scrollingElement;
      const horizontal = ['left', 'right'].includes(action.direction);
      const distance = Math.round((horizontal ? innerWidth : innerHeight) * .7) * (['up', 'left'].includes(action.direction) ? -1 : 1);
      container.scrollBy({[horizontal ? 'left' : 'top']: distance, behavior: 'instant'});
    } else if (action.type !== 'wait') {
      throw fail('Unsupported page action.');
    }
    snapshot = null; // One action per observation, even if the page looks unchanged.
    return {type: action.type, url: location.href, targetLabel: el ? label(el) : '', performed: true};
  }
  async function settle() {
    const start = Date.now();
    let changed = start;
    const observer = new MutationObserver(records => {
      if (records.some(record => !ignored(record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement))) changed = Date.now();
    });
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
    try {
      while (Date.now() - start < 1800 && (Date.now() - changed < 250 || document.readyState === 'loading')) {
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    } finally { observer.disconnect(); }
    return {url: location.href, documentId};
  }
  const listener = (message, sender, respond) => {
    if (message?.namespace !== namespace || sender.id !== chrome.runtime.id) return;
    Promise.resolve().then(async () => {
      if (message.type === 'OBSERVE') return observe();
      if (message.type === 'PREVIEW_CLICK') return previewClick(message);
      if (message.type === 'EXECUTE') return execute(message);
      if (message.type === 'VALIDATE') { validateContext(message.context); return {url: location.href, documentId}; }
      if (message.type === 'SETTLE') return settle();
      if (message.type === 'CLEANUP') { snapshot = null; chrome.runtime.onMessage.removeListener(listener); delete globalThis[KEY]; return {}; }
      throw fail('Unsupported journey message.');
    }).then(result => respond({ok: true, result}), error => respond({ok: false, error: error.message, code: error.code || 'JOURNEY_ACTION_FAILED'}));
    return true;
  };
  globalThis[KEY] = true;
  chrome.runtime.onMessage.addListener(listener);
})();
