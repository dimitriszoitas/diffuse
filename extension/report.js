import {
  commentTitle, evidenceImages, evidenceVideo, fileStem, formatDate, formatMarkdown, categoryKey, recordedFocusCrop, safeMediaUrl, commentIsAudit, reviewIsAudit,
  formatReviewHtml, formatStandaloneHtml, reviewTitle, REPORT_STYLES, categoryLabel,
} from './report-format.mjs';
import {getReview, listReviews} from './review-store.mjs';
import {createJiraExporter} from './jira-export.mjs';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const reportStyles = document.createElement('style');
reportStyles.textContent = REPORT_STYLES;
document.head.append(reportStyles);
let reviews = [];
let selectedReview = null;
let loadingRevision = 0;
let editingCommentId = null;
let editingReviewId = null;
const jiraExporter = createJiraExporter({onError: message => notice(message, 'warning')});

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, ...payload});
  if (!response?.ok) throw new Error(response?.error || 'Diffuse could not load this review. Try refreshing.');
  return response;
}

function notice(message, type = 'success') {
  ui.notice.textContent = message;
  ui.notice.dataset.type = type;
  ui.notice.hidden = !message;
}

function emptyState(title, description) {
  const section = document.createElement('section');
  section.className = 'empty-state';
  const symbol = document.createElement('span');
  symbol.className = 'empty-symbol';
  symbol.setAttribute('aria-hidden', 'true');
  symbol.textContent = '◧';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = description;
  section.append(symbol, heading, text);
  ui['report-content'].replaceChildren(section);
  ui['report-content'].setAttribute('aria-busy', 'false');
}

function renderReviewList() {
  ui['review-list'].replaceChildren();
  ui['review-count'].textContent = `${reviews.length} saved review${reviews.length === 1 ? '' : 's'}`;
  if (!reviews.length) {
    const paragraph = document.createElement('p');
    paragraph.className = 'sidebar-empty';
    paragraph.textContent = 'Start a comparison or page audit and save your first observation. It will be waiting here.';
    ui['review-list'].append(paragraph);
  }
  for (const review of reviews) {
    const button = document.createElement('button');
    button.className = `review-item${review.id === selectedReview?.id ? ' active' : ''}`;
    button.type = 'button';
    if (review.id === selectedReview?.id) button.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'review-item-title';
    title.textContent = reviewTitle(review);
    const meta = document.createElement('span');
    meta.className = 'review-item-meta';
    const count = Number.isFinite(review.count) ? review.count : 0;
    meta.textContent = `${review.mode === 'audit' ? 'Audit · ' : ''}${count} observation${count === 1 ? '' : 's'} · ${formatDate(review.updatedAt || review.createdAt).split(' ')[0]}`;
    button.append(title, meta);
    button.addEventListener('click', () => selectReview(review.id));
    ui['review-list'].append(button);
  }
}

async function prepareReviewEvidence(review) {
  const comments = [];
  for (const comment of Array.isArray(review.comments) ? review.comments : []) {
    const evidence = comment.evidence?.production;
    const crop = !safeMediaUrl(evidence?.cropDataUrl) && recordedFocusCrop(comment);
    if (!crop) { comments.push(comment); continue; }
    let bitmap;
    try {
      const source = safeMediaUrl(evidence.annotatedDataUrl) || evidence.dataUrl;
      bitmap = await createImageBitmap(await (await fetch(source)).blob());
      // Do not apply recorded coordinates to an image with unexpected dimensions.
      if (bitmap.width !== evidence.width || bitmap.height !== evidence.height) throw new Error('Image dimensions differ from capture metadata');
      const canvas = document.createElement('canvas');canvas.width = crop.width;canvas.height = crop.height;
      canvas.getContext('2d').drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      comments.push({...comment, evidence: {...comment.evidence, production: {...evidence, crop, cropDataUrl: canvas.toDataURL('image/png')}}});
    } catch { comments.push(comment); }
    finally { bitmap?.close(); }
  }
  // This derived view is never written to IndexedDB. Saved text and media stay intact.
  return {...review, comments};
}

