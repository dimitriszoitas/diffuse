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
  const visibleBounds = (el, rect = el?.getBoundingClientRect(), includeSelfClip = false) => {
    if (!el?.isConnected || ignored(el) || !rect) return null;
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let node = el; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return null;
      if ((node !== el || includeSelfClip) && node !== document.documentElement && node !== document.body) {
        const bounds = node.getBoundingClientRect();
        if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
    }
    return right > left && bottom > top ? {left, top, right, bottom, width: right - left, height: bottom - top} : null;
  };
  const visible = el => Boolean(visibleBounds(el));
  const ACTIONABLE = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="tab"],[role="menuitem"],[role="option"]';
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
  function scrollState(el, page = false) {
    const style = getComputedStyle(el), bodyStyle = page && document.body ? getComputedStyle(document.body) : null;
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth), maxY = Math.max(0, el.scrollHeight - el.clientHeight);
    const x = el.scrollLeft, y = el.scrollTop;
    const allows = axis => page
      ? !/(hidden|clip)/.test(style[`overflow${axis}`]) && !/(hidden|clip)/.test(bodyStyle?.[`overflow${axis}`] || '')
      : /(auto|scroll|overlay)/.test(style[`overflow${axis}`]);
    const rtl = style.direction === 'rtl';
    return {x, y, maxX, maxY,
      canScrollUp: allows('Y') && y > 1, canScrollDown: allows('Y') && y < maxY - 1,
      canScrollLeft: allows('X') && (rtl ? x > -maxX + 1 : x > 1),
      canScrollRight: allows('X') && (rtl ? x < -1 : x < maxX - 1)};
  }
  function scrollable(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || !visible(el)) return false;
    const state = scrollState(el);
    return state.canScrollUp || state.canScrollDown || state.canScrollLeft || state.canScrollRight;
  }
  function scrollLabel(el) {
    const named = compact(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => el.getRootNode().getElementById?.(id)).filter(node => node && visible(node))
      .map(node => node.innerText).join(' '), 160);
    if (named) return named;
    // Never use the container's innerText: it also contains clipped/offscreen
    // options, which the model has not actually seen yet.
    for (let scope = el; scope && scope !== document.body; scope = parent(scope)) {
      const heading = [...scope.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].find(node => visible(node));
      if (heading) return `${compact(heading.innerText, 120)} · scrollable region`;
      if (scope.matches('dialog,[role="dialog"],[role="listbox"]')) break;
    }
    return 'Scrollable region';
  }
  function descriptor(el, id, scrollOnly = false, scroll = null) {
    const item = {id, role: scrollOnly ? 'scroll-region' : role(el), label: scrollOnly ? scrollLabel(el) : label(el) || '(unlabelled control)'};
    const reason = scrollOnly ? '' : blockReason(el);
    if (scroll) item.scroll = scroll;
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
  function signature(el, scrollOnly = false, hasScroll = false) {
    return JSON.stringify([role(el), scrollOnly ? scrollLabel(el) : label(el), el.type, el.getAttribute('href'), el.getAttribute('formaction'),
      el.closest?.('form')?.getAttribute('action'), el.disabled, el.getAttribute('aria-disabled'), el.value, el.checked,
      hasScroll ? scrollState(el) : null]);
  }
  function visibleNodeText(el, node, budget) {
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = range.getBoundingClientRect(), bounds = visibleBounds(el, rect, true);
    if (!bounds) return '';
    if (rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1) {
      return compact(node.textContent, 600);
    }
    // Text directly inside a clipped container may span many unseen lines.
    // Read only rendered words, with a fixed inspection/output budget.
    const words = [], pattern = /\S+/g, text = node.textContent;
    let match, inspected = 0, size = 0;
    while ((match = pattern.exec(text)) && inspected++ < 2000 && budget.remaining-- > 0) {
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const wordRect = range.getBoundingClientRect();
      // The clipping ancestors are fixed for this synchronous observation.
      // Reuse their intersection instead of re-reading computed styles for
      // every word in a long, partially visible text node.
      if (wordRect.right <= bounds.left || wordRect.left >= bounds.right || wordRect.bottom <= bounds.top || wordRect.top >= bounds.bottom) continue;
      words.push(match[0]); size += match[0].length + 1;
      if (size >= 600) break;
    }
    return compact(words.join(' '), 600);
  }
  function readText(elements) {
    const output = [];
    const budget = {remaining: 6000};
    let size = 0;
    for (const el of elements) {
      if (!visible(el) || /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || el.isContentEditable) continue;
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = visibleNodeText(el, node, budget);
        if (!text) continue;
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
    const regions = elements.filter(el => {
      if (!scrollable(el)) return false;
      try { scrollPoint(el); return true; } catch { return false; }
    }).slice(0, 24);
    const candidates = elements.filter(el => visible(el) && el.matches(`${ACTIONABLE},[tabindex="0"]`)).slice(0, 180 - regions.length);
    for (const el of regions) if (!candidates.includes(el)) candidates.push(el);
    const controls = candidates.map((el, i) => {
      const id = `control-${i + 1}`;
      const hasScroll = regions.includes(el), scrollOnly = hasScroll && !el.matches(ACTIONABLE);
      refs.set(id, {el, scrollOnly, hasScroll, signature: signature(el, scrollOnly, hasScroll)});
      return descriptor(el, id, scrollOnly, hasScroll ? scrollState(el) : null);
    });
    snapshot = {observationId, url: location.href, refs, createdAt: Date.now()};
    return {
      url: location.href, title: compact(document.title, 300), text: readText(elements), controls,
      context: {
        documentId, observationId, url: location.href, title: compact(document.title, 300),
        viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1},
        scroll: scrollState(document.scrollingElement, true),
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
  function targetFor(id, actionType) {
    const saved = snapshot?.refs.get(id);
    if (!saved || !visible(saved.el) || signature(saved.el, saved.scrollOnly, saved.hasScroll) !== saved.signature) throw fail('The selected control changed. Read the page again.', 'JOURNEY_STALE');
    if (actionType === 'scroll' && !saved.hasScroll) throw fail('Choose a scrollable region from the current observation.', 'JOURNEY_INVALID_ACTION');
    if (saved.scrollOnly && actionType !== 'scroll') throw fail('This region supports scrolling. Choose one of its visible controls to interact.', 'JOURNEY_INVALID_ACTION');
    const el = saved.el;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw fail('The selected control is disabled.');
    const reason = actionType === 'scroll' ? '' : blockReason(el);
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
    const bounds = visibleBounds(el);
    if (!bounds) throw fail('The control is no longer visible.', 'JOURNEY_STALE');
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    for (let node = hit; node; node = parent(node)) if (node === el) return {x, y};
    throw fail('The control is covered by another element. Read the page again.', 'JOURNEY_STALE');
  }
  function scrollPoint(el) {
    const bounds = visibleBounds(el);
    if (!bounds) throw fail('The scrollable region is no longer visible.', 'JOURNEY_STALE');
    const points = [[.5, .5], [.15, .15], [.85, .15], [.15, .85], [.85, .85]];
    for (const [x, y] of points) {
      const point = {x: bounds.left + bounds.width * x, y: bounds.top + bounds.height * y};
      let hit = document.elementFromPoint(point.x, point.y);
      while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint?.(point.x, point.y); if (!next || next === hit) break; hit = next; }
      for (let node = hit; node; node = parent(node)) if (node === el) return point;
    }
    throw fail('The scrollable region is covered. Read the page again.', 'JOURNEY_STALE');
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
    const el = targetFor(message.action?.targetId, 'click');
    assertTargetNavigation(el, message.origin);
    return {point: unobstructed(el)};
  }
  function execute(message) {
    validateContext(message.context);
    if (location.origin !== message.origin) throw fail('This page is outside the approved website.');
    const action = message.action;
    const el = action.targetId ? targetFor(action.targetId, action.type) : null;
    if (el && action.type !== 'scroll') assertTargetNavigation(el, message.origin);
    let scrollResult = null;
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
      if (el) scrollPoint(el);
      const state = scrollState(container, !el), before = {x: state.x, y: state.y};
      const directionFlag = `canScroll${action.direction[0].toUpperCase()}${action.direction.slice(1)}`;
      const bounds = el ? visibleBounds(el) : {width: innerWidth, height: innerHeight};
      const visibleExtent = horizontal ? Math.min(bounds.width, container.clientWidth) : Math.min(bounds.height, container.clientHeight);
      const distance = Math.max(1, Math.round(visibleExtent * .7)) * (['up', 'left'].includes(action.direction) ? -1 : 1);
      if (state[directionFlag]) container.scrollBy({[horizontal ? 'left' : 'top']: distance, behavior: 'instant'});
      const afterState = scrollState(container, !el), after = {x: afterState.x, y: afterState.y};
      scrollResult = {targetId: action.targetId || null, before, after, delta: {x: after.x - before.x, y: after.y - before.y}, atBoundary: !afterState[directionFlag]};
    } else if (action.type !== 'wait') {
      throw fail('Unsupported page action.');
    }
    snapshot = null; // One action per observation, even if the page looks unchanged.
    return {type: action.type, url: location.href, targetLabel: el ? (action.type === 'scroll' ? scrollLabel(el) : label(el)) : '',
      performed: scrollResult ? Math.abs(scrollResult.delta.x) > .5 || Math.abs(scrollResult.delta.y) > .5 : true,
      ...(scrollResult ? {scroll: scrollResult} : {})};
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
