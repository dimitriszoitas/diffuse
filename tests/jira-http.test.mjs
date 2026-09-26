import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHttpHandler, HttpError} from '../backend/http.mjs';

const extensionId = 'a'.repeat(32);
function setup(overrides = {}) {
  const calls = [];
  const service = {auth: {
    start: async value => {calls.push(['start', value]); return {authorizationUrl: 'https://auth.atlassian.com/authorize'};},
    complete: async value => {calls.push(['complete', value]); return {connection: {id: 'example', credential: 'opaque'}};},
    callback: async value => {calls.push(['callback', value]); return {redirectUrl: `https://${extensionId}.chromiumapp.org/jira?code=handoff`};},
    authenticate: async value => {calls.push(['authenticate', value]); return {id: 'example'};},
    disconnect: async value => {calls.push(['disconnect', value]); return {disconnected: true};},
    withAccessToken: async (value, action) => action('provider-secret', {id: 'example'})
  }, oauth: {discoverResources: async () => [{id: 'site'}]}};
  const handler = createHttpHandler({allowedExtensionIds: [extensionId], getServices: () => service, ...overrides});
  async function request(path, {method = 'GET', headers = {}, body, parsed = false} = {}) {
    const req = Readable.from(body === undefined || parsed ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.url = path; req.method = method; req.headers = headers;
    if (parsed) req.body = body;
    const response = {headers: {}, setHeader(name, value) {this.headers[name] = value;}, end(value) {this.body = value;}};
    await handler(req, response);
    return response;
  }
  return {request, calls, service};
}
test('health works before setup and discloses no configuration or credentials', async () => {
  const {request} = setup({getServices: () => {throw new Error('sensitive configuration');}});
  const response = await request('/health');
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'online');
  assert.equal(response.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  assert.match(response.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});
test('foreign web origins and unknown extension origins cannot invoke auth or receive CORS', async () => {
  const {request, calls} = setup();
  for (const origin of ['https://evil.test', `chrome-extension://${'b'.repeat(32)}`, 'null']) {
    const response = await request('/v1/oauth/start', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: {extensionId}});
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  }
  assert.equal(calls.length, 0);
});
test('preflight and start are bound to the configured extension origin', async () => {
  const {request, calls} = setup();
  const origin = `chrome-extension://${extensionId}`;
  assert.equal((await request('/v1/oauth/start', {method: 'OPTIONS', headers: {origin}})).statusCode, 204);
  const headers = {origin, 'content-type': 'application/json'};
  const response = await request('/v1/oauth/start', {method: 'POST', headers, body: {extensionId, challenge: 'challenge', ignored: 'not-forwarded'}});
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], origin);
  assert.deepEqual(calls[0], ['start', {extensionId, challenge: 'challenge'}]);
  assert.equal((await request('/v1/oauth/start', {method: 'POST', headers, body: {extensionId: 'b'.repeat(32)}})).statusCode, 403);
});
test('JSON bodies have content type and size limits even when pre-parsed by Vercel', async () => {
  const {request, calls} = setup();
  const path = '/v1/oauth/complete'; const headers = {'content-type': 'application/json'};
  assert.equal((await request(path, {method: 'POST', body: '{}'})).statusCode, 415);
  for (const parsed of [false, true]) {
    assert.equal((await request(path, {method: 'POST', headers, body: {verifier: 'x'.repeat(30_000)}, parsed})).statusCode, 413);
  }
  assert.equal((await request(path, {method: 'POST', headers, body: '{bad'})).statusCode, 400);
  assert.equal((await request(path, {method: 'POST', headers, body: []})).statusCode, 400);
  assert.equal(calls.length, 0);
});
test('callback only redirects to exact allowlisted Chrome callback; duplicate state is rejected', async () => {
  const {request, calls, service} = setup();
  const response = await request('/oauth/jira/callback?state=s&code=c');
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.Location, `https://${extensionId}.chromiumapp.org/jira?code=handoff`);
  assert.equal((await request('/oauth/jira/callback?state=s&state=other&code=c')).statusCode, 400);
  assert.equal(calls.length, 1);
  for (const redirectUrl of ['https://evil.test/jira', `https://${extensionId}.chromiumapp.org.evil.test/jira`, `https://${extensionId}.chromiumapp.org/other`]) {
    service.auth.callback = async () => ({redirectUrl});
    const rejected = await request('/oauth/jira/callback?state=s&code=c');
    assert.equal(rejected.statusCode, 503); assert.equal(rejected.headers.Location, undefined);
  }
});
test('connection endpoints require a full credential and never return provider tokens', async () => {
  const {request, calls} = setup();
  assert.equal((await request('/v1/connection')).statusCode, 401);
  const token = `00000000-0000-4000-8000-000000000000.${'a'.repeat(43)}`;
  const headers = {authorization: `Bearer ${token}`};
  assert.equal((await request('/v1/connection', {headers})).statusCode, 200);
  assert.deepEqual(calls[0], ['authenticate', token]);
  const sites = await request('/v1/sites', {headers});
  assert.deepEqual(JSON.parse(sites.body), {sites: [{id: 'site'}]});
  assert.doesNotMatch(sites.body, /provider-secret/);
  assert.equal((await request('/v1/connection', {method: 'DELETE', headers})).statusCode, 200);
});
test('rate limits, setup failures and unknown internals remain safe', async () => {
  assert.equal((await setup({rateLimit: async () => false}).request('/v1/connection')).statusCode, 429);
  const pending = await setup({getServices: () => {throw new HttpError(503, 'Setup is pending.');}}).request('/v1/connection');
  assert.equal(JSON.parse(pending.body).error, 'Setup is pending.');
  const failed = await setup({getServices: () => {throw new Error('postgres://secret');}}).request('/v1/connection');
  assert.equal(failed.statusCode, 503); assert.doesNotMatch(failed.body, /postgres|secret/);
});
test('only fixed implemented methods and routes are reachable', async () => {
  const {request} = setup();
  assert.equal((await request('/v1/connection', {method: 'POST'})).statusCode, 405);
  assert.equal((await request('/v1/tickets', {method: 'POST'})).statusCode, 404);
});
test('delivery routes bind every operation to the authenticated connection and bound upload bodies', async () => {
  const {request, service} = setup(); const operations = [];
  service.delivery = Object.fromEntries(['prepare', 'get', 'putChunk', 'sendIssue', 'sendAttachment'].map(name => [name, async input => {operations.push({name, input}); return {status: 'prepared'};}]));
  const id = '00000000-0000-4000-8000-000000000001';
  const attachmentId = '00000000-0000-4000-8000-000000000002';
  const headers = {authorization: `Bearer ${id}.${'a'.repeat(43)}`, 'content-type': 'application/json'};
  assert.equal((await request('/v1/deliveries', {method: 'POST', headers, body: {summary: 'Example', connection: {id: 'intruder'}}})).statusCode, 200);
  assert.equal((await request(`/v1/deliveries/${id}`, {headers})).statusCode, 200);
  assert.equal((await request(`/v1/deliveries/${id}/chunks`, {method: 'POST', headers, body: {attachmentId, index: 0, dataBase64: Buffer.alloc(512 * 1024).toString('base64')}})).statusCode, 200);
  for (const path of [`/v1/deliveries/${id}/issue`, `/v1/deliveries/${id}/attachments/${attachmentId}`]) {
    assert.equal((await request(path, {method: 'POST', headers, body: {connection: {id: 'intruder'}}})).statusCode, 200);
  }
  assert.deepEqual(operations.map(({name}) => name), ['prepare', 'get', 'putChunk', 'sendIssue', 'sendAttachment']);
  assert.ok(operations.every(({input}) => input.connection.id === 'example'));
  for (const parsed of [false, true]) assert.equal((await request(`/v1/deliveries/${id}/chunks`, {method: 'POST', headers, body: {dataBase64: 'x'.repeat(721 * 1024)}, parsed})).statusCode, 413);
  assert.equal(operations.length, 5);
  assert.equal((await request(`/v1/deliveries/${id}/issue`, {method: 'POST', body: {}})).statusCode, 401);
});
test('metadata reads revalidate current site ownership before using fixed Jira operations', async () => {
  const {request, service} = setup(); const calls = [];
  service.jira = Object.fromEntries(['listProjects', 'listIssueTypes', 'getCreateFields', 'attachmentSettings'].map(name => [name, async input => {calls.push({name, input}); return {values: [], isLast: true};}]));
  const headers = {authorization: `Bearer 00000000-0000-4000-8000-000000000000.${'a'.repeat(43)}`};
  assert.equal((await request('/v1/projects?site=other-site', {headers})).statusCode, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request('/v1/projects?site=site&startAt=50', {headers})).statusCode, 200);
  assert.deepEqual(calls[0], {name: 'listProjects', input: {accessToken: 'provider-secret', cloudId: 'site', startAt: 50}});
  assert.equal((await request('/v1/create-fields?site=site&project=123&issueType=456', {headers})).statusCode, 200);
  assert.deepEqual(calls[1].input, {accessToken: 'provider-secret', cloudId: 'site', startAt: 0, projectId: '123', issueTypeId: '456'});
  assert.equal((await request('/v1/projects?site=site&site=other-site', {headers})).statusCode, 400);
  assert.equal((await request('/v1/projects?site=site&startAt=-1', {headers})).statusCode, 400);
  assert.equal(calls.length, 2);
});
