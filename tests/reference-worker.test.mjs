import {createViewportController} from '../extension/viewport-controller.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {assertPageAccess, isReviewableUrl} from '../extension/core.mjs';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const event = () => ({listeners: [], addListener(fn) {this.listeners.push(fn);}, emit(...args) {this.listeners.forEach(fn => fn(...args));}});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const viewport = {width: 1200, height: 800, dpr: 1, visualScale: 1};
const initialSession = () => ({id: 'session', reviewId: 'saved-review', startedAt: '2026-09-25T00:00:00Z', mode: 'audit', status: 'live', targetTabId: 2, target: {url: 'https://review.test/page', title: 'Reviewed page'}, targetViewport: viewport, settings: {hidden: true}, captureReady: true, commentCount: 1, aiBatchId: 'previous-batch'});

async function harness(initial = initialSession()) {
  const comments = [{id: 'saved-comment', mode: 'audit', createdAt: '2026-09-25T00:01:00Z', fields: {comment: 'Keep this exact feedback'}, evidence: {production: {dataUrl: 'data:image/png;base64,YQ=='}}, context: {production: {url: 'https://review.test/page'}}, selection: {kind: 'region'}}];
  const tabs = new Map([[2, {id: 2, windowId: 7, url: 'https://review.test/page', title: 'Reviewed page'}], [3, {id: 3, windowId: 7, url: 'https://reference.test/a', title: 'Reference A'}], [4, {id: 4, windowId: 8, url: 'https://reference.test/b', title: 'Reference B'}], [5, {id: 5, windowId: 7, url: 'chrome://settings', title: 'Settings'}]]);
  tabs.set(6, {id: 6, windowId: 7, url: 'file:///tmp/diffuse-fixture.html', title: 'Local reference'});
  const state = {media: [], tabMessages: [], scripts: [], comments, storeWrites: 0, permission: true, fileAccess: false, chooseGate: null, chooseCancelled: false, failCommit: false, failSourceInit: false, mediaSession: initial.id, metrics: new Map(), debuggerTabs: new Set()};
  const chrome = {
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onInstalled: event(), getContexts: async () => [{}],
      sendMessage: async message => {
        state.media.push(structuredClone(message));
        if (message.type === 'CHOOSE_REFERENCE') {if (state.chooseGate) await state.chooseGate.promise; return {ok: true, cancelled: state.chooseCancelled, capture: {width: 1200, height: 800}};}
        if (message.type === 'COMMIT_REFERENCE') {if (state.failCommit) return {ok: false, error: 'Selected tab identity changed'}; assert.equal(message.sessionId, state.mediaSession); state.mediaSession = message.newSessionId;}
        if (message.type === 'START_AUDIT') state.mediaSession = message.sessionId;
        return {ok: true};
      }},
    storage: {session: {get: async () => ({comparison: structuredClone(initial)}), set: async () => {}}},
    tabs: {onUpdated: event(), onRemoved: event(),
      get: async id => {if (!tabs.has(id)) throw new Error('Tab closed'); return structuredClone(tabs.get(id));},
      query: async query => query.active ? [tabs.get(2)] : [...tabs.values()], update: async () => ({}),
      sendMessage: async (id, message) => {state.tabMessages.push({id, ...structuredClone(message)}); if (message.type === 'INITIALIZE' && message.role === 'source' && state.failSourceInit) throw new Error('Reference page disconnected'); return {ok: true, viewport:state.metrics.get(id)||viewport,context:{viewport:state.metrics.get(id)||viewport}};}},
    windows: {create: async () => ({id: 90}), update: async () => ({})},
    permissions: {contains: async () => state.permission},
    extension: {isAllowedFileSchemeAccess: async () => state.fileAccess},
    debugger: {getTargets:async()=>[...tabs.keys()].map(tabId=>({tabId,attached:state.debuggerTabs.has(tabId)})),attach:async({tabId})=>{state.debuggerTabs.add(tabId);},detach:async({tabId})=>{state.debuggerTabs.delete(tabId);},sendCommand:async({tabId},method,params)=>{if(method==='Emulation.setDeviceMetricsOverride')state.metrics.set(tabId,{width:params.width,height:params.height,dpr:1,visualScale:1});if(method==='Emulation.clearDeviceMetricsOverride')state.metrics.delete(tabId);}},
    scripting: {executeScript: async options => {state.scripts.push(options); return options.world === 'MAIN' ? [{frameId: 0, result: {url: tabs.get(options.target.tabId).url, viewport}}] : []; }},
    offscreen: {closeDocument: async () => {}},
  };
  const reviews = {getReview: async () => ({comments: structuredClone(comments)}), putDraft: async () => {state.storeWrites++;}, discardDraft: async () => {state.storeWrites++;}};
  const context = vm.createContext({createViewportController,chrome, reviews, crypto: webcrypto, AbortController, DEFAULT_SETTINGS: {opacity: .55, reveal: 50, offsetX: 0, offsetY: 0}, viewportWarning: () => '',
    isReviewableUrl, assertPageAccess: (url, chromeApi = chrome, message) => assertPageAccess(url, chromeApi, message),
    protectAIStorage: async () => {}, readAISettings: async () => ({hasKey: false}), setTimeout, clearTimeout, setInterval, clearInterval});
  vm.runInContext(source.replace(/^import .*\n/gm, '') + `globalThis.api = {ready, handle, referenceBusyReason,
    current() {return session;}, replace(value) {session = value;},
    expire(id) {referenceRequests.get(id).expiresAt = 0;},
    busy(kind) {if(kind==='capture')evidenceBusy=true; if(kind==='recordingStart')recordingStart={}; if(kind==='ai')aiJob={}; if(kind==='accept')acceptingSuggestions.add('test'); if(kind==='finalizing')recordingFinishes.set('clip',{}); if(kind==='transition')transitioning=true;}
  };`, context);
  await context.api.ready;
  const sender = id => ({id: 'test', url: `chrome-extension://test/diff.html?session=${encodeURIComponent(id)}`});
  const send = (type, data = {}, from = sender(context.api.current().id)) => context.api.handle({type, sessionId: context.api.current().id, ...data}, from);
  const prepare = (id = 3) => send('PREPARE_REFERENCE', {sourceTabId: id});
  return {...context.api, state, tabs, chrome, send, sender, prepare};
}

