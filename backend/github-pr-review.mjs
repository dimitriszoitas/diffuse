// Mirrored PR model; sync with extension/pr-review.mjs before release.
/** Portable review identity and PR history. No account tokens or local browser handles belong here. */
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const own = (value, key) => Object.hasOwn(value, key);
const boundedText = (value, limit, label) => typeof value === 'string' && value.length <= limit ? value : fail(`${label} is invalid.`);
const date = (value, label) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fail(`${label} is invalid.`);
export const PR_VERIFICATION_STATUSES = Object.freeze(['ready-for-recheck', 'verified', 'still-present', 'needs-remap']);
export const PR_PROOF_STATUSES = Object.freeze(['ready-for-recheck', 'verified', 'still-present']);
export const PR_MAX_RECORDING_MS = 30000;
export const PR_MAX_VERIFICATIONS = 100;
export const PR_MAX_ATTACHMENTS = 50;

export function cleanPortableKey(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(value) ? value : fail('A portable review identifier is invalid.');
}

export function cleanCommitSha(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value.toLowerCase() : fail('Choose a complete commit SHA for this build.');
}

export function cleanPreviewUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) fail('Choose a valid HTTP or HTTPS preview URL.');
  let url;
  try { url = new URL(value); } catch { fail('Choose a valid HTTP or HTTPS preview URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Choose a valid HTTP or HTTPS preview URL.');
  const secret = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|session[_-]?id|jwt|auth[_-]?token)$/i;
  const keys = [...url.searchParams.keys()];
  const callback = url.searchParams.has('state') || /(?:^|\/)(?:oauth2?|callback|authorize|authorization)(?:\/|$)/i.test(url.pathname) || keys.some(key => /^(?:access[_-]?token|id[_-]?token|client[_-]?id|redirect[_-]?uri)$/i.test(key));
  for (const key of keys) if (secret.test(key) || (callback && /^(code|session)$/i.test(key))) url.searchParams.delete(key);
  if (/(?:^#|[?&])(?:access_token|refresh_token|id_token|api_key|client_secret|password|session_id|auth_token)=/i.test(url.hash)) url.hash = '';
  return url.href;
}

export function cleanPRContext(input) {
  if (!object(input) || typeof input.owner !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(input.owner) ||
      typeof input.repo !== 'string' || !/^[a-z\d_.-]{1,100}$/i.test(input.repo) || ['.', '..'].includes(input.repo) ||
      !Number.isSafeInteger(input.number) || input.number <= 0) fail('Choose a valid GitHub pull request.');
  const url = `https://github.com/${input.owner}/${input.repo}/pull/${input.number}`;
  if (input.url !== undefined && input.url !== url) fail('The pull request URL does not match its repository and number.');
  // A URL is a reviewer-selected association, not proof of the deployed commit.
  if (input.association !== undefined && input.association !== 'manual') fail('This preview needs an explicit build association.');
  const clean = {owner: input.owner, repo: input.repo, number: input.number, url, headSha: cleanCommitSha(input.headSha),
    previewUrl: cleanPreviewUrl(input.previewUrl), association: 'manual'};
  if (input.sourcePreviewUrl !== undefined) clean.sourcePreviewUrl = cleanPreviewUrl(input.sourcePreviewUrl);
  if (input.reviewedSha !== undefined) clean.reviewedSha = cleanCommitSha(input.reviewedSha);
  return clean;
}

export function ensurePortableIdentities(review, {uuid = () => crypto.randomUUID()} = {}) {
  if (!object(review) || !Array.isArray(review.comments)) fail('This review is no longer available.');
  const reviewKey = cleanPortableKey(review.reviewKey ?? uuid());
  const keys = new Set();
  const comments = review.comments.map(comment => {
    const findingKey = cleanPortableKey(comment.findingKey ?? uuid());
    if (keys.has(findingKey)) fail('This review contains duplicate finding identifiers.');
    keys.add(findingKey);
    return {...comment, findingKey};
  });
  return {...review, reviewKey, comments};
}

function cleanReviewer(value) {
  if (!object(value) || typeof value.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.login)) fail('Identify who checked this finding.');
  const result = {login: value.login};
  if (own(value, 'name')) result.name = boundedText(value.name, 200, 'Reviewer name');
  return result;
}

