import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiraOAuthClient, JIRA_OAUTH_SCOPES, JiraOAuthError } from '../backend/jira-oauth.mjs';

const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const OTHER = '8594f221-9797-5f78-1fa4-485e198d7cd0';
const TOKEN = 'access-fixture-secret';
const SECRET = 'client-fixture-secret';
const REFRESH = 'refresh-fixture-secret';
const STATE = 'hJlWVAg6YoKxy76ZNKGSC_QcdSTIdNYqa26zHk6XZTA';
const CONFIG = { clientId: 'diffuse_fixture_client', clientSecret: SECRET, publicOrigin: 'https://diffuse.example' };
const SITE = { id: CLOUD, name: 'Design team', url: 'https://design.atlassian.net', scopes: JIRA_OAUTH_SCOPES.slice(0, 3) };
const PAIR = { access_token: TOKEN, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer', scope: JIRA_OAUTH_SCOPES.join(' ') };
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function fixture(responses, overrides = {}) {
  const calls = [];
  const client = createJiraOAuthClient({ ...CONFIG, ...overrides, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.ok(responses.length, 'No external request is permitted by this fixture');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, init) : response;
  } });
  return { client, calls };
}
function safeError(code) {
  return error => {
    assert.ok(error instanceof JiraOAuthError);
    assert.equal(error.code, code);
    for (const secret of [TOKEN, SECRET, REFRESH, 'provider-sensitive-body', 'authcode-secret']) {
      assert.ok(!String(error.stack).includes(secret), 'Errors must not contain credentials or provider bodies');
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('authorization URL has fixed endpoints, callback, scopes and caller-bound state without a secret', () => {
  const { client, calls } = fixture([]);
  const url = new URL(client.authorizationUrl({ state: STATE }));
  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    audience: 'api.atlassian.com', client_id: CONFIG.clientId,
    scope: JIRA_OAUTH_SCOPES.join(' '), redirect_uri: 'https://diffuse.example/oauth/jira/callback',
    state: STATE, response_type: 'code', prompt: 'consent'
  });
  assert.ok(!url.href.includes(SECRET));
  assert.equal(client.callbackUrl, 'https://diffuse.example/oauth/jira/callback');
  assert.equal(calls.length, 0);
  assert.ok(Object.isFrozen(JIRA_OAUTH_SCOPES));
  assert.ok(Object.isFrozen(client));
});

test('configuration rejects non-HTTPS, callback overrides, embedded credentials and malformed settings', () => {
  for (const publicOrigin of [
    'http://diffuse.example', 'http://localhost:3000', 'https://diffuse.example/path',
    'https://diffuse.example/?redirect=elsewhere', 'https://diffuse.example/#fragment',
    'https://someone:password@diffuse.example', '//diffuse.example',
    'https://diffuse.example/../', ' https://diffuse.example', 'https://diffuse.example\\elsewhere'
  ]) assert.throws(() => createJiraOAuthClient({ ...CONFIG, publicOrigin }), safeError('invalid_configuration'));
  for (const overrides of [
    { clientId: 'client\r\nsecret' }, { clientId: '' }, { clientSecret: '' }, { clientSecret: 'secret\n' },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60_001 }, { fetchImpl: null }, { allowLocalDevelopment: 'true' }
  ]) assert.throws(() => createJiraOAuthClient({ ...CONFIG, ...overrides }), safeError('invalid_configuration'));
});

test('explicit local development permits only HTTP loopback origins and fixes the callback path', () => {
  for (const publicOrigin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    const client = createJiraOAuthClient({ ...CONFIG, publicOrigin, allowLocalDevelopment: true });
    assert.equal(client.callbackUrl, `${publicOrigin}/oauth/jira/callback`);
  }
  for (const publicOrigin of ['http://localhost.evil.example', 'http://10.0.0.1', 'http://127.0.0.1.evil.example']) {
    assert.throws(() => createJiraOAuthClient({ ...CONFIG, publicOrigin, allowLocalDevelopment: true }), safeError('invalid_configuration'));
  }
});

test('state requires a bounded URL-safe unpredictable value supplied by the session core', () => {
  const { client } = fixture([]);
  for (const state of [undefined, '', 'short', 'a'.repeat(129), 'a'.repeat(31) + '\n', `${STATE}&code=secret`]) {
    assert.throws(() => client.authorizationUrl({ state }), safeError('invalid_input'));
  }
});