async function selectReview(reviewId) {
  const revision = ++loadingRevision;
  ui['report-content'].setAttribute('aria-busy', 'true');
  setExportEnabled(false);
  try {
    // Read media in this extension origin directly to avoid runtime message-size limits.
    const review = await getReview(reviewId);
    if (revision !== loadingRevision) return;
    if (!review) throw new Error('This review is no longer available. Refresh the notebook to see your saved reviews.');
    const displayReview = await prepareReviewEvidence(review);
    if (revision !== loadingRevision) return;
    selectedReview = displayReview;
    const url = new URL(location.href);
    url.searchParams.set('review', selectedReview.id);
    history.replaceState(null, '', url.href);
    renderReviewList();
    renderReview();
  } catch (error) {
    if (revision !== loadingRevision) return;
    selectedReview = null;
    ui['export-toolbar'].hidden = true;
    renderReviewList();
    emptyState('This review needs another look.', 'Refresh your reviews to reconnect to the saved evidence.');
    notice(error.message, 'error');
  } finally {
    if (revision === loadingRevision) ui['report-content'].setAttribute('aria-busy', 'false');
  }
}

function setExportEnabled(enabled) {
  for (const id of ['copy-report', 'download-html', 'download-markdown', 'delete-review']) ui[id].disabled = !enabled;
}

async function loadReviews(preferredId = selectedReview?.id || new URL(location.href).searchParams.get('review')) {
  ui['refresh-reviews'].disabled = true;
  try {
    const savedReviews = await listReviews();
    reviews = Array.isArray(savedReviews) ? savedReviews : [];
    if (!reviews.length) {
      loadingRevision++;
      selectedReview = null;
      ui['export-toolbar'].hidden = true;
      renderReviewList();
      emptyState('The details make the difference.', 'Save an observation in a comparison or page audit. Its screenshots and engineering context will appear here, ready to share.');
      return;
    }
    const next = reviews.find((review) => review.id === preferredId) || reviews[0];
    renderReviewList();
    await selectReview(next.id);
  } catch (error) {
    notice(error.message, 'error');
    if (!selectedReview) emptyState('Your notebook could not be loaded.', 'Make sure Diffuse is enabled, then refresh your reviews.');
  } finally { ui['refresh-reviews'].disabled = false; }
}

