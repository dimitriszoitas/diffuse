import {cloneReviewAdf} from './review-adf.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {validateJiraAttachment} from './jira-api.mjs';

export const DELIVERY_LIMITS = Object.freeze({chunkBytes: 512 * 1024, attachmentBytes: 20 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024, attachments: 20, issueBytes: 256 * 1024, evidenceTtlMs: 7 * 86400000});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CLOUD = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[1-9]\d{0,19}$/;
const SHA = /^[a-f0-9]{64}$/;
const CORE = new Set(['summary', 'description', 'project', 'issuetype']);
const MIMES = {'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'],
  'image/webp': ['webp'], 'video/webm': ['webm'], 'video/mp4': ['mp4']};
const MESSAGES = {
  invalid_input: 'The selected review data is invalid. Refresh the review and try again.',
  not_found: 'This delivery is not available to the selected Jira connection.',
  access_denied: 'This Jira site is not available to the selected account.',
  destination_unavailable: 'The selected Jira project or issue type is no longer available.',
  required_fields: 'Complete the required Jira fields before sending this review.',
  invalid_fields: 'A selected Jira field value is not available. Refresh the destination fields.',
  metadata_incomplete: 'Jira returned incomplete destination settings. Refresh and try again.',
  attachments_disabled: 'Attachments are disabled on the selected Jira site.',
  attachment_too_large: 'An attachment exceeds the selected Jira site’s upload limit.',
  conflict: 'This delivery identifier already belongs to different review content.',
  chunk_conflict: 'This evidence chunk does not match the previously received chunk.',
  incomplete_evidence: 'Finish uploading the selected evidence before sending this item.',
  evidence_mismatch: 'The uploaded evidence does not match the selected file. Prepare this review again.',
  evidence_expired: 'Temporary evidence has expired. Prepare a new revision to attach it.',
  not_ready: 'Create the Jira issue before attaching its evidence.',
  invalid_configuration: 'The Jira delivery service is not configured.',
};
export class JiraDeliveryError extends Error {
  constructor(code, status = 400) {
    super(MESSAGES[code] || MESSAGES.invalid_input); this.name = 'JiraDeliveryError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'invalid_input'; this.status = status;
  }
}
const fail = (code = 'invalid_input', status) => { throw new JiraDeliveryError(code, status); };
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonical(value, depth = 0, budget = {nodes: 0}) {
  if (++budget.nodes > 12000 || depth > 16) fail();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
  if (typeof value === 'string') { if (value.length > DELIVERY_LIMITS.issueBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(); return value; }
  if (Array.isArray(value)) { if (value.length > 1000) fail(); return value.map(item => canonical(item, depth + 1, budget)); }
  if (!record(value) || Object.keys(value).length > 100) fail();
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)) fail();
    result[key] = canonical(value[key], depth + 1, budget);
  }
  return result;
}
function only(value, keys) { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) fail(); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); }
function connectionId(connection) { return uuid(connection?.id); }
function adf(value) {
  try { return cloneReviewAdf(value, {maxBytes: DELIVERY_LIMITS.issueBytes}); } catch { fail(); }
}

