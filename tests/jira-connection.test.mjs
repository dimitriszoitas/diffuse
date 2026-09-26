import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createJiraConnectionClient, JIRA_BACKEND_ORIGIN, JiraConnectionError} from '../extension/jira-connection.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secret = 'A'.repeat(43);
const key = id => `diffuseJiraConnection:${id}`;
const site = {id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Design team', url: 'https://design.atlassian.net'};
const first = {id: firstId, credential: `${firstId}.${secret}`, accountId: 'account-one', displayName: 'Personal account', sites: [site]};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

function setup(options = {}) {
  const calls = [];
  const localData = structuredClone(options.localData || {});
  const sessionData = {};
  const area = (name, data) => ({
    async setAccessLevel(value) { calls.push([`${name}.access`, value]); if (options.rejectAccess) throw new Error('private storage diagnostic'); },
    async get(keys) { calls.push([`${name}.get`, keys]); return structuredClone(keys === null ? data : Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))); },
    async set(value) { calls.push([`${name}.set`, structuredClone(value)]); if (name === 'local' && options.rejectSave) throw new Error('private storage diagnostic'); Object.assign(data, structuredClone(value)); },
    async remove(keys) { calls.push([`${name}.remove`, keys]); for (const key of [].concat(keys)) delete data[key]; }
  });
  const authorization = new URL('https://auth.atlassian.com/authorize');
  for (const [name, value] of Object.entries({client_id: 'diffuse-client', audience: 'api.atlassian.com', response_type: 'code', redirect_uri: `${JIRA_BACKEND_ORIGIN}/oauth/jira/callback`, state: secret, scope: 'read:jira-work read:jira-user write:jira-work offline_access'})) authorization.searchParams.set(name, value);
  const chromeApi = {
    runtime: {id: extensionId},
    storage: {local: area('local', localData), session: area('session', sessionData)},
    permissions: {request(value) { calls.push(['permission', value]); return Promise.resolve(options.permission !== false); }},
    identity: {async launchWebAuthFlow(value) {
      calls.push(['launch', value]);
      if (options.launchFailure) throw new Error(options.launchFailure);
      if (options.onLaunch) await options.onLaunch({sessionData, calls});
      return options.callback === undefined ? `https://${extensionId}.chromiumapp.org/jira?code=${secret}` : options.callback;
    }}
  };
  const fetchImpl = async (url, init) => {
    const request = {url, ...init, data: init.body ? JSON.parse(init.body) : undefined};
    calls.push(['fetch', request]);
    if (options.fetchImpl) return options.fetchImpl(request);
    const path = new URL(url).pathname;
    if (path === '/v1/oauth/start') return json({authorizationUrl: options.authorizationURL || authorization.href});
    if (path === '/v1/oauth/complete') return json({connection: options.connection || first});
    if (path === '/v1/connection' && init.method === 'DELETE') return json({disconnected: true});
    if (path === '/v1/connection') return json({connection: options.refreshedConnection || first});
    if (path === '/v1/sites') return json({sites: options.sites || [site]});
    throw new Error('Unexpected test request');
  };
  const client = createJiraConnectionClient({chromeApi, fetchImpl, cryptoImpl: webcrypto, timeoutMs: options.timeoutMs || 1000});
  return {client, calls, localData, sessionData, chromeApi, authorization};
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof JiraConnectionError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(secret));
    return true;
  });
}

