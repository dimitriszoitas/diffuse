import {commentDisplayTitle} from './review-store.mjs';
import {commentViewportKey, viewportLabel} from './viewport-profile.mjs';

const FIELD_LABELS = Object.freeze({comment: 'Current', expected: 'Change to', component: 'Component', state: 'State', steps: 'Steps to reproduce'});
export const CATEGORY_LABELS = Object.freeze({'design-mismatch': 'Design mismatch', 'ux-issue': 'UX issue', 'copy-change': 'Copy change'});
export const categoryKey = (category) => Object.hasOwn(CATEGORY_LABELS, category) ? category : 'design-mismatch';
export const categoryLabel = (category) => CATEGORY_LABELS[categoryKey(category)];
export const CATEGORY_PALETTE = Object.freeze({
  'design-mismatch': Object.freeze({background: '#c9adff', color: '#38205d'}),
  'ux-issue': Object.freeze({background: '#ffd28a', color: '#5e3908'}),
  'copy-change': Object.freeze({background: '#9bd5ff', color: '#123f60'}),
});

export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

export function safePageUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

/** Display-only local capture context. Never use this value as a URL or fetch target. */
export function localFilePath(value) {
  if (typeof value !== 'string' || !/^file:\/\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname || url.username || url.password) return '';
    const path = decodeURIComponent(url.pathname);
    return path && !/[\u0000-\u001f\u007f]/.test(path) ? path : '';
  } catch { return ''; }
}

function pageLocationText(value) {
  if (safePageUrl(value)) return value;
  const path = localFilePath(value);
  return path ? `Local file: ${path}` : String(value ?? '');
}

export function safeMediaUrl(value, kind = 'image') {
  if (typeof value !== 'string' || !['image', 'video'].includes(kind)) return '';
  const types = kind === 'video' ? '(?:webm|mp4)' : '(?:png|jpeg|webp|gif)';
  const pattern = new RegExp(`^data:${kind}/${types}(?:;codecs=[a-zA-Z0-9., -]+)?;base64,[A-Za-z0-9+/]+={0,2}$`);
  return pattern.test(value) ? value : '';
}

export function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function reviewTitle(review = {}) {
  return String(review.title || (review.mode === 'audit' ? 'Untitled design audit' : 'Untitled design review'));
}

export function commentTitle(comment = {}, index = 0) {
  return commentDisplayTitle(comment.fields, index);
}

export function commentIsAudit(comment = {}, review = {}) {
  if (comment.mode === 'audit') return true;
  if (comment.mode === 'comparison' || comment.evidence?.prototype?.dataUrl || comment.context?.prototype?.url) return false;
  return review.mode === 'audit';
}

export function reviewIsAudit(review = {}) {
  return review.comments?.length ? review.comments.every(comment => commentIsAudit(comment, review)) : review.mode === 'audit';
}

function referenceUrls(review, comments) {
  const urls = [...new Set(comments.filter(comment => !commentIsAudit(comment, review)).map(comment => comment.context?.prototype?.url).filter(Boolean))];
  return urls.length ? urls : !reviewIsAudit(review) && review.prototypeUrl ? [review.prototypeUrl] : [];
}

export function fileStem(value = 'Diffuse review') {
  return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'diffuse-review';
}

export function evidenceImages(comment = {}, index = 0, {audit = comment.mode === 'audit'} = {}) {
  const result = [];
  const crops = [];
  for (const side of ['production', 'prototype']) {
    const evidence = comment.evidence?.[side];
    if (!evidence) continue;
    const original = safeMediaUrl(evidence.dataUrl);
    const annotated = safeMediaUrl(evidence.annotatedDataUrl);
    const crop = safeMediaUrl(evidence.cropDataUrl);
    const label = side === 'production' ? (audit ? 'Page' : 'Production') : 'Prototype';
    const selectionLabel = comment.selection?.kind === 'region' ? 'selected region highlighted' : 'selected element highlighted';
    if (original || annotated) result.push({
      side, kind: 'full', label: `${label}${annotated ? ` · ${selectionLabel}` : ''}`,
      dataUrl: annotated || original, originalDataUrl: original,
      filename: `${fileStem(commentTitle(comment, index))}-${side}.png`,
      width: evidence.width, height: evidence.height, capturedAt: evidence.capturedAt,
    });
    if (crop) crops.push({
      side, kind: 'crop', label: `${label} · focused detail`, dataUrl: crop,
      width: evidence.crop?.width, height: evidence.crop?.height,
      displayWidth: Number.isFinite(evidence.crop?.width) && evidence.crop.width > 0 && Number.isFinite(evidence.width) && evidence.width > 0 && Number.isFinite(comment.context?.[side]?.viewport?.width)
        ? Math.round(evidence.crop.width * comment.context[side].viewport.width / evidence.width * 2) : undefined,
      filename: `${fileStem(commentTitle(comment, index))}-${side}-detail.png`, capturedAt: evidence.capturedAt,
    });
  }
  return [...result, ...crops];
}

