export const JIRA_BACKEND_ORIGIN = 'https://diffuse-jira-api.vercel.app';

const CONNECTION_PREFIX = 'diffuseJiraConnection:';
const HANDSHAKE_PREFIX = 'diffuseJiraHandshake:';
const EXTENSION_ID = /^[a-p]{32}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const HANDSHAKE_TTL = 10 * 60 * 1000;
const messages = Object.freeze({
  setup_pending: 'The Jira connection service is still being configured. Try again after setup is complete.',
  invalid_request: 'This Diffuse installation is not ready to connect. Share the installation ID below with the person setting up Jira.',
  permission_denied: 'Allow Diffuse to reach its Jira connection service, then try again.',
  cancelled: 'Sign-in was cancelled. No account was added.',
  busy: 'Finish the open Jira sign-in before starting another.',
  unsupported_browser: 'This version of Chrome cannot securely connect Jira. Update Chrome and reload Diffuse.',
  storage_unavailable: 'Diffuse could not securely save this connection. Reload this page and try again.',
  access_denied: 'Jira access was not approved. Connect the account again when you are ready.',
  no_sites: 'This account has no available Jira sites with the required permissions.',
  unauthorized: 'This Jira connection is no longer available. Connect the account again.',
  invalid_response: 'The Jira connection could not be verified. No new account was saved. Start sign-in again.',
  expired: 'This Jira sign-in expired or was already used. Start sign-in again.',
  rate_limited: 'Too many Jira connection requests. Wait a moment and try again.',
  timeout: 'The Jira connection service took too long to respond. Try again.',
  unavailable: 'The Jira connection service is unavailable. Check your connection and try again.',
  invalid_input: 'The Jira request contains an unsupported or invalid value. Check the selected destination and fields.',
  rejected: 'Jira rejected this request. Check the destination and required field values.',
  not_found: 'The selected Jira project, issue type, or delivery is not available.',
  write_outcome_unknown: 'Jira may have saved this request. Check the delivery status before trying again.',
  request_not_allowed: 'This Jira operation is not supported by Diffuse.',
  payload_too_large: 'This Jira request is too large. Reduce the attachment or split it into smaller upload chunks.',
  destination_unavailable: 'The selected Jira project or issue type is no longer available. Choose the destination again.',
  required_fields: 'Complete the required Jira fields before creating tickets.',
  invalid_fields: 'A selected Jira field value is no longer available. Refresh the destination fields.',
  metadata_incomplete: 'Jira returned incomplete destination settings. Refresh and try again.',
  attachments_disabled: 'Attachments are disabled on this Jira site. Ask its administrator to enable them before sending evidence.',
  attachment_too_large: 'An attachment exceeds this Jira site’s upload limit. Use a smaller screenshot or recording.',
  chunk_conflict: 'An evidence upload conflicts with an earlier upload. Refresh its delivery status before continuing.',
  incomplete_evidence: 'The evidence upload is incomplete. Resume this delivery to finish uploading it.',
  evidence_mismatch: 'The uploaded evidence did not match the selected file. Check the delivery status before preparing it again.',
  evidence_expired: 'The temporary evidence has expired. Check the existing ticket before preparing a new delivery.',
  not_ready: 'This delivery is not ready for attachments. Refresh its status before continuing.',
  conflict: 'This delivery has changed. Refresh its status before continuing.'
});

export class JiraConnectionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'unavailable';
    super(messages[safeCode]);
    this.name = 'JiraConnectionError';
    this.code = safeCode;
  }
}