test('connect binds the handoff to a random SHA-256 verifier and requests access within the click gesture', async () => {
  const {client, calls, localData, sessionData} = setup();
  const connecting = client.connect();
  assert.equal(calls[0][0], 'permission');
  assert.deepEqual(calls[0][1], {origins: [`${JIRA_BACKEND_ORIGIN}/*`]});
  const result = await connecting;
  assert.equal(result.id, firstId);
  assert.ok(!('credential' in result));
  assert.equal(localData[key(firstId)].credential, first.credential);
  assert.deepEqual(sessionData, {});
  const requests = calls.filter(([name]) => name === 'fetch').map(([, call]) => call);
  assert.equal(requests.length, 2);
  const {verifier} = requests[1].data;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[0].data.extensionId, extensionId);
  assert.equal(requests[0].data.challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(calls.findIndex(([name]) => name === 'local.access') < calls.findIndex(([name]) => name === 'local.set'));
  assert.ok(calls.findIndex(([name]) => name === 'session.access') < calls.findIndex(([name]) => name === 'session.set'));
  assert.ok(requests.every(request => request.redirect === 'error' && request.credentials === 'omit' && request.cache === 'no-store'));
});

test('connection lists retain multiple accounts while returning only detached public metadata', async () => {
  const another = {...first, id: secondId, credential: `${secondId}.${secret}`, accountId: 'account-two', displayName: 'Work account'};
  const {client, localData} = setup({localData: {[key(secondId)]: another, otherPrivateSetting: 'private'}});
  await client.connect();
  const list = await client.listConnections();
  assert.deepEqual(list.map(item => item.accountId), ['account-one', 'account-two']);
  assert.ok(!JSON.stringify(list).includes(secret));
  assert.ok(!JSON.stringify(list).includes('private'));
  list[0].sites[0].name = 'Changed externally';
  assert.equal(localData[key(firstId)].sites[0].name, 'Design team');
  assert.equal(localData.otherPrivateSetting, 'private');
});

test('denied host access sends no network requests and saves no handshake', async () => {
  const {client, calls, localData, sessionData} = setup({permission: false});
  await rejectsCode(client.connect(), 'permission_denied');
  assert.equal(calls.length, 1);
  assert.deepEqual(localData, {});
  assert.deepEqual(sessionData, {});
});

test('secure storage failure prevents any network access and drops private diagnostic text', async () => {
  const {client, calls} = setup({rejectAccess: true});
  await rejectsCode(client.connect(), 'storage_unavailable');
  assert.ok(!calls.some(([name]) => name === 'fetch'));
});

test('cancelled sign-in removes its verifier and leaves existing accounts untouched', async () => {
  for (const options of [{callback: ''}, {launchFailure: `The user did not approve access: ${secret}`}]) {
    const {client, localData, sessionData} = setup({...options, localData: {[key(firstId)]: first}});
    await rejectsCode(client.connect(), 'cancelled');
    assert.deepEqual(localData, {[key(firstId)]: first});
    assert.deepEqual(sessionData, {});
  }
});

test('another connect cannot replace an in-progress sign-in', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {client, calls} = setup({onLaunch: () => gate});
  const running = client.connect();
  await rejectsCode(client.connect(), 'busy');
  release();
  await running;
  assert.equal(calls.filter(([name]) => name === 'permission').length, 1);
});

test('only the fixed Atlassian authorize endpoint and registered backend callback can open', async () => {
  const original = setup().authorization;
  const altered = change => { const url = new URL(original); change(url); return url.href; };
  for (const authorizationURL of [
    altered(url => { url.hostname = 'phishing.example'; }),
    altered(url => { url.pathname = '/unexpected'; }),
    altered(url => { url.username = 'secret'; }),
    altered(url => { url.hash = '#secret'; }),
    altered(url => { url.searchParams.set('redirect_uri', 'https://other.example/callback'); }),
    altered(url => { url.searchParams.append('state', secret); }),
    altered(url => { url.searchParams.set('scope', 'read:jira-work'); })
  ]) {
    const {client, calls, sessionData} = setup({authorizationURL});
    await rejectsCode(client.connect(), 'invalid_response');
    assert.ok(!calls.some(([name]) => name === 'launch'));
    assert.deepEqual(sessionData, {});
  }
});

