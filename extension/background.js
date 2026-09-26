import {DEFAULT_SETTINGS, safeSettings, sitePattern, viewportWarning} from './core.mjs';
import * as reviews from './review-store.mjs';
import {reviewScreens} from './ai-client.mjs';
import {readAISettings, saveAISettings, clearAIKey, protectAIStorage} from './ai-config.mjs';

let session = null;
let transitioning = false;
let offscreenCreation = null;
let evidenceBusy = false;
let recordingStart = null;
let lastScreenshotAt = 0;
let aiJob = null;
const acceptingSuggestions = new Set();
let suggestionMutation = Promise.resolve();
const recordingFinishes = new Map();
const draftPreservations = new Map();
const panelPorts = new Map();
let panelDocking = Promise.resolve();
let panelDockState = null;
let diffWindow = null;
const referenceRequests = new Map();
const PANEL_ACTIONS = new Set(['selectElement', 'selectArea', 'cancelSelection', 'openAi', 'closeAi', 'setAiFields', 'runAi', 'aiSuggestion', 'acceptAllAi', 'showAllAi', 'setCommentFields', 'evidence', 'recordComment', 'saveComment', 'cancelComment', 'record', 'stopRecording', 'retryCapture', 'settings', 'showPin', 'focusTarget', 'focusSource', 'stop', 'reconnect', 'openReport', 'openSettings', 'openDiff']);
const ready = chrome.storage.session.get('comparison').then(async data => {
  await protectAIStorage();
  session = data.comparison || null;
  // A provider request cannot survive a worker restart; retained suggestions can.
  if (session?.aiRunning) { session.aiRunning = false; await publish(); }
});
const persist = () => chrome.storage.session.set({comparison: session});
const tabMessage = (tabId, type, data = {}) => chrome.tabs.sendMessage(tabId, {namespace: 'diffuse', type, ...data}, {frameId: 0});
const softTabMessage = (tabId, type, data) => tabMessage(tabId, type, data).catch(() => null);

function isSidePanel(sender) {
  const url = chrome.runtime.getURL('sidepanel.html');
  return sender.id === chrome.runtime.id && (sender.url === url || sender.url?.startsWith(`${url}?`));
}

function notifyPanels() {
  for (const [port, attachment] of panelPorts) {
    if (!attachment.connected) continue;
    try { port.postMessage({type: 'STATE_CHANGED', sessionId: session?.id || null}); } catch { /* A closing panel can disconnect before its event arrives. */ }
  }
}

function syncPanelDocking({force = false} = {}) {
  panelDocking = panelDocking.catch(() => {}).then(async () => {
    const current = session;
    if (!current) { panelDockState = null; return; }
    if (!panelPorts.size && !panelDockState) return;
    const target = await chrome.tabs.get(current.targetTabId);
    const active = await chrome.tabs.query({active: true, windowId: target.windowId});
    if (session !== current) return;
    const docked = active[0]?.id === current.targetTabId && [...panelPorts.values()].some(item => item.connected && item.visible && item.windowId === target.windowId);
    const key = `${current.id}:${current.targetTabId}:${docked}`;
    if (!force && panelDockState === key) return;
    const response = await softTabMessage(current.targetTabId, 'DOCK_STATE', {sessionId: current.id, docked});
    if (response?.ok && session === current) panelDockState = panelPorts.size || docked ? key : null;
  });
  return panelDocking;
}

function attachedPanel(sender, windowId) {
  if (!isSidePanel(sender) || !Number.isInteger(windowId)) throw new Error('Open this drawer from the Diffuse toolbar.');
  const attachment = [...panelPorts.values()].find(item => item.connected && item.visible && item.windowId === windowId && (!sender.documentId || item.documentId === sender.documentId));
  if (!attachment) throw new Error('The drawer is no longer attached. Reopen it from the Diffuse toolbar.');
  return attachment;
}

async function panelRequest(message, sender) {
  // Authorize at receipt: closing the drawer must not cancel a field update
  // already dispatched by its input event. Session and active-tab checks below
  // still prevent that request from reaching a replacement page.
  attachedPanel(sender, message.windowId);
  const current = session;
  if (!current) {
    if (message.type === 'PANEL_STATE') return {ok: true, session: null, state: null};
    throw new Error('There is no active comparison.');
  }
  if (message.type === 'PANEL_COMMAND' && message.sessionId !== current.id) throw new Error('This comparison is no longer active. Refresh the drawer.');
  if (message.type === 'PANEL_COMMAND' && !PANEL_ACTIONS.has(message.action)) throw new Error('Unknown drawer action.');
  const target = await chrome.tabs.get(current.targetTabId);
  const active = await chrome.tabs.query({active: true, windowId: message.windowId});
  if (session !== current) throw new Error('This comparison is no longer active. Refresh the drawer.');
  if (message.type === 'PANEL_COMMAND' && message.action === 'focusTarget') {
    await focusTab(current.targetTabId);
    return {ok: true, session: current};
  }
  if (target.windowId !== message.windowId || active[0]?.id !== current.targetTabId) {
    const error = target.windowId !== message.windowId ? 'This comparison belongs to another Chrome window. Return to the production page to continue.' : 'Return to the production page to use this drawer.';
    return message.type === 'PANEL_STATE' ? {ok: true, session: current, state: {active: false, available: false, message: error}} : {ok: false, code: 'PANEL_TARGET_INACTIVE', error, session: current, state: null};
  }
  if (message.type === 'PANEL_COMMAND' && message.action === 'openDiff') return openDiff(current);
  const {target: _target, namespace: _namespace, type: _type, ...payload} = message;
  const response = await tabMessage(current.targetTabId, message.type, {...payload, sessionId: current.id});
  if (message.type === 'PANEL_COMMAND' && message.action === 'stop' && !session && response?.ok) return {ok: true, session: null, state: null};
  if (session !== current) throw new Error('This comparison is no longer active. Refresh the drawer.');
  if (!response?.ok) return {ok: false, error: response?.error || 'The page is reconnecting. Return to it and reopen Diffuse.', session: current, state: null};
  return {...response, session: current};
}

async function evidenceStep(operation, errorMessage, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(errorMessage)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function mediaMessage(type, data = {}) {
  const result = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'offscreen', type, ...data});
  if (!result?.ok) throw new Error(result?.error || 'The capture service did not respond.');
  return result;
}

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')]})).length > 0;
}

async function ensureOffscreen() {
  if (offscreenCreation) return offscreenCreation;
  if (await hasOffscreen()) return;
  offscreenCreation = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['USER_MEDIA', 'WEB_RTC', 'DISPLAY_MEDIA'], justification: 'Keep the user-selected reference stream running locally while reviewing and navigating.'});
  try { await offscreenCreation; } finally { offscreenCreation = null; }
}

async function focusTab(id) {
  const tab = await chrome.tabs.get(id);
  await chrome.tabs.update(id, {active: true});
  await chrome.windows.update(tab.windowId, {focused: true});
}

async function publish() {
  if (!session) return;
  session.warning = session.mode === 'audit' ? '' : viewportWarning(session.sourceViewport, session.targetViewport);
  await persist();
  await Promise.all([
    softTabMessage(session.targetTabId, 'SESSION_UPDATE', {session}),
    ...(session.sourceTabId ? [softTabMessage(session.sourceTabId, 'SESSION_UPDATE', {session})] : [])
  ]);
  notifyPanels();
  await syncPanelDocking();
}

async function refreshComments(current = session) {
  if (!current) return;
  const review = await reviews.getReview(current.reviewId || current.id).catch(() => null);
  current.comments = (review?.comments || []).map(({id, createdAt, fields, selection, context, ai}) => ({id, createdAt, fields, selection, context: {production: context?.production}, ...(ai ? {ai} : {})}));
  current.commentCount = current.comments.length;
}

async function setStatus(status, error) {
  if (!session) return;
  session.status = status;
  session.error = error || null;
  await publish();
}