test('Diff context is read-only, scoped to the exact helper session, and excludes the reviewed page', async () => {
  const worker = await harness(); worker.current().pendingDraftId = 'draft';
  const result = await worker.send('GET_DIFF_CONTEXT');
  assert.deepEqual(Array.from(result.tabs, tab => tab.id), [3, 6, 4], 'Local files are selectable references; access is checked before preparation'); assert.match(result.busyReason, /open comment/);
  assert.equal(worker.state.media.length, 0); assert.equal(worker.state.scripts.length, 0);
  await assert.rejects(worker.send('GET_DIFF_CONTEXT', {}, worker.sender('stale')), /review changed/);
  await assert.rejects(worker.send('PREPARE_REFERENCE', {sourceTabId: 3}, {id: 'test', url: 'https://review.test/page', tab: {id: 2}}), /Unknown comparison command/);
});

test('preparation validates reference permissions and binds a main-world capture handle without changing the review', async () => {
  const worker = await harness(); const before = structuredClone(worker.current());
  worker.state.permission = false; await assert.rejects(worker.prepare(), /Allow Diffuse/); assert.equal(worker.state.scripts.length, 0);
  worker.state.permission = true; await assert.rejects(worker.prepare(2), /different page/); await assert.rejects(worker.prepare(5), /Chrome internal pages/);
  const result = await worker.prepare();
  assert.match(result.expectedHandle, /^diffuse:/); assert.equal(result.source.id, 3);
  assert.equal(worker.state.scripts[0].world, 'MAIN'); assert.equal(worker.state.scripts[0].args[1], 'chrome-extension://test');
  assert.deepEqual(worker.current(), before); assert.equal(worker.state.media.length, 0); assert.equal(worker.state.storeWrites, 0);
});

