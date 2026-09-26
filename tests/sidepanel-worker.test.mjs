import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const event = () => ({listeners: [], addListener(listener) { this.listeners.push(listener); }, emit(...args) { return this.listeners.map(listener => listener(...args)); }});
const currentSession = () => ({id: 'session', reviewId: 'review', mode: 'audit', targetTabId: 2, sourceTabId: 1, target: {}, source: {}, status: 'live', settings: {}, comments: []});
const panelSender = (extra = {}) => ({id: 'test', url: 'chrome-extension://test/sidepanel.html', documentId: 'panel-document', ...extra});
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function harness({initial = currentSession(), waitForStorage = null} = {}) {
  const state = {active: new Map([[7, 2], [8, 3]]), messages: [], opened: [], captures: 0, savedDrafts: [], getTabGate: null};
  const contextData = {url: 'https://example.test/production', viewport: {width: 900, height: 800, dpr: 1, visualScale: 1}, scroll: {x: 0, y: 0}};
  const chrome = {
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onInstalled: event(), onConnect: event(),
      getContexts: async () => [{}], sendMessage: async message => ({ok: true, evidence: {production: {dataUrl: message.dataUrl}}})},
    storage: {session: {get: async () => {if (waitForStorage) await waitForStorage.promise; return {comparison: structuredClone(initial)};}, set: async () => {}}},
    tabs: {
      onUpdated: event(), onRemoved: event(), onActivated: event(),
      get: async id => {if (state.getTabGate) await state.getTabGate.promise; return {id, windowId: id === 3 ? 8 : 7, url: `https://example.test/${id === 2 ? 'production' : 'prototype'}`};},
      query: async ({windowId}) => state.active.has(windowId) ? [{id: state.active.get(windowId), windowId}] : [],
      update: async (id, change) => {if (change.active) state.active.set(id === 3 ? 8 : 7, id);},
      create: async () => ({}), captureVisibleTab: async () => {state.captures++; return 'data:image/png;base64,YQ==';},
      sendMessage: async (tabId, message) => {
        assert.equal(message.target, undefined, 'Content ignores messages that retain an offscreen/worker target');
        state.messages.push({tabId, ...structuredClone(message)});
        if (message.type === 'GET_CONTEXT' || message.type === 'PREPARE_EVIDENCE') return {ok: true, context: contextData};
        if (message.type === 'PANEL_STATE') return {ok: true, state: {draftId: message.knownDraftId || null, evidenceKey: message.knownEvidenceKey || null}};
        if (message.type === 'INITIALIZE') return {ok: true, viewport: contextData.viewport};
        return {ok: true};
      },
    },
    windows: {onFocusChanged: event(), update: async () => ({})},
    sidePanel: {open: options => {state.opened.push(options); return Promise.resolve();}, onOpened: event(), onClosed: event()},
    permissions: {contains: async () => true}, scripting: {executeScript: async () => []},
    offscreen: {closeDocument: async () => {}},
  };
  const reviews = {getReview: async () => ({comments: []}), putDraft: async draft => {state.savedDrafts.push(draft);}};
  const context = vm.createContext({chrome, reviews, crypto: webcrypto, AbortController, DEFAULT_SETTINGS: {}, viewportWarning: () => '', sitePattern: url => url,
    protectAIStorage: async () => {}, readAISettings: async () => ({hasKey: false}), setTimeout, clearTimeout, setInterval, clearInterval});
  vm.runInContext(source.replace(/^import .*\n/gm, '') + `
    globalThis.api = {ready, handle, captureDraft, initializeTab, publish, syncPanelDocking,
      setSession(value) {session = value;}, getSession() {return session;},
      async flushPanels() {await Promise.all([...panelPorts.values()].map(item => item.queue)); await panelDocking;}
    };`, context, {filename: 'background.js'});
  const connect = (sender = panelSender()) => {
    const port = {name: 'diffuse-sidepanel', sender, onMessage: event(), onDisconnect: event(), messages: [],
      postMessage(message) {this.messages.push(structuredClone(message));}, disconnect() {this.disconnected = true; this.onDisconnect.emit();}};
    chrome.runtime.onConnect.emit(port); return port;
  };
  const attach = async (sender = panelSender(), windowId = 7) => {const port = connect(sender); port.onMessage.emit({type: 'ATTACH', windowId}); await context.api.flushPanels(); return port;};
  if (!waitForStorage) await context.api.ready;
  return {...context.api, chrome, state, connect, attach, contextData, send: (message, sender = panelSender()) => context.api.handle(message, sender)};
}

