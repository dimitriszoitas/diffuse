import test from 'node:test';
import assert from 'node:assert/strict';
import {allMetadata, fieldDescriptor, fieldValue, mediaByteLength, prepareDelivery, sendDelivery, validateEvidence} from '../extension/jira-export.mjs';

const comment = () => ({id: 'b5ce31c4-64c0-4e49-ab4e-2319e77eb92a', mode: 'audit', fields: {title: '', comment: 'Save is hard to find', expected: 'Place Save beside Cancel.', state: 'Editing'}, evidence: {production: {dataUrl: 'data:image/png;base64,YQ=='}}});
const destination = {cloudId: '5e5789a0-506f-4ca1-8d8d-65d86d57be10', projectId: '10000', issueTypeId: '10001'};
const history = () => {
  const values = new Map();
  return {values, get: async key => structuredClone(values.get(key)), set: async (key, value) => values.set(key, structuredClone(value))};
};
const issue = {id: '10101', key: 'DES-1', url: 'https://design.atlassian.net/browse/DES-1'};

function fakeClient({unknownIssue = false, rejectedAttachment = false, dedup = false} = {}) {
  const requests = [];
  let receipt;
  let rejectedOnce = false;
  return {
    requests,
    async request(connectionId, path, options = {}) {
      requests.push({connectionId, path, method: options.method || 'GET', body: structuredClone(options.body)});
      if (path === '/v1/deliveries') {
        receipt = {id: 'd7fd309e-4900-466b-a01f-3c12539d39ae', clientDeliveryId: options.body.clientDeliveryId, commentId: options.body.commentId, revision: options.body.revision, status: 'prepared', issue: null, needsCheck: false, canSendIssue: !options.body.attachments.length, attachments: options.body.attachments.map(item => ({...item, status: 'pending', receivedChunks: [], totalChunks: Math.ceil(item.size / (512 * 1024)), canSend: false}))};
        if (dedup) { receipt.clientDeliveryId = '159c442c-f2a0-40d1-b177-94af53c61627';receipt.attachments.forEach(item => { item.id = '7a2c4b3c-bbf3-44c1-b3c2-62d10fdd2bac'; }); }
      } else if (path.endsWith('/chunks')) {
        const attachment = receipt.attachments.find(item => item.id === options.body.attachmentId);
        assert.ok(attachment, 'Chunk uses the receipt’s attachment ID');
        attachment.receivedChunks.push(options.body.index);
        receipt.canSendIssue = true;
      } else if (path.endsWith('/issue')) {
        assert.ok(receipt.canSendIssue, 'Evidence arrives before issue creation');
        if (unknownIssue) { receipt.status = 'needs-check';receipt.needsCheck = true;receipt.canSendIssue = false;throw new Error('Connection interrupted'); }
        receipt.issue = issue;receipt.canSendIssue = false;receipt.status = receipt.attachments.length ? 'issue-created' : 'complete';receipt.attachments.forEach(item => { item.canSend = true; });
      } else if (path.includes('/attachments/')) {
        const item = receipt.attachments.find(item => item.id === path.split('/').at(-1));
        assert.ok(item);
        if (rejectedAttachment && !rejectedOnce) { rejectedOnce = true;item.status = 'rejected';item.message = 'Jira rejected this file.';receipt.status = 'partial'; }
        else { item.status = 'uploaded';item.canSend = false;receipt.status = 'complete'; }
      }
      return structuredClone(receipt);
    },
  };
}

test('metadata collects every page, fails on repeating pages, and never writes', async () => {
  const calls = [];
  const client = {request: async (_, path, options) => { calls.push({path, options});const startAt = Number(new URL(path, 'https://example.test').searchParams.get('startAt'));return {values: [{id: String(startAt)}], startAt, isLast: startAt === 2, nextStartAt: startAt + 1}; }};
  assert.deepEqual(await allMetadata(client, 'account', '/v1/projects?site=site'), [{id: '0'}, {id: '1'}, {id: '2'}]);
  assert.ok(calls.every(call => call.options === undefined));
  await assert.rejects(allMetadata({request: async () => ({values: [{}], startAt: 0, nextStartAt: 0, isLast: false})}, 'a', '/v1/projects'), /next destination page/);
});