test('code exchange sends only fixed JSON fields and returns a validated server-side token pair', async () => {
  const { client, calls } = fixture([json({ ...PAIR, ignored: 'provider-sensitive-body' })]);
  const pair = await client.exchangeCode({ code: 'authcode-secret', redirect_uri: 'https://untrusted.example' });
  assert.deepEqual(pair, { accessToken: TOKEN, refreshToken: REFRESH, expiresIn: 3600, scopes: [...JIRA_OAUTH_SCOPES] });
  assert.equal(calls[0].url, 'https://auth.atlassian.com/oauth/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: 'authorization_code', client_id: CONFIG.clientId, client_secret: SECRET,
    code: 'authcode-secret', redirect_uri: 'https://diffuse.example/oauth/jira/callback'
  });
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('denied exchanges produce safe errors without reading or echoing the provider error body', async () => {
  for (const [status, code] of [[400, 'authorization_rejected'], [401, 'access_denied'], [403, 'access_denied'], [429, 'rate_limited'], [503, 'unavailable']]) {
    const response = json({ error: TOKEN, error_description: SECRET + REFRESH + 'provider-sensitive-body' }, status);
    const { client, calls } = fixture([response]);
    await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError(code));
    assert.equal(response.bodyUsed, false);
    assert.equal(calls.length, 1, 'No automatic token retries');
  }
});

test('token exchange requires every granted permission and rejects malformed credentials or expiry', async () => {
  for (const missing of JIRA_OAUTH_SCOPES) {
    const { client } = fixture([json({ ...PAIR, scope: JIRA_OAUTH_SCOPES.filter(scope => scope !== missing).join(' ') })]);
    await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('insufficient_scope'));
  }
  for (const patch of [
    { access_token: '' }, { access_token: 'secret\r\nInjected: yes' }, { refresh_token: undefined },
    { expires_in: 0 }, { expires_in: '3600' }, { expires_in: 31_536_001 }, { token_type: 'Basic' },
    { scope: undefined }, { scope: ['read:jira-work', { value: 'provider-sensitive-body' }] }
  ]) {
    const { client } = fixture([json({ ...PAIR, ...patch })]);
    await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('invalid_response'));
  }
});

test('refresh exchange returns the rotated token and preserves validated grant scopes when omitted', async () => {
  const { client, calls } = fixture([json({ ...PAIR, refresh_token: 'rotated-refresh-secret', scope: undefined })]);
  const pair = await client.refreshTokens({ refreshToken: REFRESH, grantedScopes: [...JIRA_OAUTH_SCOPES] });
  assert.equal(pair.refreshToken, 'rotated-refresh-secret');
  assert.deepEqual(pair.scopes, [...JIRA_OAUTH_SCOPES]);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: 'refresh_token', client_id: CONFIG.clientId, client_secret: SECRET, refresh_token: REFRESH
  });
});

test('refresh rejects lost permission and missing rotated token without silently retaining the old token', async () => {
  const { client, calls } = fixture([
    json({ ...PAIR, refresh_token: undefined }),
    json({ ...PAIR, scope: 'read:jira-work offline_access' })
  ]);
  await assert.rejects(client.refreshTokens({ refreshToken: REFRESH, grantedScopes: JIRA_OAUTH_SCOPES }), safeError('invalid_response'));
  await assert.rejects(client.refreshTokens({ refreshToken: REFRESH, grantedScopes: JIRA_OAUTH_SCOPES }), safeError('insufficient_scope'));
  await assert.rejects(client.refreshTokens({ refreshToken: REFRESH, grantedScopes: ['read:jira-work'] }), safeError('invalid_input'));
  assert.equal(calls.length, 2);
});

