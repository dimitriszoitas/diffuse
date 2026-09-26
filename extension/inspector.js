(() => {
  if (globalThis.DiffuseInspector) return;

  const STYLE_PROPERTIES = [
    'display', 'position', 'boxSizing', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
    'color', 'backgroundColor', 'opacity', 'visibility',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopStyle', 'borderRadius', 'boxShadow',
    'gap', 'rowGap', 'columnGap', 'alignItems', 'justifyContent', 'flexDirection', 'flexWrap',
    'flexGrow', 'flexShrink', 'gridTemplateColumns', 'gridTemplateRows', 'overflowX', 'overflowY', 'transform',
  ];
  const clean = value => typeof value === 'string' ? value.slice(0, 300) : null;
  const round = value => Math.round(value * 100) / 100;
  const parentOf = element => element.parentElement || (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
  const attribute = (element, name) => clean(element.getAttribute(name));

  function localSelector(element) {
    const scope = element.getRootNode();
    const unique = selector => {
      try { return scope.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    if (element.id && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
    for (const name of ['data-testid', 'data-component', 'data-diffuse-scroll']) {
      const value = element.getAttribute(name);
      if (value) {
        const selector = `[${name}="${CSS.escape(value)}"]`;
        if (unique(selector)) return selector;
      }
    }
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      let part = node.localName;
      if (node.id && unique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  }

  function selectorFor(element) {
    const parts = [localSelector(element)];
    let scope = element.getRootNode();
    while (scope instanceof ShadowRoot) {
      parts.unshift(localSelector(scope.host));
      scope = scope.host.getRootNode();
    }
    return parts.join(' >>> ');
  }

  function context() {
    const html = document.documentElement;
    const rootStyle = getComputedStyle(html);
    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1 },
      scroll: { x: scrollX, y: scrollY },
      theme: {
        declared: attribute(html, 'data-theme') || (document.body && attribute(document.body, 'data-theme')) || null,
        colorScheme: rootStyle.colorScheme,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      },
      language: html.lang || navigator.language,
      browser: { userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform, language: navigator.language },
      device: { screenWidth: screen.width, screenHeight: screen.height, maxTouchPoints: navigator.maxTouchPoints || 0, orientation: screen.orientation?.type || null },
    };
  }

  function componentFor(element) {
    let owner = element;
    for (let depth = 0; owner && depth < 8; depth++, owner = parentOf(owner)) {
      const name = attribute(owner, 'data-component');
      if (name) return { name, source: 'data-component', selector: selectorFor(owner) };
    }
    owner = element;
    for (let depth = 0; owner && depth < 8; depth++, owner = parentOf(owner)) {
      const name = attribute(owner, 'data-testid');
      if (name) return { name, source: 'data-testid', selector: selectorFor(owner) };
    }
    const role = attribute(element, 'role');
    return { name: role || element.localName, source: role ? 'role' : 'tag', selector: selectorFor(element) };
  }

  function inspect(element) {
    if (!(element instanceof Element)) throw new Error('Choose an element on the production page.');
    const bounds = element.getBoundingClientRect();
    const viewportRect = Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, round(bounds[key])]));
    const documentRect = { ...viewportRect, x: round(bounds.x + scrollX), y: round(bounds.y + scrollY), top: round(bounds.top + scrollY), right: round(bounds.right + scrollX), bottom: round(bounds.bottom + scrollY), left: round(bounds.left + scrollX) };
    const computed = getComputedStyle(element);
    const breadcrumb = [];
    const scrollContainers = [];
    let node = element;
    for (let depth = 0; node && depth < 20; depth++, node = parentOf(node)) {
      breadcrumb.unshift({
        tag: node.localName,
        ...(node.id ? { id: clean(node.id) } : {}),
        ...(node.hasAttribute('role') ? { role: attribute(node, 'role') } : {}),
        ...(node.hasAttribute('data-testid') ? { testId: attribute(node, 'data-testid') } : {}),
        ...(node.hasAttribute('data-component') ? { component: attribute(node, 'data-component') } : {}),
      });
      const style = getComputedStyle(node);
      if (node !== document.documentElement && node !== document.body && (/(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX))) {
        scrollContainers.push({ selector: selectorFor(node), scrollLeft: node.scrollLeft, scrollTop: node.scrollTop, clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, overflowX: style.overflowX, overflowY: style.overflowY });
      }
    }
    const scrolling = document.scrollingElement;
    scrollContainers.push({ selector: ':root', scrollLeft: scrollX, scrollTop: scrollY, clientWidth: innerWidth, clientHeight: innerHeight, scrollWidth: scrolling?.scrollWidth || innerWidth, scrollHeight: scrolling?.scrollHeight || innerHeight, overflowX: getComputedStyle(document.documentElement).overflowX, overflowY: getComputedStyle(document.documentElement).overflowY });
    const ariaBoolean = name => element.hasAttribute(`aria-${name}`) ? element.getAttribute(`aria-${name}`) : null;
    return {
      schemaVersion: 1,
      kind: 'element',
      component: componentFor(element),
      selector: selectorFor(element),
      selectorFormat: element.getRootNode() instanceof ShadowRoot ? 'shadow-piercing' : 'css',
      breadcrumb,
      tagName: element.localName,
      role: attribute(element, 'role'),
      rect: { viewport: viewportRect, document: documentRect },
      styles: Object.fromEntries(STYLE_PROPERTIES.map(property => [property, computed[property]])),
      states: {
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
        checked: element.matches(':checked') || element.getAttribute('aria-checked') === 'true',
        ariaChecked: ariaBoolean('checked'),
        indeterminate: element instanceof HTMLInputElement ? element.indeterminate : false,
        selected: element instanceof HTMLOptionElement ? element.selected : ariaBoolean('selected'),
        expanded: ariaBoolean('expanded'), pressed: ariaBoolean('pressed'), busy: ariaBoolean('busy'), invalid: ariaBoolean('invalid'),
        required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
        readOnly: element.hasAttribute('readonly') || element.getAttribute('aria-readonly') === 'true',
        focused: element.matches(':focus'), focusVisible: element.matches(':focus-visible'), hovered: element.matches(':hover'),
        current: attribute(element, 'aria-current'),
        open: element.hasAttribute('open'),
        inputType: element instanceof HTMLInputElement ? element.type : null,
      },
      scrollContainers,
      context: context(),
    };
  }

  function region(x, y, width, height) {
    const left = round(Math.max(0, Math.min(innerWidth, x)));
    const top = round(Math.max(0, Math.min(innerHeight, y)));
    const right = round(Math.max(left, Math.min(innerWidth, x + width)));
    const bottom = round(Math.max(top, Math.min(innerHeight, y + height)));
    const viewportRect = {x:left, y:top, width:round(right-left), height:round(bottom-top), top, right, bottom, left};
    return {schemaVersion:1, kind:'region', component:{name:'Selected area',source:'region'}, rect:{viewport:viewportRect, document:{...viewportRect,x:round(left+scrollX),y:round(top+scrollY),left:round(left+scrollX),top:round(top+scrollY),right:round(right+scrollX),bottom:round(bottom+scrollY)}},context:context()};
  }

  function resolveSelector(selector) {
    if (typeof selector !== 'string' || !selector) return null;
    try {
      let scope = document;
      const parts = selector.split(' >>> ');
      for (let index=0; index<parts.length; index++) {
        const matches = scope.querySelectorAll(parts[index]);
        if (matches.length !== 1) return null;
        const element = matches[0];
        if (index === parts.length-1) return element;
        if (!element.shadowRoot) return null;
        scope = element.shadowRoot;
      }
    } catch {}
    return null;
  }

  globalThis.DiffuseInspector = Object.freeze({ inspect, context, region, resolveSelector });
})();