const fail = code => { throw new JiraConnectionError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function publicSites(sites) {
  if (!Array.isArray(sites) || sites.length > 1000) fail('invalid_response');
  const ids = new Set();
  return sites.map(site => {
    if (!plain(site) || !UUID.test(site.id) || ids.has(site.id) || !cleanText(site.name, 512) || typeof site.url !== 'string') fail('invalid_response');
    let url;
    try { url = new URL(site.url); } catch { fail('invalid_response'); }
    if (url.protocol !== 'https:' || url.origin !== site.url || url.username || url.password) fail('invalid_response');
    ids.add(site.id);
    return {id: site.id, name: site.name, url: site.url};
  });
}

function publicConnection(value) {
  if (!plain(value) || !UUID.test(value.id) || !cleanText(value.accountId, 256) || !cleanText(value.displayName, 512)) fail('invalid_response');
  return {id: value.id, accountId: value.accountId, displayName: value.displayName, sites: publicSites(value.sites)};
}

function storedConnection(value) {
  const result = publicConnection(value);
  if (typeof value.credential !== 'string' || value.credential !== `${result.id}.${value.credential.split('.')[1]}` || !SECRET.test(value.credential.split('.')[1])) fail('invalid_response');
  return {...result, credential: value.credential};
}

function errorCode(body, status) {
  const code = plain(body) ? (typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : body.error?.code) : '';
  if (status === 503 || code === 'invalid_configuration') return 'setup_pending';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (Object.hasOwn(messages, code)) return code;
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (['invalid_state', 'invalid_handoff'].includes(code)) return 'expired';
  if (['access_denied', 'no_sites', 'invalid_request', 'unauthorized', 'rate_limited', 'timeout', 'invalid_input', 'rejected', 'not_found', 'write_outcome_unknown'].includes(code)) return code;
  return 'unavailable';
}

function authorizationURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_response'); }
  if (url.origin !== 'https://auth.atlassian.com' || url.pathname !== '/authorize' || url.username || url.password || url.hash ||
      url.searchParams.get('redirect_uri') !== `${JIRA_BACKEND_ORIGIN}/oauth/jira/callback` ||
      url.searchParams.get('response_type') !== 'code' || url.searchParams.get('audience') !== 'api.atlassian.com' ||
      !cleanText(url.searchParams.get('client_id'), 512) || !SECRET.test(url.searchParams.get('state'))) fail('invalid_response');
  for (const key of ['client_id', 'state', 'audience', 'redirect_uri', 'response_type', 'scope']) {
    if (url.searchParams.getAll(key).length !== 1) fail('invalid_response');
  }
  const scopes = new Set(url.searchParams.get('scope').split(' '));
  for (const scope of ['read:jira-work', 'read:jira-user', 'write:jira-work', 'offline_access']) if (!scopes.has(scope)) fail('invalid_response');
  return url.href;
}

function callbackCode(value, extensionId) {
  if (!value) fail('cancelled');
  let url;
  try { url = new URL(value); } catch { fail('invalid_response'); }
  if (url.origin !== `https://${extensionId}.chromiumapp.org` || url.pathname !== '/jira' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => !['code', 'error'].includes(key))) fail('invalid_response');
  const errors = url.searchParams.getAll('error');
  const codes = url.searchParams.getAll('code');
  if (errors.length === 1 && codes.length === 0) {
    if (['invalid_state', 'invalid_handoff'].includes(errors[0])) fail('expired');
    fail(['access_denied', 'no_sites', 'rate_limited', 'timeout'].includes(errors[0]) ? errors[0] : 'invalid_response');
  }
  if (errors.length || codes.length !== 1 || !SECRET.test(codes[0])) fail('invalid_response');
  return codes[0];
}

function allowedRequest(path, method, body) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/v1/') || /[\\\s#]/.test(path) || !['GET', 'POST'].includes(method)) fail('request_not_allowed');
  let url;
  try { url = new URL(path, JIRA_BACKEND_ORIGIN); } catch { fail('request_not_allowed'); }
  if (url.origin !== JIRA_BACKEND_ORIGIN || url.username || url.password || url.hash || url.pathname !== path.split('?')[0]) fail('request_not_allowed');
  const metadata = {
    '/v1/projects': ['site', 'startAt'],
    '/v1/issue-types': ['site', 'project', 'startAt'],
    '/v1/create-fields': ['site', 'project', 'issueType', 'startAt'],
    '/v1/attachment-settings': ['site']
  };
  let capturedBody;
  if (Object.hasOwn(metadata, url.pathname)) {
    if (method !== 'GET' || body !== undefined) fail('request_not_allowed');
    const allowed = metadata[url.pathname];
    for (const [key, value] of url.searchParams) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1 ||
          (key === 'site' ? !UUID.test(value) : key === 'startAt' ? !/^(0|[1-9]\d{0,5})$/.test(value) : !/^[1-9]\d{0,19}$/.test(value))) fail('request_not_allowed');
    }
    if (allowed.filter(key => key !== 'startAt').some(key => !url.searchParams.has(key))) fail('request_not_allowed');
  } else {
    if (url.search) fail('request_not_allowed');
    const parts = url.pathname.split('/');
    const isCollection = url.pathname === '/v1/deliveries';
    const isDelivery = parts[2] === 'deliveries' && UUID.test(parts[3]);
    const isRead = isDelivery && parts.length === 4 && method === 'GET';
    const isWrite = method === 'POST' && (isCollection || (isDelivery && (
      (parts.length === 5 && ['chunks', 'issue'].includes(parts[4])) ||
      (parts.length === 6 && parts[4] === 'attachments' && UUID.test(parts[5]))
    )));
    if (!isRead && !isWrite) fail('request_not_allowed');
    if (isRead && body !== undefined) fail('request_not_allowed');
    if (isWrite) {
      if (!plain(body)) fail('invalid_input');
      let encoded;
      try { encoded = JSON.stringify(body); } catch { fail('invalid_input'); }
      if (typeof encoded !== 'string') fail('invalid_input');
      if (new TextEncoder().encode(encoded).byteLength > 768 * 1024) fail('payload_too_large');
      capturedBody = JSON.parse(encoded);
      if (!plain(capturedBody)) fail('invalid_input');
    }
  }
  return {path: url.pathname + url.search, body: capturedBody};
}