function cleanVerificationEvidence(value) {
  const invalid = () => fail('Attach a fresh PNG, JPEG or WebP screenshot, or a WebM or MP4 recording of up to 30 seconds.');
  if (!object(value) || typeof value.dataUrl !== 'string' || value.dataUrl.length > 32 * 1024 * 1024) invalid();
  const comma = value.dataUrl.indexOf(','), payload = value.dataUrl.slice(comma + 1);
  const media = /^data:((?:image\/(?:png|jpeg|webp))|(?:video\/(?:webm|mp4)(?:;codecs=[a-zA-Z0-9., _-]+)?));base64$/.exec(value.dataUrl.slice(0,comma));
  if (!media || !payload || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) invalid();
  const recording = media[1].startsWith('video/');
  if (value.kind !== undefined && value.kind !== (recording?'recording':'screenshot')) invalid();
  if (value.mimeType !== undefined && value.mimeType !== media[1]) invalid();
  if (!['width', 'height'].every(key => Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 50000)) fail('The evidence dimensions are invalid.');
  const result = {dataUrl:value.dataUrl,width:value.width,height:value.height,capturedAt:date(value.capturedAt,'Evidence capture date'),pageUrl:cleanPreviewUrl(value.pageUrl)};
  if (recording) {
    if (!Number.isInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > PR_MAX_RECORDING_MS) fail('Record up to 30 seconds of the updated behavior.');
    result.kind='recording';result.mimeType=media[1];result.durationMs=value.durationMs;
  } else {
    if (value.durationMs !== undefined) invalid();
    if (value.kind !== undefined) result.kind='screenshot';
    if (value.mimeType !== undefined) result.mimeType=media[1];
  }
  return result;
}

/** Import validation: history is data, never a fresh claim of authenticated identity. */
export function cleanVerification(value) {
  if (!object(value) || !PR_VERIFICATION_STATUSES.includes(value.status)) fail('Choose a valid finding status.');
  const result = {id: cleanPortableKey(value.id), buildSha: cleanCommitSha(value.buildSha), previewUrl: cleanPreviewUrl(value.previewUrl),
    status: value.status, reviewer: cleanReviewer(value.reviewer), checkedAt: date(value.checkedAt, 'Verification date'),
    note: boundedText(value.note ?? '', 8000, 'Verification note')};
  if (value.evidence !== undefined) result.evidence = cleanVerificationEvidence(value.evidence);
  if (result.status === 'verified' && !result.evidence) fail('Attach fresh screenshot or recording evidence before marking this finding verified.');
  if (result.evidence && new URL(result.evidence.pageUrl).origin !== new URL(result.previewUrl).origin) fail('Verification evidence must come from the chosen preview.');
  if (result.evidence && Date.parse(result.evidence.capturedAt) > Date.parse(result.checkedAt) + 5000) fail('The evidence cannot be captured after its verification.');
  return result;
}

export function cleanVerificationHistory(value) {
  if (!Array.isArray(value) || value.length > PR_MAX_VERIFICATIONS) fail('This finding has too many verification records.');
  const records = value.map(cleanVerification);
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail('This finding contains duplicate verification records.');
    ids.add(record.id);
  }
  return records;
}

/** Only same-origin production routes move. Cross-origin and reference URLs stay untouched. */
export function mapPreviewUrl(recordedUrl, sourcePreviewUrl, previewUrl) {
  const original = new URL(cleanPreviewUrl(recordedUrl));
  const source = new URL(cleanPreviewUrl(sourcePreviewUrl));
  const target = new URL(cleanPreviewUrl(previewUrl));
  if (original.origin !== source.origin) return original.href;
  return `${target.origin}${original.pathname}${original.search}${original.hash}`;
}

export function cleanPRAttachmentMetadata(value) {
  if (!object(value)) fail('The preview attachment is invalid.');
  return {buildSha:cleanCommitSha(value.buildSha),previewUrl:cleanPreviewUrl(value.previewUrl),updatedAt:date(value.updatedAt,'Attachment date')};
}

