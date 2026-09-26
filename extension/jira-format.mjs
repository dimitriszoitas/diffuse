import {commentDisplayTitle} from './review-store.mjs';
import {CATEGORY_LABELS, commentIsAudit, evidenceImages, evidenceVideo, fileStem, safePageUrl} from './report-format.mjs';
import {commentViewportKey, viewportLabel} from './viewport-profile.mjs';

const SECTION_FIELDS = Object.freeze([
  ['comment', 'Current'], ['expected', 'Requested change'], ['component', 'Component'],
  ['state', 'State'], ['steps', 'Steps to reproduce'],
]);
const MEDIA_EXTENSIONS = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/webm': 'webm', 'video/mp4': 'mp4',
});
const SEVERITY_LABELS = Object.freeze({minor: 'Minor', major: 'Major', critical: 'Critical'});

function text(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
}

function summaryFor(comment, index) {
  const title = text(commentDisplayTitle(comment.fields, index)).replace(/\s+/g, ' ');
  if (title.length <= 255) return title;
  let shortened = '';
  for (const character of title) {
    if (shortened.length + character.length > 254) break;
    shortened += character;
  }
  return `${shortened.trimEnd()}…`;
}

function heading(label) {
  return {type: 'heading', attrs: {level: 3}, content: [{type: 'text', text: label}]};
}

function paragraph(value) {
  const content = [];
  value.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index) content.push({type: 'hardBreak'});
    if (line) content.push({type: 'text', text: line});
  });
  return {type: 'paragraph', content};
}

function pageUrl(value) {
  const safe = safePageUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  return url.username || url.password ? '' : safe;
}

function capturedUrl(comment, side, fallback) {
  const context = comment.context?.[side];
  // An invalid recorded URL must not silently become a different page's URL.
  return pageUrl(context && Object.hasOwn(context, 'url') ? context.url : fallback);
}

/** Pure Jira fields only: destination, assignee and required-field mapping belong to the caller. */
export function jiraIssueFields(comment = {}, review = {}, {index = 0} = {}) {
  const content = [];
  if (commentViewportKey(comment) !== 'unknown') content.push(heading('Viewport'), paragraph(viewportLabel(comment)));
  for (const [field, label] of SECTION_FIELDS) {
    const value = text(comment.fields?.[field]);
    if (value) content.push(heading(label), paragraph(value));
  }
  for (const [field, label, labels] of [['category', 'Category', CATEGORY_LABELS], ['severity', 'Severity', SEVERITY_LABELS]]) {
    const value = comment.fields?.[field];
    if (typeof value === 'string' && Object.hasOwn(labels, value)) content.push(heading(label), paragraph(labels[value]));
  }
  const links = [
    ['Page', capturedUrl(comment, 'production', review.productionUrl)],
    ...(!commentIsAudit(comment, review) ? [['Reference', capturedUrl(comment, 'prototype', review.prototypeUrl)]] : []),
  ];
  for (const [label, url] of links) {
    if (url) content.push(heading(label), {
      type: 'paragraph', content: [{type: 'text', text: url, marks: [{type: 'link', attrs: {href: url}}]}],
    });
  }
  if (!content.length) content.push(paragraph('Design review observation.'));
  return {summary: summaryFor(comment, index), description: {version: 1, type: 'doc', content}};
}

/** Separate upload inputs; binary media is never embedded in the issue's ADF description. */
export function jiraAttachments(comment = {}, review = {}, {index = 0} = {}) {
  const audit = commentIsAudit(comment, review);
  const candidates = evidenceImages(comment, index, {audit})
    .filter(image => !audit || image.side === 'production')
    .map(image => ({kind: 'screenshot', side: image.side, detail: image.kind, label: image.label, filename: image.filename, dataUrl: image.dataUrl}));
  const video = evidenceVideo(comment, index);
  if (video) candidates.push({kind: 'recording', label: 'Recording', filename: video.filename, dataUrl: video.dataUrl});
  const seenData = new Set();
  const seenNames = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (seenData.has(candidate.dataUrl)) continue;
    const match = /^data:([^;,]+)(?:;codecs=[a-zA-Z0-9., -]+)?;base64,([A-Za-z0-9+/]+={0,2})$/.exec(candidate.dataUrl);
    const extension = MEDIA_EXTENSIONS[match?.[1]];
    // Keep only complete base64 payloads; container decoding is the uploader's responsibility.
    if (!extension || match[2].length % 4 !== 0) continue;
    const stem = fileStem(candidate.filename.replace(/\.[a-z0-9]+$/i, ''));
    let filename = `${stem}.${extension}`;
    for (let suffix = 2; seenNames.has(filename.toLowerCase()); suffix += 1) filename = `${stem}-${suffix}.${extension}`;
    seenData.add(candidate.dataUrl);
    seenNames.add(filename.toLowerCase());
    result.push({...candidate, filename, mimeType: match[1]});
  }
  return result;
}