async function stopSession() {
  const old = session;
  if (aiJob && old && aiJob.sessionId === old.id) aiJob.controller.abort();
  if (old) await preservePendingRecording(old);
  if (session !== old) return;
  session = null;
  panelDockState = null;
  await persist();
  notifyPanels();
  if (old) await Promise.all([...(old.sourceTabId ? [softTabMessage(old.sourceTabId, 'STOP')] : []), softTabMessage(old.targetTabId, 'STOP')]);
  if (await hasOffscreen()) {
    await mediaMessage('STOP_CAPTURE').catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

function captureError(error) {
  if (/activeTab|not been invoked|Either the|permission is required/i.test(error.message)) {
    const result = new Error('Click Diffuse in Chrome’s toolbar on this production tab, then choose Enable capture & return. Chrome needs this once before screenshots or recording.');
    result.code = 'NEEDS_CAPTURE_ACCESS';
    return result;
  }
  return error;
}

async function requireActiveProduction(current) {
  const tab = await chrome.tabs.get(current.targetTabId);
  const active = await chrome.tabs.query({active: true, windowId: tab.windowId});
  if (active[0]?.id !== current.targetTabId) throw new Error('Keep the production tab active while capturing evidence.');
  return tab;
}

async function captureDraft(selection, {pending = true, forAI = false, forRecording = false} = {}) {
  if (transitioning) throw new Error('Finish choosing the reference before capturing evidence.');
  if (acceptingSuggestions.size) throw new Error('Wait for the AI suggestions to finish saving before capturing evidence.');
  if (recordingStart && !forRecording) throw new Error('Wait for the recording to start before capturing another comment.');
  if (aiJob && !forAI) throw new Error('Wait for the AI review to finish before capturing another comment.');
  if (evidenceBusy) throw new Error('An evidence capture is already in progress.');
  if (session?.recording) throw new Error('Stop the current recording before adding a screenshot comment.');
  if (!session || session.status !== 'live') throw new Error('Wait for the comparison to be Live before capturing evidence.');
  if (selection && JSON.stringify(selection).length > 150000) throw new Error('The selected element contains too much metadata. Choose a smaller element.');
  evidenceBusy = true;
  const current = session;
  try {
    const target = await requireActiveProduction(current);
    const delay = Math.max(0, lastScreenshotAt + 1050 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const prepared = await evidenceStep(tabMessage(current.targetTabId, 'PREPARE_EVIDENCE', {sessionId: current.id}), 'The page did not finish preparing its screenshot. Keep production visible and try again.');
    if (!prepared?.ok || !prepared.context) throw new Error(prepared?.error || 'Could not prepare the production screenshot.');
    const productionContext = prepared.context;
    const referenceContext = current.mode === 'audit' ? null : await tabMessage(current.sourceTabId, 'GET_CONTEXT', {sessionId: current.id});
    if (current.mode !== 'audit' && !referenceContext?.ok) throw new Error('Could not read the prototype state.');
    if (selection?.context?.scroll && (Math.abs(selection.context.scroll.x - productionContext.scroll.x) > 1 || Math.abs(selection.context.scroll.y - productionContext.scroll.y) > 1)) throw new Error('The page moved after selection. Select the element again to keep its screenshot annotation accurate.');
    if (selection?.context?.viewport && ['width', 'height', 'dpr', 'visualScale'].some(key => Number.isFinite(selection.context.viewport[key]) && selection.context.viewport[key] !== productionContext.viewport[key])) throw new Error('The page resized after selection. Select the area again at the current page size.');
    await requireActiveProduction(current);
    // Rejected calls also consume Chrome's screenshot quota.
    lastScreenshotAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, {format: 'png'});
    const capturedAt = new Date().toISOString();
    const after = await requireActiveProduction(current);
    if (after.url !== productionContext.url) throw new Error('The page navigated during capture. Select the element again.');
    const afterContext = (await tabMessage(current.targetTabId, 'GET_CONTEXT', {sessionId: current.id})).context;
    if (!afterContext || ['x', 'y'].some(key => afterContext.scroll[key] !== productionContext.scroll[key]) || ['width', 'height', 'dpr', 'visualScale'].some(key => afterContext.viewport[key] !== productionContext.viewport[key])) throw new Error('The page moved or resized during capture. Select the area again.');
    if (selection?.selector && selection.kind !== 'region') {
      const refreshed = await tabMessage(current.targetTabId, 'REFRESH_SELECTION', {sessionId: current.id, selector: selection.selector});
      if (!refreshed.selection || ['x', 'y', 'width', 'height'].some(key => Math.abs(refreshed.selection.rect.viewport[key] - selection.rect.viewport[key]) > 1)) throw new Error('The selected element moved during capture. Select it again.');
      selection = refreshed.selection;
    }
    if (session?.id !== current.id) throw new Error('The comparison ended before the screenshot was saved.');
    const {evidence} = await evidenceStep(mediaMessage('SNAPSHOT_EVIDENCE', {sessionId: current.id, includePrototype: current.mode !== 'audit', dataUrl, capturedAt, selection, viewport: productionContext.viewport}), 'The screenshots could not be processed. Keep production visible and try again.');
    const draft = {id: crypto.randomUUID(), reviewId: current.reviewId || current.id, createdAt: capturedAt, mode: current.mode || 'comparison', selection: selection || null, context: {production: productionContext, ...(referenceContext ? {prototype: referenceContext.context} : {}), alignment: {...current.settings}, browser: productionContext.browser}, evidence};
    await reviews.putDraft(draft, {id: draft.reviewId, mode: draft.mode, title: `${current.target.title || 'Page'} — design ${current.mode === 'audit' ? 'audit' : 'review'}`, createdAt: current.startedAt, updatedAt: capturedAt, productionUrl: productionContext.url, ...(referenceContext ? {prototypeUrl: referenceContext.context.url} : {})});
    if (pending && session?.id === current.id) { current.pendingDraftId = draft.id; await persist(); }
    return draft;
  } catch (error) {
    const translated = captureError(error);
    if (translated.code && session?.id === current.id) { session.captureReady = false; await publish(); }
    throw translated;
  } finally {
    await softTabMessage(current.targetTabId, 'RESTORE_EVIDENCE', {sessionId: current.id});
    evidenceBusy = false;
  }
}

async function deliverPendingDraft(current) {
  if (session?.id !== current.id || current.recording || !current.pendingDraftId) return;
  const draft = await reviews.getDraft(current.pendingDraftId);
  if (draft && session?.id === current.id && current.pendingDraftId === draft.id && !current.recording) {
    await softTabMessage(current.targetTabId, 'RECORDING_STOPPED', {sessionId: current.id, draft});
  }
}

async function preservePendingRecording(current, draftId = current.pendingDraftId) {
  if (!draftId) return;
  if (draftPreservations.has(draftId)) return draftPreservations.get(draftId);
  const preserving = (async () => {
    const draft = await reviews.getDraft(draftId);
    if (!draft || (!draft.evidence?.video && !draft.recordingId)) return;
    let saved;
    try {
      const typed = partialComposerFields(draft.composerFields, {}, draft.mode || current.mode);
      const fields = typed.comment ? {
        ...typed, component: typed.component || draft.selection?.component?.name || 'Page', state: typed.state || 'Recorded interaction',
      } : {title: 'Recording interrupted', comment: 'The session ended before this recording was submitted. Review the preserved evidence and add your feedback.', component: draft.selection?.component?.name || 'Page', state: 'Recorded interaction', severity: 'minor', category: current.mode === 'audit' ? 'ux-issue' : 'design-mismatch'};
      saved = await reviews.addComment(draft.id, fields, {evidenceChoice: draft.evidence?.video ? draft.evidenceChoice : 'screenshot'});
    } catch (error) {
      // A concurrent save/discard already consumed this draft.
      if (await reviews.getDraft(draft.id)) throw error;
      return;
    }
    if (session?.id === current.id) {
      if (current.pendingDraftId === draft.id) current.pendingDraftId = null;
      current.commentCount = saved.review.count;
      await refreshComments(current);
      await publish();
    }
  })();
  draftPreservations.set(draftId, preserving);
  try { await preserving; } finally { draftPreservations.delete(draftId); }
}

async function finishRecording(recordingId, video, {notify = false, interrupted = false} = {}) {
  let finishing = recordingFinishes.get(recordingId);
  if (!finishing) {
    finishing = (async () => {
      const current = session;
      const recordingState = current?.recording;
      if (!recordingState || recordingState.id !== recordingId) throw new Error('This recording is no longer part of the current comparison.');
      const draft = await reviews.getDraft(recordingState.draftId);
      if (!draft) throw new Error('The recording’s evidence draft was removed.');
      draft.evidence.video = video;
      draft.recordingId = recordingId;
      draft.evidenceChoice = 'video';
      await reviews.putDraft(draft);
      if (session?.id === current.id) { current.pendingDraftId = draft.id; current.recording = null; await publish(); }
      return {draft, current};
    })();
    recordingFinishes.set(recordingId, finishing);
    finishing.then(() => setTimeout(() => recordingFinishes.delete(recordingId), 60000), () => recordingFinishes.delete(recordingId));
  }
  // Finalization is shared; each caller still performs its delivery/preservation.
  // In particular, a tab-close caller must not lose its interrupted intent.
  const {draft, current} = await finishing;
  if (interrupted) await preservePendingRecording(current, draft.id);
  else if (notify) await deliverPendingDraft(current);
  return draft;
}

function partialComposerFields(input = {}, previous = {}, mode) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = {};
  for (const [key, limit] of Object.entries({title: 180, comment: 8000, expected: 8000, component: 240, state: 240, steps: 8000})) {
    const value = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : previous?.[key];
    fields[key] = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }
  fields.severity = ['minor', 'major', 'critical'].includes(source.severity) ? source.severity : ['minor', 'major', 'critical'].includes(previous?.severity) ? previous.severity : 'minor';
  fields.category = ['design-mismatch', 'ux-issue', 'copy-change'].includes(source.category) ? source.category : ['design-mismatch', 'ux-issue', 'copy-change'].includes(previous?.category) ? previous.category : mode === 'audit' ? 'ux-issue' : 'design-mismatch';
  return fields;
}

async function beginRecording(message = {}) {
  if (transitioning) throw new Error('Finish choosing the reference before recording.');
  if (!session || session.status !== 'live') throw new Error('Wait for the page to be ready before recording.');
  if (session.recording || recordingStart) throw new Error('A recording is already running or starting.');
  if (aiJob || session.aiRunning || acceptingSuggestions.size) throw new Error('Wait for the AI review action to finish before recording.');
  if (evidenceBusy) throw new Error('Wait for the current screenshot capture to finish before recording.');
  const current = session;
  const starting = {sessionId: current.id, draftId: message.draftId || null};
  recordingStart = starting;
  let draft;
  let createdDraft = false;
  let recordingId;
  let mediaStarted = false;
  let previousRecordingMetadata;
  try {
    if (message.draftId) {
      draft = await reviews.getDraft(message.draftId);
      if (!draft || draft.reviewId !== current.reviewId || draft.aiBatch || current.pendingDraftId !== draft.id) throw new Error('This comment draft is no longer available for recording.');
      if (!draft.evidence?.production?.dataUrl) throw new Error('Capture a screenshot for this comment before recording.');
    } else {
      if (current.pendingDraftId) throw new Error('Finish the open comment, or add its recording inside the comment form.');
      draft = await captureDraft(null, {forRecording: true});
      createdDraft = true;
      starting.draftId = draft.id;
    }
    if (session !== current) throw new Error('The review ended before the recording could start.');
    previousRecordingMetadata = {recordingId: draft.recordingId, evidenceChoice: draft.evidenceChoice};
    if (!createdDraft || message.fields !== undefined) {
      draft.composerFields = partialComposerFields(message.fields, draft.composerFields, draft.mode || current.mode);
      await reviews.putDraft(draft);
    }
    const target = await requireActiveProduction(current);
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: target.id});
    if (session !== current) throw new Error('The review ended before the recording could start.');
    recordingId = crypto.randomUUID();
    // Register the identity before starting media so an immediate encoder error
    // cannot be mistaken for a stale event from an earlier recording.
    current.recording = {id: recordingId, draftId: draft.id, startedAt: new Date().toISOString()};
    const response = await mediaMessage('START_RECORDING', {sessionId: current.id, recordingId, streamId, viewport: current.targetViewport});
    mediaStarted = true;
    if (session !== current || current.recording?.id !== recordingId) throw new Error('The recording could not finish starting. Your comment is still available.');
    draft.recordingId = recordingId;
    draft.evidenceChoice = 'video';
    await reviews.putDraft(draft);
    current.recording = {...response.recording, draftId: draft.id};
    await publish();
    return current.recording;
  } catch (error) {
    if (mediaStarted) await mediaMessage('STOP_RECORDING', {sessionId: current.id, recordingId}).catch(() => {});
    if (session === current && current.recording?.id === recordingId) current.recording = null;
    if (createdDraft && draft) {
      await reviews.discardDraft(draft.id);
      if (session === current && current.pendingDraftId === draft.id) current.pendingDraftId = null;
    } else if (draft && previousRecordingMetadata) {
      const retained = await reviews.getDraft(draft.id);
      if (retained && retained.recordingId === recordingId) {
        for (const key of ['recordingId', 'evidenceChoice']) {
          if (previousRecordingMetadata[key] === undefined) delete retained[key];
          else retained[key] = previousRecordingMetadata[key];
        }
        await reviews.putDraft(retained);
      }
    }
    const translated = captureError(error);
    if (session === current) {
      if (translated.code === 'NEEDS_CAPTURE_ACCESS') current.captureReady = false;
      await publish();
    }
    throw translated;
  } finally {
    if (recordingStart === starting) recordingStart = null;
  }
}

