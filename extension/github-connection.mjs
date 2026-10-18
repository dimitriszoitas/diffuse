export const GITHUB_BACKEND_ORIGIN = 'https://diffuse-jira-api.vercel.app';

const CONNECTION_PREFIX = 'diffuseGitHubConnection:';
const HANDSHAKE_PREFIX = 'diffuseGitHubHandshake:';
const EXTENSION_ID = /^[a-p]{32}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const HANDSHAKE_TTL = 10 * 60 * 1000;
const messages = Object.freeze({
  setup_pending: 'GitHub connections are being configured. Try again after setup is complete.',
  invalid_request: 'This sign-in request could not be verified. Start connecting again.',
  installation_not_allowed: 'Install the latest official Diffuse release to connect GitHub.',
  permission_denied: 'Allow Diffuse to reach its connection service, then try again.',
  cancelled: 'Sign-in was cancelled. No account was added.',
  busy: 'Finish the open GitHub sign-in before starting another.',
  unsupported_browser: 'Update Chrome and reload Diffuse to securely connect GitHub.',
  storage_unavailable: 'Diffuse could not save this connection. Reload this page and try again.',
  access_denied: 'GitHub did not allow this action. Check the selected account and its access to this repository.',
  author_only: 'Only the person who originally published this review can replace its feedback. You can still read findings and record rechecks.',
  read_only: 'This account has read access. You can load and inspect feedback; Diffuse publishing and shared status updates currently need repository write access.',
  upload_failed: 'GitHub could not attach the evidence. Resume publishing to continue without omitting it.',
  reconnect_required: 'Reconnect GitHub in Settings to enable native screenshot and recording attachments. Your saved feedback stays available.',
  publication_uncertain: 'GitHub has not confirmed publication. Check publication status before starting another update.',
  needs_evidence: 'Open this finding on the selected preview so Diffuse can capture fresh evidence.',
  preview_changed: 'The pull request changed. Confirm the current build before publishing or rechecking.',
  review_changed: 'The selected feedback changed. Preview it again before publishing.',
  too_large: 'This review is too large. Choose fewer findings or shorter recordings.',
  unauthorized: 'This GitHub connection is no longer available. Connect the account again.',
  invalid_response: 'The GitHub response could not be verified. Refresh and try again.',
  expired: 'This sign-in expired or was already used. Start connecting again.',
  rate_limited: 'GitHub is receiving too many requests. Wait a moment and try again.',
  timeout: 'The GitHub connection took too long to respond. Try again.',
  unavailable: 'The GitHub connection is unavailable. Check your connection and try again.',
  invalid_input: 'Check the pull request, preview address, and selected findings.',
  rejected: 'GitHub rejected this request. Check your repository permissions.',
  not_found: 'The pull request or review is no longer available.',
  repository_unavailable: 'Install Diffuse on this repository, then refresh the pull request.',
  forbidden: 'Your GitHub account does not have access to this operation.',
  write_outcome_unknown: 'GitHub may have saved this update. Refresh before publishing again.',
  request_not_allowed: 'This GitHub operation is not supported by Diffuse.',
  payload_too_large: 'This review is too large to publish. Select fewer findings or smaller recordings.',
  conflict: 'This review changed. Refresh it before publishing again.',
  head_changed: 'New changes reached the pull request. Review the current build before publishing.',
  installation_required: 'Install Diffuse on the selected repository to continue.'

});

export class GitHubConnectionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'unavailable';
    super(messages[safeCode]);
    this.name = 'GitHubConnectionError';
    this.code = safeCode;
  }
}

const fail = code => { throw new GitHubConnectionError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function publicConnection(value) {
  if (!plain(value) || !UUID.test(value.id) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.login) || !cleanText(value.displayName, 512)) fail('invalid_response');
  return {id: value.id, login: value.login, displayName: value.displayName};
}

function storedConnection(value) {
  const result = publicConnection(value);
  if (typeof value.credential !== 'string' || value.credential !== `${result.id}.${value.credential.split('.')[1]}` || !SECRET.test(value.credential.split('.')[1])) fail('invalid_response');
  return {...result, credential: value.credential};
}

function errorCode(body, status) {
  const code = plain(body) ? (typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : body.error?.code) : '';
  if (status === 503 || code === 'invalid_configuration') return 'setup_pending';
  if (status === 401 && code === 'access_denied') return 'access_denied';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (Object.hasOwn(messages, code)) return code;
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (['invalid_state', 'invalid_handoff'].includes(code)) return 'expired';
  if (['access_denied', 'no_sites', 'invalid_request', 'unauthorized', 'rate_limited', 'timeout', 'invalid_input', 'rejected', 'not_found', 'write_outcome_unknown'].includes(code)) return code;
  return 'unavailable';
}

