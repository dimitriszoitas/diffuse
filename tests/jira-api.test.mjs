import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiraApiClient, JiraApiError, JIRA_API_LIMITS} from '../backend/jira-api.mjs';
import {jiraIssueFields} from '../extension/jira-format.mjs';

const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const TOKEN = 'secret-access-fixture';
const AUTH = {cloudId: CLOUD, accessToken: TOKEN};
const DESCRIPTION = {type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: 'Make the button label clear.'}]}]};
const ISSUE = {...AUTH, projectId: '10000', issueTypeId: '10001', summary: 'Clarify button', description: DESCRIPTION};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const UPLOAD = {...AUTH, issueId: '10100', filename: 'diffuse-evidence.png', mimeType: 'image/png', bytes: PNG};
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', ...headers}});
}
function fixture(responses, config = {}) {
  const calls = [];
  const client = createJiraApiClient({...config, fetchImpl: async (url, init) => {
    calls.push({url, init});
    assert.ok(responses.length, 'Fixture never permits a real network call');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, init) : response;
  }});
  return {calls, client};
}
function errorIs(code, outcome = 'not_sent', status) {
  return error => {
    assert.ok(error instanceof JiraApiError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    if (status !== undefined) assert.equal(error.status, status);
    for (const secret of [TOKEN, 'provider-sensitive-body']) {
      assert.ok(!String(error.stack).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}
function page(values, key = 'values', options = {}) {
  return {[key]: values, startAt: 0, maxResults: 50, total: values.length, ...options};
}

test('projects use explicit pagination and return only the fields needed by the destination picker', async () => {
  const {client, calls} = fixture([json(page([{id: '10001', key: 'DIF', name: 'Diffuse', self: 'provider-sensitive-body', avatarUrls: {secret: TOKEN}}], 'values', {startAt: 50, total: 60, isLast: false}))]);
  assert.deepEqual(await client.listProjects({...AUTH, startAt: 50}), {
    values: [{id: '10001', key: 'DIF', name: 'Diffuse'}], startAt: 50, maxResults: 50, total: 60, isLast: false, nextStartAt: 51,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/project/search?startAt=50&maxResults=50&orderBy=name`);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, {Accept: 'application/json', Authorization: `Bearer ${TOKEN}`});
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, undefined);
});

test('issue types and required fields use current paginated create metadata endpoints', async () => {
  const field = {
    fieldId: 'customfield_123', key: 'customfield_123', name: 'Team', required: true, hasDefaultValue: true,
    schema: {type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 123, extra: TOKEN},
    operations: ['set'], allowedValues: [{id: '1234', value: 'Design', self: 'provider-sensitive-body'}],
    defaultValue: {id: '1234', value: 'Design', self: 'provider-sensitive-body'}, autoCompleteUrl: 'https://untrusted.example',
  };
  const {client, calls} = fixture([
    json(page([{id: '10001', name: 'Bug', description: 'An issue\nwith the design', subtask: false, iconUrl: TOKEN}], 'issueTypes')),
    json(page([field], 'fields', {startAt: 50, total: 51})),
  ]);
  const types = await client.listIssueTypes({...AUTH, projectId: '10000'});
  assert.deepEqual(types.values, [{id: '10001', name: 'Bug', description: 'An issue\nwith the design', subtask: false}]);
  const fields = await client.getCreateFields({...AUTH, projectId: '10000', issueTypeId: '10001', startAt: 50});
  assert.equal(fields.isLast, true);
  assert.equal(fields.nextStartAt, null);
  assert.deepEqual(fields.values, [{
    fieldId: 'customfield_123', key: 'customfield_123', name: 'Team', required: true, hasDefaultValue: true,
    schema: {type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 123},
    operations: ['set'], allowedValues: [{id: '1234', value: 'Design'}], defaultValue: {id: '1234', value: 'Design'},
  }]);
  assert.ok(calls[0].url.endsWith('/issue/createmeta/10000/issuetypes?startAt=0&maxResults=50'));
  assert.ok(calls[1].url.endsWith('/issue/createmeta/10000/issuetypes/10001?startAt=50&maxResults=50'));
});

test('pagination does not silently stop on a full page when total is absent', async () => {
  const values = Array.from({length: 50}, (_, i) => ({id: String(i + 1), name: `Project ${i}`, key: `D${i}`}));
  const {client} = fixture([json({startAt: 0, maxResults: 50, values})]);
  const result = await client.listProjects(AUTH);
  assert.equal(result.total, null);
  assert.equal(result.isLast, false);
  assert.equal(result.nextStartAt, 50);
});

test('attachment settings are read-only and narrowly shaped', async () => {
  const {client, calls} = fixture([json({enabled: true, uploadLimit: 123_456, ignored: TOKEN})]);
  assert.deepEqual(await client.attachmentSettings(AUTH), {enabled: true, uploadLimit: 123_456});
  assert.ok(calls[0].url.endsWith('/attachment/meta'));
  assert.equal(calls[0].init.method, 'GET');
});

test('issue creation validates and sends exact core fields and returns only the confirmed ID and key', async () => {
  const {client, calls} = fixture([json({id: '10100', key: 'DIF-12', self: 'provider-sensitive-body', transition: TOKEN}, 201)]);
  const fields = {priority: {id: '3'}, labels: ['diffuse'], customfield_123: {id: '1234'}};
  assert.deepEqual(await client.createIssue({...ISSUE, fields}), {id: '10100', key: 'DIF-12'});
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    fields: {...fields, project: {id: '10000'}, issuetype: {id: '10001'}, summary: ISSUE.summary, description: DESCRIPTION},
  });
  assert.equal(calls[0].url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.method, 'POST');
});

test('the production formatter text, headings, line breaks and HTTP links fit the accepted ADF subset', async () => {
  const {client, calls} = fixture([json({id: '10100', key: 'DIF-12'}, 201)]);
  const formatted = jiraIssueFields({fields: {comment: 'First line\nSecond line', expected: 'Use the prototype label', category: 'copy', severity: 'minor'}}, {productionUrl: 'https://example.com/page'});
  await client.createIssue({...ISSUE, ...formatted});
  assert.deepEqual(JSON.parse(calls[0].init.body).fields.description, formatted.description);
});

test('uploads use the file multipart field, fixed issue path and required Atlassian header', async () => {
  const {client, calls} = fixture([json([{id: '10200', filename: UPLOAD.filename, mimeType: UPLOAD.mimeType, size: PNG.length, content: TOKEN, author: {secret: TOKEN}}])]);
  assert.deepEqual(await client.uploadAttachment(UPLOAD), {id: '10200', filename: UPLOAD.filename, mimeType: UPLOAD.mimeType, size: PNG.length});
  assert.equal(calls[0].url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10100/attachments`);
  assert.equal(calls[0].init.headers['X-Atlassian-Token'], 'no-check');
  assert.equal(calls[0].init.headers['Content-Type'], undefined, 'Fetch supplies a matching multipart boundary');
  assert.equal(calls[0].init.method, 'POST');
  const file = calls[0].init.body.get('file');
  assert.equal(file.name, UPLOAD.filename);
  assert.equal(file.type, UPLOAD.mimeType);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
});

test('all six supported image/video containers require matching magic bytes and filename extension', async () => {
  const webp = Buffer.from('524946460c000000574542505650385800000000', 'hex');
  const gif = Buffer.from('47494638396101000100000000', 'hex');
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 2]);
  const webm = Buffer.from('1a45dfa39f4282847765626d00', 'hex');
  const mp4 = Buffer.from('000000146674797069736f6d000002006d703432', 'hex');
  for (const [mimeType, filename, bytes] of [
    ['image/png', 'x.png', PNG], ['image/jpeg', 'x.jpg', jpeg], ['image/gif', 'x.gif', gif],
    ['image/webp', 'x.webp', webp], ['video/webm', 'x.webm', webm], ['video/mp4', 'x.mp4', mp4],
  ]) {
    const {client} = fixture([json([{id: '10200', filename, mimeType, size: bytes.length}])]);
    assert.equal((await client.uploadAttachment({...UPLOAD, mimeType, filename, bytes})).mimeType, mimeType);
  }
});

test('invalid configuration, cloud IDs, credentials and path IDs fail without sending a request', async () => {
  for (const config of [{timeoutMs: 0}, {timeoutMs: 60_001}, {timeoutMs: 1.5}, {fetchImpl: null}]) {
    assert.throws(() => createJiraApiClient(config), errorIs('invalid_configuration'));
  }
  const {client, calls} = fixture([]);
  for (const overrides of [
    {cloudId: `${CLOUD}/../../other`}, {cloudId: 'https://example.com'}, {cloudId: ''},
    {accessToken: ''}, {accessToken: 'secret\r\nHost: bad'}, {accessToken: 'x'.repeat(16_385)},
    {startAt: -1}, {startAt: 1.5}, {startAt: '0'}, {startAt: Infinity},
  ]) await assert.rejects(client.listProjects({...AUTH, ...overrides}), errorIs('invalid_input'));
  for (const projectId of ['DIF', '../issue', '10000?anything', '-1', '0', '1'.repeat(21)]) {
    await assert.rejects(client.listIssueTypes({...AUTH, projectId}), errorIs('invalid_input'));
  }
  await assert.rejects(client.getCreateFields({...AUTH, projectId: '10000', issueTypeId: '100/1'}), errorIs('invalid_input'));
  await assert.rejects(client.uploadAttachment({...UPLOAD, issueId: 'DIF-123'}), errorIs('invalid_input'));
  assert.equal(calls.length, 0);
});

test('extra fields cannot replace selected destination or document and recursive inputs are bounded', async () => {
  const {client, calls} = fixture([]);
  for (const key of ['project', 'issuetype', 'summary', 'description']) {
    await assert.rejects(client.createIssue({...ISSUE, fields: {[key]: 'different'}}), errorIs('invalid_input'));
  }
  const circular = {}; circular.self = circular;
  for (const fields of [
    JSON.parse('{"__proto__":{"polluted":true}}'), {customfield_1: {constructor: 'bad'}}, {field: () => {}},
    {value: Infinity}, {field: new Date()}, {field: Array(1001).fill('x')}, {field: circular},
    {field: 'x'.repeat(32_769)}, {field: Array(20).fill('x'.repeat(32_768))},
    {environment: {type: 'doc', version: 1, content: [{type: 'mediaSingle', content: []}]}},
  ]) await assert.rejects(client.createIssue({...ISSUE, fields}), errorIs('invalid_input'));
  for (const summary of ['', '   ', 'x'.repeat(256), 'x\nanything']) {
    await assert.rejects(client.createIssue({...ISSUE, summary}), errorIs('invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('ADF rejects media, mentions, unknown nodes and attributes, unsafe links, oversized content', async () => {
  const {client, calls} = fixture([]);
  const doc = content => ({type: 'doc', version: 1, content});
  const paragraph = content => ({type: 'paragraph', content});
  for (const description of [
    doc([{type: 'mediaSingle', content: [{type: 'media', attrs: {id: 'secret', type: 'file'}}]}]),
    doc([paragraph([{type: 'mention', attrs: {id: 'someone'}}])]),
    doc([paragraph([{type: 'text', text: 'x', attrs: {unknown: 'x'}}])]),
    doc([paragraph([{type: 'text', text: 'x', marks: [{type: 'link', attrs: {href: 'javascript:alert(1)'}}]}])]),
    doc([paragraph([{type: 'text', text: 'x', marks: [{type: 'link', attrs: {href: 'https://user:secret@example.com'}}]}])]),
    doc([{type: 'heading', attrs: {level: 7}, content: []}]),
    doc([paragraph([{type: 'text', text: 'x'.repeat(32_769)}])]),
    doc(Array(501).fill(paragraph([]))),
    {...DESCRIPTION, extra: true},
  ]) await assert.rejects(client.createIssue({...ISSUE, description}), errorIs('invalid_input'));
  assert.equal(calls.length, 0);
});

test('attachment input rejects unsafe filename, mismatched magic/type, spoofed MP4/WebM and oversized bytes', async () => {
  const {client, calls} = fixture([]);
  for (const override of [
    {filename: '../x.png'}, {filename: 'x\r\n.png'}, {filename: '.x.png'}, {filename: 'x.jpg'}, {filename: 'x'.repeat(151) + '.png'},
    {mimeType: 'image/svg+xml'}, {bytes: Buffer.from('<svg></svg>')}, {bytes: new Uint8Array()},
    {bytes: new Uint8Array(JIRA_API_LIMITS.attachmentBytes + 1)}, {bytes: 'not binary'},
    {mimeType: 'video/webm', filename: 'x.webm', bytes: Buffer.from('1a45dfa3847765626d00000000', 'hex')},
    {mimeType: 'video/mp4', filename: 'x.mp4', bytes: Buffer.from('000000106674797165746b7400000000', 'hex')},
  ]) await assert.rejects(client.uploadAttachment({...UPLOAD, ...override}), errorIs('invalid_input'));
  assert.equal(calls.length, 0);
});

test('confirmed HTTP rejection is distinct from an unknown write and never includes provider text', async () => {
  for (const [status, code] of [[400, 'rejected'], [401, 'access_denied'], [403, 'access_denied'], [404, 'not_found'], [409, 'rejected'], [413, 'rejected'], [415, 'rejected'], [422, 'rejected'], [429, 'rate_limited']]) {
    const {client, calls} = fixture([json({errors: {secret: TOKEN}, errorMessages: ['provider-sensitive-body']}, status)]);
    await assert.rejects(client.createIssue(ISSUE), errorIs(code, 'rejected', status));
    assert.equal(calls.length, 1);
  }
});

test('write network failures, timeouts, server errors and malformed successes are unknown and never retried', async () => {
  for (const response of [
    new Error(`provider-sensitive-body ${TOKEN}`), json({}, 500), json({}, 502), json({}, 408),
    json({id: '10100', key: 'bad'}, 201), json({error: TOKEN}, 200),
    new Response(`provider-sensitive-body ${TOKEN}`, {status: 201, headers: {'content-type': 'application/json'}}),
    new Response('{}', {status: 302, headers: {location: 'https://example.com'}}),
    json({id: '10100', key: 'DIF-12'}, 201, {'content-length': String(JIRA_API_LIMITS.responseBytes + 1)}),
  ]) {
    const {client, calls} = fixture([response]);
    await assert.rejects(client.createIssue(ISSUE), errorIs('write_outcome_unknown', 'unknown'));
    assert.equal(calls.length, 1);
  }
  const {client, calls} = fixture([() => new Promise(() => {})], {timeoutMs: 5});
  await assert.rejects(client.createIssue(ISSUE), errorIs('write_outcome_unknown', 'unknown'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('attachment rejection and ambiguity use the same safe delivery outcome contract', async () => {
  for (const [response, code, outcome] of [
    [json({}, 413), 'rejected', 'rejected'], [json([], 200), 'write_outcome_unknown', 'unknown'],
    [new Error(TOKEN), 'write_outcome_unknown', 'unknown'],
  ]) {
    const {client, calls} = fixture([response]);
    await assert.rejects(client.uploadAttachment(UPLOAD), errorIs(code, outcome));
    assert.equal(calls.length, 1);
  }
});

test('read failures are bounded, sanitized and do not imply a write occurred', async () => {
  for (const [response, code] of [
    [json({}, 401), 'access_denied'], [json({}, 429), 'rate_limited'], [json({}, 500), 'unavailable'],
    [new Error(`provider-sensitive-body ${TOKEN}`), 'unavailable'],
    [new Response(TOKEN, {headers: {'content-type': 'text/html'}}), 'invalid_response'],
    [json({values: [], startAt: 1, maxResults: 50, total: 1}), 'invalid_response'],
    [json({values: [], startAt: 0, maxResults: 50, total: 1, isLast: false}), 'invalid_response'],
    [json({values: [], startAt: 0, maxResults: 50, total: 1, isLast: true}), 'invalid_response'],
    [json({values: [], startAt: 0, maxResults: 50, total: 0}, 200, {'content-length': String(JIRA_API_LIMITS.responseBytes + 1)}), 'invalid_response'],
    [new Response('x'.repeat(JIRA_API_LIMITS.responseBytes + 1), {headers: {'content-type': 'application/json'}}), 'invalid_response'],
  ]) {
    const {client} = fixture([response]);
    await assert.rejects(client.listProjects(AUTH), errorIs(code, 'read_failed'));
  }
});

test('deadline covers a stalled response stream and aborts reads without exposing partial content', async () => {
  let cancelled = false;
  const stalled = new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{"secret":"'));}, cancel() {cancelled = true;}});
  const {client} = fixture([new Response(stalled, {headers: {'content-type': 'application/json'}})], {timeoutMs: 5});
  await assert.rejects(client.listProjects(AUTH), errorIs('timeout', 'read_failed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('invalid upstream metadata never leaks a full response through errors', async () => {
  const {client} = fixture([json(page([{fieldId: '__proto__', name: TOKEN, required: true}], 'fields'))]);
  await assert.rejects(client.getCreateFields({...AUTH, projectId: '10000', issueTypeId: '10001'}), errorIs('invalid_response', 'read_failed'));
});