test('foreign, duplicate, credential-bearing and malformed OAuth callbacks never reach completion', async () => {
  const base = `https://${extensionId}.chromiumapp.org`;
  for (const callback of [
    `https://evil.example/jira?code=${secret}`, `${base}/other?code=${secret}`, `${base}/jira?code=${secret}#fragment`,
    `${base}/jira?code=${secret}&code=${secret}`, `${base}/jira?code=${secret}&error=access_denied`,
    `${base}/jira?code=${secret}&next=https://evil.example`, `${base}/jira?code=short`,
    `https://user:pass@${extensionId}.chromiumapp.org/jira?code=${secret}`
  ]) {
    const {client, calls, localData, sessionData} = setup({callback});
    await rejectsCode(client.connect(), 'invalid_response');
    assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
    assert.deepEqual(localData, {});
    assert.deepEqual(sessionData, {});
  }
});

test('approved callback error codes remain safe and reject arbitrary backend text', async () => {
  for (const [raw, expected] of [['access_denied', 'access_denied'], ['no_sites', 'no_sites'], ['invalid_handoff', 'expired'], [`private-${secret}`, 'invalid_response']]) {
    const {client, localData} = setup({callback: `https://${extensionId}.chromiumapp.org/jira?error=${raw}`});
    await rejectsCode(client.connect(), expected);
    assert.deepEqual(localData, {});
  }
});

test('expired or replaced session verifier cannot finish authentication', async () => {
  for (const mutate of [value => { value.verifier = 'wrong'; }, value => { value.expiresAt = 1; }]) {
    const {client, calls, sessionData} = setup({onLaunch: ({sessionData}) => mutate(Object.values(sessionData)[0])});
    await rejectsCode(client.connect(), 'expired');
    assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
    assert.deepEqual(sessionData, {});
  }
});

test('unvalidated credentials and unsafe site links are not saved', async () => {
  for (const connection of [
    {...first, credential: `${secondId}.${secret}`}, {...first, credential: first.credential + '.extra'},
    {...first, sites: [{...site, url: 'javascript:alert(1)'}]},
    {...first, sites: [{...site, url: 'https://user:password@design.atlassian.net'}]},
    {...first, sites: [site, site]}, {...first, displayName: 'Name\nOther'}
  ]) {
    const {client, localData, sessionData} = setup({connection});
    await rejectsCode(client.connect(), 'invalid_response');
    assert.deepEqual(localData, {});
    assert.deepEqual(sessionData, {});
  }
});

test('failed local save attempts to revoke the new backend connection and retains no credential', async () => {
  const {client, calls, localData, sessionData} = setup({rejectSave: true});
  await rejectsCode(client.connect(), 'storage_unavailable');
  const revoke = calls.find(([name, call]) => name === 'fetch' && call.method === 'DELETE')?.[1];
  assert.equal(revoke.url, `${JIRA_BACKEND_ORIGIN}/v1/connection`);
  assert.equal(revoke.headers.Authorization, `Bearer ${first.credential}`);
  assert.deepEqual(localData, {});
  assert.deepEqual(sessionData, {});
});

test('refresh fetches live sites with the saved capability and returns no credentials', async () => {
  const nextSite = {...site, name: 'Updated team'};
  const {client, calls, localData} = setup({localData: {[key(firstId)]: first}, sites: [nextSite]});
  const refreshed = await client.refresh(firstId);
  assert.deepEqual(refreshed.sites, [nextSite]);
  assert.ok(!('credential' in refreshed));
  const requests = calls.filter(([name]) => name === 'fetch').map(([, call]) => call);
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/v1/connection', '/v1/sites']);
  assert.ok(requests.every(request => request.headers.Authorization === `Bearer ${first.credential}`));
  assert.equal(localData[key(firstId)].credential, first.credential);
});

test('refresh refuses to replace an existing account identity', async () => {
  const {client, localData} = setup({localData: {[key(firstId)]: first}, refreshedConnection: {...first, accountId: 'someone-else'}});
  await rejectsCode(client.refresh(firstId), 'invalid_response');
  assert.deepEqual(localData[key(firstId)], first);
});

