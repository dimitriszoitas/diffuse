/** Server-only Atlassian adapter. Never bundle this module or its tokens into the extension.
 * The caller must bind and atomically consume authorization state before exchangeCode,
 * serialize refreshes per connection, and atomically persist the returned token pair.
 * Resource-level access is configured on the registered Atlassian app, not by a URL flag.
 * No sessions, credentials, grants or tokens are persisted by this module.
 */
export const JIRA_OAUTH_SCOPES = Object.freeze([
  'read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'
]);

const JIRA_SCOPES = JIRA_OAUTH_SCOPES.filter(scope => scope !== 'offline_access');
const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const MAX_RESPONSE_BYTES = 1_048_576;
const CLOUD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MESSAGES = Object.freeze({
  invalid_configuration: 'Jira connection settings are invalid.',
  invalid_input: 'The Jira connection request is invalid.',
  access_denied: 'Jira access was denied. Connect the account again.',
  authorization_rejected: 'Jira could not complete authorization. Connect the account again.',
  grant_revoked: 'This Jira grant is no longer usable. Connect the account again.',
  insufficient_scope: 'Jira did not grant the permissions required by Diffuse. Connect the account again.',
  unavailable_resource: 'This Jira site is not available to the selected connection.',
  invalid_response: 'Jira returned an unexpected response. Try connecting again.',
  rate_limited: 'Jira is limiting requests. Wait before trying again.',
  unavailable: 'Jira could not be reached. Try again later.',
  timeout: 'Jira did not respond in time. Try again later.'
});

export class JiraOAuthError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'invalid_response';
    super(MESSAGES[safeCode]);
    this.name = 'JiraOAuthError';
    this.code = safeCode;
  }
}

function fail(code) { throw new JiraOAuthError(code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, max, code = 'invalid_input') {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(code);
  return value;
}
function opaque(value, max, code = 'invalid_input') {
  text(value, max, code);
  if (!/^[\x21-\x7e]+$/.test(value)) fail(code);
  return value;
}
function bearer(value, code = 'invalid_input') {
  text(value, 16_384, code);
  if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(value)) fail(code);
  return value;
}
function scopes(value, code = 'invalid_response') {
  const entries = typeof value === 'string' ? value.split(' ') : value;
  if (!Array.isArray(entries) || !entries.length || entries.length > 128 || entries.some(scope =>
    typeof scope !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(scope))) fail(code);
  return [...new Set(entries)];
}
function requireScopes(value, code = 'insufficient_scope') {
  if (!JIRA_OAUTH_SCOPES.every(scope => value.includes(scope))) fail(code);
  return value;
}
function origin(value, allowLocalDevelopment, code) {
  text(value, 2048, code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      ![parsed.origin, `${parsed.origin}/`].includes(value)) fail(code);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowLocalDevelopment && local && parsed.protocol === 'http:')) fail(code);
  return parsed.origin;
}

async function readJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('invalid_response');
  const declaredSize = response.headers.get('content-length');
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_RESPONSE_BYTES)) fail('invalid_response');
  if (!response.body || typeof response.body.getReader !== 'function') fail('invalid_response');
  const reader = response.body.getReader();
  const cancelRead = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelRead, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let result = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('invalid_response');
      result += decoder.decode(chunk.value, { stream: true });
    }
    result += decoder.decode();
    return JSON.parse(result);
  } catch {
    // Never include provider text, tokens or JSON parser excerpts in errors.
    fail('invalid_response');
  } finally {
    signal.removeEventListener('abort', cancelRead);
    // Do not await cancellation: a misbehaving upstream must not extend the deadline.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function tokenPair(value, previousScopes) {
  if (!record(value)) fail('invalid_response');
  if (value.token_type !== undefined && String(value.token_type).toLowerCase() !== 'bearer') fail('invalid_response');
  const grantedScopes = requireScopes(value.scope === undefined && previousScopes
    ? previousScopes : scopes(value.scope));
  if (!Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31_536_000) fail('invalid_response');
  return {
    accessToken: bearer(value.access_token, 'invalid_response'),
    refreshToken: opaque(value.refresh_token, 16_384, 'invalid_response'),
    expiresIn: value.expires_in,
    scopes: grantedScopes
  };
}

/** Supply credentials from server configuration. PUBLIC_ORIGIN must be a bare HTTPS origin.
 * allowLocalDevelopment permits only explicit HTTP loopback origins for local testing.
 * No endpoint, callback path, redirect or arbitrary request headers can be supplied by callers.
 */
