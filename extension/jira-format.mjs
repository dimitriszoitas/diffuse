import {suggestedAiPrompt} from './ai-handoff.mjs';
import {commentDisplayTitle} from './review-store.mjs';
import {CATEGORY_LABELS, commentIsAudit, evidenceImages, evidenceVideo, fileStem, safePageUrl} from './report-format.mjs';
import {commentViewportKey, viewportLabel} from './viewport-profile.mjs';

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

function boundedTextNodes(value) {
  const nodes = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 32768, value.length);
    // ADF bounds each text node. Keep the complete prompt while avoiding a split
    // between the UTF-16 halves of a character such as an emoji.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    nodes.push({type: 'text', text: value.slice(start, end)});
    start = end;
  }
  return nodes;
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

function labeledRow(entries) {
  const content = [];
  entries.filter(([, value]) => value).forEach(([label, value], index) => {
    if (index) content.push({type: 'text', text: '  ·  '});
    content.push({type: 'text', text: `${label}: `, marks: [{type: 'strong'}]}, {type: 'text', text: value});
  });
  return {type: 'paragraph', content};
}

function reproductionSteps(value) {
  // A saved line is one step. Strip an existing list marker, without guessing steps
  // from punctuation or changing the author's explanation.
  return value.split(/\r\n|\r|\n/).map(line => line.trim().replace(/^(?:\d+[.)]\s+|[-*•]\s+)/, '')).filter(Boolean);
}

/** Pure Jira fields only: destination, assignee and required-field mapping belong to the caller. */
export function jiraIssueFields(comment = {}, review = {}, {index = 0} = {}) {
  const fields = comment.fields || {};
  const content = [];
  const current = text(fields.comment);
  const expected = text(fields.expected);
  if (current) content.push(heading('Current'), paragraph(current));
  if (expected) content.push({type: 'panel', attrs: {panelType: 'info'}, content: [heading('Change to'), paragraph(expected)]});
  const context = labeledRow([
    ['Component', text(fields.component)], ['State', text(fields.state)],
    ['Viewport', commentViewportKey(comment) === 'unknown' ? '' : viewportLabel(comment)],
    ['Category', Object.hasOwn(CATEGORY_LABELS, fields.category) ? CATEGORY_LABELS[fields.category] : ''],
    ['Severity', Object.hasOwn(SEVERITY_LABELS, fields.severity) ? SEVERITY_LABELS[fields.severity] : ''],
  ]);
  if (context.content.length) content.push(context);
  const steps = reproductionSteps(text(fields.steps));
  if (steps.length) content.push(heading('Steps to reproduce'), {type: 'orderedList', attrs: {order: 1},
    content: steps.map(step => ({type: 'listItem', content: [paragraph(step)]}))});
  const attachments = jiraAttachments(comment, review, {index});
  if (attachments.length) content.push(heading('Evidence'), paragraph('Open the attached files for the captured screens and interactions.'), {
    type: 'bulletList', content: attachments.map(file => ({type: 'listItem', content: [{type: 'paragraph', content: [
      {type: 'text', text: `${file.label} — `}, {type: 'text', text: file.filename, marks: [{type: 'code'}]},
    ]}]})),
  });
  const links = [
    ['Page', capturedUrl(comment, 'production', review.productionUrl)],
    ['Figma design reference', safePageUrl(comment.ai?.designReference?.url)],
    ...(!commentIsAudit(comment, review) ? [['Reference', capturedUrl(comment, 'prototype', review.prototypeUrl)]] : []),
  ].filter(([, url]) => url);
  if (links.length) {
    content.push(heading('Pages'));
    for (const [label, url] of links) content.push({type: 'paragraph', content: [
      {type: 'text', text: `${label}: `, marks: [{type: 'strong'}]},
      {type: 'text', text: url, marks: [{type: 'link', attrs: {href: url}}]},
    ]});
  }
  const prompt = suggestedAiPrompt(comment);
  if (prompt) content.push(heading('Suggested AI prompt'), {type: 'codeBlock', attrs: {language: 'text', wrap: true, hideLineNumbers: true}, content: boundedTextNodes(prompt)});
  if (!content.length) content.push(paragraph('Design review observation.'));
  return {summary: summaryFor(comment, index), description: {version: 1, type: 'doc', content}};
}

/** Separate upload inputs; binary media is never embedded in the issue's ADF description. */
export function jiraAttachments(comment = {}, review = {}, {index = 0} = {}) {
  const audit = commentIsAudit(comment, review);
  const candidates = evidenceImages(comment, index, {audit})
    .filter(image => !audit || image.side === 'production' || image.side.startsWith('designReference'))
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