async function endRecording(options = {}) {
  const current = session;
  if (!current?.recording) throw new Error('There is no active recording.');
  const recordingId = current.recording.id;
  const response = await mediaMessage('STOP_RECORDING', {sessionId: current.id, recordingId});
  return finishRecording(recordingId, response.video, options);
}

async function initializeTab(role) {
  const current = session;
  if (!current) return;
  if (role === 'source' && current.mode === 'audit') return;
  if (role === 'target') await refreshComments(current);
  const tabId = role === 'source' ? current.sourceTabId : current.targetTabId;
  const tab = await chrome.tabs.get(tabId);
  const pattern = sitePattern(tab.url);
  if (!(await chrome.permissions.contains({origins: [pattern]}))) throw new Error('This page moved to a site that Diffuse cannot access. Open Diffuse on the prototype and start a new comparison.');
  await chrome.scripting.executeScript({target: {tabId}, files: ['inspector.js', 'content.js']});
  if (session?.id !== current.id) return;
  const response = await tabMessage(tabId, 'INITIALIZE', {role, session: current});
  if (!response?.ok) throw new Error(response?.error || 'Could not prepare the page for comparison.');
  current[role] = {title: tab.title || tab.url, url: tab.url};
  current[role === 'source' ? 'sourceViewport' : 'targetViewport'] = response.viewport;
  await publish();
  if (role === 'target') { await syncPanelDocking({force: true}); await deliverPendingDraft(current); }
}

async function connectTarget() {
  if (!session) return;
  if (session.mode === 'audit') { await setStatus('live'); return; }
  const currentId = session.id;
  const connectionId = crypto.randomUUID();
  session.connectionId = connectionId;
  await setStatus('connecting');
  await mediaMessage('CONNECT_TARGET', {sessionId: currentId, connectionId});
}

async function startSession(message) {
  if (transitioning) throw new Error('A comparison is already being prepared. Please wait.');
  if (session?.recording) throw new Error('Stop the recording before starting another comparison.');
  if (!Number.isInteger(message.sourceTabId) || !Number.isInteger(message.targetTabId) || message.sourceTabId === message.targetTabId) throw new Error('Choose two different tabs.');
  transitioning = true;
  try {
    const [source, target] = await Promise.all([chrome.tabs.get(message.sourceTabId), chrome.tabs.get(message.targetTabId)]);
    const origins = [...new Set([sitePattern(source.url), sitePattern(target.url)])];
    if (!(await chrome.permissions.contains({origins}))) throw new Error('Allow Diffuse to access these two sites before starting.');
    await stopSession();
    const id = crypto.randomUUID();
    session = {id, mode: 'comparison', reviewId: id, comments: [], commentCount: 0, captureReady: false, recording: null, sourceTabId: source.id, targetTabId: target.id, source: {title: source.title, url: source.url}, target: {title: target.title, url: target.url}, status: 'starting', settings: {...DEFAULT_SETTINGS}, startedAt: new Date().toISOString()};
    await persist();
    await ensureOffscreen();
    await initializeTab('source');
    await initializeTab('target');
    let streamId;
    try { streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: source.id}); }
    catch (error) {
      if (captureError(error).code === 'NEEDS_CAPTURE_ACCESS') {
        const access = new Error('Open the prototype tab, click Diffuse in Chrome’s toolbar, then start the comparison there. Chrome needs that toolbar invocation before capturing the prototype.');
        access.code = 'NEEDS_PROTOTYPE_ACCESS';
        throw access;
      }
      throw error;
    }
    const capture = await mediaMessage('START_CAPTURE', {sessionId: session.id, streamId, viewport: session.sourceViewport});
    session.capture = capture.capture;
    await persist();
    await connectTarget();
    await focusTab(target.id);
    return {ok: true, session};
  } catch (error) {
    await stopSession();
    throw error;
  } finally { transitioning = false; }
}