export function createJiraOAuthClient({
  clientId, clientSecret, publicOrigin, allowLocalDevelopment = false,
  fetchImpl = globalThis.fetch, timeoutMs = 15_000
} = {}) {
  opaque(clientId, 256, 'invalid_configuration');
  if (!/^[A-Za-z0-9_-]+$/.test(clientId)) fail('invalid_configuration');
  opaque(clientSecret, 4096, 'invalid_configuration');
  if (typeof allowLocalDevelopment !== 'boolean' || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid_configuration');
  const callbackUrl = `${origin(publicOrigin, allowLocalDevelopment, 'invalid_configuration')}/oauth/jira/callback`;

  async function request(url, { accessToken, body } = {}) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new JiraOAuthError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, {
          method: body ? 'POST' : 'GET',
          headers: {
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal
        });
        if (response.status === 401 || response.status === 403) fail('access_denied');
        if (response.status === 400 && url === TOKEN_URL) {
          // Only an explicit invalid_grant during refresh proves that this
          // stored grant can no longer be used. Never infer revocation from a
          // network error, permissions failure, invalid client or opaque 400.
          if (body?.grant_type === 'refresh_token') {
            const detail = await readJson(response, controller.signal);
            if (record(detail) && detail.error === 'invalid_grant') fail('grant_revoked');
          }
          fail('authorization_rejected');
        }
        if (response.status === 429) fail('rate_limited');
        if (response.status >= 500) fail('unavailable');
        if (response.status !== 200 || response.redirected) fail('invalid_response');
        return await readJson(response, controller.signal);
      })()]);
    } catch (error) {
      if (error instanceof JiraOAuthError) throw error;
      if (controller.signal.aborted) fail('timeout');
      fail('unavailable');
    } finally {
      clearTimeout(timer);
      // Also releases unread error responses on a native fetch connection.
      controller.abort();
    }
  }

  async function discoverResources({ accessToken } = {}) {
    bearer(accessToken);
    const resources = await request(RESOURCES_URL, { accessToken });
    if (!Array.isArray(resources) || resources.length > 1000) fail('invalid_response');
    const sites = new Map();
    for (const resource of resources) {
      if (!record(resource)) fail('invalid_response');
      const grantedScopes = scopes(resource.scopes);
      // The same cloud ID can also identify a Confluence container. Only full Jira grants qualify.
      if (!JIRA_SCOPES.every(scope => grantedScopes.includes(scope))) continue;
      if (typeof resource.id !== 'string' || !CLOUD_ID.test(resource.id)) fail('invalid_response');
      const site = {
        id: resource.id.toLowerCase(),
        name: text(resource.name, 512, 'invalid_response'),
        url: origin(resource.url, false, 'invalid_response'),
        scopes: grantedScopes
      };
      const previous = sites.get(site.id);
      if (previous && previous.url !== site.url) fail('invalid_response');
      sites.set(site.id, site);
    }
    return [...sites.values()];
  }

  return Object.freeze({
    callbackUrl,
    authorizationUrl({ state } = {}) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) fail('invalid_input');
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        audience: 'api.atlassian.com', client_id: clientId,
        scope: JIRA_OAUTH_SCOPES.join(' '), redirect_uri: callbackUrl,
        state, response_type: 'code', prompt: 'consent'
      }).toString();
      return url.href;
    },
    async exchangeCode({ code } = {}) {
      opaque(code, 8192);
      return tokenPair(await request(TOKEN_URL, { body: {
        grant_type: 'authorization_code', client_id: clientId,
        client_secret: clientSecret, code, redirect_uri: callbackUrl
      } }));
    },
    async refreshTokens({ refreshToken, grantedScopes } = {}) {
      opaque(refreshToken, 16_384);
      const previousScopes = requireScopes(scopes(grantedScopes, 'invalid_input'), 'invalid_input');
      // Do not retry automatically: the server must save a rotated pair under its connection lock.
      return tokenPair(await request(TOKEN_URL, { body: {
        grant_type: 'refresh_token', client_id: clientId,
        client_secret: clientSecret, refresh_token: refreshToken
      } }), previousScopes);
    },
    discoverResources,
    async getCurrentUser({ accessToken, cloudId } = {}) {
      bearer(accessToken);
      if (typeof cloudId !== 'string' || !CLOUD_ID.test(cloudId)) fail('invalid_input');
      const selectedId = cloudId.toLowerCase();
      const sites = await discoverResources({ accessToken });
      if (!sites.some(site => site.id === selectedId)) fail('unavailable_resource');
      const profile = await request(`https://api.atlassian.com/ex/jira/${selectedId}/rest/api/3/myself`, { accessToken });
      if (!record(profile) || typeof profile.accountId !== 'string' ||
          !/^[A-Za-z0-9:_-]{1,256}$/.test(profile.accountId) || typeof profile.active !== 'boolean') fail('invalid_response');
      return {
        accountId: profile.accountId,
        displayName: text(profile.displayName, 512, 'invalid_response'),
        active: profile.active
      };
    }
  });
}
