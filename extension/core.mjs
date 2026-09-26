export const DEFAULT_SETTINGS = Object.freeze({opacity: 0.55, reveal: 50, offsetX: 0, offsetY: 0, linked: true, hidden: false});

export function safeSettings(input = {}, previous = DEFAULT_SETTINGS) {
  const result = {...previous};
  for (const [key, min, max] of [['opacity', 0, 1], ['reveal', 0, 100], ['offsetX', -3000, 3000], ['offsetY', -3000, 3000]]) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = Math.min(max, Math.max(min, input[key]));
  }
  for (const key of ['linked', 'hidden']) if (typeof input[key] === 'boolean') result[key] = input[key];
  return result;
}

export function sitePattern(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Choose a normal website or a localhost page. Chrome internal pages cannot be compared.');
  // Chrome host permissions apply to all ports on the chosen host.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function viewportWarning(source, target) {
  if (!source || !target) return 'Checking viewport…';
  const parts = [];
  if (source.width !== target.width || source.height !== target.height) parts.push(`Viewports differ: prototype ${source.width} × ${source.height}, production ${target.width} × ${target.height}. After resizing, open Prototype once, then return`);
  if (Math.abs(source.dpr - target.dpr) > 0.01) parts.push('Zoom or display scale differs');
  return parts.join(' · ');
}