async function startAudit(message) {
  if (transitioning) throw new Error('An audit or comparison is already starting.');
  if (session?.recording) throw new Error('Stop the recording before starting an audit.');
  if (!Number.isInteger(message.targetTabId)) throw new Error('Choose a web page to audit.');
  transitioning = true;
  try {
    const target = await chrome.tabs.get(message.targetTabId);
    if (!(await chrome.permissions.contains({origins: [sitePattern(target.url)]}))) throw new Error('Allow Diffuse to access this page to start its audit.');
    await stopSession();
    const id = crypto.randomUUID();
    session = {id, mode: 'audit', reviewId: id, comments: [], commentCount: 0, captureReady: true, recording: null, targetTabId: target.id, target: {title: target.title, url: target.url}, status: 'starting', settings: {...DEFAULT_SETTINGS, hidden: true, linked: false}, startedAt: new Date().toISOString()};
    await persist();
    await ensureOffscreen();
    await mediaMessage('START_AUDIT', {sessionId: id});
    await initializeTab('target');
    await setStatus('live');
    await focusTab(target.id);
    return {ok: true, session};
  } catch (error) { await stopSession(); throw error; }
  finally { transitioning = false; }
}

function referenceBusyReason(current = session, {ownTransition = false} = {}) {
  if (!current || session !== current) return 'This review is no longer active.';
  if (transitioning && !ownTransition) return 'Finish choosing the reference before changing it again.';
  if (current.pendingDraftId) return 'Save or cancel the open comment before changing its reference.';
  if (evidenceBusy || recordingStart || current.recording || recordingFinishes.size || draftPreservations.size) return 'Finish the screenshot or recording before changing its reference.';
  if (aiJob || current.aiRunning || acceptingSuggestions.size) return 'Finish the AI review action before changing its reference.';
  return null;
}

function assertReferenceReady(current, options) {
  const reason = referenceBusyReason(current, options);
  if (reason) throw new Error(reason);
}

async function openDiff(current = session) {
  if (!current || session !== current) throw new Error('Start reviewing the current page first.');
  if (diffWindow?.sessionId === current.id) {
    try { await chrome.windows.update(diffWindow.id, {focused: true}); return {ok: true}; } catch { diffWindow = null; }
  }
  const created = await chrome.windows.create({url: chrome.runtime.getURL('diff.html') + `?session=${encodeURIComponent(current.id)}`, type: 'popup', width: 480, height: 660, focused: true});
  diffWindow = {id: created.id, sessionId: current.id};
  return {ok: true};
}

async function diffContext() {
  const current = session;
  if (!current) throw new Error('Start reviewing the current page first.');
  const target = await chrome.tabs.get(current.targetTabId);
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.id !== current.targetTabId && /^https?:\/\//.test(tab.url || ''))
    .sort((a, b) => Number(b.windowId === target.windowId) - Number(a.windowId === target.windowId))
    .map(({id, windowId, title, url}) => ({id, windowId, title, url}));
  if (session !== current) throw new Error('This review changed. Open Diff again.');
  return {ok: true, session: current, tabs, busyReason: referenceBusyReason(current)};
}

async function referenceSource(current, sourceTabId, expectedUrl) {
  if (!Number.isInteger(sourceTabId) || sourceTabId === current.targetTabId) throw new Error('Choose a different web page as the reference.');
  const source = await chrome.tabs.get(sourceTabId);
  const origin = sitePattern(source.url);
  if (expectedUrl && source.url !== expectedUrl) throw new Error('The selected reference navigated. Choose it again.');
  if (!(await chrome.permissions.contains({origins: [origin]}))) throw new Error('Allow Diffuse to read the selected reference page before continuing.');
  if (session !== current) throw new Error('This review changed. Open Diff again.');
  return source;
}

async function prepareReference(message) {
  const current = session;
  assertReferenceReady(current);
  const source = await referenceSource(current, message.sourceTabId);
  const requestId = crypto.randomUUID();
  const expectedHandle = current.sourceTabId === source.id && current.source?.url === source.url && current.referenceHandle ? current.referenceHandle : `diffuse:${crypto.randomUUID()}`;
  const result = await chrome.scripting.executeScript({target: {tabId: source.id}, world: 'MAIN', func: (handle, extensionOrigin) => {
    if (!navigator.mediaDevices?.setCaptureHandleConfig) throw new Error('This Chrome version cannot identify the selected reference tab.');
    navigator.mediaDevices.setCaptureHandleConfig({handle, permittedOrigins: [extensionOrigin], exposeOrigin: false});
    return {url: location.href, viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1}};
  }, args: [expectedHandle, chrome.runtime.getURL('').replace(/\/$/, '')]});
  assertReferenceReady(current);
  const context = result?.find(item => item.frameId === 0)?.result || result?.[0]?.result;
  if (!context || context.url !== source.url || !context.viewport?.width || !context.viewport?.height) throw new Error('The reference page changed while preparing it. Choose it again.');
  for (const [id, entry] of referenceRequests) if (entry.expiresAt < Date.now() || entry.current === current) referenceRequests.delete(id);
  referenceRequests.set(requestId, {current, source, expectedHandle, viewport: context.viewport, expiresAt: Date.now() + 120000});
  return {ok: true, requestId, expectedHandle, source: {id: source.id, title: source.title, url: source.url, windowId: source.windowId}, viewport: context.viewport};
}

function nextReferenceSession(current, source = null) {
  const next = {...current, id: crypto.randomUUID(), reviewId: current.reviewId || current.id, mode: source ? 'comparison' : 'audit', status: 'starting', error: null, warning: '', aiBatchId: null, aiRunning: false,
    settings: {...DEFAULT_SETTINGS, hidden: !source, linked: Boolean(source)}};
  for (const key of ['sourceTabId', 'source', 'sourceViewport', 'capture', 'connectionId', 'referenceEnded', 'referenceHandle']) delete next[key];
  if (source) {next.sourceTabId = source.id; next.source = {title: source.title, url: source.url};}
  return next;
}

async function recoverReferenceAsAudit(current, reason = '') {
  const next = nextReferenceSession(current);
  session = next; panelDockState = null;
  await persist();
  if (current.sourceTabId) await softTabMessage(current.sourceTabId, 'STOP', {sessionId: current.id});
  try {
    await ensureOffscreen();
    await mediaMessage('START_AUDIT', {sessionId: next.id});
    await initializeTab('target');
    await setStatus('live', reason);
  } catch (error) { next.status = 'error'; next.error = `Your saved review is preserved. ${error.message}`; await publish().catch(() => {}); }
  return next;
}

