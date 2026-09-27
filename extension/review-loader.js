/* Load portable or saved feedback into the live page from the native drawer. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ready = Promise.all([import('./review-store.mjs'), import('./review-transfer.mjs'), pageHelpersReady]);
  let windowId, targetTabId, loading = false, pendingReview = null, permissionUrl = null, active = false, revision = 0;
  const key = () => `diffuseReviewLoader:${windowId}`;

  function notice(message) {
    $('page-review-loader-status').textContent = message;
    $('page-review-loader-status').hidden = !message;
  }
  function lock(value) {
    loading = value;
    $('page-review-loader').setAttribute('aria-busy', String(value));
    for (const button of $('page-review-loader').querySelectorAll('button')) button.disabled = value;
  }
  function close() {
    if (loading) return;
    active = false; revision++;
    delete document.body.dataset.reviewLoader;
    $('page-review-loader').hidden = true;
    window.dispatchEvent(new Event('diffuse-refresh'));
    if (!session) $('load-review').focus();
  }
  async function savedReviews() {
    const version = revision;
    const [store] = await ready;
    const [storedReviews, visibility] = await Promise.all([store.listReviews(), chrome.storage.local.get('diffuseHiddenReviewIds')]);
    const hidden = new Set(Array.isArray(visibility.diffuseHiddenReviewIds) ? visibility.diffuseHiddenReviewIds : []);
    const reviews = storedReviews.filter(review => !hidden.has(review.id));
    if (!active || version !== revision) return;
    const list = $('page-review-list'); list.replaceChildren();
    for (const review of reviews) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'saved-item'; button.dataset.reviewId = review.id;
      const copy = document.createElement('span'); copy.textContent = review.title || 'Untitled review';
      const detail = document.createElement('small');
      detail.textContent = `${review.count || 0} comments · ${pageHelpers.pageLocation(review.productionUrl)}`;
      copy.append(detail); button.append(copy); button.disabled = loading;
      button.addEventListener('click', () => loadSaved(review.id)); list.append(button);
    }
    if (!reviews.length) {
      const empty = document.createElement('p'); empty.className = 'muted';
      empty.textContent = 'No saved reviews yet. Choose a review file to see its comments on the page.'; list.append(empty);
    }
  }
  async function show(context = {}) {
    if (loading) return;
    targetTabId = context.targetTabId ?? sourceTab?.id;
    active = true; revision++; pendingReview = null; permissionUrl = null;
    document.body.dataset.reviewLoader = 'open';
    $('page-review-loader').hidden = false; $('open-loaded-review').hidden = true; notice('');
    $('choose-page-review-file').focus();
    try { await savedReviews(); } catch (error) { notice(describeError(error)); }
  }
  function reviewUrl(review) {
    const current = sourceTab?.id === targetTabId ? sourceTab.url : null;
    const urls = [review.productionUrl, ...(review.comments || []).map(comment => comment.pinSelection?.context?.url || comment.context?.production?.url || comment.selection?.context?.url)];
    return urls.includes(current) ? current : review.productionUrl || urls.find(Boolean);
  }
  async function open(review) {
    pendingReview = review; permissionUrl = null;
    $('open-loaded-review').hidden = true;
    notice('Opening comments on the page…');
    try {
      const result = await sendMessage('OPEN_REVIEW', {reviewId:review.id, targetTabId, windowId});
      session = result.session || null;
      lock(false); close(); renderSession();
    } catch (error) {
      permissionUrl = error.pageUrl || null;
      notice(/^Allow Diffuse to access/i.test(error.message) ? 'Review loaded. Allow access to this site to show its comments on the page.' : `${describeError(error)} Your review is saved; you can try opening it again.`);
      $('open-loaded-review').hidden = false;
    }
  }
  async function loadSaved(id) {
    if (loading) return;
    lock(true); pendingReview = null; $('open-loaded-review').hidden = true; notice('Loading review…');
    try { const [store] = await ready; await open(await store.getReview(id)); }
    catch (error) { notice(describeError(error)); }
    finally { lock(false); }
  }
  $('choose-page-review-file').addEventListener('click', () => $('page-review-file').click());
  $('page-review-file').addEventListener('change', async () => {
    const file = $('page-review-file').files?.[0]; if (!file || loading) return;
    lock(true); pendingReview = null; $('open-loaded-review').hidden = true; notice('Loading review file…');
    try {
      const [store, transfer] = await ready;
      if (file.size > transfer.REVIEW_TRANSFER_MAX_BYTES) throw new Error('This review exceeds the 256 MB portable file limit.');
      // Keep images and recordings in shared IndexedDB, outside runtime messages.
      const imported = await store.importReview(await file.text());
      await open({...imported.review, comments: imported.comments});
      if (active) await savedReviews();
    } catch (error) { notice(describeError(error)); }
    finally { $('page-review-file').value = ''; lock(false); }
  });
  $('open-loaded-review').addEventListener('click', async () => {
    if (loading || !pendingReview) return;
    // Host access must be requested in this click, before any asynchronous read.
    const access = pageHelpers.requestPageAccess(permissionUrl || reviewUrl(pendingReview));
    lock(true);
    try {
      if (!await access) throw new Error('Allow access to the reviewed site to show its comments.');
      await open(pendingReview);
    } catch (error) { notice(describeError(error)); }
    finally { lock(false); }
  });
  $('close-page-review-loader').addEventListener('click', close);
  window.addEventListener('diffuse-load-review', event => show(event.detail));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !loading) { event.preventDefault(); close(); }
  });
  async function consume(value) {
    if (!value) return;
    await show(value);
    await chrome.storage.session.remove(key());
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && Number.isInteger(windowId) && changes[key()]?.newValue) consume(changes[key()].newValue).catch(error => notice(describeError(error)));
  });
  (async () => {
    windowId = (await chrome.windows.getCurrent()).id;
    const stored = await chrome.storage.session.get(key());
    await consume(stored[key()]);
  })().catch(error => notice(describeError(error)));
})();
