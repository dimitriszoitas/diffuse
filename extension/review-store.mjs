import {prepareImportedReview} from './review-transfer.mjs';
const DB_NAME = 'diffuse-reviews';
let database;

export function cleanFields(input = {}) {
  const fields = {};
  for (const [key, limit] of Object.entries({title: 180, comment: 8000, expected: 8000, component: 240, state: 240, steps: 8000})) {
    fields[key] = typeof input[key] === 'string' ? input[key].trim().slice(0, limit) : '';
  }
  fields.severity = ['minor', 'major', 'critical'].includes(input.severity) ? input.severity : 'minor';
  fields.category = ['design-mismatch', 'ux-issue', 'copy-change'].includes(input.category) ? input.category : 'design-mismatch';
  if (!fields.comment) throw new Error('Describe what needs to change.');
  if (!fields.state) throw new Error('Name the state you reviewed.');
  return fields;
}

export function commentDisplayTitle(fields = {}, index = 0) {
  fields = fields && typeof fields === 'object' ? fields : {};
  const explicit = typeof fields.title === 'string' ? fields.title.trim() : '';
  if (explicit) return explicit;
  const firstLine = typeof fields.comment === 'string' ? fields.comment.split(/\r?\n/).find((line) => line.trim()) || '' : '';
  const observation = firstLine.replace(/\s+/g, ' ').trim();
  if (!observation) return `Observation ${index + 1}`;
  const characters = Array.from(observation);
  if (characters.length <= 120) return observation;
  const excerpt = characters.slice(0, 119).join('');
  const lastSpace = excerpt.lastIndexOf(' ');
  return `${lastSpace >= 80 ? excerpt.slice(0, lastSpace) : excerpt}…`;
}

function request(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

function completion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the review.'));
    transaction.onabort = () => reject(transaction.error || new Error('The review was not saved.'));
  });
}

async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => {
      const result = opening.result;
      result.createObjectStore('reviews', {keyPath: 'id'});
      result.createObjectStore('comments', {keyPath: 'id'}).createIndex('reviewId', 'reviewId');
      result.createObjectStore('drafts', {keyPath: 'id'}).createIndex('createdAt', 'createdAt');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => { database = null; reject(opening.error); };
  });
  return database;
}

export async function putDraft(draft, review) {
  const connection = await db();
  const transaction = connection.transaction(['drafts', 'reviews'], 'readwrite');
  const done = completion(transaction);
  if (review) {
    const reviews = transaction.objectStore('reviews');
    const existing = await request(reviews.get(review.id));
    if (!existing) reviews.put({...review, count: 0});
  }
  transaction.objectStore('drafts').put(draft);
  await done;
  return draft;
}

export async function getDraft(id) {
  return request((await db()).transaction('drafts').objectStore('drafts').get(id));
}

export async function discardDraft(id) {
  const transaction = (await db()).transaction('drafts', 'readwrite');
  const done = completion(transaction);
  transaction.objectStore('drafts').delete(id);
  await done;
}

export async function addComment(draftId, input, {evidenceChoice} = {}) {
  if (evidenceChoice !== undefined && !['screenshot', 'video'].includes(evidenceChoice)) throw new Error('Choose screenshot or video evidence.');
  const fields = cleanFields(input);
  const transaction = (await db()).transaction(['drafts', 'comments', 'reviews'], 'readwrite');
  const done = completion(transaction);
  const drafts = transaction.objectStore('drafts');
  const draft = await request(drafts.get(draftId));
  if (!draft) { await done; throw new Error('This evidence draft is no longer available. Capture it again.'); }
  if (!draft.evidence?.production?.dataUrl) { await done; throw new Error('Capture a production screenshot before saving.'); }
  const reviews = transaction.objectStore('reviews');
  const review = await request(reviews.get(draft.reviewId));
  if (!review) { await done; throw new Error('This review was removed. Start another comparison.'); }
  const comment = {...draft, id: crypto.randomUUID(), fields, evidence: {...draft.evidence}, updatedAt: new Date().toISOString()};
  delete comment.composerFields;
  if (evidenceChoice === 'screenshot') {
    delete comment.evidence.video;
    delete comment.recordingId;
  }
  transaction.objectStore('comments').put(comment);
  drafts.delete(draft.id);
  review.count += 1;
  review.updatedAt = comment.updatedAt;
  reviews.put(review);
  await done;
  return {comment, review};
}