// Derive a view-only crop only from geometry saved with the original capture.
// Prototype coordinates are independent; production bounds never stand in for them.
export function recordedFocusCrop(comment = {}, side = 'production') {
  if (side !== 'production') return null;
  const evidence = comment.evidence?.production;
  const rect = comment.selection?.rect?.viewport;
  const viewport = comment.context?.production?.viewport || comment.selection?.context?.viewport;
  if (!safeMediaUrl(evidence?.dataUrl) || !rect || !viewport) return null;
  const values = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, evidence.width, evidence.height];
  if (!values.every(Number.isFinite) || values.slice(2).some(value => value <= 0)) return null;
  const sx = evidence.width / viewport.width, sy = evidence.height / viewport.height;
  const left = Math.max(0, rect.x * sx), top = Math.max(0, rect.y * sy);
  const right = Math.min(evidence.width, (rect.x + rect.width) * sx), bottom = Math.min(evidence.height, (rect.y + rect.height) * sy);
  if (right <= left || bottom <= top) return null;
  const padding = 24 * Math.max(sx, sy);
  const x = Math.max(0, Math.floor(left - padding)), y = Math.max(0, Math.floor(top - padding));
  return {x, y, width: Math.min(evidence.width, Math.ceil(right + padding)) - x, height: Math.min(evidence.height, Math.ceil(bottom + padding)) - y};
}

export function evidenceVideo(comment = {}, index = 0) {
  const video = comment.evidence?.video;
  const dataUrl = safeMediaUrl(video?.dataUrl, 'video');
  if (!dataUrl) return null;
  const extension = dataUrl.startsWith('data:video/mp4;') ? 'mp4' : 'webm';
  const rawName = String(video.filename || `${fileStem(commentTitle(comment, index))}-recording.${extension}`);
  const filename = `${fileStem(rawName.replace(/\.(webm|mp4)$/i, ''))}.${extension}`;
  return {...video, dataUrl, filename};
}

export function metadataRows(comment = {}) {
  const rows = [];
  const seen = new WeakSet();
  const visit = (value, path, depth = 0) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'object') {
      rows.push([path, /(?:^|\.)url$/.test(path) ? pageLocationText(value) : String(value)]);
      return;
    }
    if (seen.has(value)) { rows.push([path, '[Repeated object]']); return; }
    if (depth > 8) { rows.push([path, '[Additional nested metadata]']); return; }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else {
      for (const [key, item] of Object.entries(value)) {
        // Never expose embedded binary media in the engineering metadata table.
        if (/^(dataUrl|annotatedDataUrl|cropDataUrl)$/i.test(key) || /api.?key|authorization|password|secret|token|cookie|headers/i.test(key)) continue;
        visit(item, path ? `${path}.${key}` : key, depth + 1);
      }
    }
    seen.delete(value);
  };
  if (comment.selection?.kind === 'region') {
    const selection = comment.selection;
    visit({kind: 'region', rect: selection.rect, coordinateSpace: selection.coordinateSpace, source: selection.source, context: selection.context}, 'region');
  } else visit(comment.selection, 'element');
  visit(comment.context, 'context');
  for (const [key, value] of aiMetadataRows(comment.ai)) rows.push([key, value]);
  if (Number.isFinite(comment.evidence?.captureSkewMs)) rows.push(['capture.skewMs', String(comment.evidence.captureSkewMs)]);
  for (const side of ['production', 'prototype']) {
    const evidence = comment.evidence?.[side];
    if (evidence?.capturedAt) rows.push([`capture.${side}.time`, formatDate(evidence.capturedAt)]);
    if (Number.isFinite(evidence?.width) && Number.isFinite(evidence?.height)) rows.push([`capture.${side}.pixels`, `${evidence.width} × ${evidence.height}`]);
  }
  if (comment.evidence?.video) {
    const video = comment.evidence.video;
    if (video.kind) rows.push(['capture.recording.kind', String(video.kind)]);
    if (video.startedAt) rows.push(['capture.recording.startedAt', formatDate(video.startedAt)]);
    if (video.stoppedAt) rows.push(['capture.recording.stoppedAt', formatDate(video.stoppedAt)]);
    if (Number.isFinite(video.durationMs)) rows.push(['capture.recording.durationMs', String(video.durationMs)]);
  }
  return rows;
}

export function aiMetadataRows(ai) {
  if (!ai || typeof ai !== 'object') return [];
  const rows = [];
  for (const key of ['provider', 'model', 'runId', 'suggestionId', 'reason', 'acceptedAt', 'mode']) {
    const value = ai[key];
    if (typeof value === 'string' && value) rows.push([`ai.${key}`, key === 'acceptedAt' ? formatDate(value) : value]);
  }
  if (Number.isFinite(ai.mismatchScore) && ai.mismatchScore >= 0 && ai.mismatchScore <= 100) rows.push(['ai.estimatedDifferenceScore', `${ai.mismatchScore}/100 (AI estimate, not pixel accuracy)`]);
  if (Number.isFinite(ai.confidence) && ai.confidence >= 0 && ai.confidence <= 1) rows.push(['ai.confidence', String(ai.confidence)]);
  if (typeof ai.acceptedAt === 'string' && ai.acceptedAt) rows.push(['ai.reviewStatus', 'Accepted by the reviewer']);
  return rows;
}