test('required Jira fields preserve real IDs, rich text, numbers, dates and user account IDs', () => {
  const select = fieldDescriptor({fieldId: 'customfield_10000', name: 'Team', required: true, schema: {type: 'option'}, allowedValues: [{id: '17', value: 'Design'}, {id: '18', value: 'Old', disabled: true}]});
  assert.deepEqual(fieldValue(select, '17'), {id: '17'});
  assert.throws(() => fieldValue(select, 'Design'), /available/);
  assert.throws(() => fieldValue(select, '18'), /available/);
  assert.throws(() => fieldValue(select, ''), /required/);
  const textarea = fieldDescriptor({fieldId: 'customfield_10001', required: true, schema: {type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'}});
  assert.equal(fieldValue(textarea, 'Extra context').type, 'doc');
  assert.equal(fieldValue({kind: 'number', name: 'Points'}, '2.5'), 2.5);
  assert.equal(fieldValue({kind: 'date', name: 'Date'}, '2026-09-26'), '2026-09-26');
  assert.throws(() => fieldValue({kind: 'date', name: 'Date'}, '2026-02-30'), /valid date/);
  assert.deepEqual(fieldValue({kind: 'user', name: 'Assignee'}, 'abcd:1234'), {accountId: 'abcd:1234'});
  assert.throws(() => fieldValue({kind: 'user', name: 'Assignee'}, 'person@example.com'), /account ID/);
});

test('unsupported required fields block rather than guessing and optional defaults may be omitted', () => {
  assert.equal(fieldDescriptor({fieldId: 'summary', required: true, schema: {type: 'string'}}).kind, 'system');
  assert.equal(fieldDescriptor({fieldId: 'parent', required: true, schema: {type: 'issuelink'}}).kind, 'unsupported');
  assert.equal(fieldDescriptor({fieldId: 'customfield_1', required: true, hasDefaultValue: true, schema: {type: 'any'}}).kind, 'omit');
  assert.equal(fieldDescriptor({fieldId: 'priority', required: false, schema: {type: 'priority'}, allowedValues: [{id: '3', name: 'Medium'}]}).kind, 'choice');
});

test('evidence size and site limits are checked before data decoding', async () => {
  assert.equal(mediaByteLength('data:image/png;base64,YQ=='), 1);
  assert.throws(() => mediaByteLength('https://example.test/image.png'), /could not be read/);
  assert.throws(() => validateEvidence([{dataUrl: 'data:image/png;base64,YWJj', filename: 'file.png'}], {enabled: false}), /disabled/);
  assert.throws(() => validateEvidence([{dataUrl: 'data:image/png;base64,YWJj', filename: 'file.png'}], {uploadLimit: 2}), /too large/);
  let fetched = false;
  await assert.rejects(prepareDelivery(comment(), {}, destination, {}, {attachmentSettings: {enabled: false}, fetchImpl: async () => { fetched = true; }}), /disabled/);
  assert.equal(fetched, false);
});

test('local snapshots have stable content revisions, and field/evidence changes produce new revisions', async () => {
  const first = await prepareDelivery(comment(), {}, destination);
  const second = await prepareDelivery(comment(), {}, destination);
  assert.equal(first.payload.revision, second.payload.revision);
  assert.notEqual(first.payload.clientDeliveryId, second.payload.clientDeliveryId);
  assert.equal(first.payload.summary, 'Save is hard to find');
  assert.equal(first.payload.description.type, 'doc');
  assert.equal(first.payload.attachments[0].sha256.length, 64);
  const changed = comment();changed.fields.expected = 'Make Save bigger';
  assert.notEqual((await prepareDelivery(changed, {}, destination)).payload.revision, first.payload.revision);
  assert.notEqual((await prepareDelivery(comment(), {}, destination, {priority: {id: '2'}})).payload.revision, first.payload.revision);
});

test('send persists job identifiers, chunks evidence first, creates once, then attaches; resume reads only', async () => {
  const client = fakeClient();const saved = history();
  const receipt = await sendDelivery({client, accountId: 'verified-account', connectionId: 'account', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(client.requests.map(item => item.path.split('/').at(-1)), ['deliveries', 'chunks', 'issue', receipt.attachments[0].id]);
  const count = client.requests.length;
  await sendDelivery({client, accountId: 'verified-account', connectionId: 'account', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  assert.equal(client.requests.length, count + 1);
  assert.equal(client.requests.at(-1).method, 'GET');
  assert.equal([...saved.values.values()][0].receipt.issue.key, 'DES-1');
});

test('an interrupted issue write is never retried when the server needs a manual check', async () => {
  const client = fakeClient({unknownIssue: true});const saved = history();
  await assert.rejects(sendDelivery({client, accountId: 'verified-account', connectionId: 'a', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /interrupted/);
  await assert.rejects(sendDelivery({client, accountId: 'verified-account', connectionId: 'a', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /Check Jira/);
  assert.equal(client.requests.filter(item => item.path.endsWith('/issue')).length, 1);
});

test('confirmed attachment retry uses the same issue without another issue creation', async () => {
  const client = fakeClient({rejectedAttachment: true});const saved = history();
  await assert.rejects(sendDelivery({client, accountId: 'verified-account', connectionId: 'a', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /rejected this file/);
  const receipt = await sendDelivery({client, accountId: 'verified-account', connectionId: 'a', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  assert.equal(receipt.status, 'complete');
  assert.equal(client.requests.filter(item => item.path.endsWith('/issue')).length, 1);
  assert.equal(client.requests.filter(item => item.path.includes('/attachments/')).length, 2);
});

test('server deduplication after lost local history reconciles attachment IDs before upload', async () => {
  const client = fakeClient({dedup: true});const saved = history();
  const receipt = await sendDelivery({client, accountId: 'verified-account', connectionId: 'a', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  assert.equal(receipt.status, 'complete');
  assert.equal(client.requests.find(item => item.path.endsWith('/chunks')).body.attachmentId, '7a2c4b3c-bbf3-44c1-b3c2-62d10fdd2bac');
  assert.equal([...saved.values.values()][0].clientDeliveryId, '159c442c-f2a0-40d1-b177-94af53c61627');
});

test('reconnecting the same verified account returns its existing complete issue without any network request', async () => {
  const client = fakeClient();const saved = history();
  await sendDelivery({client, accountId: 'stable-account', connectionId: 'old-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  const count = client.requests.length;const progress = [];
  const receipt = await sendDelivery({client, accountId: 'stable-account', connectionId: 'new-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved, onProgress: value => progress.push(value)});
  assert.equal(client.requests.length, count);
  assert.equal(receipt.issue.url, issue.url);
  assert.match(receipt.message, /Already sent/);
  assert.equal(progress.at(-1).issue.key, 'DES-1');
});

test('reconnecting after an interrupted issue write stops for a manual Jira check without creating again', async () => {
  const client = fakeClient({unknownIssue: true});const saved = history();
  await assert.rejects(sendDelivery({client, accountId: 'stable-account', connectionId: 'old-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /interrupted/);
  const count = client.requests.length;const progress = [];
  await assert.rejects(sendDelivery({client, accountId: 'stable-account', connectionId: 'new-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved, onProgress: value => progress.push(value)}), /Check the Jira project manually/);
  assert.equal(client.requests.length, count);
  assert.equal(progress.at(-1).needsCheck, true);
  assert.equal(client.requests.filter(item => item.path.endsWith('/issue')).length, 1);
});

test('reconnecting after a partial delivery exposes the existing issue and blocks replacement or uploads', async () => {
  const client = fakeClient({rejectedAttachment: true});const saved = history();
  await assert.rejects(sendDelivery({client, accountId: 'stable-account', connectionId: 'old-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /rejected this file/);
  const count = client.requests.length;const progress = [];
  await assert.rejects(sendDelivery({client, accountId: 'stable-account', connectionId: 'new-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved, onProgress: value => progress.push(value)}), /already has a Jira issue/);
  assert.equal(client.requests.length, count);
  assert.equal(progress.at(-1).issue.url, issue.url);
});

test('account guards isolate different verified accounts and fail closed without a verified identity', async () => {
  const client = fakeClient();const saved = history();
  await sendDelivery({client, accountId: 'first-account', connectionId: 'first-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  await sendDelivery({client, accountId: 'second-account', connectionId: 'second-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved});
  assert.equal(client.requests.filter(item => item.path.endsWith('/issue')).length, 2);
  const count = client.requests.length;
  await assert.rejects(sendDelivery({client, connectionId: 'third-connection', prepared: await prepareDelivery(comment(), {}, destination), history: saved}), /could not be verified/);
  assert.equal(client.requests.length, count);
});

test('the account guard must persist before the first backend write', async () => {
  const client = fakeClient();
  await assert.rejects(sendDelivery({client, accountId: 'stable-account', connectionId: 'connection', prepared: await prepareDelivery(comment(), {}, destination), history: {get: async () => null, set: async () => { throw new Error('Storage full'); }}}), /Storage full/);
  assert.equal(client.requests.length, 0);
});