export async function listReviews() {
  const reviews = await request((await db()).transaction('reviews').objectStore('reviews').getAll());
  return reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getReview(id) {
  const transaction = (await db()).transaction(['reviews', 'comments']);
  const [review, comments] = await Promise.all([
    request(transaction.objectStore('reviews').get(id)),
    request(transaction.objectStore('comments').index('reviewId').getAll(id))
  ]);
  if (!review) throw new Error('This review is no longer available.');
  return {...review, comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || ((a.importOrder ?? Number.MAX_SAFE_INTEGER) - (b.importOrder ?? Number.MAX_SAFE_INTEGER)))};
}

export async function updateComment(reviewId, commentId, input) {
  const fields = cleanFields(input);
  const transaction = (await db()).transaction(['reviews', 'comments'], 'readwrite');
  const done = completion(transaction);
  const comments = transaction.objectStore('comments');
  const comment = await request(comments.get(commentId));
  if (!comment || comment.reviewId !== reviewId) { await done; throw new Error('This comment is no longer available.'); }
  const review = await request(transaction.objectStore('reviews').get(reviewId));
  comment.fields = fields;
  comment.updatedAt = new Date().toISOString();
  comments.put(comment);
  review.updatedAt = comment.updatedAt;
  transaction.objectStore('reviews').put(review);
  await done;
  return comment;
}

export function cleanPinOffset(offset) {
  if (!offset || typeof offset !== 'object' || Array.isArray(offset) ||
      !['x', 'y'].every(key => Object.hasOwn(offset, key) && Number.isFinite(offset[key]) && Math.abs(offset[key]) <= 100000)) {
    throw new Error('The comment position is invalid. Drag the comment again.');
  }
  return {x: offset.x, y: offset.y};
}

// A pin's display offset is separate from its captured element, geometry and
// evidence. Moving it must never rewrite what the reviewer originally saw.
export async function updateCommentPin(reviewId, commentId, offset) {
  const pinOffset = cleanPinOffset(offset);
  const transaction = (await db()).transaction(['reviews', 'comments'], 'readwrite');
  const done = completion(transaction);
  const comments = transaction.objectStore('comments');
  const comment = await request(comments.get(commentId));
  if (!comment || comment.reviewId !== reviewId) { await done; throw new Error('This comment is no longer available.'); }
  const reviews = transaction.objectStore('reviews');
  const review = await request(reviews.get(reviewId));
  if (!review) { await done; throw new Error('This review is no longer available.'); }
  comment.pinOffset = pinOffset;
  comment.updatedAt = new Date().toISOString();
  comments.put(comment);
  review.updatedAt = comment.updatedAt;
  reviews.put(review);
  await done;
  return comment;
}

export async function deleteComment(reviewId, commentId) {
  const transaction = (await db()).transaction(['reviews', 'comments'], 'readwrite');
  const done = completion(transaction);
  const comments = transaction.objectStore('comments');
  const comment = await request(comments.get(commentId));
  if (comment?.reviewId === reviewId) {
    comments.delete(commentId);
    const reviews = transaction.objectStore('reviews');
    const review = await request(reviews.get(reviewId));
    if (review) { review.count = Math.max(0, review.count - 1); review.updatedAt = new Date().toISOString(); reviews.put(review); }
  }
  await done;
}

export async function deleteReview(id) {
  const transaction = (await db()).transaction(['reviews', 'comments', 'drafts'], 'readwrite');
  const done = completion(transaction);
  transaction.objectStore('reviews').delete(id);
  const comments = transaction.objectStore('comments');
  for (const key of await request(comments.index('reviewId').getAllKeys(id))) comments.delete(key);
  const drafts = transaction.objectStore('drafts');
  const cursor = drafts.openCursor();
  cursor.onsuccess = () => { const item = cursor.result; if (item) { if (item.value.reviewId === id) item.delete(); item.continue(); } };
  await done;
}

export async function removeExpiredDrafts() {
  const transaction = (await db()).transaction('drafts', 'readwrite');
  const done = completion(transaction);
  const before = new Date(Date.now() - 86400000).toISOString();
  const cursor = transaction.objectStore('drafts').index('createdAt').openCursor(IDBKeyRange.upperBound(before));
  cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
  await done;
}

// A portable review is imported atomically under fresh IDs. add() deliberately
// refuses collisions instead of replacing any existing local review or comment.
export async function importReview(bundle) {
  const imported = prepareImportedReview(bundle);
  const transaction = (await db()).transaction(['reviews', 'comments'], 'readwrite');
  const done = completion(transaction);
  transaction.objectStore('reviews').add(imported.review);
  for (const comment of imported.comments) transaction.objectStore('comments').add(comment);
  await done;
  return imported;
}
