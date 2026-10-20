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
export async function putJourney(run) {
  const transaction = (await db()).transaction('runs', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('runs');
  store.put(run);
  const all = await request(store.getAll());
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let bytes = 0;
  for (let index = 0; index < all.length; index++) {
    bytes += JSON.stringify(all[index]).length;
    if (all[index].id !== run.id && (index >= 10 || bytes > 80 * 1024 * 1024)) store.delete(all[index].id);
  }
  await done;
  return run;
}
export async function listJourneys(reviewId) {
  const all = await request((await db()).transaction('runs').objectStore('runs').index('reviewId').getAll(reviewId));
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({id, goal, status, createdAt, updatedAt}) => ({id, goal, status, createdAt, updatedAt}));
}
export async function deleteJourneys(reviewId) {
  const transaction = (await db()).transaction('runs', 'readwrite');
  const done = complete(transaction);
  const store = transaction.objectStore('runs');
  const keys = await request(store.index('reviewId').getAllKeys(reviewId));
  keys.forEach(key => store.delete(key));
  await done;
}