function pageLink(value, clipboard = false) {
  const safe = safePageUrl(value);
  return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"${clipboard ? ' style="color:#6941C6;overflow-wrap:anywhere"' : ''}>${escapeHtml(value)}</a>` : `<span>${escapeHtml(pageLocationText(value) || 'Not recorded')}</span>`;
}

function textBlock(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function durationLabel(value) {
  return Number.isFinite(value) ? ` · ${(value / 1000).toFixed(1)} seconds` : '';
}

function inline(clipboard, styles) {
  return clipboard ? ` style="${styles}"` : '';
}

function reproductionSteps(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^(?:\d+[.)]|[-•])\s+/, ''));
}

export function formatCommentHtml(comment = {}, index = 0, {clipboard = false, audit = comment.mode === 'audit'} = {}) {
  const fields = comment.fields || {};
  const images = evidenceImages(comment, index, {audit});
  const video = evidenceVideo(comment, index);
  const rows = metadataRows(comment);
  const category = categoryKey(fields.category);
  const palette = CATEGORY_PALETTE[category];
  const badge = `<span class="category-label" data-category="${category}" style="background-color:${palette.background};color:${palette.color};border:1px solid ${palette.color};border-radius:6px;padding:5px 10px;font-size:14px;font-weight:600;display:inline-block">${escapeHtml(categoryLabel(category))}</span>`;
  const narrative = ['comment', 'expected'].filter((key) => fields[key]).map((key) => `<section class="field ${key === 'expected' ? 'requested-change' : 'observation'}"${inline(clipboard, key === 'expected' ? 'padding:18px 20px;margin:20px 0;background:#FFF0EB;border-left:4px solid #EF785C;border-radius:8px;color:#211A35' : 'margin:24px 0')}><h3${inline(clipboard, 'font-size:16px;line-height:1.5;margin:0 0 8px;color:#211A35')}>${FIELD_LABELS[key]}</h3><p${inline(clipboard, 'font-size:16px;line-height:1.65;margin:0;max-width:72ch')}>${textBlock(fields[key])}</p></section>`).join('');
  const componentState = ['component', 'state'].filter((key) => fields[key]).map((key) => `<div${inline(clipboard, 'display:inline-block;vertical-align:top;margin:0 28px 12px 0;max-width:100%')}><dt${inline(clipboard, 'font-size:14px;color:#625870;margin-bottom:3px')}>${FIELD_LABELS[key]}</dt><dd${inline(clipboard, 'margin:0;font-size:16px;font-weight:600')}>${textBlock(fields[key])}</dd></div>`).join('');
  const steps = reproductionSteps(fields.steps);
  const reproduction = steps.length ? `<section class="reproduction"><h3${inline(clipboard, 'font-size:16px;margin:24px 0 8px')}>Steps to reproduce</h3><ol${inline(clipboard, 'padding-left:24px;font-size:16px;line-height:1.65')}>${steps.map((step) => `<li>${textBlock(step)}</li>`).join('')}</ol></section>` : '';
  const imageHtml = (item, imageIndex) => `<figure class="evidence-image${item.kind === 'crop' ? ' selected-detail' : ''}" data-image-index="${imageIndex}"${inline(clipboard, 'margin:16px 0 24px;max-width:100%;break-inside:avoid')}><figcaption${inline(clipboard, 'font-size:16px;font-weight:600;color:#211A35;margin-bottom:10px')}>${escapeHtml(item.label)}</figcaption><div class="image-surface"><img src="${item.dataUrl}" alt="${escapeHtml(`${item.label}: ${commentTitle(comment, index)}`)}" style="${item.kind === 'crop' ? `width:${Math.max(1, item.displayWidth || 720)}px;` : ''}max-width:100%;height:auto${clipboard ? ';display:block;border:1px solid #8A7B9B;border-radius:8px' : ''}" loading="lazy"></div>${item.capturedAt ? `<p class="capture-time"${inline(clipboard, 'font-size:14px;color:#625870;margin:8px 0')}>Captured ${escapeHtml(formatDate(item.capturedAt))}</p>` : ''}</figure>`;
  const crops = images.map((item, imageIndex) => ({item, imageIndex})).filter(({item}) => item.kind === 'crop');
  const full = images.map((item, imageIndex) => ({item, imageIndex})).filter(({item}) => item.kind === 'full');
  const renderImageGroup = (group, className = '') => clipboard && group.length > 1
    ? `<table class="evidence-grid ${className}" role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse"><tbody><tr>${group.map(({item, imageIndex}) => `<td style="width:${100 / group.length}%;vertical-align:top;padding:0 8px">${imageHtml(item, imageIndex)}</td>`).join('')}</tr></tbody></table>`
    : `<div class="evidence-grid ${className}">${group.map(({item, imageIndex}) => imageHtml(item, imageIndex)).join('')}</div>`;
  const hasReferenceDetail = crops.some(({item}) => item.side === 'prototype');
  const detailNote = crops.length && !audit && full.some(({item}) => item.side === 'prototype') && !hasReferenceDetail
    ? '<p class="evidence-limit-note">A prototype close-up was not recorded. Expand Full screenshots to inspect the reference.</p>' : '';
  const cropEvidence = crops.length ? `<section class="evidence-section selected-evidence"><h3${inline(clipboard, 'font-size:20px;margin:28px 0 6px;color:#211A35')}>Focused evidence</h3><p class="section-description"${inline(clipboard, 'font-size:14px;color:#625870;margin:0 0 14px')}>${hasReferenceDetail ? 'The recorded issue area on each page. Compare the current result with its reference.' : 'The recorded area attached to this observation.'}</p>${renderImageGroup(crops, 'detail-grid')}${detailNote}</section>` : `<p class="evidence-limit-note">No focused area was recorded for this observation.</p>`;
  const fullEvidence = full.length ? (clipboard
    ? `<section class="evidence-section full-evidence"><h3 style="font-size:20px;margin:28px 0 6px;color:#211A35">Full screenshots · context</h3>${renderImageGroup(full)}</section>`
    : `<details class="evidence-section full-evidence"><summary>Full screenshots <span>· ${full.length} captured ${full.length === 1 ? 'page' : 'pages'}</span></summary><p class="section-description">Use these images for surrounding context. The focused evidence above shows the issue at a larger size.</p>${renderImageGroup(full)}</details>`) : '';
  const poster = images.find((item) => item.side === 'production' && item.kind === 'full') || images[0];
  const recordingDescription = audit ? 'The page as visible during recording, without audio. The original screenshot and selection remain the reference for this observation.' : 'Production as visible during recording, including the live reference and comparison controls, without audio. The original screenshots and selection remain the reference for this observation.';
  const clip = video ? `<section class="video-evidence"><h3${inline(clipboard, 'font-size:20px;margin:28px 0 6px')}>${audit ? 'Page recording' : video.kind === 'comparison-recording' ? 'Live comparison recording' : 'Screen recording'}</h3><p class="section-description"${inline(clipboard, 'font-size:14px;color:#625870')}>${recordingDescription}</p>${clipboard
    ? `<p><strong>${escapeHtml(video.filename)}</strong>${durationLabel(video.durationMs)}</p><p${inline(clipboard, 'font-size:14px;color:#625870')}>The screenshots above are the recording’s visual reference. Playable video is included in the downloaded HTML report; arbitrary documents do not preserve playable video when pasted.</p>`
    : `<video controls preload="metadata"${poster ? ` poster="${poster.dataUrl}"` : ''} src="${video.dataUrl}" style="max-width:100%">Your viewer does not support this recording.</video><p class="capture-time">${escapeHtml(video.filename)}${durationLabel(video.durationMs)}</p>`}</section>` : '';
  const region = comment.selection?.kind === 'region';
  const metadataNote = region ? 'This is a selected image region. Its bounds are recorded; no component identity or DOM measurements are inferred from the image.' : 'Captured DOM hints and observed state. Component names inferred from DOM are not verified framework source mappings.';
  const context = rows.length ? `<details class="engineering-context"${inline(clipboard, 'margin-top:24px;padding-top:16px;border-top:1px solid #8A7B9B')}><summary${inline(clipboard, 'font-size:14px;font-weight:600;color:#6941C6;padding:12px 0')}>Technical details <span class="context-count">· ${rows.length} captured values</span></summary><p class="metadata-note"${inline(clipboard, 'font-size:14px;color:#625870')}>${metadataNote}</p><table${inline(clipboard, 'border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px')}><tbody>${rows.map(([key, value]) => `<tr><th scope="row"${inline(clipboard, 'width:38%;text-align:left;vertical-align:top;padding:10px 8px;border-bottom:1px solid #DDD4EA;overflow-wrap:anywhere;color:#625870')}>${escapeHtml(key)}</th><td${inline(clipboard, 'vertical-align:top;padding:10px 8px;border-bottom:1px solid #DDD4EA;overflow-wrap:anywhere')}>${textBlock(value)}</td></tr>`).join('')}</tbody></table></details>` : '';
  const capturedReference = !audit && pageLocationText(comment.context?.prototype?.url) ? `<p class="capture-reference"${inline(clipboard, 'font-size:14px;color:#625870;margin-top:18px')}>Reference for this observation: ${pageLink(comment.context.prototype.url, clipboard)}</p>` : '';
  const aiSummary = comment.ai?.acceptedAt ? `<p class="ai-provenance"${inline(clipboard, 'font-size:14px;color:#625870;margin-top:24px')}>AI suggestion · accepted by the reviewer. Scores in technical details are AI estimates, not pixel-accuracy measurements.</p>` : '';
  return `<article class="comment-card" id="issue-${index + 1}" data-comment-id="${escapeHtml(comment.id || '')}" data-category="${category}" data-viewport="${commentViewportKey(comment)}"${inline(clipboard, 'padding:28px 0;margin:28px 0;border-top:2px solid #6941C6;color:#211A35;font-size:16px;line-height:1.65')}><header class="comment-heading"><span class="issue-number"${inline(clipboard, 'display:inline-block;color:#6941C6;font-size:20px;font-weight:700;margin:0 0 12px')}>${String(index + 1).padStart(2, '0')}</span><div class="issue-heading-content"><div class="issue-labels">${badge}<span class="viewport-label">${escapeHtml(viewportLabel(comment))}</span>${fields.severity ? `<span class="severity"${inline(clipboard, 'font-size:14px;color:#625870;margin-left:10px')}>${escapeHtml(fields.severity)}</span>` : ''}</div><h2${inline(clipboard, 'font-size:26px;line-height:1.3;color:#211A35;margin:14px 0 8px')}>${escapeHtml(commentTitle(comment, index))}</h2><p class="comment-kicker"${inline(clipboard, 'font-size:14px;color:#625870;margin:0')}>Recorded ${escapeHtml(formatDate(comment.createdAt))}</p></div></header><div class="comment-fields">${narrative}${!fields.expected ? '<p class="missing-change">No requested change was recorded. The original observation is preserved.</p>' : ''}${typeof comment.ai?.reason === 'string' && comment.ai.reason ? `<section class="field reasoning"><h3>Why this change</h3><p>${textBlock(comment.ai.reason)}</p></section>` : ''}</div>${capturedReference}${componentState ? `<dl class="issue-context"${inline(clipboard, 'padding:16px 0;margin:0')}>${componentState}</dl>` : ''}${reproduction}${cropEvidence}${fullEvidence}${!images.length ? '<p class="missing-evidence">No screenshot evidence was recorded for this observation.</p>' : ''}${clip}${aiSummary}${context}</article>`;
}

