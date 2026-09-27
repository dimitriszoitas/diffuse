import {jiraIssueFields, jiraAttachments} from './jira-format.mjs';

const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 40 * 1024 * 1024;
const CHUNK_SIZE = 512 * 1024;
const HISTORY_KEY = 'diffuseJiraDeliveryV1:';
const SYSTEM_FIELDS = new Set(['summary', 'description', 'project', 'issuetype', 'attachment']);
const encoder = new TextEncoder();

export async function sha256(value, cryptoApi = globalThis.crypto) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function mediaByteLength(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) throw new Error('A saved attachment could not be read.');
  const payload = dataUrl.slice(comma + 1);
  if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('A saved attachment has invalid data.');
  return payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}

export function validateEvidence(attachments, settings = {}) {
  let total = 0;
  if (attachments.length && settings.enabled === false) throw new Error('Attachments are disabled on this Jira site. Ask a Jira administrator to enable them before sending this evidence.');
  const limit = Math.min(FILE_LIMIT, Number.isFinite(settings.uploadLimit) ? settings.uploadLimit : FILE_LIMIT);
  for (const attachment of attachments) {
    const size = mediaByteLength(attachment.dataUrl);
    if (size > limit) throw new Error(`${attachment.filename} is too large (${formatSize(size)}). The upload limit is ${formatSize(limit)} per file. Shorten the recording or use a screenshot.`);
    total += size;
  }
  if (total > TOTAL_LIMIT) throw new Error('This observation has more than 40 MB of evidence. Use a shorter recording before sending it.');
  return total;
}

export async function allMetadata(client, connectionId, path) {
  const result = [];
  const visited = new Set();
  let startAt = 0;
  for (let page = 0; page < 100; page++) {
    if (visited.has(startAt)) throw new Error('Jira repeated a metadata page. Refresh the destination and try again.');
    visited.add(startAt);
    const separator = path.includes('?') ? '&' : '?';
    const response = await client.request(connectionId, `${path}${separator}startAt=${startAt}`);
    if (!Array.isArray(response?.values)) throw new Error('Jira returned an unexpected destination list.');
    result.push(...response.values);
    if (response.isLast === true || (Number.isFinite(response.total) && result.length >= response.total) || !response.values.length) return result;
    const next = Number.isInteger(response.nextStartAt) ? response.nextStartAt : response.startAt + response.values.length;
    if (!Number.isInteger(next) || next <= startAt) throw new Error('Jira could not load the next destination page.');
    startAt = next;
  }
  throw new Error('This Jira list is too large to load. Choose another project or ask an administrator to narrow the available configuration.');
}

export function fieldDescriptor(field) {
  const id = field.fieldId || field.key || field.id;
  const schema = field.schema || {};
  const required = !!field.required && !field.hasDefaultValue;
  const base = {id, name: field.name || id, required, optional: !required, field};
  if (!id || SYSTEM_FIELDS.has(id)) return {...base, kind: 'system'};
  if (!required && id !== 'priority' && id !== 'assignee') return {...base, kind: 'omit'};
  if (field.operations?.length && !field.operations.includes('set')) return {...base, kind: required ? 'unsupported' : 'omit'};
  if (/cascadingselect|asset|object|sprint/i.test(schema.custom || '')) return {...base, kind: required ? 'unsupported' : 'omit'};
  if (Array.isArray(field.allowedValues) && field.allowedValues.length) {
    const available = field.allowedValues.filter(value => value?.disabled !== true);
    const values = available.filter(value => value && (typeof value.id === 'string' || typeof value.id === 'number' || typeof value.accountId === 'string'));
    if (!values.length || values.length !== available.length || values.some(value => value.children?.length)) return {...base, kind: required ? 'unsupported' : 'omit'};
    return {...base, kind: schema.type === 'array' ? 'choices' : 'choice', values, user: schema.type === 'user' || schema.items === 'user'};
  }
  if (schema.type === 'user') return {...base, kind: 'user'};
  if (schema.type === 'number') return {...base, kind: 'number'};
  if (schema.type === 'date') return {...base, kind: 'date'};
  if (schema.type === 'string' && !['priority', 'assignee'].includes(id)) return {...base, kind: /textarea/.test(schema.custom || '') || id === 'environment' ? 'richtext' : 'text'};
  return {...base, kind: required ? 'unsupported' : 'omit'};
}