async function attachReference(message) {
  const current = session;
  assertReferenceReady(current);
  const prepared = referenceRequests.get(message.requestId);
  if (!prepared || prepared.current !== current || prepared.cancelled || prepared.expiresAt < Date.now()) throw new Error('The reference choice expired or was cancelled. Choose the reference again.');
  transitioning = true;
  let committed = false;
  let next;
  try {
    await referenceSource(current, prepared.source.id, prepared.source.url);
    await ensureOffscreen();
    const chosen = await mediaMessage('CHOOSE_REFERENCE', {sessionId: current.id, requestId: message.requestId, expectedHandle: prepared.expectedHandle, viewport: prepared.viewport});
    if (chosen.cancelled || prepared.cancelled) return {ok: true, cancelled: true, session: current};
    assertReferenceReady(current, {ownTransition: true});
    const source = await referenceSource(current, prepared.source.id, prepared.source.url);
    if (prepared.cancelled) return {ok: true, cancelled: true, session: current};
    next = nextReferenceSession(current, source);
    next.referenceHandle = prepared.expectedHandle;
    next.sourceViewport = prepared.viewport;
    const result = await mediaMessage('COMMIT_REFERENCE', {sessionId: current.id, requestId: message.requestId, newSessionId: next.id});
    committed = true;
    if (session !== current) throw new Error('This review changed while attaching its reference.');
    next.capture = result.capture || chosen.capture;
    session = next; panelDockState = null;
    await persist();
    if (current.sourceTabId) await softTabMessage(current.sourceTabId, 'STOP', {sessionId: current.id});
    await initializeTab('source');
    await initializeTab('target');
    await connectTarget();
    await focusTab(next.targetTabId);
    return {ok: true, session: next};
  } catch (error) {
    if (committed && (session === current || session === next)) await recoverReferenceAsAudit(next || current, 'The reference could not connect. Continue reviewing this page or choose another reference.');
    throw error;
  } finally {
    referenceRequests.delete(message.requestId);
    await mediaMessage('ABORT_REFERENCE', {requestId: message.requestId}).catch(() => {});
    transitioning = false;
    notifyPanels();
  }
}

async function detachReference() {
  const current = session;
  assertReferenceReady(current);
  if (current.mode === 'audit' && !current.sourceTabId) return {ok: true, session: current};
  transitioning = true;
  try {
    const next = await recoverReferenceAsAudit(current);
    await focusTab(next.targetTabId);
    return {ok: true, session: next};
  } finally { transitioning = false; notifyPanels(); }
}

async function referenceEnded(current, error) {
  if (!current || session !== current) return;
  if (!referenceBusyReason(current)) { await detachReference(); return; }
  current.referenceEnded = true;
  current.settings = {...current.settings, hidden: true};
  await setStatus('error', `${error || 'The reference stopped sharing.'} Your comments and current evidence are kept. Finish the open action, then use Diff to remove or replace the reference.`);
}

function publicBatch(draft) {
  if (!draft?.aiBatch) return null;
  return {id: draft.id, createdAt: draft.createdAt, mode: draft.mode, model: draft.aiBatch.model, summary: draft.aiBatch.summary, limitations: draft.aiBatch.limitations, context: {production: draft.context.production}, suggestions: draft.aiBatch.suggestions.filter(item => item.status === 'pending')};
}

async function currentBatch(batchId = session?.aiBatchId) {
  if (!batchId || batchId !== session?.aiBatchId) return null;
  const draft = await reviews.getDraft(batchId);
  return draft?.reviewId === session?.reviewId ? draft : null;
}

async function runAIReview(message) {
  const current = session;
  if (transitioning) throw new Error('Finish choosing the reference before running AI review.');
  if (!current) throw new Error('Start an audit or comparison first.');
  if (recordingStart || evidenceBusy || current.recording) throw new Error('Wait for the capture or recording to finish before AI review.');
  if (aiJob || acceptingSuggestions.size) throw new Error('Wait for the current AI review action to finish.');
  if (session.pendingDraftId) throw new Error('Save or cancel the open comment before running the AI review.');
  const config = await readAISettings({includeKey: true});
  if (!config.hasKey) { const error = new Error('Add your Anthropic API key in AI settings first.'); error.code = 'NEEDS_AI_KEY'; throw error; }
  if (!(await chrome.permissions.contains({origins: ['https://api.anthropic.com/*']}))) throw new Error('Open AI settings and save to allow a connection to Anthropic.');
  if (session !== current) throw new Error('This review belongs to a session that has ended.');
  if (transitioning) throw new Error('Finish choosing the reference before running AI review.');
  if (current.pendingDraftId) throw new Error('Save or cancel the open comment before running the AI review.');
  if (aiJob || acceptingSuggestions.size) throw new Error('Wait for the current AI review action to finish.');
  if (recordingStart || evidenceBusy || current.recording) throw new Error('Wait for the capture or recording to finish before AI review.');
  const job = {sessionId: current.id, controller: new AbortController()};
  aiJob = job;
  let draft;
  const timer = setTimeout(() => job.controller.abort(), 90000);
  // A finite, user-requested streamed review may take longer than the worker's idle timeout.
  const keepAlive = setInterval(() => chrome.storage.session.get('comparison').catch(() => {}), 20000);
  current.aiRunning = true;
  try {
    await publish();
    draft = await captureDraft(null, {pending: false, forAI: true});
    const images = await evidenceStep(mediaMessage('PREPARE_AI_IMAGES', {sessionId: current.id, evidence: draft.evidence}), 'The screenshots could not be prepared for AI review.');
    if (job.controller.signal.aborted || session?.id !== current.id) throw new Error('The AI review was cancelled.');
    const result = await reviewScreens({apiKey: config.apiKey, model: config.model, instructions: typeof message.instructions === 'string' ? message.instructions.trim().slice(0, 4000) : '', mode: current.mode || 'comparison', production: images.production, prototype: images.prototype, signal: job.controller.signal});
    if (job.controller.signal.aborted || session?.id !== current.id) throw new Error('The AI review was cancelled.');
    draft.aiBatch = {model: result.model || config.model, summary: result.summary, limitations: result.limitations, suggestions: result.suggestions.map(suggestion => ({...suggestion, id: crypto.randomUUID(), score: suggestion.mismatchScore, status: 'pending'}))};
    await reviews.putDraft(draft);
    const oldBatchId = current.aiBatchId;
    current.aiBatchId = draft.id;
    await persist();
    if (oldBatchId && oldBatchId !== draft.id) await reviews.discardDraft(oldBatchId);
    return {ok: true, batch: publicBatch(draft)};
  } catch (error) {
    if (draft) await reviews.discardDraft(draft.id).catch(() => {});
    if (job.controller.signal.aborted) throw new Error('The AI review was cancelled or timed out. Try again when the page is ready.');
    throw error;
  } finally {
    clearTimeout(timer); clearInterval(keepAlive);
    if (aiJob === job) aiJob = null;
    if (session?.id === current.id) { current.aiRunning = false; await publish(); }
  }
}

function selectionFromSuggestion(suggestion, context) {
  const {viewport, scroll} = context;
  const x = suggestion.region.x * viewport.width, y = suggestion.region.y * viewport.height;
  const width = suggestion.region.width * viewport.width, height = suggestion.region.height * viewport.height;
  const rect = {x, y, width, height, left: x, top: y, right: x + width, bottom: y + height};
  return {kind: 'region', component: {name: suggestion.component || 'Selected area', source: 'ai-region'}, rect: {viewport: rect, document: {...rect, x: x + scroll.x, y: y + scroll.y, left: x + scroll.x, top: y + scroll.y, right: rect.right + scroll.x, bottom: rect.bottom + scroll.y}}, context};
}