function snapshot(input) {
  only(input, ['clientDeliveryId', 'commentId', 'revision', 'cloudId', 'projectId', 'issueTypeId', 'summary', 'description', 'fields', 'attachments']);
  const request = canonical(input);
  request.clientDeliveryId = uuid(request.clientDeliveryId); request.commentId = uuid(request.commentId);
  if (typeof request.revision !== 'string' || !SHA.test(request.revision) || typeof request.cloudId !== 'string' || !CLOUD.test(request.cloudId) || typeof request.projectId !== 'string' || !ID.test(request.projectId) || typeof request.issueTypeId !== 'string' || !ID.test(request.issueTypeId)) fail();
  request.cloudId = request.cloudId.toLowerCase();
  if (typeof request.summary !== 'string' || !request.summary.trim() || request.summary.length > 255 || /[\r\n\t]/.test(request.summary)) fail();
  adf(request.description);
  request.fields ??= {};
  if (!record(request.fields) || Object.keys(request.fields).some(key => CORE.has(key))) fail();
  request.attachments ??= [];
  if (!Array.isArray(request.attachments) || request.attachments.length > DELIVERY_LIMITS.attachments) fail();
  let total = 0; const ids = new Set();
  for (const item of request.attachments) {
    only(item, ['id', 'filename', 'mimeType', 'size', 'sha256']); item.id = uuid(item.id);
    if (ids.has(item.id)) fail(); ids.add(item.id);
    if (!Object.hasOwn(MIMES, item.mimeType) || typeof item.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(item.filename) || item.filename.includes('..') || !MIMES[item.mimeType].includes(item.filename.split('.').at(-1)?.toLowerCase()) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > DELIVERY_LIMITS.attachmentBytes || !SHA.test(item.sha256)) fail();
    total += item.size;
  }
  if (total > DELIVERY_LIMITS.totalBytes || Buffer.byteLength(JSON.stringify(request)) > DELIVERY_LIMITS.issueBytes) fail();
  return request;
}
const present = value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim()) && (!Array.isArray(value) || value.length > 0);
function choice(value, options) {
  return options.some(option => {
    if (!record(option)) return option === value;
    if (record(value)) {
      for (const key of ['id', 'accountId', 'key', 'value', 'name']) if (value[key] !== undefined) return String(option[key]) === String(value[key]) && option[key] !== undefined && option.disabled !== true;
      return false;
    }
    return ['id', 'accountId', 'key', 'value', 'name'].some(key => option[key] !== undefined && String(option[key]) === String(value)) && option.disabled !== true;
  });
}
function validateFields(request, metadata) {
  const all = {...request.fields, summary: request.summary, description: request.description, project: {id: request.projectId}, issuetype: {id: request.issueTypeId}};
  const fields = new Map(metadata.map(field => [field.fieldId, field]));
  for (const key of Object.keys(request.fields)) if (!fields.has(key)) fail('invalid_fields');
  for (const field of metadata) {
    const value = all[field.fieldId];
    if (!present(value)) { if (field.required && !field.hasDefaultValue) fail('required_fields'); continue; }
    if (CORE.has(field.fieldId)) continue;
    if (field.operations?.length && !field.operations.includes('set')) fail('invalid_fields');
    const type = field.schema?.type;
    if ((type === 'array' && !Array.isArray(value)) || (['number', 'integer'].includes(type) && (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value)))) || (type === 'boolean' && typeof value !== 'boolean') || (['string', 'date', 'datetime'].includes(type) && typeof value !== 'string' && value?.type !== 'doc')) fail('invalid_fields');
    if (value?.type === 'doc') adf(value);
    if (field.allowedValues?.length) for (const item of Array.isArray(value) ? value : [value]) if (!choice(item, field.allowedValues)) fail('invalid_fields');
  }
}
async function pages(read) {
  let startAt = 0; const result = [];
  for (let count = 0; count < 2000; count++) {
    const page = await read(startAt);
    if (!page || !Array.isArray(page.values) || page.startAt !== startAt) fail('metadata_incomplete', 502);
    result.push(...page.values);
    if (page.isLast === true) return result;
    if (!Number.isSafeInteger(page.nextStartAt) || page.nextStartAt <= startAt) fail('metadata_incomplete', 502);
    startAt = page.nextStartAt;
  }
  fail('metadata_incomplete', 502);
}
const unknown = error => !['not_sent', 'rejected'].includes(error?.outcome);
const errorCode = error => ['invalid_input', 'access_denied', 'rejected', 'not_found', 'rate_limited'].includes(error?.code) ? error.code : 'unavailable';
function publicReceipt(job, now) {
  const stale = item => ['creating', 'uploading'].includes(item.status) && now - item.attemptAt > 90000;
  const status = stale(job) ? 'needs-check' : job.status;
  const attachments = job.attachments.map(item => {
    const state = stale(item) ? 'needs-check' : item.status === 'pending' || item.status === 'rejected' ? (now >= job.evidenceExpiresAt ? 'expired' : item.status) : item.status;
    return {id: item.id, filename: item.filename, mimeType: item.mimeType, size: item.size, status: state,
      receivedChunks: [...item.receivedChunks], totalChunks: Math.ceil(item.size / DELIVERY_LIMITS.chunkBytes),
      canSend: !!job.issue && ['pending', 'rejected'].includes(state) && item.receivedChunks.length === Math.ceil(item.size / DELIVERY_LIMITS.chunkBytes),
      message: state === 'needs-check' ? 'Jira may have received this file. Check the issue before uploading again.' : state === 'expired' ? MESSAGES.evidence_expired : state === 'rejected' ? 'Jira rejected this attachment. You can retry it on the existing issue.' : state === 'uploaded' ? 'Attached to Jira.' : state === 'uploading' ? 'Attaching evidence to Jira.' : 'Evidence waiting to be attached.',
      ...(item.receipt ? {jiraAttachmentId: item.receipt.id} : {})};
  });
  let combined = status;
  if (job.issue) combined = attachments.every(item => item.status === 'uploaded') ? 'complete' : attachments.some(item => ['needs-check', 'rejected', 'expired'].includes(item.status)) ? 'partial' : 'issue-created';
  return {id: job.id, clientDeliveryId: job.request.clientDeliveryId, commentId: job.request.commentId, revision: job.request.revision,
    status: combined, message: combined === 'complete' ? 'Sent to Jira with all selected evidence.' : combined === 'needs-check' ? 'Jira may have created this issue. Check the project before sending it again.' : combined === 'rejected' ? 'Jira rejected this issue. Review the destination fields, then retry.' : job.issue ? 'Issue created. Attach the remaining evidence to this issue.' : combined === 'creating' ? 'Creating the Jira issue.' : 'Ready to send after all selected evidence is uploaded.',
    issue: job.issue ? {...job.issue, url: `${job.siteUrl}/browse/${encodeURIComponent(job.issue.key)}`} : null,
    attachments, createdAt: job.createdAt, updatedAt: job.updatedAt,
    canSendIssue: ['prepared', 'rejected'].includes(status) && attachments.every(item => item.status !== 'expired' && item.receivedChunks.length === item.totalChunks),
    needsCheck: status === 'needs-check' || attachments.some(item => item.status === 'needs-check')};
}