test('only the exact sidepanel document can attach; its connection is required for requests', async () => {
  const worker = await harness();
  for (const sender of [panelSender({id: 'foreign'}), panelSender({url: 'chrome-extension://test/sidepanel.html.evil'}), panelSender({url: 'https://example.test/sidepanel.html'})]) {
    assert.equal(worker.connect(sender).disconnected, true);
    await assert.rejects(worker.send({type: 'PANEL_STATE', windowId: 7}, sender), /Open this drawer/);
  }
  await assert.rejects(worker.send({type: 'PANEL_STATE', windowId: 7}), /no longer attached/);
  const sender = panelSender({url: 'chrome-extension://test/sidepanel.html?window=7'});
  await worker.attach(sender);
  assert.equal((await worker.send({type: 'PANEL_STATE', windowId: 7}, sender)).ok, true);
  await assert.rejects(worker.send({type: 'PANEL_STATE', windowId: 7}, panelSender({documentId: 'other-document'})), /no longer attached/);
});

test('panel bridge rejects stale sessions and commands outside its allowlist without forwarding', async () => {
  const worker = await harness(); await worker.attach(); worker.state.messages = [];
  await assert.rejects(worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'old', action: 'saveComment'}), /no longer active/);
  await assert.rejects(worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'CAPTURE_COMMENT'}), /Unknown drawer/);
  for (const type of ['CAPTURE_COMMENT', 'SETTINGS', 'RUN_AI_REVIEW', 'ENABLE_EVIDENCE']) await assert.rejects(worker.send({type, sessionId: 'session'}), /not part/);
  assert.equal(worker.state.messages.length, 0);
});

test('panel requests stay attached to their target window and active tab, while focus recovery works', async () => {
  const worker = await harness();
  const anotherWindow = panelSender({documentId: 'wrong-window'});
  await worker.attach(anotherWindow, 8);
  const elsewhere = await worker.send({type: 'PANEL_STATE', windowId: 8}, anotherWindow);
  assert.equal(elsewhere.ok, true); assert.equal(elsewhere.state.active, false); assert.match(elsewhere.state.message, /another Chrome window/);
  await worker.attach(); worker.state.messages = []; worker.state.active.set(7, 1);
  const result = await worker.send({type: 'PANEL_STATE', windowId: 7});
  assert.equal(result.ok, true); assert.equal(result.session.id, 'session'); assert.equal(result.state.active, false);
  const command = await worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'runAi'});
  assert.equal(command.ok, false); assert.equal(worker.state.messages.length, 0);
  assert.equal((await worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'focusTarget'})).ok, true);
  assert.equal(worker.state.active.get(7), 2);
});

test('state payload caching and allowed commands use the real content bridge', async () => {
  const worker = await harness(); await worker.attach(); worker.state.messages = [];
  const result = await worker.send({namespace: 'diffuse', target: 'worker', type: 'PANEL_STATE', windowId: 7, knownDraftId: 'draft', knownEvidenceKey: 'draft:video'});
  assert.equal(result.state.draftId, 'draft'); assert.equal(result.state.evidenceKey, 'draft:video');
  await worker.send({namespace: 'diffuse', target: 'worker', type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'aiSuggestion', suggestionAction: 'accept', id: 'finding'});
  const forwarded = worker.state.messages.at(-1);
  assert.equal(forwarded.tabId, 2); assert.equal(forwarded.type, 'PANEL_COMMAND'); assert.equal(forwarded.sessionId, 'session');
  assert.equal(forwarded.suggestionAction, 'accept'); assert.equal(forwarded.id, 'finding');
});

test('a session replacement during window lookup prevents stale panel forwarding', async () => {
  const worker = await harness(); await worker.attach(); worker.state.messages = [];
  const gate = defer(); worker.state.getTabGate = gate;
  const pending = worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'saveComment'});
  await new Promise(setImmediate); worker.setSession({...currentSession(), id: 'replacement'}); gate.resolve();
  await assert.rejects(pending, /no longer active/); assert.equal(worker.state.messages.length, 0);
});

test('closing the drawer preserves an already dispatched field update but rejects new commands', async () => {
  const worker = await harness(); const port = await worker.attach(); worker.state.messages = [];
  const gate = defer(); worker.state.getTabGate = gate;
  const pending = worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'setCommentFields', fields: {comment: 'Last typed character'}});
  await new Promise(setImmediate); port.disconnect(); gate.resolve();
  assert.equal((await pending).ok, true);
  assert.ok(worker.state.messages.some(message => message.type === 'PANEL_COMMAND' && message.fields.comment === 'Last typed character'));
  await assert.rejects(worker.send({type: 'PANEL_COMMAND', windowId: 7, sessionId: 'session', action: 'saveComment'}), /no longer attached/);
});