async function acceptSuggestion(message) {
  if (aiJob) throw new Error('Wait for the current AI review to finish.');
  const key = `${message.batchId}:${message.suggestionId}`;
  if (acceptingSuggestions.has(key)) throw new Error('This suggestion is already being added.');
  acceptingSuggestions.add(key);
  try {
    const current = session;
    const batch = await currentBatch(message.batchId);
    assertSuggestionSession(current, message.batchId);
    const suggestion = batch?.aiBatch.suggestions.find(item => item.id === message.suggestionId);
    if (!suggestion || suggestion.status !== 'pending') throw new Error('This suggestion has already been reviewed or replaced.');
    const existing = await reviews.getReview(current.reviewId);
    assertSuggestionSession(current, message.batchId);
    // If a worker restarted after the atomic comment save, do not add the same finding twice.
    if (!existing.comments.some(comment => comment.ai?.suggestionId === suggestion.id)) {
      const selection = selectionFromSuggestion(suggestion, batch.context.production);
      const production = await mediaMessage('ANNOTATE_EVIDENCE', {sessionId: current.id, dataUrl: batch.evidence.production.dataUrl, capturedAt: batch.evidence.production.capturedAt, selection, viewport: batch.context.production.viewport});
      assertSuggestionSession(current, message.batchId);
      let prototype = batch.evidence.prototype;
      if (suggestion.prototypeRegion && prototype?.dataUrl && batch.context.prototype?.viewport && batch.mode !== 'audit') {
        const referenceSelection = selectionFromSuggestion({...suggestion, region: suggestion.prototypeRegion}, batch.context.prototype);
        const reference = await mediaMessage('ANNOTATE_EVIDENCE', {sessionId: current.id, dataUrl: prototype.dataUrl, capturedAt: prototype.capturedAt, selection: referenceSelection, viewport: batch.context.prototype.viewport});
        assertSuggestionSession(current, message.batchId);
        prototype = reference.production;
      }
      const draft = {id: `ai-${batch.id}-${suggestion.id}`, reviewId: batch.reviewId, mode: batch.mode, createdAt: batch.createdAt, selection, context: batch.context, evidence: {...batch.evidence, production: production.production, ...(prototype ? {prototype} : {})}, ai: {provider: 'anthropic', model: batch.aiBatch.model, runId: batch.id, suggestionId: suggestion.id, mismatchScore: suggestion.mismatchScore, confidence: suggestion.confidence, reason: suggestion.reason || '', acceptedAt: new Date().toISOString(), mode: batch.mode}};
      assertSuggestionSession(current, message.batchId);
      await reviews.putDraft(draft);
      assertSuggestionSession(current, message.batchId);
      await reviews.addComment(draft.id, {...suggestion, steps: 'Open the page in the captured state and inspect the highlighted region.', ...message.fields});
    }
    assertSuggestionSession(current, message.batchId);
    suggestion.status = 'accepted';
    await reviews.putDraft(batch);
    await refreshComments(current);
    if (session?.id === current.id) await publish();
    return {ok: true, review: {id: current.reviewId, count: current.commentCount}, batch: publicBatch(batch)};
  } finally { acceptingSuggestions.delete(key); }
}

function assertSuggestionSession(current, batchId) {
  if (!current || session !== current || current.aiBatchId !== batchId) throw new Error('This suggestion batch has been replaced or its review has ended.');
  if (aiJob) throw new Error('Wait for the current AI review to finish.');
}

async function acceptSuggestions(message) {
  const ids = message.suggestionIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 12 || ids.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(ids).size !== ids.length) throw new Error('Choose 1–12 different suggestions from this review.');
  const current = session;
  assertSuggestionSession(current, message.batchId);
  if (recordingStart || evidenceBusy || current.recording) throw new Error('Wait for the capture or recording to finish before adding suggestions.');
  const batch = await currentBatch(message.batchId);
  assertSuggestionSession(current, message.batchId);
  if (!batch || ids.some(id => !batch.aiBatch.suggestions.some(item => item.id === id))) throw new Error('One or more suggestions do not belong to this review batch.');
  const initialReview = await reviews.getReview(current.reviewId);
  assertSuggestionSession(current, message.batchId);
  const previousIds = new Set(initialReview.comments.map(comment => comment.ai?.suggestionId).filter(Boolean));
  const failures = [];
  let skippedCount = 0;
  let knownAcceptedCount = 0;
  let knownReviewCount = initialReview.comments.length;
  for (const suggestionId of ids) {
    const suggestion = batch.aiBatch.suggestions.find(item => item.id === suggestionId);
    if (suggestion.status !== 'pending') { skippedCount++; continue; }
    try {
      assertSuggestionSession(current, message.batchId);
      const accepted = await acceptSuggestion({batchId: message.batchId, suggestionId});
      if (!previousIds.has(suggestionId)) knownAcceptedCount++;
      knownReviewCount = accepted.review.count;
    } catch (error) {
      failures.push({suggestionId, error: error.message || 'This suggestion could not be saved.'});
      // Keep the remaining items pending so a retry can use the fresh batch.
      break;
    }
  }
  // Count committed comments, including a save whose subsequent batch update
  // failed. A retry detects that provenance and cannot create it twice.
  let latestReview;
  try { latestReview = await reviews.getReview(current.reviewId); }
  catch (error) { failures.push({suggestionId: null, error: error.message || 'The saved review could not be refreshed.'}); }
  const acceptedCount = latestReview ? latestReview.comments.filter(comment => ids.includes(comment.ai?.suggestionId) && !previousIds.has(comment.ai.suggestionId)).length : knownAcceptedCount;
  let latestBatch = null;
  if (session === current && current.aiBatchId === message.batchId) {
    try { latestBatch = await currentBatch(message.batchId); }
    catch (error) { failures.push({suggestionId: null, error: error.message || 'The remaining suggestions could not be refreshed.'}); }
  }
  if (session !== current || current.aiBatchId !== message.batchId) {
    latestBatch = null;
    if (!failures.length) failures.push({suggestionId: null, error: 'This suggestion batch has been replaced or its review has ended.'});
  }
  return {ok: true, batch: publicBatch(latestBatch), review: {id: current.reviewId, count: latestReview?.comments.length ?? knownReviewCount}, acceptedCount, skippedCount, failures, partial: failures.length > 0};
}

async function serializeSuggestion(action) {
  const current = session;
  const batchId = current?.aiBatchId;
  const reservation = Symbol('suggestion mutation');
  acceptingSuggestions.add(reservation);
  const previous = suggestionMutation;
  let release;
  suggestionMutation = new Promise(resolve => { release = resolve; });
  await previous;
  try { assertSuggestionSession(current, batchId); return await action(); }
  finally { acceptingSuggestions.delete(reservation); release(); }
}

async function dismissSuggestion(message) {
  const current = session;
  const batch = await currentBatch(message.batchId);
  assertSuggestionSession(current, message.batchId);
  const item = batch?.aiBatch.suggestions.find(item => item.id === message.suggestionId);
  if (!item || item.status !== 'pending') throw new Error('This suggestion is no longer pending.');
  item.status = 'dismissed'; await reviews.putDraft(batch);
  return {ok: true, batch: publicBatch(batch)};
}