export function formatReviewHtml(review = {}, options = {}) {
  const comments = Array.isArray(review.comments) ? review.comments : [];
  const audit = reviewIsAudit(review);
  const clipboard = options.clipboard;
  const prototypes = referenceUrls(review, comments);
  const prototypeUrl = prototypes.length === 1 ? prototypes[0] : '';
  const paired = !audit && comments.some((comment) => safeMediaUrl(comment.evidence?.production?.dataUrl) && safeMediaUrl(comment.evidence?.prototype?.dataUrl));
  const note = paired ? 'Production and prototype are captured separately. Timing and the selected area are recorded in each issue’s technical details.' : 'Each observation includes its recorded page and state. Capture timing and the selected area are in technical details.';
  const counts = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((key) => [key, comments.filter((comment) => categoryKey(comment.fields?.category) === key).length]));
  const categories = [['all', 'All observations', comments.length], ...Object.entries(counts).filter(([, count]) => count).map(([key, count]) => [key, categoryLabel(key), count])];
  const navigation = comments.length ? `<nav class="review-categories" aria-label="Observation categories"${inline(clipboard, 'margin:24px 0;line-height:2.7')}>${categories.map(([key, label, count]) => {
    const colors = key === 'all' ? {background: '#EEE7FA', color: '#38205d'} : CATEGORY_PALETTE[key];
    const first = key === 'all' ? 'review-issues' : `issue-${comments.findIndex((comment) => categoryKey(comment.fields?.category) === key) + 1}`;
    return `<a class="category-nav${key === 'all' ? ' active' : ''}" href="#${first}" data-category-filter="${key}"${inline(clipboard, `display:inline-block;margin:0 8px 8px 0;padding:5px 12px;border:1px solid ${colors.color};border-radius:8px;background:${colors.background};color:${colors.color};font-size:14px;text-decoration:none`)}><span class="category-dot" style="background:${colors.background};border-color:${colors.color}" aria-hidden="true"></span><span>${label}</span><strong>${count}</strong></a>`;
  }).join('')}</nav>` : '';
  return `<div class="diffuse-report"${inline(clipboard, 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:16px;line-height:1.65;color:#211A35;max-width:1080px')}><header class="report-heading"><p class="report-kicker"${inline(clipboard, 'font-size:14px;font-weight:700;color:#6941C6;letter-spacing:1px')}>DIFFUSE / ${audit ? 'DESIGN AUDIT' : 'DESIGN REVIEW'}</p><h1${inline(clipboard, 'font-size:36px;line-height:1.2;letter-spacing:-1px;margin:12px 0;color:#211A35')}>${escapeHtml(reviewTitle(review))}</h1><p class="review-summary"${inline(clipboard, 'font-size:16px;color:#625870')}><strong${inline(clipboard, 'color:#211A35')}>${comments.length} observation${comments.length === 1 ? '' : 's'}</strong><span class="summary-separator" aria-hidden="true"> · </span>Created ${escapeHtml(formatDate(review.createdAt))}</p><dl class="review-urls">${[[audit ? 'Page' : 'Production', review.productionUrl || comments[0]?.context?.production?.url], ...(!audit && prototypeUrl ? [['Prototype', prototypeUrl]] : [])].map(([label, url]) => `<div${inline(clipboard, 'padding:12px 0;max-width:100%')}><dt${inline(clipboard, 'font-size:14px;font-weight:700;color:#625870')}>${label}</dt><dd${inline(clipboard, 'margin:4px 0 0;font-size:16px;overflow-wrap:anywhere')}>${pageLink(url, clipboard)}</dd></div>`).join('')}</dl><p class="report-note"${inline(clipboard, 'font-size:14px;color:#625870;max-width:80ch')}>${note}</p>${navigation}</header><p class="filter-status" role="status" aria-live="polite" hidden></p><section class="review-issues" id="review-issues" aria-label="Review observations">${comments.map((comment, index) => formatCommentHtml(comment, index, {...options, audit: commentIsAudit(comment, review)})).join('') || '<p>No observations in this review yet.</p>'}</section><footer class="report-footer"${inline(clipboard, 'font-size:14px;color:#625870;margin:32px 0')}>Made with Diffuse. Evidence is embedded locally in this report.</footer></div>`;
}