export function validatePRAttachmentLocation(attachment, comment, sourcePreviewUrl) {
  const original=comment.context?.production;
  const selected=attachment.selection?.context;
  const mapped=mapPreviewUrl(original?.url,comment.prSourcePreviewUrl || sourcePreviewUrl || original?.url,attachment.previewUrl);
  if (!selected?.url || cleanPreviewUrl(selected.url)!==mapped || new URL(mapped).origin!==new URL(attachment.previewUrl).origin) fail('Remap this finding on its page in the chosen preview.');
  const profile=original.viewportProfile?.key;
  if (profile && profile!=='unknown' && selected.viewportProfile?.key!==profile) fail('Remap this finding in its original viewport.');
  if (['preset','emulated'].includes(original.viewportProfile?.mode) &&
      ['width','height'].some(key=>original.viewport?.[key]!==selected.viewport?.[key])) fail('Restore the recorded viewport size before remapping this finding.');
  return attachment;
}

export function upsertPRAttachment(history, attachment) {
  if (!Array.isArray(history) || history.length>PR_MAX_ATTACHMENTS) fail('This finding has too many preview attachments.');
  const same=item=>item.buildSha===attachment.buildSha&&item.previewUrl===attachment.previewUrl;
  const result=history.filter(item=>!same(item));
  if(result.length>=PR_MAX_ATTACHMENTS)fail('This finding has reached its preview attachment limit.');
  return [...result,attachment];
}

export function projectReviewToPreview(review, input = review.prContext) {
  const context = cleanPRContext(input);
  const sourceUrl = context.sourcePreviewUrl || review.productionUrl;
  const map = value => { try { return mapPreviewUrl(value, sourceUrl, context.previewUrl); } catch { return value; } };
  const result = structuredClone(review);
  result.productionUrl = map(review.productionUrl);
  result.prContext = context;
  result.comments = result.comments.map(comment => {
    const original = comment.context?.production?.url;
    if (!original) return comment;
    const commentSource=comment.prSourcePreviewUrl || sourceUrl;
    const mapComment=value=>{try{return mapPreviewUrl(value,commentSource,context.previewUrl);}catch{return value;}};
    const attachment=comment.prAttachments?.find(item=>item.buildSha===context.headSha&&item.previewUrl===context.previewUrl);
    if(attachment) {
      try {
        validatePRAttachmentLocation(attachment,comment,sourceUrl);
        comment.pinSelection=structuredClone(attachment.selection);
        if(attachment.pinPoint)comment.pinPoint={...attachment.pinPoint};
        else delete comment.pinPoint;
        comment.pinOffset={x:0,y:0};
      } catch { /* Never move a live pin onto an unrelated or malformed stored page. */ }
    }
    if(mapComment(original)!==original) {
      comment.context.production.url = mapComment(original);
      for (const selection of [comment.selection, comment.pinSelection]) if (selection?.context?.url) selection.context.url = mapComment(selection.context.url);
    }
    return comment;
  });
  return result;
}

/** New records are append-only. The authenticated caller provides the reviewer identity. */
export function createVerification(input, {comment, context: suppliedContext, now = new Date().toISOString(), uuid = () => crypto.randomUUID()} = {}) {
  const context = cleanPRContext(suppliedContext);
  if (!object(comment)) fail('This finding is no longer available.');
  if (!object(input)) fail('Choose a valid finding status.');
  const history = cleanVerificationHistory(comment.verifications || []);
  if (history.length >= PR_MAX_VERIFICATIONS) fail('This finding has reached its verification history limit.');
  const checkedAt = date(now, 'Verification date');
  if (input.buildSha !== undefined && cleanCommitSha(input.buildSha) !== context.headSha) fail('This finding must be checked against the selected build.');
  const record = cleanVerification({...input, id: uuid(), buildSha: context.headSha, previewUrl: context.previewUrl, checkedAt});
  // Older shared files may contain a recipient's note-only status. Keep that
  // history readable, but require new proof for every new change or verdict.
  if (PR_PROOF_STATUSES.includes(record.status) && !record.evidence) fail('Attach a fresh screenshot or recording before saving this status.');
  if (record.evidence) {
    const source = comment.prSourcePreviewUrl || context.sourcePreviewUrl || comment.context?.production?.url;
    const expectedUrl = mapPreviewUrl(comment.context?.production?.url, source, context.previewUrl);
    if (record.evidence.pageUrl !== expectedUrl) fail('Capture evidence on this finding’s page in the chosen preview.');
    const captured = Date.parse(record.evidence.capturedAt);
    if (captured < Date.parse(checkedAt) - 5 * 60 * 1000 || captured <= Date.parse(comment.evidence?.production?.capturedAt || comment.createdAt || 0)) fail('Capture a fresh screenshot or recording before saving this status.');
  }
  if (history.some(item => item.id === record.id)) fail('A unique verification identifier could not be created.');
  return record;
}