test('disconnect removes only the selected connection after backend revocation', async () => {
  const another = {...first, id: secondId, credential: `${secondId}.${secret}`};
  const {client, calls, localData} = setup({localData: {[key(firstId)]: first, [key(secondId)]: another}});
  assert.deepEqual(await client.disconnect(firstId), {disconnected: true});
  assert.ok(!localData[key(firstId)]);
  assert.deepEqual(localData[key(secondId)], another);
  assert.ok(calls.findIndex(([name]) => name === 'fetch') < calls.findIndex(([name]) => name === 'local.remove'));
});

test('disconnect preserves the local connection on a network failure, but clears an already revoked one', async () => {
  const offline = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => { throw new Error(`Network credential ${secret}`); }});
  await rejectsCode(offline.client.disconnect(firstId), 'unavailable');
  assert.deepEqual(offline.localData[key(firstId)], first);
  const revoked = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({error: `Private detail ${secret}`}, 401)});
  assert.deepEqual(await revoked.client.disconnect(firstId), {disconnected: true});
  assert.deepEqual(revoked.localData, {});
});

test('setup errors, response size limits and timeouts never expose raw service text', async () => {
  for (const [fetchImpl, code] of [
    [async () => json({error: `Private setup ${secret}`}, 503), 'setup_pending'],
    [async () => new Response('Setup unavailable', {status: 503}), 'setup_pending'],
    [async () => json({authorizationUrl: 'x'.repeat(140_000)}), 'invalid_response'],
    [async () => new Response('private non-JSON content', {headers: {'Content-Type': 'application/json'}}), 'invalid_response'],
    [async () => new Promise(() => {}), 'timeout']
  ]) {
    const {client, sessionData, localData} = setup({fetchImpl, timeoutMs: 20});
    await rejectsCode(client.connect(), code);
    assert.deepEqual(sessionData, {});
    assert.deepEqual(localData, {});
  }
});

test('damaged local entries are excluded without exposing unrelated settings', async () => {
  const {client} = setup({localData: {
    [key(firstId)]: {...first, credential: 'broken'},
    [key(secondId)]: first,
    diffuseJiraConnectionMalformed: {credential: secret},
    someOtherApiKey: secret
  }});
  assert.deepEqual(await client.listConnections(), []);
  await rejectsCode(client.refresh('not-an-id'), 'unauthorized');
});

test('metadata and delivery requests use only whitelisted methods and preserve immutable JSON snapshots', async () => {
  const {client, calls} = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({status: 'ready'})});
  const base = `/v1/deliveries/${secondId}`;
  const metadata = [
    `/v1/projects?site=${site.id}&startAt=50`,
    `/v1/issue-types?site=${site.id}&project=10001`,
    `/v1/create-fields?site=${site.id}&project=10001&issueType=10002&startAt=0`,
    `/v1/attachment-settings?site=${site.id}`, base
  ];
  for (const path of metadata) assert.deepEqual(await client.request(firstId, path), {status: 'ready'});
  const body = {summary: 'Original captured content', fields: {custom: ['Original']}};
  const sending = client.request(firstId, '/v1/deliveries', {method: 'POST', body});
  body.summary = 'Changed after request started';
  body.fields.custom[0] = 'Changed';
  await sending;
  const snapshot = calls.filter(([name]) => name === 'fetch').at(-1)[1];
  assert.equal(snapshot.data.summary, 'Original captured content');
  assert.deepEqual(snapshot.data.fields, {custom: ['Original']});
  for (const path of [`${base}/chunks`, `${base}/issue`, `${base}/attachments/${firstId}`]) {
    assert.deepEqual(await client.request(firstId, path, {method: 'POST', body: {}}), {status: 'ready'});
  }
  for (const [, request] of calls.filter(([name]) => name === 'fetch')) {
    assert.equal(new URL(request.url).origin, JIRA_BACKEND_ORIGIN);
    assert.equal(request.headers.Authorization, `Bearer ${first.credential}`);
    if (request.method === 'POST') assert.equal(request.headers['Content-Type'], 'application/json');
  }
});