function actionButton(label, className, action, {busy = true} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${className || ''}`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    if (busy) button.disabled = true;
    try { await action(); } catch (error) { notice(error.message, 'error'); }
    finally { if (busy) button.disabled = false; }
  });
  return button;
}

function download(content, filename, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], {type: mimeType});
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // This URL exists only to trigger the download; exported documents contain no blob URLs.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function imageBlob(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Chrome could not prepare this image. Use Download image instead.');
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob((png) => png ? resolve(png) : reject(new Error('Could not prepare the image for copying.')), 'image/png'));
  } finally { bitmap.close(); }
}

async function copyImage(image) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying is unavailable here. Use Download image, then attach it to your document.');
  await navigator.clipboard.write([new ClipboardItem({'image/png': imageBlob(image.dataUrl)})]);
  notice(`${image.label} copied. Paste it into your document or ticket.`);
}

function previewImage(image) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-preview';
  dialog.setAttribute('aria-label', image.label);
  const header = document.createElement('header');header.className = 'dialog-header';
  const label = document.createElement('h2');label.textContent = image.label;
  header.append(label, actionButton('Close', '', () => dialog.close(), {busy: false}));
  const controls = document.createElement('div');controls.className = 'image-zoom-controls';
  const status = document.createElement('output');status.setAttribute('aria-live', 'polite');
  const viewport = document.createElement('div');viewport.className = 'image-preview-scroll';viewport.tabIndex = 0;viewport.setAttribute('aria-label', 'Image viewport. Scroll to inspect an enlarged image.');
  const picture = document.createElement('img');picture.src = image.dataUrl;picture.alt = image.label;
  let zoom = null;
  const applyZoom = value => {
    zoom = value;
    picture.style.width = value === null ? '100%' : `${picture.naturalWidth * value}px`;
    picture.style.maxWidth = value === null ? (picture.naturalWidth ? `min(100%, ${picture.naturalWidth * 4}px)` : '100%') : 'none';
    status.textContent = value === null ? 'Fit to window' : `${Math.round(value * 100)}%`;
  };
  const step = direction => {
    if (!picture.naturalWidth) return;
    // Start from the actual fitted size. Fit shares the 4× ceiling, and
    // zooming out below 25% halves the current scale rather than enlarging it.
    const current = picture.getBoundingClientRect().width / picture.naturalWidth;
    const delta = direction < 0 ? Math.min(.25, current / 2) : .25;
    applyZoom(Math.max(Number.EPSILON, Math.min(4, current + direction * delta)));
  };
  controls.append(actionButton('Fit', '', () => applyZoom(null), {busy: false}), actionButton('100%', '', () => applyZoom(1), {busy: false}), actionButton('−', '', () => step(-1), {busy: false}), actionButton('+', '', () => step(1), {busy: false}), status);
  controls.querySelectorAll('button')[2].setAttribute('aria-label', 'Zoom out');
  controls.querySelectorAll('button')[3].setAttribute('aria-label', 'Zoom in');
  viewport.append(picture);dialog.append(header, controls, viewport);
  picture.addEventListener('load', () => applyZoom(zoom), {once: true});
  dialog.addEventListener('close', () => { dialog.remove();if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true}); }, {once: true});
  document.body.append(dialog);dialog.showModal();applyZoom(null);
}

function renderReview() {
  const review = selectedReview;
  if (!review) return;
  document.title = `${reviewTitle(review)} — Diffuse`;
  const paired = !reviewIsAudit(review) && review.comments.some((comment) => comment.evidence?.production?.dataUrl && comment.evidence?.prototype?.dataUrl);
  ui['handoff-description'].textContent = paired ? 'Every observation, both screenshots, and the context behind them.' : 'Every observation, the captured page, and the context behind it.';
  ui['export-toolbar'].hidden = false;
  setExportEnabled(true);
  // All user content, URLs, attributes, and media are validated/escaped in this pure formatter.
  ui['report-content'].innerHTML = formatReviewHtml(review);
  const cards = [...ui['report-content'].querySelectorAll('.comment-card')];
  const categoryLinks = [...ui['report-content'].querySelectorAll('[data-category-filter]')];
  const filterStatus = ui['report-content'].querySelector('.filter-status');
  categoryLinks.forEach((link) => {
    link.setAttribute('role', 'button');
    link.setAttribute('aria-pressed', String(link.dataset.categoryFilter === 'all'));
    const applyFilter = () => {
      const filter = link.dataset.categoryFilter;
      let count = 0;
      cards.forEach((card) => {
        card.hidden = filter !== 'all' && card.dataset.category !== filter;
        if (!card.hidden) count++;
      });
      categoryLinks.forEach((item) => {
        const active = item === link;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      filterStatus.textContent = filter === 'all' ? `Showing all ${count} observations.` : `Showing ${count} ${categoryLabel(filter).toLowerCase()} observation${count === 1 ? '' : 's'} of ${cards.length}. Exports include the full review.`;
      filterStatus.hidden = false;
    };
    link.addEventListener('click', (event) => { event.preventDefault(); applyFilter(); });
    link.addEventListener('keydown', (event) => {
      if (event.key === ' ') { event.preventDefault(); applyFilter(); }
    });
  });
  cards.forEach((card, index) => {
    const comment = review.comments[index];
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    actions.append(
      actionButton('Edit observation', '', () => editComment(comment, review.id)),
      actionButton('Delete', 'danger-subtle', async () => {
        if (!window.confirm(`Delete “${commentTitle(comment, index)}” and its saved evidence? This cannot be undone.`)) return;
        await request('DELETE_COMMENT', {reviewId: review.id, commentId: comment.id});
        await loadReviews(review.id);
        notice('Observation deleted.');
      }),
    );
    card.querySelector('.comment-heading').after(actions);
    const images = evidenceImages(comment, index, {audit: commentIsAudit(comment, review)});
    card.querySelectorAll('.evidence-image').forEach((figure) => {
      // Crops are shown first, while this stable index identifies their original media.
      const image = images[Number(figure.dataset.imageIndex)];
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      actions.append(
        actionButton('Enlarge', '', () => previewImage(image), {busy: false}),
        actionButton('Copy image', '', () => copyImage(image)),
        actionButton('Download image', '', async () => download(await imageBlob(image.dataUrl), image.filename, 'image/png')),
      );
      figure.append(actions);
      const img = figure.querySelector('img');
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `Enlarge ${image.label}`);
      img.addEventListener('click', () => previewImage(image));
      img.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); previewImage(image); }
      });
    });
    const recording = evidenceVideo(comment, index);
    if (recording) card.querySelector('.video-evidence').append(actionButton('Download recording', '', async () => {
      const blob = await (await fetch(recording.dataUrl)).blob();
      download(blob, recording.filename, blob.type);
    }));
  });
  jiraExporter.mount(review, ui['report-content'], cards);
}

function editComment(comment, reviewId) {
  editingCommentId = comment.id;
  editingReviewId = reviewId;
  ui['edit-error'].hidden = true;
  const fields = comment.fields || {};
  const severity = ui['edit-form'].elements.namedItem('severity');
  severity.querySelectorAll('[data-custom-option]').forEach((option) => option.remove());
  if (fields.severity && ![...severity.options].some((option) => option.value === fields.severity)) {
    const option = document.createElement('option');
    option.value = fields.severity;
    option.textContent = fields.severity;
    option.dataset.customOption = 'true';
    severity.append(option);
  }
  for (const name of ['title', 'comment', 'expected', 'component', 'state', 'steps', 'severity']) {
    ui['edit-form'].elements.namedItem(name).value = fields[name] ?? '';
  }
  ui['edit-form'].elements.namedItem('category').value = ['design-mismatch', 'ux-issue', 'copy-change'].includes(fields.category) ? fields.category : 'design-mismatch';
  ui['edit-category'].dataset.category = categoryKey(fields.category);
  ui['edit-dialog'].showModal();
}

ui['edit-category'].addEventListener('change', () => {
  ui['edit-category'].dataset.category = categoryKey(ui['edit-category'].value);
});

for (const id of ['close-edit', 'cancel-edit']) ui[id].addEventListener('click', () => ui['edit-dialog'].close());
ui['edit-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingCommentId || !editingReviewId) return;
  const fields = Object.fromEntries(new FormData(ui['edit-form']).entries());
  const reviewId = editingReviewId;
  const commentId = editingCommentId;
  ui['save-comment'].disabled = true;
  ui['save-comment'].textContent = 'Saving…';
  ui['edit-error'].hidden = true;
  try {
    await request('UPDATE_COMMENT', {reviewId, commentId, fields});
    ui['edit-dialog'].close();
    await loadReviews(reviewId);
    notice('Observation updated. Original capture evidence is unchanged.');
  } catch (error) {
    ui['edit-error'].textContent = error.message;
    ui['edit-error'].hidden = false;
  } finally {
    ui['save-comment'].disabled = false;
    ui['save-comment'].textContent = 'Save changes';
  }
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Fall back for restricted clipboard contexts. */ }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.className = 'clipboard-fallback';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Chrome blocked clipboard access. Download the HTML or Markdown report instead.');
}

ui['copy-report'].addEventListener('click', async () => {
  if (!selectedReview) return;
  const review = selectedReview;
  ui['copy-report'].disabled = true;
  try {
    const text = formatMarkdown(review, {embedMedia: false});
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      try {
        const html = formatReviewHtml(review, {clipboard: true});
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], {type: 'text/html'}),
          'text/plain': new Blob([text], {type: 'text/plain'}),
        })]);
        notice('Report copied with screenshots. Paste it into your document; if images are stripped, use Copy image below. Playable recordings are preserved in the HTML download.');
        return;
      } catch { /* A plain-text copy is still useful when rich clipboard data is rejected. */ }
    }
    await copyText(text);
    notice('Only report text was copied: this browser blocked rich content. Use Copy image for screenshots, or download HTML to keep images and playable video together.', 'warning');
  } catch (error) { notice(error.message, 'error'); }
  finally { ui['copy-report'].disabled = !selectedReview; }
});

ui['download-html'].addEventListener('click', () => {
  if (!selectedReview) return;
  download(formatStandaloneHtml(selectedReview), `${fileStem(reviewTitle(selectedReview))}.html`, 'text/html;charset=utf-8');
  notice('HTML download started. It contains embedded screenshots and playable recordings; it can be opened offline.');
});
ui['download-markdown'].addEventListener('click', () => {
  if (!selectedReview) return;
  download(formatMarkdown(selectedReview), `${fileStem(reviewTitle(selectedReview))}.md`, 'text/markdown;charset=utf-8');
  notice('Markdown download started. Screenshots are embedded as data URLs; viewer support varies. Download HTML for playable recordings and reliable image display.');
});
ui['delete-review'].addEventListener('click', async () => {
  if (!selectedReview) return;
  const review = selectedReview;
  if (!window.confirm(`Delete “${reviewTitle(review)}” and all of its observations and evidence? This cannot be undone.`)) return;
  ui['delete-review'].disabled = true;
  try {
    await request('DELETE_REVIEW', {reviewId: review.id});
    selectedReview = null;
    await loadReviews(null);
    notice('Review deleted.');
  } catch (error) { notice(error.message, 'error'); }
  finally { ui['delete-review'].disabled = !selectedReview; }
});
ui['refresh-reviews'].addEventListener('click', () => loadReviews());
ui['ai-settings'].addEventListener('click', async () => {
  ui['ai-settings'].disabled = true;
  try { await request('OPEN_AI_SETTINGS'); }
  catch (error) { notice(error.message, 'error'); }
  finally { ui['ai-settings'].disabled = false; }
});

await loadReviews();
