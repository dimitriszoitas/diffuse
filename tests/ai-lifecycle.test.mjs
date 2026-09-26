import {assertPageAccess as coreAssertPageAccess} from '../extension/core.mjs';
import {createViewportController} from '../extension/viewport-controller.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const config = {hasKey: true, apiKey: 'sk-ant-test-not-a-real-key', model: 'claude-sonnet-5', threshold: 35};
const comparison = id => ({id, reviewId: id, mode: 'audit', targetTabId: 2, target: {}, status: 'live', settings: {}, recording: null});
const listener = {addListener() {}};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function harness({initial = null, settings} = {}) {
  const state = {
    saved: structuredClone(initial), messages: [], sequence: [],
    settingsReads: 0, tabReads: 0, captures: 0, providerCalls: 0,
    failNextWrite: false, timeouts: new Set(), intervals: new Set(),
  };
  let timerId = 0;
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: listener, onInstalled: listener,
      getContexts: async () => [],
    },
    storage: {session: {
      get: async () => ({comparison: structuredClone(state.saved)}),
      set: async ({comparison}) => {
        if (state.failNextWrite) { state.failNextWrite = false; throw new Error('Simulated storage failure'); }
        state.saved = structuredClone(comparison);
      },
    }},
    tabs: {
      onUpdated: listener, onRemoved: listener,
      get: async () => { state.tabReads++; throw new Error('Unexpected capture preparation'); },
      captureVisibleTab: async () => { state.captures++; throw new Error('Unexpected screenshot'); },
      sendMessage: async (tabId, message) => {
        state.sequence.push('tab-message');
        state.messages.push(structuredClone(message));
        return {ok: true};
      },
    },
    permissions: {contains: async () => true},
  };
  const context = vm.createContext({createViewportController, assertPageAccess:(url,api=chrome,message)=>coreAssertPageAccess(url,api,message),
    chrome, crypto: webcrypto, AbortController,
    DEFAULT_SETTINGS: {}, viewportWarning: () => '',
    reviews: {},
    protectAIStorage: async () => { state.sequence.push('protect-storage'); },
    readAISettings: async () => { state.settingsReads++; return settings ? settings() : config; },
    reviewScreens: async () => { state.providerCalls++; throw new Error('Unexpected provider request'); },
    setTimeout: () => { const id = ++timerId; state.timeouts.add(id); return id; },
    clearTimeout: id => state.timeouts.delete(id),
    setInterval: () => { const id = ++timerId; state.intervals.add(id); return id; },
    clearInterval: id => state.intervals.delete(id),
  });
  // Run the real worker functions; replace only external browser/provider APIs.
  vm.runInContext(source.replace(/^import .*\n/gm, '') + `
    globalThis.api = {
      ready, stopSession, runAIReview,
      getSession() { return session; }, setSession(value) { session = value; },
      hasJob() { return aiJob !== null; }
    };
  `, context, {filename: 'background.js'});
  await context.api.ready;
  return {...context.api, state};
}

test('worker restart clears a stale AI-running flag and preserves pending suggestions', async () => {
  const initial = {...comparison('existing'), aiRunning: true, aiBatchId: 'retained-batch'};
  const worker = await harness({initial});
  assert.equal(worker.getSession().aiRunning, false);
  assert.equal(worker.getSession().aiBatchId, 'retained-batch');
  assert.equal(worker.state.saved.aiRunning, false);
  assert.equal(worker.state.saved.aiBatchId, 'retained-batch');
  assert.equal(worker.state.sequence[0], 'protect-storage');
  assert.ok(worker.state.messages.some(message => message.type === 'SESSION_UPDATE' && message.session.aiRunning === false));
  assert.equal(worker.state.providerCalls, 0);
});

test('stopping without an active session or AI job is safe and repeatable', async () => {
  const worker = await harness();
  await worker.stopSession();
  await worker.stopSession();
  assert.equal(worker.getSession(), null);
  assert.equal(worker.state.saved, null);
  assert.equal(worker.state.messages.length, 0);
  assert.equal(worker.hasJob(), false);
});

test('an AI request cannot capture a replacement session after an asynchronous settings read', async () => {
  const gate = deferred();
  const worker = await harness({initial: comparison('requested-page'), settings: () => gate.promise});
  const running = worker.runAIReview({instructions: 'Inspect the current page.'});
  assert.equal(worker.state.settingsReads, 1);
  worker.setSession(comparison('replacement-page'));
  gate.resolve(config);
  await assert.rejects(running, /session that has ended/);
  assert.equal(worker.getSession().id, 'replacement-page');
  assert.equal(worker.state.tabReads, 0, 'No capture preparation may reach the replacement page');
  assert.equal(worker.state.captures, 0);
  assert.equal(worker.state.providerCalls, 0);
  assert.equal(worker.hasJob(), false);
  assert.equal(worker.state.timeouts.size + worker.state.intervals.size, 0);
});

test('failure to publish AI startup clears its job, timer, and keep-alive interval', async () => {
  const worker = await harness({initial: comparison('current-page')});
  worker.state.failNextWrite = true;
  await assert.rejects(worker.runAIReview({instructions: ''}), /Simulated storage failure/);
  assert.equal(worker.hasJob(), false);
  assert.equal(worker.getSession().aiRunning, false);
  assert.equal(worker.state.saved.aiRunning, false);
  assert.equal(worker.state.timeouts.size, 0);
  assert.equal(worker.state.intervals.size, 0);
  assert.equal(worker.state.tabReads, 0);
  assert.equal(worker.state.providerCalls, 0);
});