test('resource discovery filters non-Jira and under-scoped containers without taking arbitrary request URLs', async () => {
  const { client, calls } = fixture([json([
    { ...SITE, scopes: ['read:confluence-content.all'], name: 'Confluence' },
    SITE, { ...SITE, id: OTHER, scopes: ['read:jira-work'] }
  ])]);
  assert.deepEqual(await client.discoverResources({ accessToken: TOKEN, url: 'https://untrusted.example' }), [SITE]);
  assert.equal(calls[0].url, 'https://api.atlassian.com/oauth/token/accessible-resources');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` });
  assert.equal(calls[0].init.body, undefined);
});

test('empty resource grants are allowed but malformed and ambiguous Jira resources are rejected', async () => {
  const { client } = fixture([json([])]);
  assert.deepEqual(await client.discoverResources({ accessToken: TOKEN }), []);
  for (const value of [
    {}, [null], [{ ...SITE, id: '../elsewhere' }], [{ ...SITE, name: '\nsecret' }],
    [{ ...SITE, url: 'http://team.atlassian.net' }], [{ ...SITE, url: 'https://user:secret@team.atlassian.net' }],
    [{ ...SITE, url: 'https://team.atlassian.net/?token=secret' }], [{ ...SITE, scopes: null }],
    [SITE, { ...SITE, url: 'https://different.atlassian.net' }]
  ]) {
    const { client: invalid } = fixture([json(value)]);
    await assert.rejects(invalid.discoverResources({ accessToken: TOKEN }), safeError('invalid_response'));
  }
});

test('myself request revalidates current site access and only returns account identity fields', async () => {
  const { client, calls } = fixture([json([SITE]), json({
    accountId: 'user:123456', displayName: 'Demo Designer', active: true,
    emailAddress: 'private@example.test', self: 'https://untrusted.example', extra: SECRET
  })]);
  assert.deepEqual(await client.getCurrentUser({ accessToken: TOKEN, cloudId: CLOUD }), {
    accountId: 'user:123456', displayName: 'Demo Designer', active: true
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('myself never fetches a site omitted by current grant, even if a caller supplies claimed sites', async () => {
  const { client, calls } = fixture([json([])]);
  await assert.rejects(client.getCurrentUser({ accessToken: TOKEN, cloudId: CLOUD, resources: [SITE] }), safeError('unavailable_resource'));
  assert.equal(calls.length, 1);
});

test('myself rejects malformed profile identities without exposing provider content', async () => {
  for (const profile of [null, { accountId: '../escape', displayName: 'Demo', active: true },
    { accountId: 'user', displayName: '', active: true }, { accountId: 'user', displayName: 'Demo', active: 'true' }]) {
    const { client } = fixture([json([SITE]), json(profile)]);
    await assert.rejects(client.getCurrentUser({ accessToken: TOKEN, cloudId: CLOUD }), safeError('invalid_response'));
  }
});

test('caller input validation prevents header, URL path and body injection before any request', async () => {
  const { client, calls } = fixture([]);
  for (const accessToken of ['', undefined, 'secret\nHeader: value', 'Bearer token', 'token"']) {
    await assert.rejects(client.discoverResources({ accessToken }), safeError('invalid_input'));
  }
  for (const cloudId of ['../secret', 'https://untrusted.example', `${CLOUD}?redirect=1`, '', undefined]) {
    await assert.rejects(client.getCurrentUser({ accessToken: TOKEN, cloudId }), safeError('invalid_input'));
  }
  for (const code of ['', undefined, 'authcode-secret\n', 'a'.repeat(8193)]) {
    await assert.rejects(client.exchangeCode({ code }), safeError('invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('redirects, invalid JSON, non-JSON content and oversized bodies fail safely', async () => {
  const cases = [
    new Response(null, { status: 302, headers: { location: `https://untrusted.example/${SECRET}` } }),
    new Response(`invalid JSON ${SECRET}`, { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(SECRET, { status: 200, headers: { 'content-type': 'text/html' } }),
    json(PAIR, 200, { 'content-length': '1048577' }),
    new Response('"' + 'x'.repeat(1_048_576) + '"', { headers: { 'content-type': 'application/json' } })
  ];
  for (const response of cases) {
    const { client } = fixture([response]);
    await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('invalid_response'));
  }
});

test('network exceptions are redacted and never retried', async () => {
  const { client, calls } = fixture([new Error(`fetch failed ${TOKEN} ${SECRET} provider-sensitive-body`)]);
  await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('unavailable'));
  assert.equal(calls.length, 1);
});

test('deadline aborts a request even if an injected fetch ignores AbortSignal', async () => {
  let signal;
  const client = createJiraOAuthClient({ ...CONFIG, timeoutMs: 10, fetchImpl: (_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('timeout'));
  assert.equal(signal.aborted, true);
});

test('deadline includes response streaming instead of ending after headers', async () => {
  let signal;
  const client = createJiraOAuthClient({ ...CONFIG, timeoutMs: 10, fetchImpl: async (_, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(client.exchangeCode({ code: 'authcode-secret' }), safeError('timeout'));
  assert.equal(signal.aborted, true);
});

test('safe error constructor cannot be used to embed an arbitrary provider error', () => {
  assert.throws(() => { throw new JiraOAuthError(`provider-sensitive-body ${SECRET}`); }, safeError('invalid_response'));
});