export function findingStatus(comment, input) {
  const context = cleanPRContext(input);
  const history = cleanVerificationHistory(comment.verifications || []);
  const latest = history.at(-1);
  if (!latest || latest.buildSha !== context.headSha || latest.previewUrl !== context.previewUrl) return 'needs-recheck';
  return latest.status;
}

function mergeSharedFields(local, received, baseline) {
  // Older local reviews have no remote baseline, so their authored wording is
  // retained on the first refresh. Received copies start with a known baseline.
  if(!baseline)return {...local};
  const merged={};
  for(const key of new Set([...Object.keys(local||{}),...Object.keys(received||{})])) {
    const value=local?.[key]===baseline[key]?received?.[key]:local?.[key];
    if(value!==undefined)merged[key]=value;
  }
  return merged;
}

/** Shared status is authoritative; remote edits update untouched fields while
 * genuine local edits and all original captured evidence remain intact. */
export function mergePRReview(existing, incoming, {uuid = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const local = ensurePortableIdentities(existing, {uuid}), remote = ensurePortableIdentities(incoming, {uuid});
  if (local.reviewKey !== remote.reviewKey) fail('This shared review does not match the local review.');
  if(local.prContext&&remote.prContext&&cleanPRContext(local.prContext).url.toLowerCase()!==cleanPRContext(remote.prContext).url.toLowerCase())fail('This shared review belongs to a different pull request.');
  const byKey = new Map(remote.comments.map(item => [item.findingKey, item]));
  const comments = local.comments.map(item => {
    const received = byKey.get(item.findingKey);
    if (!received) return item;
    byKey.delete(item.findingKey);
    const attachments=new Map();
    for(const attachment of [...(received.prAttachments || []),...(item.prAttachments || [])])attachments.set(`${attachment.buildSha}:${attachment.previewUrl}`,attachment);
    if(attachments.size>PR_MAX_ATTACHMENTS)fail('This finding has too many preview attachments.');
    return {...item,fields:mergeSharedFields(item.fields,received.fields,item.prRemoteFields),prRemoteFields:{...received.fields}, verifications:cleanVerificationHistory(received.verifications || []),...(attachments.size?{prAttachments:[...attachments.values()]}:{})};
  });
  const ids = new Set([local.id, ...comments.map(item => item.id)]);
  for (const received of byKey.values()) {
    const id = uuid();
    if (typeof id !== 'string' || !id || ids.has(id)) fail('A unique finding identifier could not be created.');
    ids.add(id);
    comments.push({...received, id, reviewId:local.id,prRemoteFields:{...received.fields}});
  }
  const title=local.prRemoteTitle!==undefined&&local.title===local.prRemoteTitle?remote.title:local.title;
  const result = {...local,title,prRemoteTitle:remote.title, comments, count:comments.length, updatedAt:date(now, 'Review update date')};
  if (local.prContext || remote.prContext) result.prContext = cleanPRContext(local.prContext || remote.prContext);
  return result;
}

/** This link belongs only to the current profile and is excluded from portable bundles. */
export function cleanPRRemoteBinding(input) {
  if (!object(input) || typeof input.remoteReviewId !== 'string' || !/^[a-z\d_-]{4,200}$/i.test(input.remoteReviewId) ||
      typeof input.connectionId !== 'string' || !/^[a-z\d_-]{4,200}$/i.test(input.connectionId) ||
      !Number.isSafeInteger(input.remoteRevision) || input.remoteRevision < 1) fail('The shared review connection is invalid.');
  const result = {remoteReviewId:input.remoteReviewId, remoteRevision:input.remoteRevision, connectionId:input.connectionId};
  if (input.commentUrl !== undefined && input.commentUrl !== null && input.commentUrl !== '') {
    if (typeof input.commentUrl !== 'string' || !/^https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+\/(?:issues|pull)\/[1-9]\d*#issuecomment-\d+$/i.test(input.commentUrl)) fail('The shared PR comment URL is invalid.');
    result.commentUrl = input.commentUrl;
  }
  return result;
}
