// Journey screenshots stay on this device until a finding is explicitly shared.
let database;
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Could not save this journey.'));
});
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const opening = indexedDB.open('diffuse-journeys', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('runs', {keyPath: 'id'}).createIndex('reviewId', 'reviewId');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => { database = null; reject(opening.error); };
  });
  return database;
}
export async function getJourney(id) {
  return request((await db()).transaction('runs').objectStore('runs').get(id));
}
// Reserve the written run and its direct parent, or its directly linked help
// continuation while saving the parent's response pointer. The pair may exceed
// the approximate byte budget, but never recursively protects an ancestry.
export function retainedJourneyIds(runs, writtenId, {maxRuns = 10, maxBytes = 80 * 1024 * 1024} = {}) {
  const written = runs.find(run => run.id === writtenId);
  const parentId = written?.fork?.parentRunId || written?.continuation?.parentRunId;
  const parent = parentId ? runs.find(run => run.id === parentId && run.reviewId === written.reviewId) : null;
  const response = written?.assistance?.response;
  const linkedChild = response?.continuationRunId && response.id && response.decision === 'continue'
    ? runs.find(run => run.id === response.continuationRunId && run.reviewId === written.reviewId &&
      run.continuation?.parentRunId === written.id && run.continuation.assistanceResponseId === response.id) : null;
  const protectedRuns = [written, linkedChild || parent].filter(Boolean);
  const kept = new Set(protectedRuns.map(run => run.id));
  let bytes = protectedRuns.reduce((total, run) => total + JSON.stringify(run).length, 0);
  for (const run of [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (kept.has(run.id)) continue;
    const size = JSON.stringify(run).length;
    if (kept.size >= maxRuns || bytes + size > maxBytes) continue;
    kept.add(run.id); bytes += size;
  }
  return kept;
}

export async function putJourney(run) {
  const transaction = (await db()).transaction('runs', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('runs');
  store.put(run);
  const all = await request(store.getAll());
  const kept = retainedJourneyIds(all, run.id);
  for (const previous of all) if (!kept.has(previous.id)) store.delete(previous.id);
  await done;
  return run;
}
export async function listJourneys(reviewId) {
  const all = await request((await db()).transaction('runs').objectStore('runs').index('reviewId').getAll(reviewId));
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({id, goal, status, createdAt, updatedAt, fork, continuation, persona}) => ({id, goal, status, createdAt, updatedAt,
    ...(persona ? {persona} : {}),
    ...(fork ? {fork: {parentRunId: fork.parentRunId, stepIndex: fork.stepIndex, instructions: fork.instructions?.slice(0, 100)}} : {}),
    ...(continuation ? {continuation: {parentRunId: continuation.parentRunId, instructions: continuation.instructions?.slice(0, 100),
      ...(continuation.assistanceResponseId ? {assistanceResponseId: continuation.assistanceResponseId} : {})}} : {})}));
}
export async function deleteJourneys(reviewId) {
  const transaction = (await db()).transaction('runs', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('runs');
  const keys = await request(store.index('reviewId').getAllKeys(reviewId));
  keys.forEach(key => store.delete(key));
  await done;
}