// Shared by the review viewer and offline HTML, so readability stays consistent across both.
export const REPORT_STYLES = `
.diffuse-report{max-width:1120px;margin:auto;color:#211A35;font-size:16px;line-height:1.65;overflow-wrap:anywhere}
.diffuse-report *{box-sizing:border-box}.diffuse-report [hidden]{display:none!important}.diffuse-report a{color:#6941C6;text-underline-offset:3px}.diffuse-report a:focus-visible,.diffuse-report summary:focus-visible,.diffuse-report img:focus-visible{outline:3px solid #6941C6;outline-offset:4px}
.viewport-label{font-size:14px;color:#625870;border:1px solid #d8cfe5;border-radius:6px;padding:4px 8px}.report-heading{margin-bottom:20px}.report-kicker{font-size:14px;font-weight:700;letter-spacing:1.2px;color:#6941C6;margin:0 0 8px}.report-heading h1{font-size:30px;font-weight:720;line-height:1.25;letter-spacing:-.6px;margin:0 0 10px;max-width:38ch}.review-summary{font-size:16px;color:#625870;margin:0 0 16px}.review-summary strong{color:#211A35}.review-urls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0 12px}.review-urls>div{min-width:0;border:1px solid #D8CFE5;border-radius:12px;background:#FFFFFF;padding:12px 14px}.review-urls>div:only-child{grid-column:1/-1}.review-urls dt{font-size:14px;font-weight:650;color:#625870;margin-bottom:4px}.review-urls dd{margin:0;font-size:16px;line-height:1.5;overflow-wrap:anywhere}.report-note{font-size:14px;line-height:1.6;color:#625870;max-width:86ch;margin:0}.review-categories{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}.category-nav{display:inline-flex;align-items:center;justify-content:center;gap:9px;padding:8px 12px;min-height:44px;border:1px solid #8A7B9B;border-radius:9px;background:#FFFFFF;color:#211A35!important;font-size:14px;line-height:1.4;text-decoration:none;font-weight:600}.category-nav strong{min-width:24px;line-height:24px;text-align:center;background:#EEE7FA;border-radius:5px;font-size:14px}.category-nav.active{border-color:#6941C6;background:#EEE7FA;box-shadow:inset 0 0 0 1px #6941C6}.category-nav:hover{background:#EEE7FA}.category-dot{height:11px;width:11px;flex-shrink:0;border:1px solid;border-radius:3px}.filter-status{font-size:14px;color:#625870;margin:16px 0}.comment-card{background:#FFFFFF;border:1px solid #D8CFE5;border-radius:12px;padding:20px;margin:0 0 16px;box-shadow:0 3px 14px #211A3504;scroll-margin-top:24px;min-width:0;break-inside:avoid}.comment-heading{display:flex;align-items:flex-start;gap:12px}.issue-number{display:grid;place-items:center;flex:0 0 44px;width:44px;height:44px;border-radius:9px;background:#EEE7FA;color:#6941C6;font-size:18px;font-weight:750;letter-spacing:-.5px}.issue-heading-content{min-width:0;flex:1}.issue-labels{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin:1px 0 8px}.category-label{line-height:1.35}.severity{font-size:14px;text-transform:capitalize;color:#625870;padding:4px 9px;border:1px solid #8A7B9B;border-radius:6px;line-height:1.4}.comment-heading h2{font-size:22px;line-height:1.35;font-weight:700;letter-spacing:-.3px;margin:0 0 6px;max-width:45ch}.comment-kicker{font-size:14px;line-height:1.5;color:#625870;margin:0}.comment-fields{margin-top:16px}.field h3,.reproduction h3{font-size:16px;line-height:1.5;font-weight:700;margin:0 0 8px}.field p{font-size:16px;line-height:1.6;margin:0;max-width:75ch}.requested-change{margin-top:14px;padding:12px 16px;border-left:4px solid #EF785C;border-radius:0 10px 10px 0;background:#FFF0EB}.requested-change h3{color:#9D3524}.issue-context{display:flex;gap:12px 28px;flex-wrap:wrap;margin:16px 0 0;padding:12px 0;border-top:1px solid #E4DDEE;border-bottom:1px solid #E4DDEE}.issue-context>div{min-width:0;max-width:100%}.issue-context dt{font-size:14px;color:#625870;line-height:1.4;margin-bottom:4px}.issue-context dd{font-size:16px;font-weight:600;line-height:1.5;margin:0;max-width:65ch}.reproduction{margin-top:18px;max-width:76ch}.reproduction ol{padding-left:24px;margin:0;font-size:16px;line-height:1.65}.reproduction li+li{margin-top:6px}.reproduction li::marker{color:#6941C6;font-weight:600}.evidence-section,.video-evidence{margin-top:18px}.evidence-section h3,.video-evidence h3{font-size:20px;font-weight:700;line-height:1.4;letter-spacing:-.25px;margin:0 0 7px}.section-description{font-size:14px;line-height:1.6;color:#625870;margin:0 0 16px;max-width:82ch}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:12px}.evidence-image{margin:0;min-width:0}.evidence-image:only-child{grid-column:1/-1}.evidence-image figcaption{font-size:16px;font-weight:650;line-height:1.5;margin:0 0 10px}.image-surface{display:flex;align-items:center;justify-content:center;border:1px solid #8A7B9B;border-radius:10px;overflow:hidden;background:#F7F4FC}.evidence-image img{display:block;width:100%;max-width:100%;height:auto;object-fit:contain}.selected-detail .image-surface{min-height:140px;padding:12px;background:repeating-linear-gradient(45deg,#F7F4FC,#F7F4FC 10px,#F2ECFA 10px,#F2ECFA 20px)}.selected-detail img{width:100%;max-height:none;box-shadow:0 5px 20px #211A3518;border-radius:5px}.capture-time{font-size:14px;line-height:1.5;color:#625870;margin:9px 0;overflow-wrap:anywhere}.video-evidence video{display:block;width:100%;max-height:650px;border:1px solid #8A7B9B;border-radius:10px;background:#211A35}.ai-provenance{font-size:14px;line-height:1.6;color:#625870;margin:25px 0 0;max-width:84ch}.engineering-context{margin-top:16px;border-top:1px solid #D8CFE5}.engineering-context summary{font-size:14px;line-height:1.5;min-height:44px;padding:10px 0;font-weight:650;color:#6941C6;cursor:pointer}.context-count{font-weight:400;color:#625870}.metadata-note{font-size:14px;line-height:1.6;color:#625870;margin:0 0 16px;max-width:80ch}.engineering-context table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px;line-height:1.6}.engineering-context th,.engineering-context td{padding:11px 10px;border-bottom:1px solid #E4DDEE;text-align:left;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}.engineering-context th{width:38%;font-weight:500;color:#625870}.report-footer{font-size:14px;color:#625870;text-align:center;padding:10px 0 24px}.missing-evidence{font-size:16px;color:#625870;margin:24px 0}
.full-evidence{border:1px solid #D8CFE5;border-radius:12px;padding:0 14px;background:#FCFAFF}.full-evidence summary{cursor:pointer;min-height:44px;padding:10px 0;color:#6941C6;font-size:16px;font-weight:650}.full-evidence summary span{font-weight:400;color:#625870}.full-evidence[open]{padding-bottom:14px}.full-evidence>.section-description{margin-top:4px}.evidence-limit-note,.missing-change{font-size:14px;line-height:1.6;color:#625870;margin:16px 0 0}.reasoning{margin-top:20px}.reasoning h3{color:#625870}.detail-grid{align-items:start}.selected-detail .image-surface{padding:12px;min-height:140px}.requested-change p,.observation p{white-space:normal}.requested-change{border-left-width:4px}.comment-fields .field h3{text-transform:none;letter-spacing:0}
@media(max-width:640px){.report-heading h1{font-size:28px;letter-spacing:-.6px}.review-urls{grid-template-columns:1fr}.category-nav{flex:1 1 calc(50% - 10px);justify-content:flex-start;padding:10px}.category-nav strong{margin-left:auto}.comment-card{padding:16px;border-radius:12px}.comment-heading{gap:12px}.issue-number{flex-basis:40px;width:40px;height:40px;font-size:18px;border-radius:9px}.comment-heading h2{font-size:20px;letter-spacing:-.3px}.issue-labels{gap:6px}.evidence-grid{grid-template-columns:1fr}.requested-change{padding:16px}.selected-detail .image-surface{padding:14px}.engineering-context th,.engineering-context td{padding:9px 6px}.context-count{display:block}.review-summary .summary-separator{display:block;height:0;font-size:0}.review-summary strong{display:block;margin-bottom:5px}}
@media(max-width:360px){.comment-card{padding:16px 14px}.comment-heading{gap:10px}.issue-number{flex-basis:34px;width:34px;height:36px;font-size:16px}.comment-heading h2{font-size:20px}.category-nav{flex-basis:100%}.review-urls>div{padding:12px}.category-label{padding:5px 7px!important}.issue-context{gap:16px}}
@media print{.comment-card{break-inside:auto;box-shadow:none}.evidence-image{break-inside:avoid}.evidence-image img{max-height:75vh;object-fit:contain}.review-categories{display:none}.report-footer{margin-top:24px}}
`;