test('unsupported paths, path normalization, unknown query values and methods cannot send a credential', async () => {
  const {client, calls} = setup({localData: {[key(firstId)]: first}});
  for (const [path, options] of [
    ['https://evil.example/v1/projects', {}], ['//evil.example/v1/projects', {}],
    ['/v1/connection', {}], ['/v1/oauth/start', {method: 'POST', body: {}}],
    [`/v1/projects?site=${site.id}&url=https://evil.example`, {}],
    [`/v1/projects?site=${site.id}&site=${site.id}`, {}], ['/v1/projects', {}],
    [`/v1/projects?site=${site.id}&startAt=-1`, {}],
    [`/v1/projects?site=${site.id}&startAt=0#secret`, {}],
    [`/v1/anything/../projects?site=${site.id}`, {}],
    [`/v1/issue-types?site=${site.id}&project=javascript`, {}],
    [`/v1/projects?site=${site.id}`, {method: 'DELETE'}],
    [`/v1/projects?site=${site.id}`, {body: {}}],
    [`/v1/deliveries/${secondId}/issue?redirect=https://evil.example`, {method: 'POST', body: {}}],
    [`/v1/deliveries/${secondId}/issue`, {}],
    [`/v1/deliveries/${secondId}/attachments/${firstId}/extra`, {method: 'POST', body: {}}],
    ['/v1/deliveries/not-a-uuid', {}], ['/v1/deliveries', {}]
  ]) await rejectsCode(client.request(firstId, path, options), 'request_not_allowed');
  assert.ok(!calls.some(([name]) => name === 'fetch'));
});

test('chunk requests accept a 512 KiB base64 chunk but refuse requests larger than 768 KiB', async () => {
  const {client, calls} = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({status: 'receiving'})});
  const path = `/v1/deliveries/${secondId}/chunks`;
  await client.request(firstId, path, {method: 'POST', body: {attachmentId: firstId, index: 0, dataBase64: Buffer.alloc(512 * 1024).toString('base64')}});
  assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
  await rejectsCode(client.request(firstId, path, {method: 'POST', body: {dataBase64: 'A'.repeat(800 * 1024)}}), 'payload_too_large');
  assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
});

test('delivery validation errors preserve actionable safe messages without provider text', async () => {
  for (const code of ['required_fields', 'invalid_fields', 'attachments_disabled', 'attachment_too_large', 'destination_unavailable', 'metadata_incomplete', 'evidence_mismatch', 'evidence_expired', 'incomplete_evidence', 'chunk_conflict', 'not_ready']) {
    const {client} = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({code, error: secret}, code === 'chunk_conflict' ? 409 : 400)});
    await rejectsCode(client.request(firstId, `/v1/deliveries/${secondId}/issue`, {method: 'POST', body: {}}), code);
  }
});

test('public request strips secret-bearing fields and bounds metadata responses at 2 MiB', async () => {
  const route = `/v1/projects?site=${site.id}`;
  const service = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({
    credential: first.credential, access_token: secret, values: [{name: 'Project', credential: first.credential, refreshToken: secret}],
    nested: {clientSecret: secret, authorization: secret, harmless: 'Value'}
  })});
  const result = await service.client.request(firstId, route);
  assert.deepEqual(result, {values: [{name: 'Project'}], nested: {harmless: 'Value'}});
  const large = setup({localData: {[key(firstId)]: first}, fetchImpl: async () => json({values: [{name: 'A'.repeat(2 * 1024 * 1024)}]})});
  await rejectsCode(large.client.request(firstId, route), 'invalid_response');
});
