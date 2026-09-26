import test from 'node:test';
import assert from 'node:assert/strict';
import {readAISettings, saveAISettings, clearAIKey} from '../extension/ai-config.mjs';

test('Anthropic keys are session-only by default, hidden from config, explicitly remembered and removable', async () => {
  function storage() {
    const data = {};
    return {data, access: null, async setAccessLevel({accessLevel}) { this.access = accessLevel; }, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]])); }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; }};
  }
  globalThis.chrome = {storage: {session: storage(), local: storage()}};
  const key = 'sk-ant-test-key-for-local-unit-test-only';
  let result = await saveAISettings({apiKey: key, model: 'claude-sonnet-5', threshold: 35, rememberKey: false});
  assert.equal(result.hasKey, true);
  assert.equal(result.apiKey, undefined);
  assert.equal(chrome.storage.session.data.anthropicApiKey, key);
  assert.equal(chrome.storage.local.data.anthropicApiKey, undefined);
  assert.equal(chrome.storage.local.access, 'TRUSTED_CONTEXTS');
  assert.equal(chrome.storage.session.access, 'TRUSTED_CONTEXTS');
  result = await saveAISettings({apiKey: '', model: 'claude-sonnet-5', threshold: 12, rememberKey: true});
  assert.equal(result.threshold, 12);
  assert.equal(chrome.storage.local.data.anthropicApiKey, key);
  assert.equal(chrome.storage.session.data.anthropicApiKey, undefined);
  assert.equal((await readAISettings({includeKey: true})).apiKey, key);
  await saveAISettings({rememberKey: false});
  assert.equal(chrome.storage.local.data.anthropicApiKey, undefined);
  assert.equal(chrome.storage.session.data.anthropicApiKey, key);
  await assert.rejects(saveAISettings({threshold: 120}), /between 0 and 100/);
  await assert.rejects(saveAISettings({apiKey: 'invalid key'}), /valid Anthropic/);
  assert.equal((await clearAIKey()).hasKey, false);
  assert.equal(chrome.storage.session.data.anthropicApiKey, undefined);
  assert.equal(chrome.storage.local.data.anthropicApiKey, undefined);
  delete globalThis.chrome;
});