test('local reference preparation requires both file access and host permission, rechecked before attachment', async () => {
  const worker = await harness(); const before = worker.current();
  await assert.rejects(worker.prepare(6), error => error.code === 'FILE_ACCESS_REQUIRED');
  assert.equal(worker.state.scripts.length, 0);
  worker.state.fileAccess = true; worker.state.permission = false;
  await assert.rejects(worker.prepare(6), /Allow Diffuse/);
  assert.equal(worker.state.scripts.length, 0);
  worker.state.permission = true;
  const prepared = await worker.prepare(6);
  assert.equal(prepared.source.url, 'file:///tmp/diffuse-fixture.html');
  worker.state.fileAccess = false;
  await assert.rejects(worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId}), error => error.code === 'FILE_ACCESS_REQUIRED');
  assert.equal(worker.current(), before);
  assert.equal(worker.state.media.some(message => message.type === 'CHOOSE_REFERENCE' || message.type === 'COMMIT_REFERENCE'), false);
});

test('reference changes wait for pending evidence, recording, AI and queued mutations', async () => {
  for (const kind of ['capture', 'recordingStart', 'ai', 'accept', 'finalizing', 'transition', 'draft', 'recording']) {
    const worker = await harness();
    if (kind === 'draft') worker.current().pendingDraftId = 'draft'; else if (kind === 'recording') worker.current().recording = {id: 'recording'}; else worker.busy(kind);
    await assert.rejects(worker.prepare(), /Finish|Save/);
    await assert.rejects(worker.send('DETACH_REFERENCE'), /Finish|Save/);
    assert.equal(worker.state.media.length, 0);
  }
});

test('native cancellation and failed commit preserve the previous session and every saved comment', async () => {
  for (const kind of ['cancel', 'commit']) {
    const worker = await harness(); const current = worker.current(); const before = structuredClone(current);
    const prepared = await worker.prepare(); worker.state.chooseCancelled = kind === 'cancel'; worker.state.failCommit = kind === 'commit';
    if (kind === 'cancel') assert.equal((await worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId})).cancelled, true);
    else await assert.rejects(worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId}), /identity changed/);
    assert.equal(worker.current(), current); assert.deepEqual(worker.current(), before); assert.equal(worker.state.storeWrites, 0);
    assert.equal(worker.state.media.at(-1).type, 'ABORT_REFERENCE');
  }
});

test('attaching and removing a reference rotate only the live session while retaining review identity and old evidence', async () => {
  const worker = await harness(); const old = worker.current(); const saved = structuredClone(worker.state.comments);
  const prepared = await worker.prepare(); const attached = await worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId});
  assert.notEqual(attached.session.id, old.id); assert.equal(attached.session.reviewId, old.reviewId); assert.equal(attached.session.startedAt, old.startedAt);
  assert.equal(attached.session.mode, 'comparison'); assert.equal(attached.session.sourceTabId, 3); assert.equal(attached.session.referenceHandle, prepared.expectedHandle);
  assert.equal(attached.session.captureReady, true); assert.equal(attached.session.aiBatchId, null); assert.equal(attached.session.commentCount, 1);
  const detached = await worker.send('DETACH_REFERENCE');
  assert.notEqual(detached.session.id, attached.session.id); assert.equal(detached.session.mode, 'audit'); assert.equal(detached.session.sourceTabId, undefined);
  assert.equal(detached.session.reviewId, old.reviewId); assert.equal(detached.session.commentCount, 1); assert.equal(detached.session.status, 'live');
  assert.deepEqual(worker.state.comments, saved); assert.equal(worker.state.storeWrites, 0);
});