/** Each send method claims one operation durably before contacting Jira. No automatic write retries. */
export function createDeliveryService({store, jira, oauth, clock = Date.now} = {}) {
  if (!store?.prepare || !store?.withJobLock || !store?.get || !jira || !oauth?.discoverResources || typeof clock !== 'function') fail('invalid_configuration', 503);
  async function authorizedSite(accessToken, cloudId) {
    const sites = await oauth.discoverResources({accessToken});
    const site = sites.find(item => item.id.toLowerCase() === cloudId);
    if (!site) fail('access_denied', 403);
    let url; try { url = new URL(site.url); } catch { fail('metadata_incomplete', 502); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) fail('metadata_incomplete', 502);
    return url.origin;
  }
  async function preflight(accessToken, request) {
    const siteUrl = await authorizedSite(accessToken, request.cloudId);
    const input = {accessToken, cloudId: request.cloudId, projectId: request.projectId, issueTypeId: request.issueTypeId};
    const projects = await pages(startAt => jira.listProjects({...input, startAt}));
    if (!projects.some(item => item.id === request.projectId)) fail('destination_unavailable', 403);
    const types = await pages(startAt => jira.listIssueTypes({...input, startAt}));
    if (!types.some(item => item.id === request.issueTypeId)) fail('destination_unavailable', 403);
    validateFields(request, await pages(startAt => jira.getCreateFields({...input, startAt})));
    if (request.attachments.length) {
      const settings = await jira.attachmentSettings(input);
      if (!settings.enabled) fail('attachments_disabled');
      if (request.attachments.some(item => item.size > settings.uploadLimit)) fail('attachment_too_large');
    }
    return siteUrl;
  }
  async function find(connection, id) {
    const job = await store.get({connectionId: connectionId(connection), id: uuid(id)});
    if (!job) fail('not_found', 404); return job;
  }
  async function verifiedEvidence(item, tx) {
    const chunks = await tx.readChunks(item.id), count = Math.ceil(item.size / DELIVERY_LIMITS.chunkBytes);
    if (chunks.length !== count || chunks.some((chunk, index) => chunk.index !== index)) fail('incomplete_evidence');
    const bytes = Buffer.concat(chunks.map(chunk => chunk.bytes));
    if (bytes.length !== item.size || hash(bytes) !== item.sha256) fail('evidence_mismatch');
    try { return validateJiraAttachment({bytes, filename: item.filename, mimeType: item.mimeType}); }
    catch { fail('evidence_mismatch'); }
  }
  const assertJob = job => { if (!job) fail('not_found', 404); };
  function attachment(job, id) { const item = job.attachments.find(item => item.id === uuid(id)); if (!item) fail('not_found', 404); return item; }
  return Object.freeze({
    async prepare({connection, accessToken, request: input}) {
      const request = snapshot(input), owner = connectionId(connection);
      const siteUrl = await preflight(accessToken, request); const now = clock();
      const job = {id: randomUUID(), connectionId: owner, request, siteUrl, status: 'prepared', issue: null,
        createdAt: now, updatedAt: now, evidenceExpiresAt: now + DELIVERY_LIMITS.evidenceTtlMs,
        attachments: request.attachments.map(item => ({...item, status: 'pending', receivedChunks: []}))};
      const {job: saved, conflict} = await store.prepare({job,
        payloadHash: hash(JSON.stringify(request)), stableKey: hash(JSON.stringify([owner, request.cloudId, request.projectId, request.issueTypeId, request.commentId, request.revision]))});
      if (conflict) fail('conflict', 409); return publicReceipt(saved, now);
    },
    async get({connection, id}) { return publicReceipt(await find(connection, id), clock()); },
    async putChunk({connection, id, attachmentId, index, dataBase64}) {
      if (!Number.isInteger(index) || index < 0 || index >= 40 || typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length > 4 * Math.ceil(DELIVERY_LIMITS.chunkBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) fail();
      const bytes = Buffer.from(dataBase64, 'base64'); if (bytes.toString('base64') !== dataBase64) fail();
      return store.withJobLock({connectionId: connectionId(connection), id: uuid(id)}, async (job, tx) => {
        assertJob(job); const item = attachment(job, attachmentId); const now = clock();
        if (now >= job.evidenceExpiresAt) fail('evidence_expired', 410);
        if (!['pending', 'rejected'].includes(item.status)) fail('not_ready', 409);
        const count = Math.ceil(item.size / DELIVERY_LIMITS.chunkBytes);
        const expected = index === count - 1 ? item.size - index * DELIVERY_LIMITS.chunkBytes : DELIVERY_LIMITS.chunkBytes;
        if (index >= count || bytes.length !== expected) fail();
        if (!await tx.putChunk({attachmentId: item.id, index, hash: hash(bytes), bytes})) fail('chunk_conflict', 409);
        if (!item.receivedChunks.includes(index)) item.receivedChunks.push(index);
        item.receivedChunks.sort((a, b) => a - b); job.updatedAt = now;
        return publicReceipt(job, now);
      });
    },
    async sendIssue({connection, accessToken, id}) {
      const existing = await find(connection, id);
      if (!['prepared', 'rejected'].includes(existing.status)) return publicReceipt(existing, clock());
      const siteUrl = await preflight(accessToken, existing.request);
      const key = {connectionId: connectionId(connection), id: uuid(id)};
      const attemptId = randomUUID();
      const claimed = await store.withJobLock(key, async (job, tx) => {
        assertJob(job); if (!['prepared', 'rejected'].includes(job.status)) return null;
        if (!publicReceipt(job, clock()).canSendIssue) fail('incomplete_evidence');
        // A broken file must never create a ticket that cannot receive its evidence.
        for (const item of job.attachments) await verifiedEvidence(item, tx);
        job.siteUrl = siteUrl; job.status = 'creating'; job.attemptAt = job.updatedAt = clock(); job.attemptId = attemptId;
        return structuredClone(job.request);
      });
      if (!claimed) return publicReceipt(await find(connection, id), clock());
      let issue, failure;
      try { issue = await jira.createIssue({accessToken, ...claimed}); } catch (error) { failure = error; }
      return store.withJobLock(key, job => {
        assertJob(job);
        if (job.status !== 'creating' || job.attemptId !== attemptId) return publicReceipt(job, clock());
        if (failure) { job.status = unknown(failure) ? 'needs-check' : 'rejected'; job.errorCode = errorCode(failure); }
        else { job.issue = issue; job.status = 'issue-created'; }
        job.updatedAt = clock(); return publicReceipt(job, clock());
      });
    },
    async sendAttachment({connection, accessToken, id, attachmentId}) {
      const existing = await find(connection, id); const before = attachment(existing, attachmentId);
      if (!existing.issue) fail('not_ready', 409);
      if (!['pending', 'rejected'].includes(before.status)) return publicReceipt(existing, clock());
      const siteUrl = await authorizedSite(accessToken, existing.request.cloudId);
      const settings = await jira.attachmentSettings({accessToken, cloudId: existing.request.cloudId});
      if (!settings.enabled) fail('attachments_disabled'); if (before.size > settings.uploadLimit) fail('attachment_too_large');
      const key = {connectionId: connectionId(connection), id: uuid(id)}, attemptId = randomUUID();
      const claimed = await store.withJobLock(key, async (job, tx) => {
        assertJob(job); const item = attachment(job, attachmentId);
        if (!job.issue) fail('not_ready', 409);
        if (!['pending', 'rejected'].includes(item.status)) return null;
        if (clock() >= job.evidenceExpiresAt) fail('evidence_expired', 410);
        const bytes = await verifiedEvidence(item, tx);
        item.status = 'uploading'; item.attemptId = attemptId; item.attemptAt = job.updatedAt = clock(); job.siteUrl = siteUrl;
        return {bytes, filename: item.filename, mimeType: item.mimeType, issueId: job.issue.id, cloudId: job.request.cloudId};
      });
      if (!claimed) return publicReceipt(await find(connection, id), clock());
      let receipt, failure;
      try { receipt = await jira.uploadAttachment({accessToken, ...claimed}); } catch (error) { failure = error; }
      return store.withJobLock(key, async (job, tx) => {
        assertJob(job); const item = attachment(job, attachmentId);
        if (item.status !== 'uploading' || item.attemptId !== attemptId) return publicReceipt(job, clock());
        if (failure) { item.status = unknown(failure) ? 'needs-check' : 'rejected'; item.errorCode = errorCode(failure); }
        else { item.status = 'uploaded'; item.receipt = receipt; await tx.deleteChunks(item.id); }
        job.updatedAt = clock(); return publicReceipt(job, clock());
      });
    }
  });
}
