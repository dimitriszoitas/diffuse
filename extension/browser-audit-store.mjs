// Audit evidence stays in this extension's local IndexedDB. No cloud sync.
let database;
const STORE = 'audits';
const STATUSES = new Set(['opening', 'ready', 'running', 'completed', 'stopped', 'error']);
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Could not save this interactive audit.'));
});
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const opening = indexedDB.open('diffuse-browser-audits', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, {keyPath: 'id'}).createIndex('reviewId', 'reviewId');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => { database = null; reject(opening.error); };
  });
  return database;
}

// Only image/video payloads are removed. Failed and stopped audit ledgers,
// measured styles, accessibility findings and AI analysis remain available.
export function archiveBrowserAuditEvidence(audit) {
  const archived = structuredClone(audit);
  let removed = false;
  const strip = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^data:(?:image|video)\//i.test(child)) { delete value[key]; removed = true; }
      else strip(child);
    }
  };
  strip(archived);
  if (removed) archived.evidenceArchived = true;
  return archived;
}

function mediaBytes(value) {
  if (typeof value === 'string') return /^data:(?:image|video)\//i.test(value) ? value.length : 0;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((total, child) => total + mediaBytes(child), 0);
}

// Keep the most recently saved evidence within a bounded image budget. Text
// records are never evicted, including an audit that stopped before analysis.
export function browserAuditsWithRetainedEvidence(audits, writtenId, {maxAudits = 10, maxBytes = 60 * 1024 * 1024} = {}) {
  let bytes = 0, count = 0;
  const retained = new Set();
  const recent = [...audits].sort((a, b) => a.id === writtenId ? -1 : b.id === writtenId ? 1 : String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const audit of recent) {
    const size = mediaBytes(audit);
    if (!size) continue;
    if (count < maxAudits && bytes + size <= maxBytes) { retained.add(audit.id); bytes += size; count++; }
  }
  return audits.map(audit => mediaBytes(audit) && !retained.has(audit.id) ? archiveBrowserAuditEvidence(audit) : audit);
}

export function browserAuditSummary(audit) {
  const {id, reviewId, status, createdAt, updatedAt, page, checks, error, analysisStatus, analysisError, stopUnconfirmed, syncError, evidenceArchived} = audit;
  return {id, reviewId, status, createdAt, updatedAt, page, checks, error, analysisStatus, analysisError, stopUnconfirmed: Boolean(stopUnconfirmed), syncError,
    stepCount: Array.isArray(audit.steps) ? audit.steps.length : 0,
    findingCount: Array.isArray(audit.analysis?.findings) ? audit.analysis.findings.length : 0,
    violationCount: Array.isArray(audit.evidence?.accessibility?.violations) ? audit.evidence.accessibility.violations.length : 0,
    ...(evidenceArchived ? {evidenceArchived: true} : {})};
}

// Optional storage adapter is useful for deterministic tests: get/getAll/put/delete.
export async function saveBrowserAudit(audit, {storage, retention} = {}) {
  if (!audit || typeof audit.id !== 'string' || !audit.id.trim() || typeof audit.reviewId !== 'string' || !audit.reviewId.trim()) throw new Error('An interactive audit needs an ID and a review ID.');
  if (!STATUSES.has(audit.status)) throw new Error('This interactive audit has an unsupported status.');
  const saved = structuredClone(audit);
  const now = new Date().toISOString();
  saved.createdAt ||= now;
  saved.updatedAt ||= now;
  saved.steps = Array.isArray(saved.steps) ? saved.steps : [];
  if (storage) {
    const all = (await storage.getAll()).filter(item => item.id !== saved.id);
    all.push(saved);
    const retained = browserAuditsWithRetainedEvidence(all, saved.id, retention);
    for (const item of retained) if (item.id === saved.id || item !== all.find(original => original.id === item.id)) await storage.put(item);
    return retained.find(item => item.id === saved.id);
  }
  const transaction = (await db()).transaction(STORE, 'readwrite');
  const done = complete(transaction);
  // Observe rejection immediately if a request fails before awaiting completion.
  done.catch(() => {});
  const store = transaction.objectStore(STORE);
  const all = (await request(store.getAll())).filter(item => item.id !== saved.id);
  all.push(saved);
  const retained = browserAuditsWithRetainedEvidence(all, saved.id, retention);
  for (const item of retained) if (item.id === saved.id || item !== all.find(original => original.id === item.id)) store.put(item);
  await done;
  return retained.find(item => item.id === saved.id);
}

export async function getBrowserAudit(id, {storage} = {}) {
  if (storage) return storage.get(id);
  return request((await db()).transaction(STORE).objectStore(STORE).get(id));
}

export async function listBrowserAudits(reviewId, {storage} = {}) {
  const all = storage ? (await storage.getAll()).filter(item => !reviewId || item.reviewId === reviewId)
    : await request(reviewId ? (await db()).transaction(STORE).objectStore(STORE).index('reviewId').getAll(reviewId)
      : (await db()).transaction(STORE).objectStore(STORE).getAll());
  return all.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).map(browserAuditSummary);
}

export async function deleteBrowserAudits(reviewId, {storage} = {}) {
  if (!reviewId) throw new Error('Choose the review whose audits should be deleted.');
  if (storage) {
    for (const audit of await storage.getAll()) if (audit.reviewId === reviewId) await storage.delete(audit.id);
    return;
  }
  const transaction = (await db()).transaction(STORE, 'readwrite');
  const done = complete(transaction);
  done.catch(() => {});
  const store = transaction.objectStore(STORE);
  const keys = await request(store.index('reviewId').getAllKeys(reviewId));
  keys.forEach(key => store.delete(key));
  await done;
}