test('same-reference preparation reuses the live handle so cancellation does not end the current stream', async () => {
  const initial = {...initialSession(), mode: 'comparison', sourceTabId: 3, source: {url: 'https://reference.test/a'}, referenceHandle: 'diffuse:already-live'};
  const worker = await harness(initial); const prepared = await worker.prepare();
  assert.equal(prepared.expectedHandle, initial.referenceHandle); assert.equal(worker.state.scripts[0].args[0], initial.referenceHandle);
  worker.state.chooseCancelled = true; await worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId});
  assert.equal(worker.current().referenceHandle, initial.referenceHandle); assert.equal(worker.current().id, initial.id);
});

test('a post-commit controller failure recovers to a page review with the same saved review', async () => {
  const worker = await harness(); const prepared = await worker.prepare(); worker.state.failSourceInit = true;
  await assert.rejects(worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId}), /disconnected/);
  assert.equal(worker.current().mode, 'audit'); assert.equal(worker.current().reviewId, 'saved-review'); assert.equal(worker.current().status, 'live');
  assert.equal(worker.state.mediaSession, worker.current().id); assert.equal(worker.state.storeWrites, 0);
});

test('closed helpers cancel pending consent and no late result commits', async () => {
  const worker = await harness(); const current = worker.current(); const prepared = await worker.prepare();
  worker.state.chooseGate = deferred();
  const choosing = worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId}); await new Promise(setImmediate);
  await worker.send('CANCEL_REFERENCE', {requestId: prepared.requestId}); worker.state.chooseGate.resolve();
  assert.equal((await choosing).cancelled, true); assert.equal(worker.current(), current);
  assert.equal(worker.state.media.some(message => message.type === 'COMMIT_REFERENCE'), false);
});

test('expired, navigated and replaced-session preparations cannot commit', async () => {
  for (const kind of ['expired', 'navigated', 'replaced']) {
    const worker = await harness(); const prepared = await worker.prepare();
    if (kind === 'expired') worker.expire(prepared.requestId);
    if (kind === 'navigated') worker.tabs.get(3).url = 'https://reference.test/other-page';
    if (kind === 'replaced') worker.replace({...initialSession(), id: 'new-session'});
    await assert.rejects(worker.send('ATTACH_REFERENCE', {requestId: prepared.requestId}), /expired|navigated/);
    assert.equal(worker.state.media.some(message => message.type === 'COMMIT_REFERENCE'), false);
  }
});

test('source loss returns an idle review to the page but preserves an open comment', async () => {
  for (const pending of [false, true]) {
    const worker = await harness({...initialSession(), mode: 'comparison', sourceTabId: 3, source: {url: 'https://reference.test/a'}, ...(pending ? {pendingDraftId: 'open-draft'} : {})});
    await worker.send('STREAM_ENDED', {error: 'Sharing ended'}, {id: 'test', url: 'chrome-extension://test/offscreen.html'});
    assert.equal(worker.current().reviewId, 'saved-review'); assert.equal(worker.state.storeWrites, 0);
    if (pending) {assert.equal(worker.current().pendingDraftId, 'open-draft'); assert.equal(worker.current().settings.hidden, true); assert.equal(worker.state.media.length, 0);}
    else {assert.equal(worker.current().mode, 'audit'); assert.equal(worker.current().status, 'live');}
  }
});

 test('a newly attached reference inherits the chosen viewport before its stream is resized and connected', async () => {
  const worker=await harness();
  await worker.send('VIEWPORT_PRESET',{preset:'phone'},{id:'test',tab:{id:2,windowId:7},frameId:0,url:'https://review.test/page'});
  assert.equal(worker.current().viewportPreset,'phone');
  const prepared=await worker.prepare();await worker.send('ATTACH_REFERENCE',{requestId:prepared.requestId});
  const resized=worker.state.media.findLast(item=>item.type==='RESIZE_CAPTURE');
  assert.equal(resized.viewport.width,390);assert.equal(resized.viewport.height,844);
  assert.ok(worker.state.media.indexOf(resized)<worker.state.media.findLastIndex(item=>item.type==='CONNECT_TARGET'));
  assert.deepEqual(Array.from(worker.current().viewportDebuggerTabs),[2,3]);
});
