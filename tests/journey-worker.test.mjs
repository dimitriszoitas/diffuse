import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JOURNEY_MESSAGES} from '../extension/journey-service.mjs';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const listener = {addListener() {}};
async function harness() {
  const state = {calls: [], ended: [], created: 0};
  const chrome = {
    runtime: {
      id: 'test', getURL: path => `chrome-extension://test/${path}`,
      onMessage: {addListener(fn) { state.listener = fn; }}, onInstalled: listener,
    },
    storage: {session: {get: async () => ({comparison: null})}},
    tabs: {onUpdated: listener, onRemoved: listener},
  };
  const context = vm.createContext({
    chrome, createViewportController: () => ({}), assertPageAccess() {}, protectAIStorage: async () => {}, reviews: {},
    JOURNEY_MESSAGES, createJourneyService: () => {
      state.created++;
      return {async handle(message) { state.calls.push(message); return {ok: true}; }, async recordingEnded(id) { state.ended.push(id); }};
    },
    createJourneyExecutor() {}, refreshComments() {}, readAISettings() {},
    isReviewableUrl: url => /^https?:/.test(url),
  });
  vm.runInContext(source.replace(/^import .*\n/gm, '') + `
    globalThis.api = {
      ready,
      setSession(value) { session = value; },
      attach(fields = {}) { panelPorts.set('panel', {connected: true, visible: true, windowId: 1, documentId: 'panel-doc', ...fields}); },
      clearAttachments() { panelPorts.clear(); },
    };
  `, context);
  await context.api.ready;
  context.api.setSession({id: 'session-1', reviewId: 'review-1', targetTabId: 4, sourceTabId: 5});
  context.api.attach();
  function send(type = 'JOURNEY_START', sender = {}, fields = {}) {
    return new Promise(resolve => {
      const result = state.listener(
        {namespace: 'diffuse', target: 'worker', type, sessionId: 'session-1', windowId: 1, ...fields},
        {id: 'test', url: 'chrome-extension://test/sidepanel.html?windowId=1', documentId: 'panel-doc', frameId: 0, ...sender},
        resolve,
      );
      if (result !== true) resolve(null);
    });
  }
  return {state, api: context.api, send};
}

test('only the attached extension sidebar can start, inspect or mutate journeys', async () => {
  const h = await harness();
  for (const type of JOURNEY_MESSAGES) {
    for (const sender of [
      {id: 'foreign'}, {url: 'https://example.test/', tab: {id: 4}}, {url: 'chrome-extension://test/popup.html'},
      {url: 'chrome-extension://test/report.html'}, {url: 'chrome-extension://test/settings.html'},
      {url: 'chrome-extension://test/sidepanel.html.evil'}, {documentId: 'other-doc'},
    ]) {
      const result = await h.send(type, sender);
      assert.ok(result === null || result.ok === false);
    }
  }
  assert.equal(h.state.created, 0);
  assert.equal(h.state.calls.length, 0);
  assert.equal((await h.send()).ok, true);
  assert.equal(h.state.calls.length, 1);
});

test('wrong session, detached/hidden panel and wrong window cannot issue journey commands', async () => {
  const h = await harness();
  assert.equal((await h.send('JOURNEY_START', {}, {sessionId: 'old-session'})).ok, false);
  assert.equal((await h.send('JOURNEY_START', {}, {windowId: 2})).ok, false);
  h.api.clearAttachments();
  assert.equal((await h.send()).ok, false);
  h.api.attach({visible: false});
  assert.equal((await h.send()).ok, false);
  assert.equal(h.state.calls.length, 0);
});

test('pause and stop remain available without querying a loading/inactive website', async () => {
  const h = await harness();
  assert.equal((await h.send('JOURNEY_PAUSE')).ok, true);
  assert.equal((await h.send('JOURNEY_STOP')).ok, true);
  assert.deepEqual(h.state.calls.map(item => item.type), ['JOURNEY_PAUSE', 'JOURNEY_STOP']);
});

test('only the same-session offscreen document can report recording termination', async () => {
  const h = await harness();
  await h.send(); // Initializes the real routing boundary's service dependency.
  for (const [sender, fields] of [
    [{url: 'https://example.test/', tab: {id: 4}}, {}],
    [{url: 'chrome-extension://test/sidepanel.html'}, {}],
    [{url: 'chrome-extension://test/offscreen.html', id: 'foreign'}, {}],
    [{url: 'chrome-extension://test/offscreen.html'}, {sessionId: 'old-session'}],
  ]) await h.send('JOURNEY_CAPTURE_ENDED', sender, {recordingId: 'recording-1', ...fields});
  assert.equal(h.state.ended.length, 0);
  assert.equal((await h.send('JOURNEY_CAPTURE_ENDED', {url: 'chrome-extension://test/offscreen.html'}, {recordingId: 'recording-1'})).ok, true);
  assert.deepEqual(h.state.ended, ['recording-1']);
});
