import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createDeliveryService, DELIVERY_LIMITS, JiraDeliveryError} from '../backend/delivery-service.mjs';
import {JiraApiError, createJiraApiClient} from '../backend/jira-api.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const WEBM = Buffer.from([26, 69, 223, 163, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0]);
const CLOUD = 'ae3d3412-1234-1234-1234-678901234567';
function fakeStore() {
  const jobs = new Map(), keys = new Map(), stable = new Map(), chunks = new Map();
  let tail = Promise.resolve();
  const locked = action => { const next = tail.then(action, action); tail = next.catch(() => {}); return next; };
  return {jobs, chunks,
    prepare: ({job, payloadHash, stableKey}) => locked(() => {
      const alias = `${job.connectionId}:${job.request.clientDeliveryId}`, key = keys.get(alias);
      if (key) return {job: structuredClone(jobs.get(key.id)), conflict: key.hash !== payloadHash};
      const existing = stable.get(stableKey); if (!existing) { jobs.set(job.id, structuredClone(job)); stable.set(stableKey, job.id); }
      const id = existing || job.id; keys.set(alias, {id, hash: payloadHash}); return {job: structuredClone(jobs.get(id)), conflict: false};
    }),
    async get({connectionId, id}) { const job = jobs.get(id); return job?.connectionId === connectionId ? structuredClone(job) : null; },
    withJobLock: ({connectionId, id}, action) => locked(async () => {
      const saved = jobs.get(id); if (!saved || saved.connectionId !== connectionId) return action(null, null);
      const job = structuredClone(saved), temporary = new Map(chunks);
      const result = await action(job, {
        async putChunk({attachmentId, index, hash, bytes}) {
          const key = `${id}/${attachmentId}/${index}`, old = temporary.get(key);
          if (old) return old.hash === hash;
          temporary.set(key, {hash, index, bytes: Buffer.from(bytes)}); return true;
        },
        async readChunks(attachmentId) { return [...temporary.entries()].filter(([key]) => key.startsWith(`${id}/${attachmentId}/`)).map(([, row]) => row).sort((a, b) => a.index - b.index); },
        async deleteChunks(attachmentId) { for (const key of temporary.keys()) if (key.startsWith(`${id}/${attachmentId}/`)) temporary.delete(key); }
      });
      jobs.set(id, job); chunks.clear(); for (const [key, value] of temporary) chunks.set(key, value); return result;
    })
  };
}
function fixture(options = {}) {
  const connection = {id: randomUUID()}, store = fakeStore(), calls = {create: 0, upload: 0, projects: [], fields: []};
  let now = 1000000;
  const page = values => ({values, startAt: 0, isLast: true, nextStartAt: null});
  const oauth = {async discoverResources() { return [{id: CLOUD, url: 'https://example.atlassian.net'}]; }, ...options.oauth};
  const jira = {
    async listProjects({startAt}) { calls.projects.push(startAt); return page([{id: '10001'}]); },
    async listIssueTypes() { return page([{id: '10002'}]); },
    async getCreateFields({startAt}) { calls.fields.push(startAt); return page([
      {fieldId: 'summary', required: true}, {fieldId: 'project', required: true}, {fieldId: 'issuetype', required: true},
      {fieldId: 'description', required: false}, {fieldId: 'labels', required: false, schema: {type: 'array'}}]); },
    async attachmentSettings() { return {enabled: true, uploadLimit: DELIVERY_LIMITS.attachmentBytes}; },
    async createIssue() { calls.create++; return {id: '20001', key: 'DES-1'}; },
    async uploadAttachment(input) { calls.upload++; calls.lastUpload = input; return {id: '30001'}; },
    ...options.jira
  };
  const service = createDeliveryService({store, jira, oauth, clock: () => now});
  const request = {clientDeliveryId: randomUUID(), commentId: randomUUID(), revision: 'a'.repeat(64), cloudId: CLOUD,
    projectId: '10001', issueTypeId: '10002', summary: 'Fix title alignment',
    description: {type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: 'Align the heading with the content.'}]}]}, fields: {}, attachments: []};
  const context = {connection, accessToken: 'token'};
  return {connection, store, calls, oauth, jira, service, request, context, advance: value => { now += value; },
    prepare: () => service.prepare({...context, request})};
}
function addFile(f, bytes = Buffer.from(WEBM), type = 'video/webm', filename = 'evidence.webm') {
  const item = {id: randomUUID(), filename, mimeType: type, size: bytes.length, sha256: digest(bytes)};
  f.request.attachments.push(item); return item;
}
async function uploadChunks(f, receipt, item, bytes) {
  let result;
  for (let index = 0; index < Math.ceil(bytes.length / DELIVERY_LIMITS.chunkBytes); index++) {
    result = await f.service.putChunk({connection: f.connection, id: receipt.id, attachmentId: item.id, index,
      dataBase64: bytes.subarray(index * DELIVERY_LIMITS.chunkBytes, (index + 1) * DELIVERY_LIMITS.chunkBytes).toString('base64')});
  }
  return result;
}
const code = wanted => error => error instanceof JiraDeliveryError && error.code === wanted;