async function handle(message, sender) {
  await ready;
  const isPopup = sender.url === chrome.runtime.getURL('popup.html');
  const isPanel = isSidePanel(sender);
  const isReport = sender.url?.split('?')[0] === chrome.runtime.getURL('report.html');
  const isMedia = sender.url === chrome.runtime.getURL('offscreen.html');
  const isAISettings = sender.url === chrome.runtime.getURL('ai-settings.html');
  const role = session && Number.isInteger(sender.tab?.id) ? sender.tab.id === session.targetTabId ? 'target' : sender.tab.id === session.sourceTabId ? 'source' : null : null;
  const isDiff = sender.id === chrome.runtime.id && sender.url?.split('?')[0] === chrome.runtime.getURL('diff.html');
  if (isDiff) {
    if (!session || sender.url !== chrome.runtime.getURL('diff.html') + `?session=${encodeURIComponent(session.id)}` || (message.type !== 'GET_DIFF_CONTEXT' && message.sessionId !== session.id)) throw new Error('This review changed. Close this window and open Diff again.');
    if (message.type === 'GET_DIFF_CONTEXT') return diffContext();
    if (message.type === 'PREPARE_REFERENCE') return prepareReference(message);
    if (message.type === 'ATTACH_REFERENCE') return attachReference(message);
    if (message.type === 'DETACH_REFERENCE') return detachReference();
    if (message.type === 'CANCEL_REFERENCE') {
      const prepared = referenceRequests.get(message.requestId);
      if (prepared?.current === session) {prepared.cancelled = true; await mediaMessage('ABORT_REFERENCE', {requestId: message.requestId}).catch(() => {});}
      return {ok: true};
    }
    throw new Error('Unknown reference chooser command.');
  }
  if (message.type === 'OPEN_DIFF' && (isPopup || (role === 'target' && message.sessionId === session.id))) return openDiff();
  if (message.type === 'PANEL_STATE' || message.type === 'PANEL_COMMAND') return panelRequest(message, sender);
  if (message.type === 'OPEN_AI_SETTINGS' && (isPopup || isPanel || isReport || role === 'target')) { await chrome.tabs.create({url: chrome.runtime.getURL('ai-settings.html')}); return {ok: true}; }
  if (message.type === 'GET_AI_CONFIG' && (isAISettings || isPopup || isPanel || role === 'target')) return {ok: true, config: await readAISettings()};
  if (isAISettings && message.type === 'SAVE_AI_CONFIG') return {ok: true, config: await saveAISettings(message)};
  if (isAISettings && message.type === 'CLEAR_AI_KEY') return {ok: true, config: await clearAIKey()};
  if (message.type === 'GET_SESSION' && (isPopup || isPanel)) {
    const current = session;
    if (current && !transitioning && !offscreenCreation && !(await hasOffscreen()) && session === current && !transitioning && !offscreenCreation) await stopSession();
    return {ok: true, session};
  }
  if (message.type === 'START' && (isPopup || isPanel)) return startSession(message);
  if (message.type === 'START_AUDIT' && (isPopup || isPanel)) return startAudit(message);
  if (message.type === 'OPEN_REPORT' && (isPopup || isPanel || isReport || role === 'target')) {
    const id = message.reviewId || session?.reviewId;
    await chrome.tabs.create({url: chrome.runtime.getURL('report.html') + (id ? `?review=${encodeURIComponent(id)}` : '')});
    return {ok: true};
  }
  if (isReport) {
    if (message.type === 'LIST_REVIEWS') return {ok: true, reviews: await reviews.listReviews()};
    if (message.type === 'GET_REVIEW') return {ok: true, review: await reviews.getReview(message.reviewId)};
    if (message.type === 'UPDATE_COMMENT') { await reviews.updateComment(message.reviewId, message.commentId, message.fields); if (session?.reviewId === message.reviewId) { await refreshComments(); await publish(); } return {ok: true}; }
    if (message.type === 'DELETE_COMMENT') {
      await reviews.deleteComment(message.reviewId, message.commentId);
      if (session?.reviewId === message.reviewId) { await refreshComments(); await publish(); }
      return {ok: true};
    }
    if (message.type === 'DELETE_REVIEW') {
      if (transitioning && session?.reviewId === message.reviewId) throw new Error('Finish choosing the reference before deleting this review.');
      if (session?.reviewId === message.reviewId && (session.recording || recordingStart || aiJob || acceptingSuggestions.size)) throw new Error('Stop the recording or wait for the AI review action before deleting this review.');
      await reviews.deleteReview(message.reviewId);
      if (session?.reviewId === message.reviewId) { session.commentCount = 0; session.comments = []; session.pendingDraftId = null; session.aiBatchId = null; await publish(); }
      return {ok: true};
    }
    throw new Error('Unknown report command.');
  }
  if (!session) return {ok: false, error: 'There is no active comparison.'};
  if (!isPopup && !role && !isMedia) throw new Error('This page is not part of the active comparison.');
  if (!isPopup && message.sessionId !== session.id) return {ok: false, error: 'This comparison is no longer active.'};
  if (transitioning && ['STOP_SESSION', 'CAPTURE_COMMENT', 'ADD_COMMENT', 'DISCARD_DRAFT', 'START_RECORDING', 'RUN_AI_REVIEW', 'ACCEPT_AI_SUGGESTION', 'ACCEPT_AI_SUGGESTIONS', 'DISMISS_AI_SUGGESTION', 'SETTINGS', 'RECONNECT'].includes(message.type)) throw new Error('Finish choosing the reference before continuing the review.');
  switch (message.type) {
    case 'DETACH_REFERENCE':
      if (role !== 'target') throw new Error('Remove the reference from the reviewed page.');
      return detachReference();
    case 'PANEL_STATE_CHANGED':
      if (role !== 'target') throw new Error('Unknown drawer page.');
      notifyPanels(); return {ok: true};
    case 'STOP_SESSION':
      if (isMedia) throw new Error('Unsupported command.');
      if (recordingStart) throw new Error('Wait for the recording to finish starting before ending the comparison.');
      if (session.recording) await endRecording({interrupted: true});
      await stopSession(); return {ok: true};
    case 'ENABLE_EVIDENCE': {
      if (!isPopup) throw new Error('Enable capture from Diffuse in Chrome’s toolbar.');
      await requireActiveProduction(session);
      if (!session.recording) {
        try { await chrome.tabCapture.getMediaStreamId({targetTabId: session.targetTabId}); }
        catch (error) { throw captureError(error); }
      }
      session.captureReady = true;
      await publish();
      await focusTab(session.targetTabId);
      await softTabMessage(session.targetTabId, 'CAPTURE_ACCESS_GRANTED', {sessionId: session.id, session});
      return {ok: true, session};
    }
    case 'CAPTURE_COMMENT':
      if (role !== 'target') throw new Error('Select an element on the production page.');
      return {ok: true, draft: await captureDraft(message.selection)};
    case 'ADD_COMMENT': {
      if (role !== 'target') throw new Error('Save comments from the comparison page.');
      if (session.recording || recordingStart) throw new Error('Stop the recording before saving this comment.');
      const draft = await reviews.getDraft(message.draftId);
      if (!draft || draft.reviewId !== session.reviewId) throw new Error('This evidence belongs to a different comparison.');
      if (session.recording || recordingStart) throw new Error('Stop the recording before saving this comment.');
      if (message.evidenceChoice === 'video' && !draft.evidence?.video) throw new Error('Record a clip first, or choose Screenshot before saving.');
      const saved = await reviews.addComment(message.draftId, message.fields, {evidenceChoice: message.evidenceChoice});
      session.commentCount = saved.review.count;
      await refreshComments();
      if (session.pendingDraftId === message.draftId) session.pendingDraftId = null;
      await publish();
      return {ok: true, review: {id: saved.review.id, count: saved.review.count}};
    }
    case 'GET_COMMENT': {
      if (role !== 'target') throw new Error('Open the comment on the audited page.');
      const review = await reviews.getReview(session.reviewId);
      const comment = review.comments.find(item => item.id === message.commentId);
      if (!comment) throw new Error('This comment is no longer available.');
      return {ok: true, comment};
    }
    case 'RUN_AI_REVIEW':
      if (role !== 'target') throw new Error('Run AI review from the audited page.');
      return runAIReview(message);
    case 'GET_AI_SUGGESTIONS':
      if (role !== 'target') throw new Error('Open AI suggestions on the audited page.');
      return {ok: true, batch: publicBatch(await currentBatch())};
    case 'ACCEPT_AI_SUGGESTION':
      if (role !== 'target') throw new Error('Review suggestions on the audited page.');
      return serializeSuggestion(() => acceptSuggestion(message));
    case 'ACCEPT_AI_SUGGESTIONS':
      if (role !== 'target') throw new Error('Review suggestions on the audited page.');
      return serializeSuggestion(() => acceptSuggestions(message));
    case 'DISMISS_AI_SUGGESTION':
      if (role !== 'target') throw new Error('Review suggestions on the audited page.');
      return serializeSuggestion(() => dismissSuggestion(message));
    case 'DISCARD_DRAFT': {
      if (role !== 'target') throw new Error('Unknown comparison page.');
      if (session.recording || recordingStart) throw new Error('Stop the recording before discarding this comment.');
      const draft = await reviews.getDraft(message.draftId);
      if (session.recording || recordingStart) throw new Error('Stop the recording before discarding this comment.');
      if (draft?.reviewId === session.reviewId) await reviews.discardDraft(draft.id);
      if (session.pendingDraftId === message.draftId) { session.pendingDraftId = null; await persist(); }
      return {ok: true};
    }
    case 'START_RECORDING':
      if (role !== 'target') throw new Error('Start recording from the production page.');
      return {ok: true, recording: await beginRecording(message)};
    case 'STOP_RECORDING':
      if (role !== 'target') throw new Error('Stop recording from the production page.');
      if (recordingStart) throw new Error('Wait for the recording to finish starting.');
      return {ok: true, draft: await endRecording()};
    case 'RECORDING_FINISHED':
      if (!isMedia) throw new Error('Unsupported recording event.');
      await finishRecording(message.recordingId, message.video, {notify: true});
      return {ok: true};
    case 'RECORDING_ERROR': {
      if (!isMedia) throw new Error('Unsupported recording event.');
      if (message.recordingId !== session.recording?.id) return {ok: true};
      const draft = session.recording ? await reviews.getDraft(session.recording.draftId) : null;
      session.recording = null;
      await publish();
      await softTabMessage(session.targetTabId, 'RECORDING_STOPPED', {sessionId: session.id, draft, error: message.error});
      return {ok: true};
    }
    case 'FOCUS_SOURCE':
      if (session.sourceTabId) await focusTab(session.sourceTabId); return {ok: true};
    case 'FOCUS_TARGET':
      await focusTab(session.targetTabId); return {ok: true};
    case 'SETTINGS':
      if (role !== 'target') throw new Error('Settings must come from the comparison page.');
      session.settings = safeSettings(message.settings, session.settings);
      await publish(); return {ok: true};
    case 'VIEWPORT':
      if (!role) throw new Error('Unknown page.');
      session[role === 'source' ? 'sourceViewport' : 'targetViewport'] = message.viewport;
      if (role === 'source') await mediaMessage('RESIZE_CAPTURE', {sessionId: session.id, viewport: message.viewport});
      await publish(); return {ok: true};
    case 'SCROLL': {
      if (role !== 'target' || session.mode === 'audit' || !session.settings.linked) return {ok: true};
      const result = await softTabMessage(session.sourceTabId, 'APPLY_SCROLL', {sessionId: session.id, scroll: message.scroll});
      return result || {ok: false, error: 'Prototype is reconnecting.'};
    }
    case 'RTC_OFFER': {
      if (!isMedia || message.connectionId !== session.connectionId) return {ok: true};
      const response = await tabMessage(session.targetTabId, 'RTC_OFFER', {sessionId: session.id, connectionId: message.connectionId, description: message.description});
      if (!response?.ok) throw new Error(response?.error || 'The comparison page could not receive the live stream.');
      return {ok: true};
    }
    case 'RTC_ANSWER':
      if (role !== 'target' || message.connectionId !== session.connectionId) return {ok: true};
      await mediaMessage('RTC_ANSWER', {sessionId: session.id, connectionId: message.connectionId, description: message.description});
      return {ok: true};
    case 'RTC_CONNECTED': {
      if (role !== 'target' || message.connectionId !== session.connectionId) return {ok: true};
      const capture = await mediaMessage('CAPTURE_STATUS');
      if (!capture.active || capture.sessionId !== session.id) throw new Error('The prototype capture is no longer active.');
      await setStatus('live');
      await softTabMessage(session.targetTabId, 'SYNC_NOW', {sessionId: session.id});
      return {ok: true};
    }
    case 'RECONNECT':
      if (role !== 'target' || transitioning) return {ok: true};
      await connectTarget(); return {ok: true};
    case 'STREAM_STATUS':
      if (!isMedia && role !== 'target') throw new Error('Unsupported status update.');
      await setStatus(message.status === 'live' ? 'live' : 'reconnecting'); return {ok: true};
    case 'STREAM_ENDED':
      if (!isMedia) throw new Error('Unsupported status update.');
      await referenceEnded(session, message.error);
      return {ok: true};
    default: throw new Error('Unknown comparison command.');
  }
}