test('a connected drawer can show setup with no active session', async () => {
  const worker = await harness({initial: null}); await worker.attach();
  const result = await worker.send({type: 'PANEL_STATE', windowId: 7});
  assert.equal(result.ok, true); assert.equal(result.session, null); assert.equal(result.state, null);
  assert.equal((await worker.send({type: 'GET_SESSION'})).session, null);
});

test('hidden, disconnected and inactive panels restore the on-page controls; reload reapplies docking', async () => {
  const worker = await harness(); const port = await worker.attach();
  const docked = () => worker.state.messages.filter(message => message.type === 'DOCK_STATE').at(-1)?.docked;
  assert.equal(docked(), true);
  port.onMessage.emit({type: 'VISIBILITY', visible: false}); await worker.flushPanels(); assert.equal(docked(), false);
  port.onMessage.emit({type: 'VISIBILITY', visible: true}); await worker.flushPanels(); assert.equal(docked(), true);
  worker.state.active.set(7, 1); worker.chrome.tabs.onActivated.emit({tabId: 1, windowId: 7}); await new Promise(setImmediate); await worker.flushPanels(); assert.equal(docked(), false);
  worker.state.active.set(7, 2); worker.chrome.tabs.onActivated.emit({tabId: 2, windowId: 7}); await new Promise(setImmediate); await worker.flushPanels(); assert.equal(docked(), true);
  const before = worker.state.messages.filter(message => message.type === 'DOCK_STATE').length;
  await worker.initializeTab('target'); assert.ok(worker.state.messages.filter(message => message.type === 'DOCK_STATE').length > before);
  port.disconnect(); await new Promise(setImmediate); await worker.syncPanelDocking(); assert.equal(docked(), false);
});

test('native close/open signals update docking, and only real target state events invalidate panels', async () => {
  const worker = await harness(); const port = await worker.attach();
  worker.chrome.sidePanel.onClosed.emit({windowId: 7}); await new Promise(setImmediate); await worker.flushPanels();
  assert.equal(worker.state.messages.filter(message => message.type === 'DOCK_STATE').at(-1).docked, false);
  worker.chrome.sidePanel.onOpened.emit({windowId: 7}); await new Promise(setImmediate); await worker.flushPanels();
  assert.equal(worker.state.messages.filter(message => message.type === 'DOCK_STATE').at(-1).docked, true);
  const count = port.messages.length;
  await worker.send({type: 'PANEL_STATE_CHANGED', sessionId: 'session'}, {id: 'test', tab: {id: 2}, url: 'https://example.test/production'});
  assert.equal(port.messages.length, count + 1); assert.equal(port.messages.at(-1).type, 'STATE_CHANGED');
  await assert.rejects(worker.send({type: 'PANEL_STATE_CHANGED', sessionId: 'session'}, {id: 'test', tab: {id: 1}, url: 'https://example.test/prototype'}), /Unknown drawer/);
});

test('native open preserves the original gesture stack before asynchronous worker startup', async () => {
  const gate = defer(); const worker = await harness({waitForStorage: gate});
  let response;
  const message = {namespace: 'diffuse', target: 'worker', type: 'OPEN_SIDE_PANEL', windowId: 7};
  const accepted = worker.chrome.runtime.onMessage.emit(message, {id: 'test', url: 'chrome-extension://test/popup.html'}, result => {response = result;});
  assert.deepEqual(accepted, [true]); assert.equal(worker.state.opened.length, 1, 'open is invoked synchronously before storage can resolve');
  gate.resolve(); await worker.ready; await new Promise(setImmediate); assert.equal(response.ok, true);
  worker.chrome.runtime.onMessage.emit({...message, windowId: 8, sessionId: 'session'}, {id: 'test', url: 'https://example.test/production', tab: {id: 2, windowId: 7}, frameId: 0}, () => {});
  assert.equal(worker.state.opened.at(-1).windowId, 7, 'Target content cannot choose another window');
  const before = worker.state.opened.length;
  worker.chrome.runtime.onMessage.emit(message, panelSender(), result => {response = result;});
  assert.equal(worker.state.opened.length, before); assert.equal(response.ok, false);
});

test('region capture rejects stale viewport coordinates before taking a screenshot', async () => {
  const worker = await harness();
  for (const key of ['width', 'height', 'dpr', 'visualScale']) {
    const selection = {kind: 'region', context: structuredClone(worker.contextData), rect: {viewport: {x: 10, y: 10, width: 40, height: 40}}};
    selection.context.viewport[key] += 1;
    await assert.rejects(worker.captureDraft(selection), /resized after selection/);
  }
  assert.equal(worker.state.captures, 0); assert.equal(worker.state.savedDrafts.length, 0);
});
