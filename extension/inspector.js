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

  function nestedScrollSnapshot() {
    const positions=[];
    const visit=scope=>{
      for(const node of scope.querySelectorAll('*')) {
        if(node.localName==='diffuse-live-overlay')continue;
        if(node!==document.body&&node!==document.documentElement&&(node.scrollTop||node.scrollLeft))positions.push({selector:selectorFor(node),x:node.scrollLeft,y:node.scrollTop});
        if(node.shadowRoot)visit(node.shadowRoot);
      }
    };
    visit(document);
    return positions;
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
      nestedScroll: nestedScrollSnapshot(),
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
      anchor: anchorFor(element, viewportRect, 'element'),
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
    const target = regionTarget(viewportRect);
    const anchor = target ? anchorFor(target, viewportRect, 'region') : null;
    return {schemaVersion:1, kind:'region', ...(anchor ? {anchor} : {}), component:{name:'Selected area',source:'region'}, rect:{viewport:viewportRect, document:{...viewportRect,x:round(left+scrollX),y:round(top+scrollY),left:round(left+scrollX),top:round(top+scrollY),right:round(right+scrollX),bottom:round(bottom+scrollY)}},context:context()};
  }

  // Anchors are persisted with the capture, not inferred later from a changed
  // page. A positional selector also keeps a small identity hint so recycled
  // list rows do not silently inherit a comment from a different item.
  function identityFor(element) {
    const attributes = {};
    for (const name of ['id', 'data-testid', 'data-component', 'data-diffuse-scroll', 'role', 'aria-label']) {
      if (element.hasAttribute(name)) attributes[name] = element.getAttribute(name).slice(0, 300);
    }
    const durable = ['id', 'data-testid', 'data-component', 'data-diffuse-scroll'].some(name => attributes[name] && (() => {
      try { return element.getRootNode().querySelectorAll(`[${name}="${CSS.escape(attributes[name])}"]`).length === 1; } catch { return false; }
    })());
    const text = !durable && !element.matches('input,textarea,select,[contenteditable]')
      ? (element.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return {tag:element.localName, attributes, ...(text && text.length <= 160 ? {text} : {})};
  }

  function identityMatches(element, identity) {
    if (!identity || identity.tag !== element.localName) return false;
    if (Object.entries(identity.attributes || {}).some(([name, value]) => element.getAttribute(name) !== value)) return false;
    return !identity.text || (element.textContent || '').replace(/\s+/g, ' ').trim() === identity.text;
  }

  function anchorFor(element, rect, kind) {
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const style = getComputedStyle(element);
    const scrolls = /(auto|scroll|hidden)/.test(`${style.overflowX} ${style.overflowY}`)
      && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
    return {version:1, kind, selector:selectorFor(element), identity:identityFor(element),
      ...(kind === 'region' ? (scrolls ? {
        space:'scroll-content', offset:{x:rect.x-bounds.x+element.scrollLeft,y:rect.y-bounds.y+element.scrollTop,width:rect.width,height:rect.height},
      } : {
        space:'relative', relative:{x:(rect.x-bounds.x)/bounds.width,y:(rect.y-bounds.y)/bounds.height,width:rect.width/bounds.width,height:rect.height/bounds.height},
      }) : {})};
  }

  function isPageElement(element) {
    for (let node=element; node; node=parentOf(node)) if (node.localName === 'diffuse-live-overlay') return false;
    return element !== document.documentElement && element !== document.body;
  }

  function elementAt(x,y) {
    let target = document.elementsFromPoint(x,y).find(isPageElement);
    // Open shadow roots are inspectable without changing the page.
    while (target?.shadowRoot?.elementFromPoint) {
      const inner = target.shadowRoot.elementFromPoint(x,y);
      if (!inner || inner === target || !isPageElement(inner)) break;
      target = inner;
    }
    return target;
  }

  function regionTarget(rect) {
    const x = Math.max(0, Math.min(innerWidth-1, rect.x+rect.width/2));
    const y = Math.max(0, Math.min(innerHeight-1, rect.y+rect.height/2));
    let candidate = elementAt(x,y);
    while (candidate && isPageElement(candidate)) {
      const bounds = candidate.getBoundingClientRect();
      if (bounds.width && bounds.height && bounds.left <= rect.x+1 && bounds.top <= rect.y+1
        && bounds.right >= rect.x+rect.width-1 && bounds.bottom >= rect.y+rect.height-1) return candidate;
      candidate = parentOf(candidate);
    }
    return null;
  }

  function clipRect(rect, element) {
    let left=Math.max(0,rect.x), top=Math.max(0,rect.y), right=Math.min(innerWidth,rect.x+rect.width), bottom=Math.min(innerHeight,rect.y+rect.height);
    for (let node=element; node; node=parentOf(node)) {
      const style=getComputedStyle(node);
      if (style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse') return null;
      if (node===element && !node.getClientRects().length) return null;
      if (node===document.body || node===document.documentElement) continue;
      const bounds=node.getBoundingClientRect();
      if ( /(auto|scroll|hidden|clip)/.test(style.overflowX)) {left=Math.max(left,bounds.left+node.clientLeft);right=Math.min(right,bounds.left+node.clientLeft+node.clientWidth);}
      if ( /(auto|scroll|hidden|clip)/.test(style.overflowY)) {top=Math.max(top,bounds.top+node.clientTop);bottom=Math.min(bottom,bounds.top+node.clientTop+node.clientHeight);}
    }
    return right>left && bottom>top ? {x:left,y:top,width:right-left,height:bottom-top} : null;
  }

  function resolveAnchor(anchor) {
    if (anchor?.version !== 1) return null;
    const element=resolveSelector(anchor.selector);
    if (!element?.isConnected || !identityMatches(element,anchor.identity)) return null;
    const bounds=element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    let rect={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
    if (anchor.kind==='region') {
      if (anchor.space==='scroll-content' && anchor.offset) {
        const offset=anchor.offset;
        rect={x:bounds.x+offset.x-element.scrollLeft,y:bounds.y+offset.y-element.scrollTop,width:offset.width,height:offset.height};
      } else if (anchor.space==='relative' && anchor.relative) {
        const relative=anchor.relative;
        rect={x:bounds.x+relative.x*bounds.width,y:bounds.y+relative.y*bounds.height,width:relative.width*bounds.width,height:relative.height*bounds.height};
      } else return null;
    }
    if (!Object.values(rect).every(Number.isFinite) || rect.width<0 || rect.height<0) return null;
    return {...rect,visible:clipRect(rect,element)};
  }

  function resolveSelection(selection) {
    if (!selection) return null;
    if (selection.anchor) return resolveAnchor(selection.anchor);
    if (selection.kind!=='region' && selection.selector) {
      const target=resolveSelector(selection.selector);
      if (!target?.isConnected) return null;
      const bounds=target.getBoundingClientRect();
      const rect={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
      return {...rect,visible:clipRect(rect,target)};
    }
    // Older area captures have no reliable element identity. Preserve their
    // recorded document position, adjusting only known scroll containers.
    const original=selection.rect?.document;
    if (!original || ![original.x,original.y,original.width,original.height].every(Number.isFinite)) return null;
    const rect={x:original.x-scrollX,y:original.y-scrollY,width:original.width,height:original.height};
    let clip=null;
    for (const container of selection.scrollContainers || []) {
      if (container.selector===':root') continue;
      const target=resolveSelector(container.selector);
      if (!target) return null;
      rect.x-=(target.scrollLeft-(container.scrollLeft||0));rect.y-=(target.scrollTop-(container.scrollTop||0));
      clip ||= target;
    }
    return {...rect,visible:clipRect(rect,clip)};
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

  globalThis.DiffuseInspector = Object.freeze({ inspect, context, region, resolveSelector, resolveSelection, nestedScrollSnapshot });
})();
