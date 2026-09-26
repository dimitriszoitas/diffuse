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
  if (parsed.protocol === 'file:') return 'file:///*';
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(UNSUPPORTED_PAGE_MESSAGE);
  // Chrome host permissions apply to all ports on the chosen host.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export const FILE_ACCESS_MESSAGE = 'To review local HTML files, open Diffuse’s extension settings and turn on “Allow access to file URLs”. Then return to this page.';
export const UNSUPPORTED_PAGE_MESSAGE = 'Open a website, localhost page, or local HTML file to start a review. Chrome internal pages cannot be reviewed.';

export function isReviewableUrl(url) {
  try { return ['http:', 'https:', 'file:'].includes(new URL(url).protocol); }
  catch { return false; }
}

export function isFileUrl(url) {
  try { return new URL(url).protocol === 'file:'; }
  catch { return false; }
}

export function pageLocation(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      let path = parsed.pathname;
      try { path = decodeURIComponent(path); } catch { /* Keep malformed escapes readable. */ }
      return `Local file · ${path}`;
    }
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch { return 'Page unavailable'; }
}

export async function pageAccess(url, chromeApi = globalThis.chrome) {
  const supported = isReviewableUrl(url);
  const localFile = isFileUrl(url);
  let fileAccess = !localFile;
  if (localFile) {
    try { fileAccess = await chromeApi.extension.isAllowedFileSchemeAccess() === true; }
    catch { fileAccess = false; }
  }
  return {
    supported, localFile, allowed: supported && fileAccess,
    needsFileAccess: localFile && !fileAccess,
    message: !supported ? UNSUPPORTED_PAGE_MESSAGE : !fileAccess ? FILE_ACCESS_MESSAGE : ''
  };
}

function accessError(status) {
  const error = new Error(status.message);
  error.code = status.needsFileAccess ? 'FILE_ACCESS_REQUIRED' : 'UNSUPPORTED_PAGE';
  return error;
}

export async function assertPageAccess(url, chromeApi = globalThis.chrome, permissionMessage = 'Allow Diffuse to access this page before continuing.') {
  const status = await pageAccess(url, chromeApi);
  if (!status.allowed) throw accessError(status);
  const pattern = sitePattern(url);
  if (!(await chromeApi.permissions.contains({origins: [pattern]}))) throw new Error(permissionMessage);
  return pattern;
}

// Invoke this directly from the click/submit handler: Chrome's host permission
// request must run before any await consumes the user gesture. The separate file
// toggle is always checked again before a worker injects or captures the page.
export async function requestPageAccess(url, chromeApi = globalThis.chrome) {
  const pattern = sitePattern(url);
  let granted;
  try { granted = await chromeApi.permissions.request({origins: [pattern]}); }
  catch (error) {
    const status = await pageAccess(url, chromeApi);
    if (!status.allowed) throw accessError(status);
    throw error;
  }
  const status = await pageAccess(url, chromeApi);
  if (!status.allowed) throw accessError(status);
  return granted === true;
}

export function extensionSettingsUrl(extensionId) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw new Error('Diffuse’s extension settings are unavailable. Open chrome://extensions and choose Diffuse.');
  return `chrome://extensions/?id=${extensionId}`;
}

export function viewportWarning(source, target) {
  if (!source || !target) return 'Checking viewport…';
  const parts = [];
  if (source.width !== target.width || source.height !== target.height) parts.push(`Viewports differ: prototype ${source.width} × ${source.height}, production ${target.width} × ${target.height}. After resizing, open Prototype once, then return`);
  if (Math.abs(source.dpr - target.dpr) > 0.01) parts.push('Zoom or display scale differs');
  return parts.join(' · ');
}