chrome.runtime.onConnect?.addListener(port => {
  if (port.name !== 'diffuse-sidepanel' || !isSidePanel(port.sender || {})) { port.disconnect(); return; }
  const attachment = {connected: true, visible: false, windowId: null, documentId: port.sender.documentId, queue: Promise.resolve()};
  panelPorts.set(port, attachment);
  port.onMessage.addListener(message => {
    attachment.queue = attachment.queue.catch(() => {}).then(async () => {
      await ready;
      if (!attachment.connected) return;
      if (message?.type === 'ATTACH') {
        const windowId = message.windowId;
        if (!Number.isInteger(windowId) || windowId < 0 || (Number.isInteger(port.sender.tab?.windowId) && port.sender.tab.windowId !== windowId)) throw new Error('The drawer window is unavailable. Reopen Diffuse.');
        const active = await chrome.tabs.query({active: true, windowId});
        if (!active.length) throw new Error('The drawer window is no longer available.');
        if (!attachment.connected) return;
        attachment.windowId = windowId;
        attachment.visible = message.visible !== false;
        port.postMessage({type: 'ATTACHED', windowId, sessionId: session?.id || null});
      } else if (message?.type === 'VISIBILITY') {
        if (attachment.windowId === null || typeof message.visible !== 'boolean') throw new Error('Attach this drawer before changing its visibility.');
        attachment.visible = message.visible;
      } else throw new Error('Unknown drawer connection message.');
      await syncPanelDocking();
      notifyPanels();
    }).catch(error => { if (attachment.connected) { try { port.postMessage({type: 'ERROR', error: error.message}); } catch {} } });
  });
  port.onDisconnect.addListener(() => {
    attachment.connected = false;
    panelPorts.delete(port);
    ready.then(() => syncPanelDocking()).catch(() => {});
  });
});

function nativePanelVisibility(info, visible) {
  ready.then(async () => {
    const windowId = Number.isInteger(info?.windowId) ? info.windowId : Number.isInteger(info?.tabId) ? (await chrome.tabs.get(info.tabId)).windowId : null;
    for (const attachment of panelPorts.values()) if (attachment.windowId === windowId) attachment.visible = visible;
    await syncPanelDocking();
    notifyPanels();
  }).catch(() => {});
}
chrome.sidePanel?.onOpened?.addListener(info => nativePanelVisibility(info, true));
chrome.sidePanel?.onClosed?.addListener(info => nativePanelVisibility(info, false));
chrome.tabs.onActivated?.addListener(() => { ready.then(async () => { await syncPanelDocking(); notifyPanels(); }).catch(() => {}); });
chrome.windows?.onFocusChanged?.addListener(() => { ready.then(async () => { await syncPanelDocking(); notifyPanels(); }).catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.namespace !== 'diffuse' || message.target !== 'worker') return;
  // Chrome requires this call in the original user-gesture stack, before ready or any tab query.
  if (message.type === 'OPEN_SIDE_PANEL') {
    try {
      const popup = sender.url === chrome.runtime.getURL('popup.html');
      const target = session && sender.tab?.id === session.targetTabId && sender.frameId === 0 && message.sessionId === session.id;
      if (!popup && !target) throw new Error('Open the drawer from Diffuse on the production page or Chrome toolbar.');
      const windowId = target ? sender.tab.windowId : message.windowId;
      if (!Number.isInteger(windowId) || windowId < 0) throw new Error('The Chrome window is unavailable. Reopen Diffuse from its toolbar icon.');
      if (!chrome.sidePanel?.open) throw new Error('The drawer requires Chrome 116 or later. Use the controls on the page.');
      const opened = chrome.sidePanel.open({windowId});
      Promise.resolve(opened).then(() => respond({ok: true}), error => respond({ok: false, error: error.message || 'Chrome could not open the drawer. Use the Diffuse toolbar icon.'}));
    } catch (error) { respond({ok: false, error: error.message}); }
    return true;
  }
  handle(message, sender).then(respond, error => respond({ok: false, error: error.message, code: error.code}));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  (async () => {
    await ready;
    if (!session || transitioning) return;
    const role = tabId === session.targetTabId ? 'target' : tabId === session.sourceTabId ? 'source' : null;
    if (!role) return;
    if (change.status === 'loading') await setStatus('reconnecting');
    if (change.status === 'complete') {
      await initializeTab(role);
      if (role === 'target') await connectTarget();
      else {
        await mediaMessage('RESIZE_CAPTURE', {sessionId: session.id, viewport: session.sourceViewport});
        await softTabMessage(session.targetTabId, 'SYNC_NOW', {sessionId: session.id});
        await softTabMessage(session.targetTabId, 'CHECK_FRAME', {sessionId: session.id});
      }
    } else if (change.url) {
      session[role].url = change.url;
      await publish();
    }
  })().catch(error => setStatus('error', error.message));
});

chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(async () => {
    if (session && tabId === session.sourceTabId) {
      await referenceEnded(session, 'The reference tab was closed.');
    } else if (session && tabId === session.targetTabId) {
      if (session.recording) await endRecording({interrupted: true}).catch(() => {});
      await stopSession();
    }
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => { chrome.storage.session.remove('comparison'); reviews.removeExpiredDrafts().catch(() => {}); });
