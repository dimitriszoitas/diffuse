import {commentTitle, categoryLabel, evidenceImages, evidenceVideo, safeMediaUrl, metadataRows} from './report-format.mjs';
import {viewportLabel} from './viewport-profile.mjs';
import {requestPageAccess} from './core.mjs';
import {findingStatus, cleanPreviewUrl} from './pr-review.mjs';

export const PR_ROLE_COPY = Object.freeze({
  reviewer: {label: 'Give feedback', detail: 'Capture what needs attention, then check the changes.'},
  recipient: {label: 'Work through feedback', detail: 'Read the context, make changes, and ask for another look.'}
});
export const PR_STATUS_LABELS = Object.freeze({'ready-for-recheck': 'Ready for recheck', verified: 'Verified on this build', 'still-present': 'Still present', 'needs-remap': 'Needs remapping', 'needs-recheck': 'Needs recheck'});
export function canonicalPRUrl(value) {
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('Paste a GitHub pull request link.'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || !/^\/[A-Za-z\d-]+\/[A-Za-z\d_.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)) throw new Error('Paste a GitHub pull request link, such as github.com/team/project/pull/42.');
  return `https://github.com${url.pathname.replace(/\/$/, '')}`;
}
export function safeGitHubReviewLink(value, prUrl, {comment = false} = {}) {
  try {
    const expected = new URL(canonicalPRUrl(prUrl)); const url = new URL(value);
    const expectedPath = expected.pathname;
    if(url.origin !== 'https://github.com' || url.username || url.password || url.search) return '';
    if(comment) return [expectedPath, expectedPath.replace('/pull/','/issues/')].includes(url.pathname) && /^#issuecomment-[1-9]\d*$/.test(url.hash) ? url.href : '';
    return url.pathname === expectedPath && !url.hash ? url.href : '';
  } catch { return ''; }
}

function node(tag, text, className = '') { const item = document.createElement(tag); if (text != null) item.textContent = text; item.className = className; return item; }
function button(text, action, primary = false) { const item = node('button', text, `button${primary ? ' primary' : ''}`); item.type = 'button'; item.addEventListener('click', action); return item; }
function field(text, type = 'text') { const label = node('label', null, 'github-field'); const caption = node('span', text); const input = document.createElement(type === 'select' || type === 'textarea' ? type : 'input'); if (input.tagName === 'INPUT') input.type = type; label.append(caption, input); return {label, input}; }
function option(value, text) { const item = node('option', text); item.value = value; return item; }
function external(text, url) { const item = node('a', text); item.href = url; item.target = '_blank'; item.rel = 'noopener noreferrer'; return item; }
function installationLink(url) { return typeof url === 'string' && /^https:\/\/github\.com\/apps\/[a-z\d-]+\/installations\/new$/.test(url) ? external('Choose repositories for Diffuse ↗', url) : null; }
function publication(review) { const saved = review?.prRemote || {}; return {...saved, revision: saved.remoteRevision}; }
function evidencePreview(comment, index) {
  const section = node('section', null, 'github-evidence-preview');
  section.setAttribute('aria-label', 'Evidence to share');
  const gallery = node('div', null, 'github-evidence-gallery');
  const images = evidenceImages(comment,index);
  const originals = images.filter(image => image.kind === 'full' && image.originalDataUrl && image.originalDataUrl !== image.dataUrl)
    .map(image => ({...image, dataUrl:image.originalDataUrl, label:`${image.label.split(' · ')[0]} · original capture`}));
  const checks = (comment.verifications || []).flatMap(check => {
    const dataUrl = safeMediaUrl(check.evidence?.dataUrl);
    return dataUrl ? [{dataUrl,label:`Recheck · ${PR_STATUS_LABELS[check.status] || check.status}${check.checkedAt ? ` · ${check.checkedAt}` : ''}`}]:[];
  });
  for (const image of [...images,...originals,...checks]) {
    const figure = node('figure', null, 'github-evidence-image');
    const img = node('img'); img.src = image.dataUrl; img.alt = image.label; img.loading = 'lazy';
    const expand = button('Expand image', () => {
      const expanded = figure.classList.toggle('is-expanded'); expand.setAttribute('aria-expanded',String(expanded)); expand.textContent = expanded ? 'Reduce image' : 'Expand image'; expand.setAttribute('aria-label',`${expanded ? 'Reduce' : 'Expand'} ${image.label}`);
    }); expand.setAttribute('aria-expanded','false'); expand.setAttribute('aria-label',`Expand ${image.label}`);
    figure.append(node('figcaption',image.label),img,expand); gallery.append(figure);
  }
  if(gallery.childElementCount) section.append(node('h5','Captured images'),gallery);
  const video = evidenceVideo(comment,index);
  const checkVideos=(comment.verifications || []).flatMap(check=>{const dataUrl=safeMediaUrl(check.evidence?.dataUrl,'video');return dataUrl?[{dataUrl,label:`Recheck recording · ${PR_STATUS_LABELS[check.status] || check.status}${check.checkedAt?` · ${check.checkedAt}`:''}`}]:[];});
  for(const clip of [...(video?[{...video,label:'Full captured recording'}]:[]),...checkVideos]) {
    const figure = node('figure',null,'github-evidence-recording');
    const player = node('video'); player.src=clip.dataUrl; player.controls=true; player.preload='metadata'; player.setAttribute('aria-label',clip.label);
    figure.append(node('figcaption',clip.label),player); section.append(figure);
  }
  const context=node('dl',null,'github-evidence-context');
  for(const [label,value] of [['Page',comment.context?.production?.url || comment.selection?.context?.url],['Reference page',comment.context?.prototype?.url],['Figma reference',comment.ai?.designReference?.url],['Viewport',viewportLabel(comment)]]) {
    if(value) context.append(node('dt',label),node('dd',String(value)));
  }
  section.append(context);
  const rows=metadataRows(comment);
  if(rows.length){
    const details=node('details',null,'github-comment-source'); const data=node('dl',null,'github-evidence-context');
    for(const [label,value] of rows) data.append(node('dt',label),node('dd',value));
    details.append(node('summary','All captured context'),data); section.append(details);
  }
  return section;
}

