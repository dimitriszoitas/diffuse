import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveBrowserAuditEvidence, browserAuditsWithRetainedEvidence, saveBrowserAudit, getBrowserAudit, listBrowserAudits, deleteBrowserAudits} from '../extension/browser-audit-store.mjs';

function memoryStorage() {
  const records = new Map();
  return {get: async id => structuredClone(records.get(id)), getAll: async () => [...records.values()].map(value => structuredClone(value)),
    put: async value => records.set(value.id, structuredClone(value)), delete: async id => records.delete(id)};
}
const audit = (id, extras = {}) => ({id, reviewId: 'review', status: 'completed', createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:01:00Z', page: {title: 'Ingredients', url: 'https://example.test'}, steps: [{id: 'step-1', action: 'measure', description: 'Collect typography', status: 'completed'}], ...extras});

test('every audit status is saved and indexed independently of comments and AI completion', async () => {
  const storage = memoryStorage();
  for (const status of ['opening', 'ready', 'running', 'completed', 'stopped', 'error']) {
    await saveBrowserAudit(audit(status, {status, error: status === 'error' ? 'Connection closed' : undefined}), {storage});
    assert.equal((await getBrowserAudit(status, {storage})).status, status);
  }
  const saved = await listBrowserAudits('review', {storage});
  assert.equal(saved.length, 6);
  assert(saved.every(item => item.stepCount === 1));
  assert.equal(saved.find(item => item.id === 'error').error, 'Connection closed');
});

test('audit indexes omit large screenshots and measurements but preserve result counts', async () => {
  const storage = memoryStorage();
  await saveBrowserAudit(audit('a', {evidence: {screenshots: [{dataUrl: 'data:image/png;base64,AAAA'}], accessibility: {violations: [{id: 'color-contrast'}]}}, analysis: {findings: [{title: 'Contrast'}]}}), {storage});
  const [item] = await listBrowserAudits('review', {storage});
  assert.equal(item.findingCount, 1);
  assert.equal(item.violationCount, 1);
  assert.equal(item.evidence, undefined);
  assert.equal(item.analysis, undefined);
  assert.equal(item.steps, undefined);
  assert.equal((await getBrowserAudit('a', {storage})).evidence.screenshots.length, 1);
});

test('audit indexes retain analysis and unconfirmed-stop metadata needed for report recovery', async () => {
  const storage = memoryStorage();
  await saveBrowserAudit(audit('analyzing', {analysisStatus: 'running'}), {storage});
  await saveBrowserAudit(audit('stopping-offline', {status: 'stopped', stopUnconfirmed: true, syncError: 'Helper is offline', evidence: {screenshots: [{dataUrl: 'data:image/png;base64,AAAA'}]}}), {storage});
  const saved = await listBrowserAudits('review', {storage});
  assert.equal(saved.find(item => item.id === 'analyzing').analysisStatus, 'running');
  assert.equal(saved.find(item => item.id === 'analyzing').stopUnconfirmed, false);
  const stopping = saved.find(item => item.id === 'stopping-offline');
  assert.equal(stopping.stopUnconfirmed, true);
  assert.equal(stopping.syncError, 'Helper is offline');
  assert.equal(stopping.evidence, undefined, 'Recovery metadata must not bring media into the index');
  await saveBrowserAudit(audit('stopping-offline', {status: 'stopped', stopUnconfirmed: false, syncError: null}), {storage});
  assert.equal((await listBrowserAudits('review', {storage})).find(item => item.id === 'stopping-offline').stopUnconfirmed, false);
});

test('media retention never removes stopped steps, failure details, measurements or AI results', async () => {
  const storage = memoryStorage();
  const old = audit('old', {status: 'stopped', evidence: {screenshots: [{label: 'Before', dataUrl: 'data:image/png;base64,AAAA'}], styles: {typography: [{fontSize: '23px'}]}}, error: 'Stopped by reviewer', analysis: {summary: 'Partial evidence'}});
  await saveBrowserAudit(old, {storage});
  await saveBrowserAudit(audit('new', {evidence: {screenshots: [{dataUrl: 'data:image/png;base64,BBBB'}]}}), {storage, retention: {maxAudits: 1}});
  const archived = await getBrowserAudit('old', {storage});
  assert.equal(archived.evidenceArchived, true);
  assert.equal(archived.evidence.screenshots[0].dataUrl, undefined);
  assert.equal(archived.evidence.screenshots[0].label, 'Before');
  assert.deepEqual(archived.steps, old.steps);
  assert.deepEqual(archived.evidence.styles, old.evidence.styles);
  assert.deepEqual(archived.analysis, old.analysis);
  assert.equal(archived.error, old.error);
  assert.equal((await listBrowserAudits('review', {storage})).length, 2);
});

test('oversized current media is archived visibly instead of exceeding the image budget', () => {
  const original = audit('large', {evidence: {screenshots: [{dataUrl: 'data:image/png;base64,AAAA'}]}});
  const [result] = browserAuditsWithRetainedEvidence([original], 'large', {maxBytes: 1});
  assert.equal(result.evidenceArchived, true);
  assert.equal(result.steps.length, 1);
  assert(original.evidence.screenshots[0].dataUrl, 'Archival must not mutate the caller record');
});

test('archival strips nested media payloads while preserving their evidence metadata', () => {
  const original = audit('nested', {steps: [{id: 'step-1', details: {label: 'Dialog opened', screenshotDataUrl: 'data:image/png;base64,AAAA'}}]});
  const result = archiveBrowserAuditEvidence(original);
  assert.equal(result.steps[0].details.label, 'Dialog opened');
  assert.equal(result.steps[0].details.screenshotDataUrl, undefined);
  assert.equal(result.evidenceArchived, true);
  assert(original.steps[0].details.screenshotDataUrl);
});

test('deleting one review clears only its audits and requires an explicit review ID', async () => {
  const storage = memoryStorage();
  await saveBrowserAudit(audit('a'), {storage});
  await saveBrowserAudit(audit('b', {reviewId: 'other'}), {storage});
  await assert.rejects(deleteBrowserAudits('', {storage}), /Choose the review/);
  await deleteBrowserAudits('review', {storage});
  assert.equal(await getBrowserAudit('a', {storage}), undefined);
  assert.equal((await getBrowserAudit('b', {storage})).reviewId, 'other');
});

test('updates replace one record without losing its ledger and invalid identities are rejected', async () => {
  const storage = memoryStorage();
  await saveBrowserAudit(audit('run', {status: 'running'}), {storage});
  await saveBrowserAudit(audit('run', {status: 'stopped', steps: [{id: 'one'}, {id: 'two'}]}), {storage});
  assert.equal((await listBrowserAudits('review', {storage})).length, 1);
  assert.equal((await getBrowserAudit('run', {storage})).steps.length, 2);
  for (const invalid of [{id: '', reviewId: 'review'}, {id: 'x', reviewId: ''}, audit('x', {status: 'invented'})]) await assert.rejects(saveBrowserAudit(invalid, {storage}));
});