export const EXPORT_STYLES = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#F7F4FC;color:#211A35;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px 24px}${REPORT_STYLES}@media(max-width:640px){body{padding:28px 14px}}@media print{body{background:white;padding:0}}`;

export function formatStandaloneHtml(review = {}) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(reviewTitle(review))} — Diffuse</title><style>${EXPORT_STYLES}</style></head><body>${formatReviewHtml(review)}</body></html>`;
}

function markdownText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
}

export function formatMarkdown(review = {}, {embedMedia = true} = {}) {
  const comments = Array.isArray(review.comments) ? review.comments : [];
  const audit = reviewIsAudit(review);
  const prototypes = referenceUrls(review, comments);
  const prototypeUrl = prototypes.length === 1 ? prototypes[0] : '';
  const lines = [`# ${markdownText(reviewTitle(review))}`, '', audit ? 'Diffuse design audit' : 'Diffuse design review', '', `**${comments.length} observation${comments.length === 1 ? '' : 's'}** · Created ${markdownText(formatDate(review.createdAt))}`, '', `${audit ? 'Page' : 'Production'}: ${markdownText(pageLocationText(review.productionUrl || comments[0]?.context?.production?.url) || 'Not recorded')}`, ...(!audit && pageLocationText(prototypeUrl) ? [`Prototype: ${markdownText(pageLocationText(prototypeUrl))}`] : []), ''];
  const counts = Object.keys(CATEGORY_LABELS).map((category) => [category, comments.filter((comment) => categoryKey(comment.fields?.category) === category).length]).filter(([, count]) => count);
  if (counts.length) lines.push(counts.map(([category, count]) => `${categoryLabel(category)}: ${count}`).join(' · '), '');
  if (embedMedia) lines.push('Screenshots are embedded as data URLs. Markdown viewers vary in support; use the HTML report for reliable images and playable video.', '');
  comments.forEach((comment, index) => {
    const fields = comment.fields || {};
    const commentAudit = commentIsAudit(comment, review);
    lines.push(`## ${index + 1}. ${markdownText(commentTitle(comment, index))}`, '', `Category: ${categoryLabel(fields.category)}${fields.severity ? ` · Severity: ${markdownText(fields.severity)}` : ''}`, '', `Recorded: ${markdownText(formatDate(comment.createdAt))}`, '');
    lines.push(`**Viewport:** ${markdownText(viewportLabel(comment))}`, '');
    if (!commentAudit && pageLocationText(comment.context?.prototype?.url)) lines.push(`Reference for this observation: ${markdownText(pageLocationText(comment.context.prototype.url))}`, '');
    for (const key of ['comment', 'expected']) if (fields[key]) lines.push(`### ${FIELD_LABELS[key]}`, '', markdownText(fields[key]), '');
    if (typeof comment.ai?.reason === 'string' && comment.ai.reason) lines.push('### Why this change', '', markdownText(comment.ai.reason), '');
    for (const key of ['component', 'state']) if (fields[key]) lines.push(`**${FIELD_LABELS[key]}:** ${markdownText(fields[key])}`, '');
    const steps = reproductionSteps(fields.steps);
    if (steps.length) lines.push('### Steps to reproduce', '', ...steps.map((step, stepIndex) => `${stepIndex + 1}. ${markdownText(step)}`), '');
    const images = evidenceImages(comment, index, {audit: commentAudit});
    for (const [kind, heading] of [['crop', 'Focused evidence'], ['full', 'Full screenshots · context']]) {
      const grouped = images.filter((image) => image.kind === kind);
      if (!grouped.length) continue;
      lines.push(`### ${heading}`, '');
      for (const image of grouped) lines.push(embedMedia ? `![${markdownText(image.label)}](${image.dataUrl})` : `Screenshot: ${markdownText(image.label)} (${markdownText(image.filename)})`, '');
    }
    if (!images.length) lines.push('No screenshot evidence recorded.', '');
    const video = evidenceVideo(comment, index);
    if (video) lines.push('### Screen recording', '', `${markdownText(video.filename)}${durationLabel(video.durationMs)}`, 'Playable video is included in the downloaded HTML report. Paste the screenshot poster, and attach the video separately if the destination supports it.', '');
    if (comment.ai?.acceptedAt) lines.push('AI suggestion accepted by the reviewer. Scores in technical details are AI estimates, not pixel-accuracy measurements.', '');
    const rows = metadataRows(comment);
    if (rows.length) {
      lines.push('<details>', '<summary>Technical details</summary>', '', comment.selection?.kind === 'region' ? 'Selected image region: bounds are recorded; no component identity or DOM measurements are inferred.' : 'Component names inferred from DOM are not verified framework source mappings.', '');
      for (const [key, value] of rows) lines.push(`- ${markdownText(key)}: ${markdownText(value).replace(/\n/g, '\n  ')}`);
      lines.push('', '</details>', '');
    }
    lines.push('---', '');
  });
  if (!embedMedia) lines.push('This text copy cannot carry images or playable video. Use the report’s Copy image buttons or download the self-contained HTML report.', '');
  return lines.join('\n');
}