function publicPayload(value, depth = 0) {
  if (depth > 40) fail('invalid_response');
  if (Array.isArray(value)) return value.map(item => publicPayload(item, depth + 1));
  if (!plain(value)) return value;
  // A malformed service response must not expose capabilities through this API.
  const privateKeys = new Set(['credential', 'accesstoken', 'refreshtoken', 'clientsecret', 'authorization', 'proto', 'constructor', 'prototype']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key.toLowerCase().replaceAll('_', ''))).map(([key, item]) => [key, publicPayload(item, depth + 1)]));
}

/** This client runs only in trusted extension pages. It never returns credentials
 * or Atlassian tokens. The backend owns provider tokens and their refresh cycle.
 */
export function createJiraConnectionClient({chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto, timeoutMs = 20_000} = {}) {
  let initialized;
  let connecting = false;
  const id = chromeApi?.runtime?.id;
  const local = chromeApi?.storage?.local;
  const session = chromeApi?.storage?.session;
  const initialize = () => initialized ||= (async () => {
    if (!EXTENSION_ID.test(id) || typeof local?.setAccessLevel !== 'function' || !session ||
        typeof chromeApi?.identity?.launchWebAuthFlow !== 'function' || typeof cryptoImpl?.subtle?.digest !== 'function' ||
        typeof cryptoImpl?.getRandomValues !== 'function' || typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('unsupported_browser');
    try {
      await local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
      await session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
    } catch { fail('storage_unavailable'); }
  })();

  const storage = async action => {
    try { return await action(); } catch (error) { if (error instanceof JiraConnectionError) throw error; fail('storage_unavailable'); }
  };

  async function request(path, {method = 'GET', data, credential, responseLimit = MAX_RESPONSE_BYTES} = {}) {
    const controller = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetchImpl(`${JIRA_BACKEND_ORIGIN}${path}`, {
        method, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: {Accept: 'application/json', ...(data === undefined ? {} : {'Content-Type': 'application/json'}), ...(credential ? {Authorization: `Bearer ${credential}`} : {})},
        ...(data === undefined ? {} : {body: JSON.stringify(data)})
      });
      if (response.status === 204 && response.ok) return {};
      if (Number(response.headers.get('content-length')) > responseLimit) fail('invalid_response');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        fail(response.status === 503 ? 'setup_pending' : response.ok ? 'invalid_response' : 'unavailable');
      }
      if (!response.body?.getReader) fail('invalid_response');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = '';
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > responseLimit) { void reader.cancel().catch(() => {}); fail('invalid_response'); }
          text += decoder.decode(value, {stream: true});
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      let body;
      try { body = JSON.parse(text); } catch { fail('invalid_response'); }
      if (!response.ok) fail(errorCode(body, response.status));
      if (!plain(body)) fail('invalid_response');
      return body;
    })();
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new JiraConnectionError('timeout')); }, timeoutMs);
      })]);
    } catch (error) { if (error instanceof JiraConnectionError) throw error; fail('unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function getStored(connectionId) {
    await initialize();
    if (!UUID.test(connectionId)) fail('unauthorized');
    const key = CONNECTION_PREFIX + connectionId;
    const entries = await storage(() => local.get(key));
    if (!entries?.[key]) fail('unauthorized');
    return storedConnection(entries[key]);
  }

  return Object.freeze({
    installationId: EXTENSION_ID.test(id) ? id : '',

    async listConnections() {
      await initialize();
      const entries = await storage(() => local.get(null));
      const results = [];
      for (const [key, item] of Object.entries(entries || {})) {
        if (!key.startsWith(CONNECTION_PREFIX)) continue;
        try {
          const connection = storedConnection(item);
          if (key === CONNECTION_PREFIX + connection.id) results.push(publicConnection(connection));
        } catch { /* A damaged entry cannot expose unvalidated account data. */ }
      }
      return results.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
    },

    async connect() {
      if (connecting) fail('busy');
      connecting = true;
      let handshakeKey;
      let pendingConnection;
      try {
        // Chrome requires this request in the button's user gesture, before await.
        let permission;
        try { permission = chromeApi.permissions.request({origins: [`${JIRA_BACKEND_ORIGIN}/*`]}); }
        catch { fail('permission_denied'); }
        if (!await permission) fail('permission_denied');
        await initialize();
        const verifier = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        handshakeKey = HANDSHAKE_PREFIX + challenge;
        await storage(() => session.set({[handshakeKey]: {verifier, expiresAt: Date.now() + HANDSHAKE_TTL}}));
        const started = await request('/v1/oauth/start', {method: 'POST', data: {extensionId: id, challenge}});
        let redirected;
        try { redirected = await chromeApi.identity.launchWebAuthFlow({url: authorizationURL(started.authorizationUrl), interactive: true}); }
        catch (error) {
          if (error instanceof JiraConnectionError) throw error;
          fail(/cancel|closed|did not approve|user rejected/i.test(error?.message || '') ? 'cancelled' : 'unavailable');
        }
        const code = callbackCode(redirected, id);
        const claim = (await storage(() => session.get(handshakeKey)))?.[handshakeKey];
        if (claim?.verifier !== verifier || !Number.isFinite(claim.expiresAt) || claim.expiresAt < Date.now()) fail('expired');
        const completed = await request('/v1/oauth/complete', {method: 'POST', data: {code, verifier}});
        pendingConnection = storedConnection(completed.connection);
        await storage(() => local.set({[CONNECTION_PREFIX + pendingConnection.id]: pendingConnection}));
        const connected = publicConnection(pendingConnection);
        pendingConnection = null;
        return connected;
      } catch (error) {
        // If local saving fails after exchange, do not leave a usable orphan grant.
        if (pendingConnection) await request('/v1/connection', {method: 'DELETE', credential: pendingConnection.credential}).catch(() => {});
        if (error instanceof JiraConnectionError) throw error;
        fail('unavailable');
      } finally {
        connecting = false;
        if (handshakeKey) await storage(() => session.remove(handshakeKey)).catch(() => {});
      }
    },

    async refresh(connectionId) {
      const saved = await getStored(connectionId);
      const result = await request('/v1/connection', {credential: saved.credential});
      const current = publicConnection(result.connection);
      if (current.id !== saved.id || current.accountId !== saved.accountId) fail('invalid_response');
      const siteResult = await request('/v1/sites', {credential: saved.credential});
      current.sites = publicSites(siteResult.sites);
      await storage(() => local.set({[CONNECTION_PREFIX + saved.id]: {...current, credential: saved.credential}}));
      return current;
    },

    async request(connectionId, path, {method = 'GET', body} = {}) {
      const captured = allowedRequest(path, method, body);
      const saved = await getStored(connectionId);
      const result = await request(captured.path, {method, data: captured.body, credential: saved.credential, responseLimit: 2 * 1024 * 1024});
      return publicPayload(result);
    },

    async disconnect(connectionId) {
      const saved = await getStored(connectionId);
      try { await request('/v1/connection', {method: 'DELETE', credential: saved.credential}); }
      catch (error) { if (!(error instanceof JiraConnectionError) || error.code !== 'unauthorized') throw error; }
      await storage(() => local.remove(CONNECTION_PREFIX + saved.id));
      return {disconnected: true};
    }
  });
}
