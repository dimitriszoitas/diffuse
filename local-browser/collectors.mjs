// These fixed collectors are shipped by Diffuse. Neither an AI nor a web page can
// supply JavaScript to the companion API.
export function collectStyles() {
  const maxElements = 2500;
  const text = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const selector = el => {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 8) {
      const tag = el.localName;
      const siblings = el.parentElement ? [...el.parentElement.children].filter(n => n.localName === tag) : [];
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : ''}`);
      el = el.parentElement;
    }
    return parts.join(' > ').slice(0, 500);
  };
  const groups = { typography: new Map(), colors: new Map(), spacing: new Map(), radii: new Map() };
  const add = (kind, properties, example) => {
    properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, String(value).slice(0, 300)]));
    const key = JSON.stringify(properties);
    let entry = groups[kind].get(key);
    if (!entry) {
      if (groups[kind].size >= 150) return;
      entry = { ...properties, count: 0, examples: [] };
      groups[kind].set(key, entry);
    }
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(example);
  };
  const all = [...document.querySelectorAll('body *')];
  let inspected = 0;
  for (const el of all) {
    if (inspected >= maxElements) break;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    inspected++;
    const example = { selector: selector(el), text: text([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ')), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    if (example.text) add('typography', { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color }, example);
    for (const property of ['color', 'backgroundColor', 'borderTopColor']) if (style[property] !== 'rgba(0, 0, 0, 0)') add('colors', { property, value: style[property] }, example);
    for (const property of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap']) if (!['0px', 'normal'].includes(style[property])) add('spacing', { property, value: style[property] }, example);
    if (style.borderRadius !== '0px') add('radii', { value: style.borderRadius }, example);
  }
  return { elementsInspected: inspected, truncated: inspected >= maxElements || Object.values(groups).some(g => g.size >= 150), ...Object.fromEntries(Object.entries(groups).map(([key, map]) => [key, [...map.values()].sort((a, b) => b.count - a.count)])) };
}

export function collectPage() {
  const url = new URL(location.href);
  return { url: `${url.origin}${url.pathname}`, title: document.title.slice(0, 200), viewport: { width: innerWidth, height: innerHeight }, capturedAt: new Date().toISOString() };
}

export function hoverCandidates() {
  return [...document.querySelectorAll('button, a[href], [role="button"]')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width && r.height && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !el.disabled && getComputedStyle(el).visibility !== 'hidden';
  }).slice(0, 3).map((el, index) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, name: (el.getAttribute('aria-label') || el.textContent || el.localName).replace(/\s+/g, ' ').trim().slice(0, 100), index };
  });
}

export function hoverState({ x, y }) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const s = getComputedStyle(el);
  return { tag: el.localName, color: s.color, backgroundColor: s.backgroundColor, borderColor: s.borderColor, boxShadow: s.boxShadow, outline: s.outline, textDecoration: s.textDecoration, cursor: s.cursor, transform: s.transform };
}

export function focusState() {
  const el = document.activeElement;
  if (!el) return null;
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  return { tag: el.localName, role: el.getAttribute('role'), name: (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 100), visible: Boolean(r.width && r.height && s.visibility !== 'hidden'), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, outline: s.outline, borderColor: s.borderColor, boxShadow: s.boxShadow };
}

export function axeSummary(result) {
  const issue = item => ({ id: item.id, impact: item.impact, description: item.description.slice(0, 500), help: item.help.slice(0, 250), helpUrl: item.helpUrl, tags: item.tags.slice(0, 15), nodes: item.nodes.slice(0, 8).map(node => ({ target: node.target.slice(0, 3).map(t => String(t).slice(0, 300)), failureSummary: (node.failureSummary || '').slice(0, 700) })) });
  return { engine: 'axe-core', version: result.testEngine.version, violations: result.violations.slice(0, 60).map(issue), incomplete: result.incomplete.slice(0, 40).map(issue), passesCount: result.passes.length, inapplicableCount: result.inapplicable.length, limitations: ['Automated checks do not establish full WCAG conformance.', 'Screen-reader behavior, meaning, and task usability need manual assessment.', 'Cross-origin frames and closed shadow roots are not fully inspected.'], truncated: result.violations.length > 60 || result.incomplete.length > 40 || [...result.violations, ...result.incomplete].some(item => item.nodes.length > 8) };
}
