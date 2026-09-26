import {cloneReviewAdf} from './review-adf.mjs';
/** Server-only Jira REST adapter. The caller must revalidate that cloudId belongs to the
 * authenticated connection before every operation, and authorize the selected project,
 * required fields and issue before writes. This module has no retries or persistence.
 * A write with outcome=unknown must be reconciled by the delivery service, never blindly
 * retried. Binary input must already have arrived through a size-bounded upload route.
 */
export const JIRA_API_LIMITS = Object.freeze({
  responseBytes: 2 * 1024 * 1024,
  issueBytes: 256 * 1024,
  attachmentBytes: 20 * 1024 * 1024,
  pageSize: 50,
});

const CLOUD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ID = /^[1-9]\d{0,19}$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CORE_FIELDS = new Set(['project', 'issuetype', 'summary', 'description']);
const MIME_EXTENSIONS = Object.freeze({
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'],
  'image/gif': ['gif'], 'video/webm': ['webm'], 'video/mp4': ['mp4'],
});
const MESSAGES = Object.freeze({
  invalid_configuration: 'Jira request settings are invalid.',
  invalid_input: 'The Jira request contains an unsupported or invalid value.',
  access_denied: 'Jira did not allow this request. Check the connection and project permissions.',
  rejected: 'Jira rejected this request. Check the destination and required field values.',
  not_found: 'The selected Jira project, issue type or issue is not available.',
  rate_limited: 'Jira is limiting requests. Wait before trying again.',
  invalid_response: 'Jira returned an unexpected response.',
  unavailable: 'Jira could not be reached. Try again later.',
  timeout: 'Jira did not respond in time. Try again later.',
  write_outcome_unknown: 'Jira may have saved this request. Check its delivery status before trying again.',
});

export class JiraApiError extends Error {
  constructor(code, {status, outcome = 'not_sent'} = {}) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'invalid_response';
    super(MESSAGES[safeCode]);
    this.name = 'JiraApiError';
    this.code = safeCode;
    this.outcome = ['not_sent', 'rejected', 'unknown', 'read_failed'].includes(outcome) ? outcome : 'not_sent';
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

function fail(code = 'invalid_input', options) { throw new JiraApiError(code, options); }
function record(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value, max, code = 'invalid_input', {empty = false, multiline = false} = {}) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || controls.test(value)) fail(code);
  return value;
}
function id(value, code = 'invalid_input') {
  if (typeof value !== 'string' || !ID.test(value)) fail(code);
  return value;
}
function integer(value, {min = 0, max = Number.MAX_SAFE_INTEGER, code = 'invalid_input'} = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function boolean(value, code = 'invalid_response') {
  if (typeof value !== 'boolean') fail(code);
  return value;
}
function safeKeys(value, allowed, code = 'invalid_input') {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code);
}
function safeUrl(value) {
  text(value, 4096);
  let parsed;
  try { parsed = new URL(value); } catch { fail(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail();
  return parsed.href;
}

// Clone bounded JSON rather than forwarding caller objects/toJSON/prototype properties.
function jsonValue(value, code = 'invalid_input', budget = {nodes: 0, bytes: 0}, depth = 0) {
  if (++budget.nodes > 10_000 || depth > 10) fail(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (typeof value === 'string') {
    text(value, 32_768, code, {empty: true, multiline: true});
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > JIRA_API_LIMITS.issueBytes) fail(code);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) fail(code);
    return value.map(item => jsonValue(item, code, budget, depth + 1));
  }
  if (!record(value) || Object.keys(value).length > 100) fail(code);
  // Multiline custom fields and environment also accept ADF; apply the same policy.
  if (code === 'invalid_input' && value.type === 'doc') {
    const document = adf(value);
    budget.bytes += Buffer.byteLength(JSON.stringify(document));
    if (budget.bytes > JIRA_API_LIMITS.issueBytes) fail(code);
    return document;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (BAD_KEYS.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)) fail(code);
    result[key] = jsonValue(item, code, budget, depth + 1);
  }
  return result;
}

// Both delivery validation and outbound requests use the same bounded ADF policy.
function adf(value) {
  try { return cloneReviewAdf(value, {maxBytes: JIRA_API_LIMITS.issueBytes}); } catch { fail(); }
}

function page(value, key, requestedStart, map) {
  const code = 'invalid_response';
  if (!record(value) || !Array.isArray(value[key]) || value[key].length > JIRA_API_LIMITS.pageSize) fail(code);
  const startAt = integer(value.startAt, {code});
  const maxResults = integer(value.maxResults, {min: 1, max: 1000, code});
  if (startAt !== requestedStart || value[key].length > maxResults) fail(code);
  const total = value.total === undefined ? null : integer(value.total, {code});
  const end = startAt + value[key].length;
  const isLast = value.isLast === undefined ? (total === null ? value[key].length < maxResults : end >= total) : boolean(value.isLast);
  if ((!isLast && !value[key].length) || (total !== null && end > total && value[key].length) ||
      (total !== null && isLast && end < total)) fail(code);
  return {values: value[key].map(map), startAt, maxResults, total, isLast, nextStartAt: isLast ? null : end};
}

