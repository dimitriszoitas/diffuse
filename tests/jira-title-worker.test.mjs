import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {hasJiraTitle} from '../extension/jira-titles.mjs';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const listener = {addListener() {}};
const saved = {comments: [{id: 'new', fields: {comment: 'Saved comment'}}, {id: 'old', fields: {title: 'Legacy title', comment: 'Old comment'}}]};
async function harness({permission = true} = {}) {
  const state = {calls: [], settingsReads: 0};
  const chrome = {
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: {addListener(fn) {state.listener = fn;}}, onInstalled: listener},
    storage: {session: {get: async () => ({comparison: null})}},
    tabs: {onUpdated: listener, onRemoved: listener},
    permissions: {contains: async () => permission},
  };
  const context = vm.createContext({chrome, hasJiraTitle, createViewportController: () => ({}), assertPageAccess() {}, protectAIStorage: async () => {},
    reviews: {getReview: async id => id === 'review' ? structuredClone(saved) : null},
    readAISettings: async () => {state.settingsReads++;return {apiKey: 'PRIVATE-KEY', model: 'configured-model'};},
    generateJiraTitles: async (comments, config) => {state.calls.push({comments, config});return {titles: [{commentId: comments[0].id, title: 'Suggested title'}], reason: 'generated'};},
  });
  vm.runInContext(source.replace(/^import .*\n/gm, '') + '\nglobalThis.readyForTest = ready;', context);
  await context.readyForTest;
  const send = (message, sender = {}) => new Promise(resolve => {
    const result = state.listener({namespace: 'diffuse', target: 'worker', type: 'GENERATE_JIRA_TITLES', reviewId: 'review', commentIds: ['new'], ...message}, {id: 'test', url: 'chrome-extension://test/report.html?review=review', frameId: 0, ...sender}, resolve);
    if (result !== true) resolve(null);
  });
  return {state, send};
}

test('only the trusted report can generate titles, and the worker reads saved comments rather than accepting page text', async () => {
  const worker = await harness();
  for (const sender of [{id: 'foreign-extension'}, {url: 'https://example.test/'}, {url: 'chrome-extension://test/sidepanel.html'}, {frameId: 3}]) {
    await worker.send({}, sender);
    assert.equal(worker.state.calls.length, 0);
  }
  const result = await worker.send({commentIds: ['new', 'old'], comments: [{fields: {comment: 'Injected text'}}], apiKey: 'ATTACKER-KEY'});
  assert.equal(result.ok, true);
  assert.equal(worker.state.calls.length, 1);
  assert.equal(worker.state.calls[0].comments.length, 1);
  assert.equal(worker.state.calls[0].comments[0].fields.comment, 'Saved comment');
  assert.equal(worker.state.calls[0].config.apiKey, 'PRIVATE-KEY');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|ATTACKER|Injected/);
});

test('missing permission, missing comments and invalid batches cannot spend AI tokens', async () => {
  const worker = await harness({permission: false});
  assert.equal((await worker.send({})).reason, 'not-configured');
  assert.equal(worker.state.settingsReads, 0);
  for (const message of [{reviewId: 'missing'}, {commentIds: ['missing']}, {commentIds: ['new', 'new']}, {commentIds: []}, {commentIds: Array.from({length: 21}, (_, index) => String(index))}]) {
    assert.equal((await worker.send(message)).ok, false);
  }
  assert.equal(worker.state.calls.length, 0);
});

test('legacy-only exports leave existing titles alone without reading the AI key', async () => {
  const worker = await harness();
  assert.equal((await worker.send({commentIds: ['old']})).reason, 'existing');
  assert.equal(worker.state.settingsReads, 0);assert.equal(worker.state.calls.length, 0);
});
