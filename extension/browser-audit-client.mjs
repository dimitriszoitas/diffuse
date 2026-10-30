// Fixed loopback companion. Never accepts a page-supplied endpoint or tool name.
export const BROWSER_AUDIT_ENDPOINT = 'http://127.0.0.1:8932';
export const BROWSER_AUDIT_ORIGIN = 'http://127.0.0.1/*';
const KEY = 'diffuseLocalBrowserToken';
export class BrowserAuditError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserAuditError'; this.code = code; }
}
const fail = (code, message) => { throw new BrowserAuditError(code, message); };
export function browserAuditURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('AUDIT_URL', 'Enter a complete http or https page address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096 || (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '8932')) fail('AUDIT_URL', 'Choose a website address without credentials.');
  return url.href;
}
export function browserAuditChecks(value = {}) {
  const checks = Object.fromEntries(['styles', 'accessibility', 'interactions'].map(key => [key, value[key] !== false]));
  if (!Object.values(checks).some(Boolean)) fail('AUDIT_CHECKS', 'Choose at least one check.');
  return checks;
}
export function browserAuditId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('AUDIT_ID', 'Choose a saved interactive audit.');
  return value;
}
export async function readBrowserAuditConfig({storage = chrome.storage.local, includeToken = false} = {}) {
  await storage.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  const token = (await storage.get(KEY))[KEY] || '';
  return {endpoint: BROWSER_AUDIT_ENDPOINT, paired: Boolean(token), ...(includeToken ? {token} : {})};
}
export async function pairBrowserAudit(token, {storage = chrome.storage.local, fetchImpl} = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token.trim())) fail('AUDIT_TOKEN', 'Paste the pairing token shown by the local browser helper.');
  token = token.trim();
  await browserAuditRequest('/health', {token, fetchImpl});
  await storage.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  await storage.set({[KEY]: token});
  return {...await readBrowserAuditConfig({storage}), connected: true};
}
export async function disconnectBrowserAudit({storage = chrome.storage.local} = {}) {
  await storage.remove(KEY); return readBrowserAuditConfig({storage});
}
export async function browserAuditRequest(path, {method = 'GET', body, token, signal, fetchImpl = globalThis.fetch, timeoutMs = 12000} = {}) {
  if (!/^\/(?:health|audits(?:\/[A-Za-z0-9_-]{1,100}(?:\/(?:run|stop))?)?)$/.test(path) || !['GET', 'POST'].includes(method)) fail('AUDIT_REQUEST', 'Unsupported local browser action.');
  if (!token) fail('AUDIT_PAIRING', 'Connect the local browser helper first.');
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(BROWSER_AUDIT_ENDPOINT + path, {method, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      const [code, message] = response.status === 401 || response.status === 403 ? ['AUDIT_PAIRING', 'The local browser connection was rejected. Check the pairing token and allowed extension.'] : response.status === 404 ? ['AUDIT_MISSING', 'This browser session is no longer in the helper. Your saved evidence is still in Reports.'] : response.status === 409 ? ['AUDIT_BUSY', 'Finish or stop the current browser audit first.'] : ['AUDIT_HELPER', 'The local browser helper could not complete this action. Check its terminal and try again.'];
      fail(code, message);
    }
    const reader = response.body?.getReader();
    if (!reader) fail('AUDIT_RESPONSE', 'The local browser helper returned an unreadable response.');
    let text = '', size = 0; const decoder = new TextDecoder();
    try {
      while (true) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 16 * 1024 * 1024) fail('AUDIT_RESPONSE', 'The local audit was too large to load.'); text += decoder.decode(value, {stream: true}); }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (text.includes(token)) fail('AUDIT_RESPONSE', 'The helper returned credential-like data. No evidence was saved.');
    let result; try { result = JSON.parse(text); } catch { fail('AUDIT_RESPONSE', 'The local browser helper returned an unreadable response.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('AUDIT_RESPONSE', 'The local browser helper returned an invalid result.');
    return result;
  } catch (error) {
    if (error instanceof BrowserAuditError) throw error;
    fail(controller.signal.aborted ? 'AUDIT_TIMEOUT' : 'AUDIT_OFFLINE', controller.signal.aborted ? 'The local browser did not answer in time. Check its status before starting again.' : 'Start the local browser helper, then check the connection again.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