function metadataChoice(value, depth = 0) {
  const code = 'invalid_response';
  if (value === null || typeof value !== 'object') return jsonValue(value, code);
  if (depth > 4) fail(code);
  if (Array.isArray(value)) {
    if (value.length > 1000) fail(code);
    return value.map(item => metadataChoice(item, depth + 1));
  }
  if (!record(value)) fail(code);
  const result = {};
  for (const key of ['id', 'key', 'name', 'value', 'description', 'accountId', 'displayName', 'disabled', 'children', 'child']) {
    if (Object.hasOwn(value, key)) result[key] = metadataChoice(value[key], depth + 1);
  }
  return result;
}
function fieldMetadata(field) {
  const code = 'invalid_response';
  if (!record(field)) fail(code);
  const fieldId = text(field.fieldId, 128, code);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(fieldId) || BAD_KEYS.has(fieldId)) fail(code);
  const result = {
    fieldId, key: text(field.key ?? fieldId, 128, code), name: text(field.name, 512, code),
    required: boolean(field.required), hasDefaultValue: boolean(field.hasDefaultValue ?? false),
    operations: [], schema: {},
  };
  if (field.operations !== undefined) {
    if (!Array.isArray(field.operations) || field.operations.length > 20) fail(code);
    result.operations = field.operations.map(operation => text(operation, 32, code));
  }
  if (field.schema !== undefined) {
    if (!record(field.schema)) fail(code);
    for (const key of ['type', 'items', 'system', 'custom']) {
      if (field.schema[key] !== undefined) result.schema[key] = text(field.schema[key], 512, code);
    }
    if (field.schema.customId !== undefined) result.schema.customId = integer(field.schema.customId, {code});
  }
  if (field.allowedValues !== undefined) {
    if (!Array.isArray(field.allowedValues) || field.allowedValues.length > 1000) fail(code);
    result.allowedValues = field.allowedValues.map(value => metadataChoice(value));
  }
  if (Object.hasOwn(field, 'defaultValue')) result.defaultValue = metadataChoice(field.defaultValue);
  return result;
}

/** Validate and copy bounded evidence without making a network request. */
export function validateJiraAttachment({bytes, mimeType, filename}) {
  const extensions = MIME_EXTENSIONS[mimeType];
  if (!extensions || typeof filename !== 'string' || filename.length > 150 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || filename.includes('..') ||
      !extensions.includes(filename.split('.').at(-1)?.toLowerCase())) fail();
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > JIRA_API_LIMITS.attachmentBytes) fail();
  const data = Buffer.from(bytes); // Copy prevents mutation while a request is in flight.
  const ascii = (offset, count) => data.toString('ascii', offset, offset + count);
  let valid = false;
  if (mimeType === 'image/png') valid = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && ascii(12, 4) === 'IHDR';
  if (mimeType === 'image/jpeg') valid = data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (mimeType === 'image/gif') valid = data.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mimeType === 'image/webp') valid = data.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 4));
  if (mimeType === 'video/webm' && data.length >= 12 && data.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) {
    // EBML DocType (0x4282), one-byte size=4 and "webm" identifies the WebM container.
    valid = data.subarray(4, Math.min(data.length, 4096)).includes(Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d]));
  }
  if (mimeType === 'video/mp4' && data.length >= 16 && ascii(4, 4) === 'ftyp') {
    const size = data.readUInt32BE(0);
    const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'msdh', 'msix']);
    if (size >= 16 && size <= Math.min(data.length, 4096) && size % 4 === 0) {
      valid = brands.has(ascii(8, 4));
      for (let offset = 16; offset < size; offset += 4) valid ||= brands.has(ascii(offset, 4));
    }
  }
  if (!valid) fail();
  return data;
}

async function readJson(response, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('invalid_response');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > JIRA_API_LIMITS.responseBytes)) fail('invalid_response');
  if (!response.body || typeof response.body.getReader !== 'function') fail('invalid_response');
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0, result = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > JIRA_API_LIMITS.responseBytes) fail('invalid_response');
      result += decoder.decode(chunk.value, {stream: true});
    }
    result += decoder.decode();
    return JSON.parse(result);
  } catch { fail('invalid_response'); }
  finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