export function fieldValue(descriptor, raw) {
  const empty = raw === '' || raw == null || (Array.isArray(raw) && !raw.length);
  if (empty) {
    if (descriptor.required) throw new Error(`${descriptor.name} is required.`);
    return undefined;
  }
  const {kind} = descriptor;
  if (kind === 'number') {
    if (!Number.isFinite(Number(raw))) throw new Error(`${descriptor.name} must be a number.`);
    return Number(raw);
  }
  if (kind === 'date') {
    const date = new Date(`${raw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error(`${descriptor.name} must be a valid date.`);
    return raw;
  }
  if (kind === 'choice' || kind === 'choices') {
    const selected = kind === 'choices' ? raw : [raw];
    const values = selected.map(id => {
      const match = descriptor.values.find(value => String(value.accountId || value.id) === id);
      if (!match) throw new Error(`Choose an available value for ${descriptor.name}.`);
      return descriptor.user ? {accountId: match.accountId || String(match.id)} : {id: String(match.id)};
    });
    return kind === 'choices' ? values : values[0];
  }
  if (kind === 'user') {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(raw)) throw new Error(`Enter a Jira account ID for ${descriptor.name}.`);
    return {accountId: raw};
  }
  if (kind === 'richtext') return {type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: raw}]}]};
  if (kind === 'text') return String(raw);
  throw new Error(`${descriptor.name} needs a field type that Diffuse cannot yet send. Complete this issue in Jira instead.`);
}

function formatSize(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

/** Prepares an immutable snapshot locally; nothing is sent until the caller explicitly submits it. */
export async function prepareDelivery(comment, review, destination, fields = {}, {index = 0, cryptoApi = globalThis.crypto, fetchImpl = globalThis.fetch, attachmentSettings = {}} = {}) {
  const evidence = jiraAttachments(comment, review, {index});
  validateEvidence(evidence, attachmentSettings);
  const attachments = [];
  const blobs = new Map();
  for (const attachment of evidence) {
    // jiraAttachments permits only embedded data URLs. Never fetch a captured page or remote media here.
    if (!attachment.dataUrl.startsWith('data:')) throw new Error('Only saved evidence can be uploaded.');
    const blob = await (await fetchImpl(attachment.dataUrl)).blob();
    if (blob.size !== mediaByteLength(attachment.dataUrl)) throw new Error('An attachment changed while it was being prepared.');
    const id = cryptoApi.randomUUID();
    attachments.push({id, filename: attachment.filename, mimeType: attachment.mimeType, size: blob.size, sha256: await sha256(await blob.arrayBuffer(), cryptoApi)});
    blobs.set(id, blob);
  }
  const formatted = jiraIssueFields(comment, review, {index});
  const content = {commentId: comment.id, cloudId: destination.cloudId, projectId: destination.projectId, issueTypeId: destination.issueTypeId, summary: formatted.summary, description: formatted.description, fields};
  const revision = await sha256(JSON.stringify(ordered({...content, attachments: attachments.map(({id, ...attachment}) => attachment)})), cryptoApi);
  return {payload: {...content, revision, clientDeliveryId: cryptoApi.randomUUID(), attachments}, blobs};
}

function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

function receiptOf(value) { return value?.receipt || value; }
function storageHistory(storage) {
  return {
    async get(key) { return (await storage.get(`${HISTORY_KEY}${key}`))[`${HISTORY_KEY}${key}`]; },
    async set(key, value) { await storage.set({[`${HISTORY_KEY}${key}`]: value}); },
  };
}

/** Runs only after explicit submission. Resume reuses the saved delivery; uncertain writes stop. */
export async function sendDelivery({client, connectionId, accountId, prepared, history, onProgress = () => {}}) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256) throw new Error('The connected Atlassian account could not be verified. Reopen Jira settings before sending.');
  const destinationKey = `${prepared.payload.cloudId}:${prepared.payload.projectId}:${prepared.payload.issueTypeId}:${prepared.payload.commentId}:${prepared.payload.revision}`;
  const historyId = `${connectionId}:${destinationKey}`;
  // Account identity survives reconnects; server delivery receipts may not. Keep this
  // guard locally even after an old connection has been removed from Jira settings.
  const accountHistoryId = `account:${encodeURIComponent(accountId)}:${destinationKey}`;
  const previousConnection = await history.get(accountHistoryId);
  if (previousConnection && previousConnection.connectionId !== connectionId) {
    const previousReceipt = previousConnection.receipt;
    if (previousReceipt?.issue) {
      const message = previousReceipt.status === 'complete'
        ? 'Already sent from this Atlassian account before it was reconnected. Open the existing Jira issue below.'
        : 'This observation already has a Jira issue from the previous connection. Open it to check or add the remaining evidence. No new issue was created.';
      onProgress({...previousReceipt, message});
      if (previousReceipt.status === 'complete') return {...previousReceipt, message};
      throw new Error(message);
    }
    const message = 'This observation has a delivery from before this Atlassian account was reconnected. Check the Jira project manually to see whether an issue was created. Diffuse will not send it again automatically.';
    onProgress({...previousReceipt, status: 'needs-check', needsCheck: true, message});
    throw new Error(message);
  }
  let saved = await history.get(historyId);
  const persist = async value => {
    const guard = {...value, connectionId, accountId};
    // Fail closed before any network write if the account-level guard cannot be saved.
    await history.set(accountHistoryId, guard);
    await history.set(historyId, value);
  };
  let receipt;
  if (saved) {
    prepared.payload.clientDeliveryId = saved.clientDeliveryId;
    // Keep attachment identifiers identical across reloads. Evidence hashes and ordering are part of revision.
    prepared.payload.attachments.forEach((attachment, index) => {
      const previousId = saved.attachmentIds[index];
      if (!previousId) throw new Error('The saved delivery cannot be resumed safely. Open Jira settings for support.');
      const blob = prepared.blobs.get(attachment.id);
      prepared.blobs.delete(attachment.id); attachment.id = previousId; prepared.blobs.set(previousId, blob);
    });
    if (saved.id) receipt = receiptOf(await client.request(connectionId, `/v1/deliveries/${saved.id}`));
  } else {
    saved = {clientDeliveryId: prepared.payload.clientDeliveryId, attachmentIds: prepared.payload.attachments.map(item => item.id), revision: prepared.payload.revision};
    await persist(saved);
  }
  const remember = async value => {
    receipt = receiptOf(value);
    // A server-side deduplication may return an older job after local history was cleared.
    // Match its immutable evidence descriptors before using the server's attachment IDs.
    if (!Array.isArray(receipt?.attachments) || receipt.attachments.length !== prepared.payload.attachments.length) throw new Error('The saved delivery evidence does not match this observation.');
    const reassigned = new Map();
    prepared.payload.attachments.forEach(attachment => {
      const match = receipt.attachments.find(item => item.filename === attachment.filename && item.size === attachment.size && item.mimeType === attachment.mimeType);
      if (!match || reassigned.has(match.id)) throw new Error('The saved delivery evidence could not be matched safely.');
      reassigned.set(match.id, prepared.blobs.get(attachment.id));attachment.id = match.id;
    });
    prepared.blobs = reassigned;
    prepared.payload.clientDeliveryId = receipt.clientDeliveryId;
    saved = {...saved, clientDeliveryId: receipt.clientDeliveryId, attachmentIds: prepared.payload.attachments.map(item => item.id), id: receipt.id, receipt, updatedAt: Date.now()};
    await persist(saved);
    onProgress(receipt);
  };
  if (!receipt) {
    onProgress({message: 'Preparing the saved delivery…'});
    await remember(await client.request(connectionId, '/v1/deliveries', {method: 'POST', body: prepared.payload}));
  } else await remember(receipt);
  if (receipt.needsCheck || ['needs-check', 'creating'].includes(receipt.status)) throw new Error(receipt.message || 'Jira may already have created this issue. Check Jira before trying again; Diffuse will not create a duplicate.');
  if (receipt.status === 'complete') return receipt;
  for (const attachment of receipt.attachments || []) {
    if (attachment.status === 'uploaded') continue;
    if (['needs-check', 'uploading', 'expired'].includes(attachment.status)) throw new Error(attachment.message || `${attachment.filename} needs a manual check in Jira before continuing.`);
    const blob = prepared.blobs.get(attachment.id);
    if (!blob) throw new Error('The saved evidence is unavailable. Keep the original review to resume this delivery.');
    const received = new Set(Array.isArray(attachment.receivedChunks) ? attachment.receivedChunks : []);
    const count = Math.ceil(blob.size / CHUNK_SIZE);
    for (let index = 0; index < count; index++) {
      if (received.has(index)) continue;
      onProgress({...receipt, message: `Preparing ${attachment.filename} · part ${index + 1} of ${count}`});
      const bytes = new Uint8Array(await blob.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).arrayBuffer());
      await remember(await client.request(connectionId, `/v1/deliveries/${receipt.id}/chunks`, {method: 'POST', body: {attachmentId: attachment.id, index, dataBase64: base64(bytes)}}));
    }
  }
  if (!receipt.issue) {
    if (!receipt.canSendIssue) throw new Error(receipt.message || 'The delivery is not ready to create an issue. Check its status before continuing.');
    onProgress({...receipt, message: 'Creating the Jira issue…'});
    await persist({...saved, phase: 'issue-write-started', updatedAt: Date.now()});
    await remember(await client.request(connectionId, `/v1/deliveries/${receipt.id}/issue`, {method: 'POST', body: {}}));
    if (!receipt.issue || receipt.needsCheck) throw new Error(receipt.message || 'Check Jira to confirm whether the issue was created.');
  }
  for (const attachment of receipt.attachments || []) {
    if (attachment.status === 'uploaded') continue;
    if (attachment.canSend === false || ['needs-check', 'uploading'].includes(attachment.status)) throw new Error(attachment.message || 'The issue exists, but an attachment needs checking in Jira.');
    onProgress({...receipt, message: `Attaching ${attachment.filename}…`});
    await remember(await client.request(connectionId, `/v1/deliveries/${receipt.id}/attachments/${attachment.id}`, {method: 'POST', body: {}}));
    const current = receipt.attachments.find(item => item.id === attachment.id);
    if (current?.status !== 'uploaded') throw new Error(current?.message || receipt.message || 'The issue exists, but its evidence did not finish uploading.');
  }
  return receipt;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, onClick, primary = false) {
  const node = element('button', label, `button${primary ? ' primary' : ''}`);node.type = 'button';node.addEventListener('click', onClick);return node;
}
function selectField(labelText, placeholder) {
  const label = element('label', labelText, 'jira-export-field');
  const select = element('select');select.append(new Option(placeholder, ''));select.disabled = true;label.append(select);
  return {label, select};
}
function populate(select, values, placeholder, labelOf = item => item.name || item.id) {
  select.replaceChildren(new Option(placeholder, ''));
  values.forEach(value => select.append(new Option(labelOf(value), value.id)));
  select.disabled = !values.length;
}

// Render the exact ADF prepared for Jira using DOM text nodes only. Jira uses its
// own colors and typography; the hierarchy and content stay the same.
function descriptionPreview(description) {
  function render(node) {
    if (node.type === 'text') {
      let child = document.createTextNode(node.text);
      for (const mark of node.marks || []) {
        const tag = {strong: 'strong', em: 'em', code: 'code', link: 'a'}[mark.type];
        if (!tag) continue;
        const wrapper = element(tag);
        if (tag === 'a') {
          let url;try { url = new URL(mark.attrs?.href); } catch { continue; }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
          wrapper.href = url.href;wrapper.target = '_blank';wrapper.rel = 'noopener noreferrer';
        }
        wrapper.append(child);child = wrapper;
      }
      return child;
    }
    if (node.type === 'hardBreak') return element('br');
    const tag = {heading: 'h4', paragraph: 'p', panel: 'section', orderedList: 'ol', bulletList: 'ul', listItem: 'li', codeBlock: 'pre'}[node.type];
    if (!tag) return document.createTextNode('');
    const block = element(tag);
    if (node.type === 'panel') block.className = 'jira-description-change';
    if (node.type === 'codeBlock') block.className = 'jira-description-prompt';
    if (node.type === 'orderedList') block.start = node.attrs?.order ?? 1;
    if (node.type === 'paragraph' && node.content?.[0]?.marks?.some(mark => mark.type === 'strong')) block.className = 'jira-description-context';
    block.append(...(node.content || []).map(render));
    return block;
  }
  const preview = element('div', null, 'jira-description-preview');
  preview.append(...description.content.map(render));
  return preview;
}

export function createJiraExporter({onError = () => {}, clientFactory, storage = globalThis.chrome?.storage?.local} = {}) {
  const selections = new Map();
  let observer;
  let activeDialog;
  let sending = false;
  async function client() {
    return clientFactory ? clientFactory() : (await import('./jira-connection.mjs')).createJiraConnectionClient();
  }
  async function open(review, selectedIds) {
    if (activeDialog) { if (!activeDialog.open) activeDialog.showModal(); return; }
    const comments = review.comments.map((comment, index) => ({comment, index})).filter(({comment}) => selectedIds.has(comment.id));
    if (!comments.length) return;
    const previousFocus = document.activeElement;
    const dialog = element('dialog', null, 'jira-export-dialog');activeDialog = dialog;
    dialog.setAttribute('aria-labelledby', 'jira-export-title');
    const header = element('header', null, 'dialog-header');
    const heading = element('h2', 'Send observations to Jira');heading.id = 'jira-export-title';
    header.append(heading, button('Close', () => dialog.close()));
    const body = element('div', null, 'jira-export-body');
    body.append(element('p', 'Choose a destination and review exactly what will be sent. Each observation becomes a separate Jira issue. Jira applies its own typography and panel colors.'));
    const grid = element('div', null, 'jira-export-grid');
    const account = selectField('Atlassian account', 'Choose an account');
    const site = selectField('Jira site', 'Choose a site');
    const project = selectField('Project', 'Choose a project');
    const issueType = selectField('Issue type', 'Choose an issue type');
    grid.append(account.label, site.label, project.label, issueType.label);
    const settingsLink = element('a', 'Manage Jira accounts ↗');settingsLink.href = 'settings.html#jira';settingsLink.target = '_blank';settingsLink.rel = 'noopener';
    const metadataStatus = element('p', 'Loading your connected accounts…', 'jira-export-status');metadataStatus.setAttribute('role', 'status');
    const extraFields = element('section', null, 'jira-required-fields');
    const error = element('p', null, 'jira-export-error');error.setAttribute('role', 'alert');error.hidden = true;
    const intent = element('p', `${comments.length} observation${comments.length === 1 ? '' : 's'} selected. Choose a destination to continue.`, 'jira-export-intent');
    const list = element('ol', null, 'jira-export-items');
    const rows = comments.map(({comment, index}) => {
      const item = element('li', null, 'jira-export-item');
      const formatted = jiraIssueFields(comment, review, {index});
      item.append(element('h3', formatted.summary));
      item.append(descriptionPreview(formatted.description));
      const evidence = jiraAttachments(comment, review, {index});
      const filesDetail = element('details', null, 'jira-export-attachments');
      filesDetail.append(element('summary', evidence.length ? `${evidence.length} attached file${evidence.length === 1 ? '' : 's'} · upload details` : 'No saved evidence files'));
      if (evidence.length) {
        filesDetail.append(element('p', 'Files upload to the issue’s attachments after the ticket is created.'));
        const files = element('ul', null, 'jira-export-files');
        evidence.forEach(file => files.append(element('li', `${file.filename} · ${formatSize(mediaByteLength(file.dataUrl))}`)));
        filesDetail.append(files);
      }
      item.append(filesDetail);
      const progress = element('div', '', 'jira-item-progress');progress.hidden = true;progress.setAttribute('role', 'status');
      item.append(progress);list.append(item);
      return {comment, index, evidence, progress, item};
    });
    body.append(grid, settingsLink, metadataStatus, extraFields, error, intent, list);
    const footer = element('footer', null, 'dialog-footer');
    const footnote = element('p', 'Only these observations and their saved evidence are sent when you select Create tickets.');
    const actions = element('div', null, 'jira-export-actions');
    const cancel = button('Cancel', () => dialog.close());
    const submit = button(`Create ${comments.length} ticket${comments.length === 1 ? '' : 's'}`, () => send(), true);submit.disabled = true;
    actions.append(cancel, submit);footer.append(footnote, actions);dialog.append(header, body, footer);
    const dispose = () => { dialog.remove();if (activeDialog === dialog) activeDialog = null;if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true}); };
    dialog.addEventListener('close', () => { if (!sending) dispose();else footnote.textContent = 'Sending continues while this report remains open.'; });
    document.body.append(dialog);dialog.showModal();
    let api;
    let connections = [];
    let projects = [];
    let types = [];
    let metadataVersion = 0;
    let descriptors = [];
    let inputs = [];
    let attachmentSettings = {};
    let ready = false;
    function fail(reason) { error.textContent = reason?.message || String(reason);error.hidden = false; }
    function pending(message) { ready = false;submit.disabled = true;error.hidden = true;metadataStatus.textContent = message;extraFields.replaceChildren();descriptors = [];inputs = []; }
    const destination = () => ({cloudId: site.select.value, projectId: project.select.value, issueTypeId: issueType.select.value});
    function updateIntent() {
      const count = comments.length;
      const chosen = [site.select, project.select, issueType.select].every(input => input.value);
      intent.textContent = chosen ? `${count} separate ${issueType.select.selectedOptions[0].textContent} issue${count === 1 ? '' : 's'} → ${site.select.selectedOptions[0].textContent} / ${project.select.selectedOptions[0].textContent}.` : `${count} observation${count === 1 ? '' : 's'} selected. Choose a destination to continue.`;
    }
    function appendFields(fields) {
      descriptors = fields.map(fieldDescriptor).filter(item => !['system', 'omit'].includes(item.kind));
      const unsupported = descriptors.filter(item => item.kind === 'unsupported');
      if (unsupported.length) throw new Error(`This project requires fields Diffuse cannot yet fill: ${unsupported.map(item => item.name).join(', ')}. Choose another issue type or create the issues in Jira.`);
      if (!descriptors.length) return;
      extraFields.append(element('h3', 'Issue details'), element('p', 'These values apply to every selected observation. Jira controls which fields are required.'));
      const fieldGrid = element('div', null, 'jira-export-grid');extraFields.append(fieldGrid);
      inputs = descriptors.map(descriptor => {
        const label = element('label', `${descriptor.name}${descriptor.required ? ' (required)' : ' (optional)'}`, 'jira-export-field');
        let input;
        if (['choice', 'choices'].includes(descriptor.kind)) {
          input = element('select');input.multiple = descriptor.kind === 'choices';
          if (!input.multiple) input.append(new Option('Choose a value', ''));
          descriptor.values.forEach(value => input.append(new Option(value.displayName || value.name || value.value || value.accountId || String(value.id), String(value.accountId || value.id))));
        } else {
          input = element(descriptor.kind === 'richtext' ? 'textarea' : 'input');
          if (input.tagName === 'INPUT') input.type = ['number', 'date'].includes(descriptor.kind) ? descriptor.kind : 'text';
          if (descriptor.kind === 'number') input.step = 'any';
          if (descriptor.kind === 'user') label.append(element('small', 'Paste the person’s Jira account ID. Names and email addresses are not account IDs.'));
        }
        input.required = descriptor.required;label.append(input);fieldGrid.append(label);return {descriptor, input};
      });
    }
    async function loadProjects() {
      const version = ++metadataVersion;pending('Loading projects…');populate(project.select, [], 'Choose a project');populate(issueType.select, [], 'Choose an issue type');updateIntent();
      if (!site.select.value) { metadataStatus.textContent = 'Choose a Jira site.';return; }
      try {
        const [available, settings] = await Promise.all([allMetadata(api, account.select.value, `/v1/projects?site=${encodeURIComponent(site.select.value)}`), api.request(account.select.value, `/v1/attachment-settings?site=${encodeURIComponent(site.select.value)}`)]);
        if (version !== metadataVersion) return;
        projects = available;attachmentSettings = settings;populate(project.select, projects, 'Choose a project', item => `${item.name} (${item.key})`);metadataStatus.textContent = projects.length ? 'Choose the project where these issues belong.' : 'No projects are available for this account and site.';
      } catch (reason) { if (version === metadataVersion) { metadataStatus.textContent = '';fail(reason); } }
    }
    async function loadTypes() {
      const version = ++metadataVersion;pending('Loading issue types…');populate(issueType.select, [], 'Choose an issue type');updateIntent();
      if (!project.select.value) { metadataStatus.textContent = 'Choose a project.';return; }
      try {
        types = await allMetadata(api, account.select.value, `/v1/issue-types?site=${encodeURIComponent(site.select.value)}&project=${encodeURIComponent(project.select.value)}`);
        if (version !== metadataVersion) return;
        populate(issueType.select, types.filter(type => !type.subtask), 'Choose an issue type');metadataStatus.textContent = 'Choose an issue type to load its required fields.';
      } catch (reason) { if (version === metadataVersion) { metadataStatus.textContent = '';fail(reason); } }
    }
    async function loadFields() {
      const version = ++metadataVersion;pending('Checking required fields and evidence…');updateIntent();
      if (!issueType.select.value) { metadataStatus.textContent = 'Choose an issue type.';return; }
      try {
        const fields = await allMetadata(api, account.select.value, `/v1/create-fields?site=${encodeURIComponent(site.select.value)}&project=${encodeURIComponent(project.select.value)}&issueType=${encodeURIComponent(issueType.select.value)}`);
        if (version !== metadataVersion) return;
        appendFields(fields);rows.forEach(row => validateEvidence(row.evidence, attachmentSettings));ready = true;submit.disabled = false;metadataStatus.textContent = 'Destination ready. Review the observations below before creating tickets.';
      } catch (reason) { if (version === metadataVersion) { metadataStatus.textContent = '';fail(reason); } }
    }
    function accountChanged() {
      ++metadataVersion;pending('Choose a Jira site.');populate(project.select, [], 'Choose a project');populate(issueType.select, [], 'Choose an issue type');
      const connection = connections.find(item => item.id === account.select.value);
      populate(site.select, connection?.sites || [], 'Choose a site');updateIntent();
      if (connection?.sites?.length === 1) { site.select.value = connection.sites[0].id;void loadProjects(); }
    }
    account.select.addEventListener('change', accountChanged);site.select.addEventListener('change', loadProjects);project.select.addEventListener('change', loadTypes);issueType.select.addEventListener('change', loadFields);
    async function send() {
      if (!ready || sending) return;
      error.hidden = true;
      const fields = {};
      try {
        for (const {descriptor, input} of inputs) {
          if (!input.reportValidity()) return;
          const raw = descriptor.kind === 'choices' ? [...input.selectedOptions].map(option => option.value) : input.value.trim();
          const value = fieldValue(descriptor, raw);
          if (value !== undefined) fields[descriptor.id] = value;
        }
      } catch (reason) { fail(reason);return; }
      sending = true;submit.disabled = true;cancel.textContent = 'Hide progress';footnote.textContent = 'Keep this report open while sending. If interrupted, select the same items and destination to resume.';
      [account.select, site.select, project.select, issueType.select, ...inputs.map(item => item.input)].forEach(input => { input.disabled = true; });
      const connectionId = account.select.value;
      const accountId = connections.find(connection => connection.id === connectionId)?.accountId;
      const dest = destination();
      const history = storageHistory(storage);
      let completed = 0;
      for (const row of rows) {
        row.progress.hidden = false;row.progress.dataset.error = 'false';row.progress.textContent = 'Preparing saved evidence…';
        const update = receipt => {
          row.progress.replaceChildren(element('span', receipt.message || (receipt.status === 'complete' ? 'Sent with evidence.' : 'Delivery in progress…')));
          if (receipt.issue?.url) {
            try {
              const url = new URL(receipt.issue.url);
              if (url.protocol === 'https:' && !url.username && !url.password) {
                const link = element('a', `Open ${receipt.issue.key || 'issue'} in Jira ↗`, 'jira-item-link');link.href = url.href;link.target = '_blank';link.rel = 'noopener';row.progress.append(element('br'), link);
              }
            } catch { /* Do not render malformed remote links. */ }
          }
        };
        try {
          const prepared = await prepareDelivery(row.comment, review, dest, fields, {index: row.index, attachmentSettings});
          const receipt = await sendDelivery({client: api, connectionId, accountId, prepared, history, onProgress: update});update(receipt);completed++;
        } catch (reason) {
          row.progress.dataset.error = 'true';row.progress.prepend(element('p', reason.message || 'This observation could not be sent.'));
        }
      }
      sending = false;cancel.textContent = 'Close';submit.textContent = completed === rows.length ? 'All tickets sent' : 'Check status / resume';submit.disabled = completed === rows.length;
      metadataStatus.textContent = `${completed} of ${rows.length} observations sent. ${completed === rows.length ? 'Open each Jira issue above.' : 'Review the item statuses below. Resume keeps the same issue and never retries an uncertain write.'}`;
      footnote.textContent = 'Deliveries are saved. Reopening this review with the same selection and destination resumes existing issues.';
      if (!dialog.open) { onError(metadataStatus.textContent);dispose(); }
    }
    try {
      api = await client();connections = await api.listConnections();
      populate(account.select, connections, 'Choose an account', item => item.displayName || item.accountId || 'Atlassian account');
      metadataStatus.textContent = connections.length ? 'Choose the account and site for this review.' : 'Connect an Atlassian account in Jira settings, then reopen this preview.';
      if (connections.length === 1) { account.select.value = connections[0].id;accountChanged(); }
    } catch (reason) { metadataStatus.textContent = '';fail(reason); }
  }
  function mount(review, container, cards) {
    observer?.disconnect();
    let selected = selections.get(review.id);
    if (!selected) { selected = new Set();selections.set(review.id, selected); }
    const valid = new Set(review.comments.map(comment => comment.id));
    for (const id of selected) if (!valid.has(id)) selected.delete(id);
    const bar = element('div', null, 'jira-selection-bar');bar.setAttribute('aria-label', 'Send selected observations to Jira');
    const count = element('strong');count.setAttribute('aria-live', 'polite');
    const send = button('Send selected to Jira', () => open(review, new Set(selected)).catch(reason => onError(reason.message)), true);
    const selectVisible = button('Select visible', () => { cards.forEach((card, index) => { if (!card.hidden) selected.add(review.comments[index].id); });update(); });
    const clear = button('Clear selection', () => { selected.clear();update(); });
    bar.append(count, selectVisible, clear, send);
    const issues = container.querySelector('.review-issues');
    if (issues) issues.before(bar); else container.prepend(bar);
    const checkboxes = cards.map((card, index) => {
      const comment = review.comments[index];
      const label = element('label', null, 'jira-select-observation');const input = element('input');input.type = 'checkbox';
      input.setAttribute('aria-label', `Select observation ${index + 1}: ${jiraIssueFields(comment, review, {index}).summary}`);
      label.append(input, element('span', 'Select for Jira'));
      input.addEventListener('change', () => { if (input.checked) selected.add(comment.id);else selected.delete(comment.id);update(); });
      const actions = card.querySelector('.comment-actions');
      const single = button('Send to Jira', () => open(review, new Set([comment.id])).catch(reason => onError(reason.message)));single.classList.add('jira-send-one');
      card.prepend(label);actions.append(single);return input;
    });
    function update() {
      const hiddenSelected = cards.filter((card, index) => card.hidden && selected.has(review.comments[index].id)).length;
      count.textContent = `${selected.size} selected${hiddenSelected ? ` · ${hiddenSelected} hidden by the current filters` : ''}`;
      send.disabled = !selected.size;clear.disabled = !selected.size;selectVisible.disabled = cards.every(card => card.hidden || selected.has(review.comments[cards.indexOf(card)].id));
      checkboxes.forEach((input, index) => { input.checked = selected.has(review.comments[index].id); });
    }
    observer = new MutationObserver(update);cards.forEach(card => observer.observe(card, {attributes: true, attributeFilter: ['hidden']}));update();
  }
  return {mount};
}