export function createGitHubReview({request = async (type, payload) => {
  const response = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, ...payload});
  if (!response?.ok) { const error = new Error(response?.error || 'This GitHub request could not be completed.'); Object.assign(error, {code: response?.code, installationUrl: response?.installationUrl}); throw error; }
  return response;
}, onError = () => {}, onRefresh = async () => {}, clientFactory, pageAccess = requestPageAccess} = {}) {
  const roles = new Map(), selections = new Map();
  function setRole(id, role) { roles.set(id, role); try { globalThis.localStorage?.setItem(`diffusePRRole:${id}`, role); } catch {} }
  function getRole(id) { if (roles.has(id)) return roles.get(id); try { const saved = globalThis.localStorage?.getItem(`diffusePRRole:${id}`); if (Object.hasOwn(PR_ROLE_COPY,saved)) return saved; } catch {} return 'reviewer'; }
  let activeDialog;
  const client = async () => clientFactory ? clientFactory() : (await import('./github-connection.mjs')).createGitHubConnectionClient();
  function dialog(title, description) {
    activeDialog?.close();
    const opener = document.activeElement;
    const element = node('dialog', null, 'github-dialog'); activeDialog = element;
    const header = node('header', null, 'dialog-header');
    const heading = node('h2', title); heading.id = 'github-dialog-title'; element.setAttribute('aria-labelledby', heading.id);
    const close = button('×', () => element.close()); close.className = 'close-button'; close.setAttribute('aria-label', 'Close GitHub dialog');
    header.append(heading, close);
    const body = node('div', null, 'github-dialog-body'); body.append(node('p', description, 'github-muted'));
    const status = node('p', '', 'github-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true;
    const footer = node('footer', null, 'dialog-footer');
    element.append(header, body, status, footer); document.body.append(element); element.showModal();
    let revision = 0, writing = false;
    element.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
    element.addEventListener('close', () => { revision++; element.remove(); if (activeDialog === element) activeDialog = null; if (opener?.isConnected) opener.focus({preventScroll: true}); });
    return {element,body,footer,close,
      message(text, error = false) { status.textContent = text; status.hidden = !text; status.dataset.error = String(error); status.setAttribute('role', error ? 'alert' : 'status'); },
      alive() { return element.isConnected && element.open; },
      async run(action, {write = false} = {}) {
        if (element.getAttribute('aria-busy') === 'true') return;
        const current = ++revision; element.setAttribute('aria-busy', 'true'); writing = write; close.disabled = write;
        const controls = [...element.querySelectorAll('button,input,select,textarea')].filter(item => item !== close && !item.disabled); controls.forEach(item => { item.disabled = true; });
        try { await action(() => current === revision && element.isConnected && element.open); }
        catch (error) { if (current === revision && element.isConnected && element.open) { status.textContent = error.message; status.hidden = false; status.dataset.error = 'true'; status.setAttribute('role', 'alert'); const link = installationLink(error.installationUrl); if (link) status.append(node('br'), link); } }
        finally { if (current === revision && element.isConnected && element.open) { controls.forEach(item => { item.disabled = item.dataset.githubLocked === 'true'; }); element.setAttribute('aria-busy', 'false'); writing = false; close.disabled = false; } }
      }
    };
  }
  async function accounts(d, preferred) {
    const c = await client();
    const connection = field('GitHub account', 'select'); connection.input.dataset.native = 'true';
    const scope=node('label',null,'github-private-access');const privateAccess=node('input');privateAccess.type='checkbox';scope.append(privateAccess,node('span','Include private repositories when connecting'));
    const connect = button('Connect GitHub ↗', () => d.run(async alive => {
      const added = await c.connect({privateRepositoryAccess:privateAccess.checked}); if (!alive()) return;
      connection.input.append(option(added.id, `@${added.login}`)); connection.input.value = added.id;
      d.message(`Connected as @${added.login}. No feedback has been published.`);
    }));
    const row = node('div', null, 'github-account-row'); row.append(connection.label, connect); d.body.append(row,scope,node('p','Public access is the default. Private access requests GitHub’s repo permission, which grants broad read/write access to public and private repositories your account can access. Diffuse still requires its app on each chosen repository.','github-muted'));
    const entries = await c.listConnections(); if (!d.alive()) return connection.input;
    connection.input.replaceChildren(option('', 'Choose an account'), ...entries.map(item => option(item.id, `@${item.login}`)));
    if (entries.some(item => item.id === preferred)) connection.input.value = preferred;
    else if (entries.length === 1) connection.input.value = entries[0].id;
    return connection.input;
  }
  function previewFields(d, review = {}) {
    const grid = node('div', null, 'github-grid');
    const pr = field('Pull request link', 'url'); pr.input.placeholder = 'https://github.com/team/project/pull/42'; pr.input.value = review.prContext?.url || ''; pr.input.maxLength = 2048;
    const preview = field('Preview to open', 'url'); preview.input.placeholder = 'https://preview.example.com'; preview.input.value = review.prContext?.previewUrl || review.productionUrl || ''; preview.input.maxLength = 16384;
    const help = node('p', 'Choose the deployed preview for this build. A URL alone cannot prove which commit is running.', 'github-muted');
    grid.append(pr.label, preview.label); d.body.append(grid, help); return {pr: pr.input, preview: preview.input};
  }
  function metadataBox(pull) {
    const box = node('div', null, 'github-destination');
    const name = `${pull.owner}/${pull.repo} #${pull.number}`;
    box.append(node('strong', name), node('p', pull.title || 'Pull request'));
    const visibility = pull.visibility || (pull.private === false ? 'public' : pull.private === true ? 'private' : 'unknown');
    box.append(node('p', visibility === 'public' ? 'Public repository. Anyone can read the feedback you publish.' : visibility === 'private' ? 'Private repository. Feedback is available to people with access to this repository.' : 'Repository visibility could not be verified. Refresh before publishing.', 'github-visibility'));
    box.append(node('p', `Commit ${String(pull.headSha || '').slice(0, 12)}`, 'github-build'));
    return box;
  }
  async function openPublish(review) {
    const d = dialog('Publish feedback to a PR', 'Choose findings to add or update, check the destination, then publish one review summary. Findings already shared stay in the review when you leave them unchecked.');
    let account; try { account = await accounts(d, publication(review).connectionId); } catch (error) { d.message(error.message, true); return; }
    if (!d.alive()) return;
    const fields = previewFields(d, review);
    const selected = selections.get(review.id) || new Set(); selections.set(review.id, selected);
    for (const id of selected) if (!review.comments.some(item => item.id === id)) selected.delete(id);
    const items = node('div', null, 'github-finding-list'); const count = node('p', '', 'github-muted');
    const selectAll = button('Select all findings', () => { review.comments.forEach(item => selected.add(item.id)); updateSelection(); });
    const clear = button('Clear', () => { selected.clear(); updateSelection(); });
    const selectionBar = node('div', null, 'github-selection-actions'); selectionBar.append(count, selectAll, clear); d.body.append(selectionBar, items);
    const checkboxes = review.comments.map((comment, index) => {
      const label = node('label', null, 'github-finding-choice'); const input = node('input'); input.type = 'checkbox'; input.value = comment.id; input.checked = selected.has(comment.id);
      const copy = node('span'); copy.append(node('strong', commentTitle(comment, index)), node('small', `${categoryLabel(comment.fields?.category || comment.category)} · ${comment.fields?.severity || 'minor'}`));
      label.append(input, copy); items.append(label); input.addEventListener('change', () => { if (input.checked) selected.add(comment.id); else selected.delete(comment.id); updateSelection(); }); return input;
    });
    const output = node('section', null, 'github-publish-preview'); output.hidden = true; d.body.append(output);
    let prepared = null, buildConfirmed = null, resumable = null;
    function lockPublication(value) {
      for (const item of [...d.body.querySelectorAll('input,select,textarea,button'),previewButton]) {
        if (value) item.dataset.githubLocked = 'true'; else delete item.dataset.githubLocked;
        item.disabled = value;
      }
    }
    function showPending(result, payload) {
      resumable = result.resume || payload;
      const progress = result.progress || {};
      const measured = Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0;
      const progressText = measured ? progress.phase === 'upload' ? `Review upload: ${Math.min(100,Math.round(progress.completed/progress.total*100))}%. Resume to continue.` : `${progress.completed} of ${progress.total} evidence files attached. Resume to finish publishing.` : 'The approved publication is saved. Resume to finish sharing it.';
      d.message(progress.waiting ? result.message || 'GitHub is confirming the existing publication. Check its status before starting another.' : progressText);
      publish.hidden = true; previewButton.hidden = true; resume.hidden = false;
      resume.textContent = progress.waiting ? 'Check publication status' : 'Resume publication';
      lockPublication(true);
    }
    async function sendPublication(payload, alive) {
      d.message('Publishing the selected feedback and evidence…');
      let result;
      try { result = await request('GITHUB_PUBLISH',payload); }
      catch (error) {
        const saved = await request('GITHUB_PUBLICATION_STATUS',{reviewId:review.id,connectionId:payload.connectionId}).catch(()=>null);
        if (alive() && saved?.pending && saved.resume) showPending(saved,saved.resume);
        throw error;
      }
      if (!alive()) return;
      if (result.pending) { showPending(result,payload); return; }
      d.message('Feedback published. People can read it directly in GitHub.');
      const link = safeGitHubReviewLink(result.commentUrl || result.url,payload.prUrl,{comment:true}); if (link) output.append(external('Open published feedback ↗', link));
      await onRefresh(review.id); prepared = null; resumable = null; lockPublication(true); publish.hidden = true; resume.hidden = true; previewButton.hidden = true; d.footer.append(button('Done',()=>d.element.close()));
    }
    const resume = button('Resume publication',()=>d.run(async alive=>{
      if (!resumable) return;
      const {type,...payload}=resumable;
      await sendPublication(payload,alive);
    },{write:true}),true); resume.hidden = true;
    const publish = button('Publish to PR', () => d.run(async alive => {
      if (!prepared) return;
      if (!buildConfirmed?.checked) throw new Error('Confirm the preview and reviewed commit before publishing.');
      const snapshot = prepared;
      await sendPublication({...snapshot.payload, expectedHeadSha: snapshot.preview.pull.headSha, previewToken: snapshot.token, previewDigest: snapshot.digest, expectedRevision: snapshot.preview.expectedRevision ?? publication(review).revision},alive);
    }, {write: true}), true); publish.hidden = true;
    const previewButton = button('Preview publication', () => d.run(async alive => {
      if (!account.value) throw new Error('Connect or choose a GitHub account.');
      if (!selected.size) throw new Error('Select at least one finding to publish.');
      const payload = {connectionId: account.value, reviewId: review.id, commentIds: [...selected], prUrl: canonicalPRUrl(fields.pr.value), previewUrl: fields.preview.value.trim()};
      const response = await request('GITHUB_PREVIEW', payload); if (!alive()) return;
      if(response.pending && response.requiresResume && response.resume) { showPending(response,response.resume); return; }
      const preview = response.preview;
      if (!preview?.pull || typeof preview.markdown !== 'string') throw new Error('The publish preview could not be verified. Refresh and try again.');
      output.replaceChildren(metadataBox(preview.pull));
      const text = node('pre', preview.markdown, 'github-markdown-preview'); text.setAttribute('aria-label', 'Selected changes for GitHub');
      output.append(node('h3', 'Selected feedback to add or update'));
      for (const [index,comment] of review.comments.entries()) {
        if (!selected.has(comment.id)) continue;
        const item = node('article', null, 'github-preview-finding'); item.append(node('h4', commentTitle(comment,index)), node('p', comment.fields?.comment || ''));
        if (comment.fields?.expected) item.append(node('strong', 'Requested change'), node('p', comment.fields.expected));
        item.append(evidencePreview(comment,index)); output.append(item);
      }
      if(preview.expectedRevision > 0) output.append(node('p','Any findings already published remain in the shared review. This preview shows only the checked findings being added or updated; unselected local edits do not replace published feedback.','github-muted'));
      const raw = node('details',null,'github-comment-source'); raw.append(node('summary','Selected changes in GitHub format'),text); output.append(raw,node('p', 'This shares the selected feedback, captured page and reference images, full recordings, page URLs, viewport and element context, and any previous checks. Inspect the evidence above before publishing. Unselected local findings are not added; anything already published stays shared.', 'github-muted'));
      if (preview.pull.canWrite === false) { output.hidden = false; throw new Error('This account can read this repository. Diffuse publishing currently needs repository write access. You can still load and inspect shared findings.'); }
      if (response.canPublish === false || preview.canPublish === false) { output.hidden = false; throw new Error('Only the original publisher can replace this review’s feedback. You can still load it and record rechecks.'); }
      const visibility = preview.pull.visibility || (typeof preview.pull.private === 'boolean' ? preview.pull.private ? 'private' : 'public' : 'unknown');
      if (visibility === 'unknown') throw new Error('Repository visibility is unavailable. Refresh before publishing.');
      const confirmBuild = node('label',null,'github-finding-choice'); buildConfirmed = node('input'); buildConfirmed.type = 'checkbox';
      confirmBuild.append(buildConfirmed,node('span',`I reviewed these findings on this preview for commit ${preview.pull.headSha.slice(0,12)}.`)); output.append(confirmBuild);
      prepared = {payload,preview,token: response.previewToken,digest: response.previewDigest || preview.digest}; output.hidden = false; publish.hidden = false; d.message('Check the destination and feedback before publishing.');
      output.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    }));
    function invalidate() { prepared = null; buildConfirmed = null; output.hidden = true; publish.hidden = true; }
    function updateSelection() { checkboxes.forEach(input => { input.checked = selected.has(input.value); }); count.textContent = `${selected.size} of ${review.comments.length} selected`; previewButton.disabled = !selected.size; invalidate(); }
    for (const item of [account,fields.pr,fields.preview]) item.addEventListener('input', invalidate);
    d.footer.append(previewButton, publish, resume); updateSelection();
    // This reads a local receipt only. Reopening never replays a write.
    const receipt = await request('GITHUB_PUBLICATION_STATUS',{reviewId:review.id,connectionId:account.value || undefined}).catch(()=>null);
    if (d.alive() && receipt?.pending && receipt.resume) {
      const pending = receipt.resume;
      account.value = pending.connectionId; fields.pr.value = pending.prUrl || fields.pr.value; fields.preview.value = pending.previewUrl || fields.preview.value;
      selected.clear(); for(const id of pending.commentIds || []) selected.add(id); updateSelection();
      output.replaceChildren(node('p','An earlier publication is saved. Continue that approved snapshot; changes made since then remain on this device.','github-muted')); output.hidden = false;
      showPending(receipt,pending);
    }
  }
  async function openLoad({previewUrl = ''} = {}) {
    const d = dialog('Load feedback from a PR', 'Bring published findings onto the preview you are working on. Existing local notes stay available.');
    let account; try { account = await accounts(d); } catch (error) { d.message(error.message, true); return; }
    if (!d.alive()) return;
    const fields = previewFields(d);
    if (previewUrl) { try { fields.preview.value = cleanPreviewUrl(previewUrl); } catch { /* An invalid link parameter is never used for navigation. */ } }
    const list = field('Published review', 'select'); list.label.hidden = true; d.body.append(list.label);
    const destination = node('div'); d.body.append(destination); let pull = null;
    const load = button('Load on preview', () => {
      // Permission must be requested directly from the user's click.
      const access = pageAccess(fields.preview.value.trim());
      void d.run(async alive => {
        if (!await access) throw new Error('Allow Diffuse to open this preview and display its feedback.');
        if (!pull || !list.input.value) throw new Error('Choose a published review first.');
        const result = await request('GITHUB_LOAD', {connectionId: account.value, prUrl: canonicalPRUrl(fields.pr.value), remoteReviewId: list.input.value, previewUrl: fields.preview.value.trim(), expectedHeadSha: pull.headSha});
        if (!alive()) return; setRole(result.reviewId,'recipient'); await onRefresh(result.reviewId); d.element.close();
      });
    }, true); load.hidden = true;
    const find = button('Find feedback', () => d.run(async alive => {
      if (!account.value) throw new Error('Connect or choose a GitHub account.');
      const payload = {connectionId: account.value, prUrl: canonicalPRUrl(fields.pr.value)};
      const info = await request('GITHUB_GET_PR', {connectionId: account.value, url: payload.prUrl});
      const response = await request('GITHUB_LIST_REVIEWS', payload); if (!alive()) return;
      pull = info.pull;
      if(canonicalPRUrl(pull?.url) !== payload.prUrl) throw new Error('This response belongs to another pull request. No review was loaded.');
      destination.replaceChildren(metadataBox(pull));
      if(!Array.isArray(response.reviews)) throw new Error('The shared review list could not be verified.');
      const rows = response.reviews.filter(item=>{try{return typeof item?.id === 'string' && (!item.pullUrl || canonicalPRUrl(item.pullUrl) === payload.prUrl);}catch{return false;}});
      if(rows.length !== response.reviews.length) { pull=null; list.label.hidden=true; load.hidden=true; throw new Error('The shared review list included a different pull request. No review was loaded.'); } list.input.replaceChildren(...rows.map(item => option(item.id, item.title || `Review ${item.reviewKey?.slice(0, 8) || item.id}`)));
      list.label.hidden = !rows.length; load.hidden = !rows.length;
      d.message(rows.length ? `${rows.length} published review${rows.length === 1 ? '' : 's'} found. Choose the preview where you want to see the pins.` : 'No Diffuse feedback has been published on this pull request yet.');
    }));
    for (const item of [account,fields.pr]) item.addEventListener('input', () => { pull = null; list.label.hidden = true; load.hidden = true; destination.replaceChildren(); });
    d.footer.append(find, load);
  }
  async function openStatus(review, comment, status) {
    const verify = status === 'verified' || status === 'still-present';
    const d = dialog(verify ? 'Record what you checked' : 'Ask for another look', verify ? 'Check the finding on the preview, capture the updated state, then inspect it before sharing your check.' : 'Capture the updated state and tell the reviewer what changed. This asks for verification; it does not mark the finding as fixed.');
    let account; try { account = await accounts(d, publication(review).connectionId); } catch (error) { d.message(error.message,true); return; }
    if (!d.alive()) return;
    const fields = previewFields(d,review); fields.pr.readOnly = true;
    const note = field(verify ? 'What did you check? (optional)' : 'What changed? (optional)', 'textarea'); note.input.rows = 3; note.input.maxLength = 8000; d.body.append(note.label);
    const build = node('div'); d.body.append(build); let checkedPull = null, proofToken = null, proofAccount = null, recording = null;
    const proofPreview=node('section',null,'github-proof-preview');proofPreview.hidden=true;proofPreview.setAttribute('aria-label','Updated evidence preview');
    function discardProof(token){if(token)void request('GITHUB_DISCARD_PROOF',{connectionId:proofAccount||account.value,reviewId:review.id,proofToken:token}).catch(()=>{});}
    function clearProof(){discardProof(proofToken);proofToken=null;proofAccount=null;proofPreview.replaceChildren();proofPreview.hidden=true;proofPreview.classList.remove('is-expanded');capture.textContent='Capture updated screenshot';}
    const confirmation = node('label', null, 'github-finding-choice'); const checked = node('input'); checked.type = 'checkbox';
    confirmation.append(checked, node('span', verify ? 'I checked this finding on the selected preview and build.' : 'My changes are available on the selected preview and build.')); d.body.append(confirmation);
    const showBuild = button('Confirm current build', () => d.run(async alive => {
      if (!account.value) throw new Error('Choose a GitHub account.');
      const info = await request('GITHUB_GET_PR', {connectionId:account.value,url:canonicalPRUrl(fields.pr.value)});
      if (!alive()) return; checkedPull = info.pull; checked.checked = false; clearProof();build.replaceChildren(metadataBox(info.pull));
      if (info.pull.canWrite === false) { checkedPull = null; d.message('This account can read the feedback. Diffuse shared status updates currently need repository write access.',true); return; }
      d.message('Confirm that this preview contains the displayed commit before saving.');
    })); d.body.append(showBuild);
    for (const item of [account,fields.preview]) item.addEventListener('input', () => { checkedPull = null; checked.checked = false; clearProof();build.replaceChildren(); });
    const opened = node('p', '', 'github-muted'); opened.setAttribute('role','status'); d.body.append(opened);
    const open = button('Open finding on preview ↗', () => {
      const access = pageAccess(fields.preview.value.trim());
      void d.run(async alive => { if (!await access) throw new Error('Allow Diffuse to open this preview.'); await request('GITHUB_OPEN_FINDING',{reviewId:review.id,commentId:comment.id,connectionId:account.value,previewUrl:fields.preview.value.trim(),...(checkedPull ? {expectedHeadSha:checkedPull.headSha}: {})}); if(alive()) opened.textContent='The finding is open on your preview. Return here after checking it.'; });
    });
    d.body.append(open);
    const proofHeading=node('h3','Updated evidence');
    const proofHelp=node('p','The original capture stays in the PR. Your updated screenshot or recording appears alongside it so others can compare what changed. Capturing does not publish anything.','github-muted');
    function proofRequest(){return {connectionId:account.value,reviewId:review.id,commentId:comment.id,previewUrl:fields.preview.value.trim(),expectedHeadSha:checkedPull.headSha};}
    function showProof(response){
      const image=safeMediaUrl(response.evidence?.dataUrl),video=safeMediaUrl(response.evidence?.dataUrl,'video');
      if((!image&&!video) || typeof response.proofToken!=='string' || !response.proofToken)throw new Error('The updated capture could not be verified. Capture it again.');
      if(response.context?.headSha && response.context.headSha!==checkedPull.headSha)throw new Error('The pull request changed. Confirm the current build and capture it again.');
      if(proofToken!==response.proofToken)discardProof(proofToken);proofToken=response.proofToken;proofAccount=account.value;checked.checked=false;proofPreview.classList.remove('is-expanded');
      const media=node(video?'video':'img');media.src=video||image;
      if(video){media.controls=true;media.preload='metadata';media.setAttribute('aria-label','Updated recording to share on the pull request');}
      else media.alt='Updated screenshot to share on the pull request';
      const caption=node('p',`Captured ${response.evidence.capturedAt || 'just now'}${Number.isFinite(response.evidence.width)&&Number.isFinite(response.evidence.height)?` · ${response.evidence.width} × ${response.evidence.height}`:''}`,'github-muted');
      proofPreview.replaceChildren(media,caption);
      if(!video){const expand=button('Expand updated screenshot',()=>{const expanded=proofPreview.classList.toggle('is-expanded');expand.setAttribute('aria-expanded',String(expanded));expand.textContent=expanded?'Reduce updated screenshot':'Expand updated screenshot';});expand.setAttribute('aria-expanded','false');proofPreview.append(expand);}
      proofPreview.hidden=false;capture.textContent='Retake screenshot';d.message('Inspect the updated evidence, then confirm your check before sharing it.');
    }
    const capture=button('Capture updated screenshot',()=>{
      const access=pageAccess(fields.preview.value.trim());
      void d.run(async alive=>{
        if(!checkedPull)throw new Error('Confirm the current build before capturing updated evidence.');
        if(!await access)throw new Error('Allow Diffuse to capture the updated preview.');
        const response=await request('GITHUB_CAPTURE_PROOF',proofRequest());
        if(!alive()){discardProof(response.proofToken);return;}
        showProof(response);
      });
    });
    function lockRecording(value){
      for(const item of [...d.body.querySelectorAll('input,select,button'),save]){
        if(item===stopRecording)continue;
        if(value)item.dataset.githubLocked='true';else delete item.dataset.githubLocked;
        item.disabled=value;
      }
      stopRecording.hidden=!value;record.hidden=value;
    }
    const record=button('Record updated behavior',()=>{
      const access=pageAccess(fields.preview.value.trim());
      void d.run(async alive=>{
        if(!checkedPull)throw new Error('Confirm the current build before recording updated evidence.');
        if(!await access)throw new Error('Allow Diffuse to record the updated preview.');
        const payload=proofRequest();const response=await request('GITHUB_START_PROOF_RECORDING',payload);
        if(typeof response.recordingToken!=='string'||!response.recordingToken)throw new Error('The recording could not be started. Try again.');
        recording={...payload,recordingToken:response.recordingToken};
        if(!alive()){await request('GITHUB_DISCARD_PROOF',{connectionId:recording.connectionId,reviewId:review.id,recordingToken:recording.recordingToken}).catch(()=>{});recording=null;return;}
        clearProof();lockRecording(true);d.message('Recording the preview. Show the updated behavior, then stop to inspect it. Recording ends after 30 seconds.');
      },{write:true});
    });
    const stopRecording=button('Stop & preview',()=>d.run(async alive=>{
      if(!recording)return;const current=recording;
      try {const response=await request('GITHUB_STOP_PROOF_RECORDING',current);recording=null;if(!alive()){discardProof(response.proofToken);return;}lockRecording(false);showProof(response);}
      catch(error){await request('GITHUB_DISCARD_PROOF',{connectionId:current.connectionId,reviewId:review.id,recordingToken:current.recordingToken}).catch(()=>{});recording=null;if(alive()){lockRecording(false);clearProof();}throw error;}
    },{write:true}));stopRecording.hidden=true;
    d.element.addEventListener('close',()=>{if(recording||proofToken){const pending={connectionId:recording?.connectionId||proofAccount||account.value,reviewId:review.id,...(recording?{recordingToken:recording.recordingToken}:{}),...(proofToken?{proofToken}:{})};recording=null;proofToken=null;proofAccount=null;void request('GITHUB_DISCARD_PROOF',pending).catch(()=>{});}});
    const proofActions=node('div',null,'github-proof-actions');proofActions.append(capture,record,stopRecording);
    d.body.append(proofHeading,proofHelp,proofActions,proofPreview,confirmation);
    function recoverEvent(receipt) {
      save.hidden=true;
      d.message(receipt.eventMessage || (receipt.eventState === 'sending' ? 'A previous status update needs confirmation. Sync it before recording another check.' : 'Status saved. The GitHub comment has not refreshed yet. Your update is safe in the shared review.'));
      const sync = button(receipt.eventState === 'sending' ? 'Confirm status update' : 'Refresh GitHub summary',()=>d.run(async alive=>{
        const refreshed = await request('GITHUB_SYNC_SUMMARY',{reviewId:review.id,connectionId:account.value});
        if(!alive()) return;
        if(refreshed.summaryUpdated === false) { d.message('Your status is saved. GitHub’s comment is still waiting to refresh. Try again later.'); sync.textContent='Refresh GitHub summary'; return; }
        await onRefresh(review.id); d.message('GitHub summary updated.'); sync.hidden=true;
      },{write:true})); d.footer.append(sync);
    }
    const save = button(verify ? status === 'verified' ? 'Share check & mark verified' : 'Share check & mark still present' : 'Share update & mark ready', () => {
      void d.run(async alive => {
        if (!account.value) throw new Error('Choose a GitHub account.');
        if (!checkedPull || !checked.checked) throw new Error('Confirm the current build and check the preview before saving.');
        if(!proofToken)throw new Error('Capture and inspect updated evidence before sharing this status.');
        let result;
        try { result = await request('GITHUB_RECHECK',{connectionId:account.value,reviewId:review.id,commentId:comment.id,status,note:note.input.value.trim(),previewUrl:fields.preview.value.trim(),expectedHeadSha:checkedPull.headSha,expectedRevision:publication(review).revision,proofToken}); }
        catch(error) {
          const receipt=await request('GITHUB_PUBLICATION_STATUS',{reviewId:review.id,connectionId:account.value}).catch(()=>null);
          if(alive() && (receipt?.eventPending || receipt?.summaryPending)) { recoverEvent(receipt); return; }
          throw error;
        }
        if (!alive()) return; await onRefresh(review.id);
        if (result.summaryUpdated === false) {
          recoverEvent({eventState:'summary-pending'}); return;
        }
        d.element.close();
      }, {write:true});
    },true); d.footer.append(save);
  }
  function mount(review, container, cards) {
    const role = getRole(review.id);
    const panel = node('section',null,'github-review-panel'); panel.setAttribute('aria-label','Pull request feedback');
    const heading = node('div',null,'github-review-heading'); const copy = node('div'); copy.append(node('h2','Feedback, together'),node('p',PR_ROLE_COPY[role].detail,'github-muted'));
    const tabs = node('div',null,'github-role-switch'); tabs.setAttribute('role','group'); tabs.setAttribute('aria-label','Your role in this review');
    for (const [key,value] of Object.entries(PR_ROLE_COPY)) {const tab=button(value.label,()=>{setRole(review.id,key);panel.remove();container.querySelectorAll('.github-finding-state').forEach(item=>item.remove());mount(review,container,cards);});tab.setAttribute('aria-pressed',String(role===key));tabs.append(tab);}
    heading.append(copy,tabs);panel.append(heading);
    const actions=node('div',null,'github-panel-actions');
    actions.append(button('Load from PR',()=>openLoad().catch(error=>onError(error.message))));
    if(role==='reviewer') actions.append(button('Publish to PR',()=>openPublish(review).catch(error=>onError(error.message)),true));
    if(review.prContext) {
      const prLink=safeGitHubReviewLink(review.prContext.url,`https://github.com/${review.prContext.owner}/${review.prContext.repo}/pull/${review.prContext.number}`);if(prLink)panel.append(external(`${review.prContext.owner}/${review.prContext.repo} #${review.prContext.number} ↗`,prLink));
      actions.append(button('Refresh feedback',async()=>{try {const c=await client();const entries=await c.listConnections();const connectionId=publication(review).connectionId||entries[0]?.id;if(!connectionId)throw new Error('Connect GitHub in Settings first.');await request('GITHUB_REFRESH',{reviewId:review.id,connectionId});await onRefresh(review.id);}catch(error){onError(error.message);}}));
      cards.forEach((card,index)=>{
        const comment=review.comments[index];const row=node('div',null,'github-finding-state');const state=findingStatus(comment,review.prContext);
        row.append(node('span',PR_STATUS_LABELS[state]||'Needs recheck','github-state-badge'));
        const latest=comment.verifications?.at(-1);if(latest)row.append(node('small',`@${latest.reviewer?.login||'reviewer'} · ${String(latest.buildSha||'').slice(0,8)}`));
        const statuses=role==='reviewer'?['verified','still-present']:['ready-for-recheck'];
        for(const status of statuses)row.append(button(status==='verified'?'Verify on preview':status==='still-present'?'Still present':'Ready for recheck',()=>openStatus(review,comment,status).catch(error=>onError(error.message))));
        card.querySelector('.comment-actions')?.after(row);
      });
    } else panel.append(node('p',role==='recipient'?'Load a published review to see its comments on your preview and work through the feedback.':'Feedback is saved on this device until you choose to publish it.','github-muted'));
    panel.append(actions);container.prepend(panel);
    request('GITHUB_PUBLICATION_STATUS',{reviewId:review.id,connectionId:publication(review).connectionId}).then(receipt=>{
      if(!panel.isConnected || (!receipt?.pending && !receipt?.summaryPending && !receipt?.eventPending)) return;
      const pending=node('div',null,'github-pending-notice');pending.setAttribute('role','status');
      if(receipt.pending){pending.append(node('p','A previous publication is saved and waiting to finish.'),button('Continue publication',()=>openPublish(review).catch(error=>onError(error.message))));}
      if(receipt.summaryPending || receipt.eventPending){
        const message=node('p',receipt.eventMessage || (receipt.eventState === 'sending' ? 'A previous status update needs confirmation. Sync it before recording another check.' : 'Your shared status is saved. The GitHub comment is waiting to refresh.'));
        const sync=button(receipt.eventState === 'sending' ? 'Confirm status update' : 'Refresh GitHub summary',async()=>{sync.disabled=true;try{const result=await request('GITHUB_SYNC_SUMMARY',{reviewId:review.id,connectionId:publication(review).connectionId});if(result.summaryUpdated===false){message.textContent='Your status is saved. GitHub’s comment is still waiting to refresh. Try again later.';sync.textContent='Refresh GitHub summary';}else{pending.remove();await onRefresh(review.id);}}catch(error){onError(error.message);}finally{sync.disabled=false;}});
        pending.append(message,sync);
      }
      panel.append(pending);
    }).catch(()=>{});
  }
  return {mount,openLoad,openPublish};
}