test('prepare is read-only in Jira and returns an immutable receipt; same or new client IDs deduplicate', async () => {
  const f = fixture(), a = await f.prepare(), same = await f.prepare();
  assert.equal(a.id, same.id); assert.equal(a.status, 'prepared'); assert.equal(f.calls.create, 0);
  f.request.summary = 'Changed after prepare';
  assert.equal(f.store.jobs.get(a.id).request.summary, 'Fix title alignment');
  await assert.rejects(f.prepare(), code('conflict'));
  f.request.clientDeliveryId = randomUUID();
  assert.equal((await f.prepare()).id, a.id);
  f.request.summary = 'Different again'; await assert.rejects(f.prepare(), code('conflict'));
});
test('concurrent prepares with new IDs return one durable delivery for the same revision', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({length: 8}, () => f.service.prepare({...f.context, request: {...f.request, clientDeliveryId: randomUUID()}})));
  assert.equal(new Set(results.map(item => item.id)).size, 1); assert.equal(f.store.jobs.size, 1);
});
test('all project and required-field metadata pages are validated before preparation', async () => {
  const f = fixture();
  f.jira.listProjects = async ({startAt}) => ({values: startAt ? [{id: '10001'}] : [{id: '999'}], startAt, isLast: !!startAt, nextStartAt: startAt ? null : 1});
  f.jira.getCreateFields = async ({startAt}) => ({values: startAt ? [{fieldId: 'customfield_7', required: true, schema: {type: 'string'}}] : [{fieldId: 'summary', required: true}], startAt, isLast: !!startAt, nextStartAt: startAt ? null : 1});
  await assert.rejects(f.prepare(), code('required_fields'));
  f.request.fields.customfield_7 = 'Layout'; assert.equal((await f.prepare()).status, 'prepared');
  assert.equal(f.calls.create, 0);
});
test('metadata defaults are accepted, while missing, unknown and unavailable field values are rejected', async () => {
  const f = fixture();
  f.jira.getCreateFields = async () => ({startAt: 0, isLast: true, values: [
    {fieldId: 'assignee', required: true, hasDefaultValue: true},
    {fieldId: 'priority', required: true, schema: {type: 'priority'}, allowedValues: [{id: '1', name: 'High'}]}]});
  await assert.rejects(f.prepare(), code('required_fields'));
  f.request.fields.priority = {id: '2'}; await assert.rejects(f.prepare(), code('invalid_fields'));
  f.request.fields.priority = {id: '1'}; await f.prepare();
  f.request.fields.unknown = 'x'; await assert.rejects(f.prepare(), code('invalid_fields'));
});
test('site authorization is refreshed and issue type must be available', async () => {
  const f = fixture(); f.oauth.discoverResources = async () => [];
  await assert.rejects(f.prepare(), code('access_denied'));
  f.oauth.discoverResources = async () => [{id: CLOUD, url: 'https://example.atlassian.net'}];
  f.jira.listIssueTypes = async () => ({startAt: 0, isLast: true, values: []});
  await assert.rejects(f.prepare(), code('destination_unavailable')); assert.equal(f.calls.create, 0);
});
test('attachment site policy and conservative size bounds are enforced before persistence', async () => {
  const f = fixture(); addFile(f);
  f.jira.attachmentSettings = async () => ({enabled: false, uploadLimit: 100}); await assert.rejects(f.prepare(), code('attachments_disabled'));
  f.jira.attachmentSettings = async () => ({enabled: true, uploadLimit: 2}); await assert.rejects(f.prepare(), code('attachment_too_large'));
  f.request.attachments[0].size = DELIVERY_LIMITS.attachmentBytes + 1; await assert.rejects(f.prepare(), code('invalid_input'));
  assert.equal(f.store.jobs.size, 0);
});
test('cross-connection reads, chunks and sends never disclose or mutate another job', async () => {
  const f = fixture(), item = addFile(f), receipt = await f.prepare(), other = {id: randomUUID()};
  for (const operation of [() => f.service.get({connection: other, id: receipt.id}),
    () => f.service.sendIssue({connection: other, accessToken: 'other', id: receipt.id}),
    () => f.service.putChunk({connection: other, id: receipt.id, attachmentId: item.id, index: 0, dataBase64: Buffer.from('evidence').toString('base64')})]) await assert.rejects(operation(), code('not_found'));
  assert.equal(f.calls.create, 0);
});
test('chunks enforce canonical base64, exact bounds and duplicate content identity', async () => {
  const f = fixture(), bytes = Buffer.alloc(DELIVERY_LIMITS.chunkBytes + 3, 17), item = addFile(f, bytes), receipt = await f.prepare();
  const input = {connection: f.connection, id: receipt.id, attachmentId: item.id, index: 0};
  for (const dataBase64 of ['', 'Zg=', 'Zh==', 'Zg==\n', Buffer.from('x').toString('base64')]) await assert.rejects(f.service.putChunk({...input, dataBase64}), code('invalid_input'));
  const first = bytes.subarray(0, DELIVERY_LIMITS.chunkBytes).toString('base64');
  await f.service.putChunk({...input, dataBase64: first}); await f.service.putChunk({...input, dataBase64: first});
  await assert.rejects(f.service.putChunk({...input, dataBase64: Buffer.alloc(DELIVERY_LIMITS.chunkBytes, 18).toString('base64')}), code('chunk_conflict'));
  await assert.rejects(f.service.sendIssue({...f.context, id: receipt.id}), code('incomplete_evidence'));
  const done = await uploadChunks(f, receipt, item, bytes); assert.equal(done.canSendIssue, true);
  assert.deepEqual(done.attachments[0].receivedChunks, [0, 1]);
});
test('concurrent sends create only one issue, persist its receipt, and never resend on repeated calls', async () => {
  const f = fixture(), receipt = await f.prepare(); let release;
  f.jira.createIssue = async () => { f.calls.create++; await new Promise(resolve => { release = resolve; }); return {id: '20001', key: 'DES-1'}; };
  const first = f.service.sendIssue({...f.context, id: receipt.id});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(second.status, 'creating');
  release(); const done = await first; assert.equal(done.status, 'complete'); assert.equal(done.issue.url, 'https://example.atlassian.net/browse/DES-1');
  await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(f.calls.create, 1);
});
test('an unknown issue outcome requires checking Jira and cannot be retried automatically or explicitly', async () => {
  const f = fixture(), receipt = await f.prepare();
  f.jira.createIssue = async () => { f.calls.create++; throw new JiraApiError('write_outcome_unknown', {outcome: 'unknown'}); };
  const result = await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(result.status, 'needs-check'); assert.equal(result.canSendIssue, false);
  await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(f.calls.create, 1);
});
test('a confirmed rejected issue can be explicitly retried without changing its delivery identity', async () => {
  const f = fixture(), receipt = await f.prepare();
  f.jira.createIssue = async () => { f.calls.create++; if (f.calls.create === 1) throw new JiraApiError('rate_limited', {outcome: 'rejected', status: 429}); return {id: '20001', key: 'DES-1'}; };
  assert.equal((await f.service.sendIssue({...f.context, id: receipt.id})).status, 'rejected');
  const result = await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(result.status, 'complete'); assert.equal(result.id, receipt.id);
});
test('interrupted claims become needs-check after 90 seconds and remain unrepeatable', async () => {
  const f = fixture(), receipt = await f.prepare();
  const job = f.store.jobs.get(receipt.id); job.status = 'creating'; job.attemptAt = job.updatedAt;
  f.advance(91000); const result = await f.service.get({connection: f.connection, id: receipt.id}); assert.equal(result.status, 'needs-check');
  await f.service.sendIssue({...f.context, id: receipt.id}); assert.equal(f.calls.create, 0);
});
test('evidence hash is checked before upload; success clears temporary bytes but preserves the Jira receipt', async () => {
  const f = fixture(), bytes = Buffer.from(WEBM), item = addFile(f, bytes), receipt = await f.prepare();
  await uploadChunks(f, receipt, item, bytes); await f.service.sendIssue({...f.context, id: receipt.id});
  const stored = [...f.store.chunks.values()][0]; stored.bytes = Buffer.from('badbytes');
  await assert.rejects(f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id}), code('evidence_mismatch'));
  assert.equal(f.calls.upload, 0); stored.bytes = bytes;
  const done = await f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id});
  assert.equal(done.status, 'complete'); assert.equal(done.attachments[0].jiraAttachmentId, '30001'); assert.equal(f.store.chunks.size, 0);
  await f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id}); assert.equal(f.calls.upload, 1); assert.equal(f.calls.create, 1);
});
test('attachment retry after confirmed rejection uses the existing issue, while unknown upload blocks repeats', async () => {
  const f = fixture(), bytes = Buffer.from(WEBM), item = addFile(f, bytes), receipt = await f.prepare();
  await uploadChunks(f, receipt, item, bytes); await f.service.sendIssue({...f.context, id: receipt.id});
  f.jira.uploadAttachment = async ({issueId}) => { assert.equal(issueId, '20001'); f.calls.upload++; throw new JiraApiError('rejected', {outcome: f.calls.upload === 1 ? 'rejected' : 'unknown'}); };
  const rejected = await f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id}); assert.equal(rejected.attachments[0].canSend, true);
  const unknown = await f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id}); assert.equal(unknown.needsCheck, true); assert.equal(unknown.attachments[0].canSend, false);
  await f.service.sendAttachment({...f.context, id: receipt.id, attachmentId: item.id}); assert.equal(f.calls.upload, 2); assert.equal(f.calls.create, 1);
});
test('expired temporary evidence cannot be uploaded or sent, while receipts survive', async () => {
  const f = fixture(), bytes = Buffer.from(WEBM), item = addFile(f, bytes), receipt = await f.prepare();
  await uploadChunks(f, receipt, item, bytes); f.advance(DELIVERY_LIMITS.evidenceTtlMs);
  const status = await f.service.get({connection: f.connection, id: receipt.id}); assert.equal(status.attachments[0].status, 'expired'); assert.equal(status.canSendIssue, false);
  await assert.rejects(uploadChunks(f, receipt, item, bytes), code('evidence_expired'));
});
test('invalid file signatures are rejected before issue creation or any attachment network write', async () => {
  const f = fixture(), bytes = Buffer.from('this is not a PNG image container'), item = addFile(f, bytes, 'image/png', 'image.png'), receipt = await f.prepare();
  await uploadChunks(f, receipt, item, bytes);
  let network = 0; f.jira.uploadAttachment = createJiraApiClient({fetchImpl: async () => { network++; throw new Error('must not run'); }}).uploadAttachment;
  await assert.rejects(f.service.sendIssue({...f.context, id: receipt.id}), code('evidence_mismatch'));
  const result = await f.service.get({connection: f.connection, id: receipt.id});
  assert.equal(result.status, 'prepared'); assert.equal(result.issue, null); assert.equal(f.calls.create, 0); assert.equal(network, 0);
});
test('a whole-file hash mismatch prevents issue creation before the durable write claim', async () => {
  const f = fixture(), bytes = Buffer.from(WEBM), item = addFile(f, bytes);
  item.sha256 = 'b'.repeat(64); const receipt = await f.prepare();
  await uploadChunks(f, receipt, item, bytes);
  await assert.rejects(f.service.sendIssue({...f.context, id: receipt.id}), code('evidence_mismatch'));
  assert.equal(f.store.jobs.get(receipt.id).status, 'prepared'); assert.equal(f.calls.create, 0);
});