function authorizationURL(value, privateRepositoryAccess = false) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_response'); }
  if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize' || url.username || url.password || url.hash ||
      url.searchParams.get('redirect_uri') !== `${GITHUB_BACKEND_ORIGIN}/github/oauth/callback` ||
      !cleanText(url.searchParams.get('client_id'), 512) || !SECRET.test(url.searchParams.get('state'))) fail('invalid_response');
  for (const key of ['client_id', 'state', 'redirect_uri']) if (url.searchParams.getAll(key).length !== 1) fail('invalid_response');
  const scopes=url.searchParams.get('scope')?.trim().split(/\s+/).sort();
  if(url.searchParams.getAll('scope').length !== 1 || JSON.stringify(scopes)!==JSON.stringify([privateRepositoryAccess?'repo':'public_repo','offline_access'].sort())) fail('invalid_response');
  return url.href;
}

function callbackCode(value, extensionId) {
  if (!value) fail('cancelled');
  let url;
  try { url = new URL(value); } catch { fail('invalid_response'); }
  if (url.origin !== `https://${extensionId}.chromiumapp.org` || url.pathname !== '/github' || url.username || url.password || url.hash ||
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
  if (typeof path !== 'string' || path.length > 4096 || /[\\\s#]/.test(path) || !['GET', 'POST'].includes(method)) fail('request_not_allowed');
  let url;
  try { url = new URL(path, GITHUB_BACKEND_ORIGIN); } catch { fail('request_not_allowed'); }
  if (url.origin !== GITHUB_BACKEND_ORIGIN || url.username || url.password || url.hash || url.pathname !== path.split('?')[0]) fail('request_not_allowed');
  const parts = url.pathname.split('/');
  const review = parts[3] === 'reviews' && UUID.test(parts[4]);
  const read = ['/github/v1/pull', '/github/v1/reviews'].includes(url.pathname) || (review && (parts.length === 5 || (parts.length === 7 && parts[5] === 'chunks' && /^(0|[1-9]\d{0,3})$/.test(parts[6]))));
  const write = url.pathname === '/github/v1/reviews/prepare' || (review && parts.length === 6 && ['chunks', 'publish', 'events'].includes(parts[5]));
  if (!(method === 'GET' ? read : write)) fail('request_not_allowed');
  if (method === 'GET') {
    if (body !== undefined || [...url.searchParams.keys()].some(key => !(url.pathname === '/github/v1/pull' ? ['url'] : url.pathname === '/github/v1/reviews' ? ['pullUrl'] : []).includes(key) || url.searchParams.getAll(key).length !== 1)) fail('request_not_allowed');
    if (url.pathname === '/github/v1/pull' && !url.searchParams.has('url')) fail('request_not_allowed');
    if (url.pathname === '/github/v1/reviews' && !url.searchParams.has('pullUrl')) fail('request_not_allowed');
  } else if (url.search || !plain(body)) fail('request_not_allowed');
  let capturedBody;
  if (body !== undefined) {
    let encoded;
    try { encoded = JSON.stringify(body); } catch { fail('invalid_input'); }
    if (new TextEncoder().encode(encoded).byteLength > 12 * 1024 * 1024) fail('payload_too_large');
    capturedBody = JSON.parse(encoded);
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
 * or GitHub tokens. The backend owns provider tokens and their refresh cycle.
 */
export function createGitHubConnectionClient({chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto, timeoutMs = 20_000} = {}) {
  let initialized;
  let connecting = false;
  const revokedConnections = new Set();
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
    try { return await action(); } catch (error) { if (error instanceof GitHubConnectionError) throw error; fail('storage_unavailable'); }
  };

  async function request(path, {method = 'GET', data, credential, responseLimit = MAX_RESPONSE_BYTES} = {}) {
    const controller = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetchImpl(`${GITHUB_BACKEND_ORIGIN}${path}`, {
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
      if (!response.ok) {
        const error = new GitHubConnectionError(errorCode(body, response.status));
        error.status = response.status;
        if (typeof body.installationUrl === 'string' && /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(body.installationUrl)) error.installationUrl = body.installationUrl;
        throw error;
      }
      if (!plain(body)) fail('invalid_response');
      return body;
    })();
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new GitHubConnectionError('timeout')); }, timeoutMs);
      })]);
    } catch (error) { if (error instanceof GitHubConnectionError) throw error; fail('unavailable'); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function getStored(connectionId) {
    await initialize();
    if (!UUID.test(connectionId) || revokedConnections.has(connectionId)) fail('unauthorized');
    const key = CONNECTION_PREFIX + connectionId;
    const entries = await storage(() => local.get(key));
    if (!entries?.[key]) fail('unauthorized');
    return storedConnection(entries[key]);
  }

  async function authenticatedRequest(saved, path, options = {}) {
    try { return await request(path, {...options, credential: saved.credential}); }
    catch (error) {
      // An authoritative revocation must also remove cached account metadata.
      // Temporary failures and saved review/delivery records are unaffected.
      if (error instanceof GitHubConnectionError && error.code === 'unauthorized' && error.status === 401) {
        revokedConnections.add(saved.id);
        await storage(() => local.remove(CONNECTION_PREFIX + saved.id));
      }
      throw error;
    }
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

    async connect({privateRepositoryAccess = false} = {}) {
      if(typeof privateRepositoryAccess !== 'boolean') fail('invalid_input');
      if (connecting) fail('busy');
      connecting = true;
      let handshakeKey;
      let pendingConnection;
      try {
        // Chrome requires this request in the button's user gesture, before await.
        let permission;
        try { permission = chromeApi.permissions.request({origins: [`${GITHUB_BACKEND_ORIGIN}/*`]}); }
        catch { fail('permission_denied'); }
        if (!await permission) fail('permission_denied');
        await initialize();
        const verifier = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        handshakeKey = HANDSHAKE_PREFIX + challenge;
        await storage(() => session.set({[handshakeKey]: {verifier, expiresAt: Date.now() + HANDSHAKE_TTL}}));
        const started = await request('/github/v1/oauth/start', {method: 'POST', data: {extensionId: id, challenge, privateRepositoryAccess}});
        let redirected;
        try { redirected = await chromeApi.identity.launchWebAuthFlow({url: authorizationURL(started.authorizationUrl,privateRepositoryAccess), interactive: true}); }
        catch (error) {
          if (error instanceof GitHubConnectionError) throw error;
          fail(/cancel|closed|did not approve|user rejected/i.test(error?.message || '') ? 'cancelled' : 'unavailable');
        }
        const code = callbackCode(redirected, id);
        const claim = (await storage(() => session.get(handshakeKey)))?.[handshakeKey];
        if (claim?.verifier !== verifier || !Number.isFinite(claim.expiresAt) || claim.expiresAt < Date.now()) fail('expired');
        const completed = await request('/github/v1/oauth/complete', {method: 'POST', data: {code, verifier}});
        pendingConnection = storedConnection(completed.connection);
        await storage(() => local.set({[CONNECTION_PREFIX + pendingConnection.id]: pendingConnection}));
        const connected = publicConnection(pendingConnection);
        pendingConnection = null;
        return connected;
      } catch (error) {
        // If local saving fails after exchange, do not leave a usable orphan grant.
        if (pendingConnection) await request('/github/v1/connection', {method: 'DELETE', credential: pendingConnection.credential}).catch(() => {});
        if (error instanceof GitHubConnectionError) throw error;
        fail('unavailable');
      } finally {
        connecting = false;
        if (handshakeKey) await storage(() => session.remove(handshakeKey)).catch(() => {});
      }
    },

    async refresh(connectionId) {
      const saved = await getStored(connectionId);
      const result = await authenticatedRequest(saved, '/github/v1/connection');
      const current = publicConnection(result.connection);
      if (current.id !== saved.id || current.login !== saved.login) fail('invalid_response');
      if (revokedConnections.has(saved.id)) fail('unauthorized');
      await storage(() => local.set({[CONNECTION_PREFIX + saved.id]: {...current, credential: saved.credential}}));
      return current;
    },

    async request(connectionId, path, {method = 'GET', body} = {}) {
      const captured = allowedRequest(path, method, body);
      const saved = await getStored(connectionId);
      const result = await authenticatedRequest(saved, captured.path, {method, data: captured.body, responseLimit: 12 * 1024 * 1024});
      return publicPayload(result);
    },

    async disconnect(connectionId) {
      const saved = await getStored(connectionId);
      try { await request('/github/v1/connection', {method: 'DELETE', credential: saved.credential}); }
      catch (error) { if (!(error instanceof GitHubConnectionError) || error.code !== 'unauthorized') throw error; }
      revokedConnections.add(saved.id);
      await storage(() => local.remove(CONNECTION_PREFIX + saved.id));
      return {disconnected: true};
    }
  });
}