export function createJiraApiClient({fetchImpl = globalThis.fetch, timeoutMs = 15_000} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid_configuration');

  async function request({accessToken, cloudId}, path, {body, form, expected = 200, parse = value => value} = {}) {
    if (typeof accessToken !== 'string' || accessToken.length > 16_384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken) ||
        typeof cloudId !== 'string' || !CLOUD_ID.test(cloudId)) fail();
    const write = body !== undefined || form !== undefined;
    const outcome = write ? 'unknown' : 'read_failed';
    const controller = new AbortController();
    let timer, status;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new JiraApiError(write ? 'write_outcome_unknown' : 'timeout', {outcome, status}));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(`https://api.atlassian.com/ex/jira/${cloudId.toLowerCase()}/rest/api/3${path}`, {
          method: write ? 'POST' : 'GET',
          headers: {
            Accept: 'application/json', Authorization: `Bearer ${accessToken}`,
            ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
            ...(form !== undefined ? {'X-Atlassian-Token': 'no-check'} : {}),
          },
          ...(write ? {body: form ?? body} : {}),
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        });
        status = response.status;
        if (response.redirected) fail('invalid_response');
        if (status >= 400 && status < 500 && status !== 408) {
          const code = [401, 403].includes(status) ? 'access_denied' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'rejected';
          fail(code, {status, outcome: write ? 'rejected' : 'read_failed'});
        }
        if (status !== expected) fail(status >= 500 ? 'unavailable' : 'invalid_response');
        return parse(await readJson(response, controller.signal));
      })()]);
    } catch (error) {
      if (error instanceof JiraApiError && ['rejected', 'unknown', 'read_failed'].includes(error.outcome)) throw error;
      if (write) fail('write_outcome_unknown', {status, outcome});
      if (error instanceof JiraApiError) fail(error.code, {status, outcome});
      fail(controller.signal.aborted ? 'timeout' : 'unavailable', {status, outcome});
    } finally { clearTimeout(timer); controller.abort(); }
  }

  return Object.freeze({
    async listProjects({accessToken, cloudId, startAt = 0} = {}) {
      integer(startAt, {max: 10_000_000});
      return request({accessToken, cloudId}, `/project/search?startAt=${startAt}&maxResults=${JIRA_API_LIMITS.pageSize}&orderBy=name`, {
        parse: value => page(value, 'values', startAt, project => {
          if (!record(project)) fail('invalid_response');
          return {id: id(project.id, 'invalid_response'), key: text(project.key, 128, 'invalid_response'), name: text(project.name, 512, 'invalid_response')};
        }),
      });
    },
    async listIssueTypes({accessToken, cloudId, projectId, startAt = 0} = {}) {
      id(projectId); integer(startAt, {max: 10_000_000});
      return request({accessToken, cloudId}, `/issue/createmeta/${projectId}/issuetypes?startAt=${startAt}&maxResults=${JIRA_API_LIMITS.pageSize}`, {
        parse: value => page(value, 'issueTypes', startAt, type => {
          if (!record(type)) fail('invalid_response');
          return {id: id(type.id, 'invalid_response'), name: text(type.name, 512, 'invalid_response'),
            description: text(type.description ?? '', 4096, 'invalid_response', {empty: true, multiline: true}), subtask: boolean(type.subtask)};
        }),
      });
    },
    async getCreateFields({accessToken, cloudId, projectId, issueTypeId, startAt = 0} = {}) {
      id(projectId); id(issueTypeId); integer(startAt, {max: 10_000_000});
      return request({accessToken, cloudId}, `/issue/createmeta/${projectId}/issuetypes/${issueTypeId}?startAt=${startAt}&maxResults=${JIRA_API_LIMITS.pageSize}`, {
        parse: value => page(value, 'fields', startAt, fieldMetadata),
      });
    },
    async attachmentSettings({accessToken, cloudId} = {}) {
      return request({accessToken, cloudId}, '/attachment/meta', {parse: value => {
        if (!record(value)) fail('invalid_response');
        return {enabled: boolean(value.enabled), uploadLimit: integer(value.uploadLimit, {code: 'invalid_response'})};
      }});
    },
    async createIssue({accessToken, cloudId, projectId, issueTypeId, summary, description, fields = {}} = {}) {
      id(projectId); id(issueTypeId); text(summary, 255);
      if (!summary.trim() || !record(fields) || Object.keys(fields).some(key => CORE_FIELDS.has(key))) fail();
      const safeFields = jsonValue(fields);
      const body = JSON.stringify({fields: {...safeFields, project: {id: projectId}, issuetype: {id: issueTypeId}, summary, description: adf(description)}});
      if (Buffer.byteLength(body) > JIRA_API_LIMITS.issueBytes) fail();
      return request({accessToken, cloudId}, '/issue', {body, expected: 201, parse: value => {
        if (!record(value) || typeof value.key !== 'string' || !/^[A-Z][A-Z\d_]{0,127}-[1-9]\d{0,19}$/.test(value.key)) fail('invalid_response');
        return {id: id(value.id, 'invalid_response'), key: value.key};
      }});
    },
    async uploadAttachment({accessToken, cloudId, issueId, filename, mimeType, bytes} = {}) {
      id(issueId);
      const data = validateJiraAttachment({bytes, mimeType, filename});
      const form = new FormData();
      form.append('file', new Blob([data], {type: mimeType}), filename);
      return request({accessToken, cloudId}, `/issue/${issueId}/attachments`, {form, parse: value => {
        if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) fail('invalid_response');
        const item = value[0];
        return {id: id(item.id, 'invalid_response'), filename: text(item.filename, 512, 'invalid_response'),
          mimeType: text(item.mimeType, 128, 'invalid_response'), size: integer(item.size, {min: 1, max: JIRA_API_LIMITS.attachmentBytes, code: 'invalid_response'})};
      }});
    },
  });
}
