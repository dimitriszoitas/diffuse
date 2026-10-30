import test from 'node:test';
import assert from 'node:assert/strict';
import {readAISettings, saveAISettings, clearAIKey} from '../extension/ai-config.mjs';

function storage(initial = {}) {
  const data = {...initial};
  return {data, access: null, async setAccessLevel({accessLevel}) { this.access = accessLevel; }, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]])); }, async set(values) { Object.assign(data, values); }, async remove(key) { delete data[key]; }};
}

test('Anthropic keys are session-only by default, hidden from config, explicitly remembered and removable', async () => {
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

test('old AI settings default to direct journeys and a $2 limit without exposing credentials', async () => {
  globalThis.chrome = {storage: {session: storage(), local: storage({anthropicApiKey: 'sk-ant-saved-fixture-key-not-real', aiConfig: {model: 'claude-sonnet-5', threshold: 12, rememberKey: true}})}};
  try {
    const result = await readAISettings();
    assert.equal(result.journeyEngine, 'direct');
    assert.equal(result.journeyBudgetUsd, 2);
    assert.equal(result.hasKey, true);
    assert.equal(result.apiKey, undefined);
    assert.equal(JSON.stringify(result).includes('sk-ant-'), false);
    chrome.storage.local.data.aiConfig.journeyEngine = 'unknown';
    chrome.storage.local.data.aiConfig.journeyBudgetUsd = null;
    assert.equal((await readAISettings()).journeyEngine, 'direct');
    assert.equal((await readAISettings()).journeyBudgetUsd, 2);
  } finally { delete globalThis.chrome; }
});

test('journey engine and budget survive unrelated saves and remembered key preferences stay unchanged', async () => {
  globalThis.chrome = {storage: {session: storage(), local: storage()}};
  try {
    const key = 'sk-ant-test-config-roundtrip-only';
    await saveAISettings({apiKey: key, rememberKey: true, journeyEngine: 'managed', journeyBudgetUsd: 3.25});
    const saved = await saveAISettings({threshold: 65});
    assert.equal(saved.journeyEngine, 'managed');
    assert.equal(saved.journeyBudgetUsd, 3.25);
    assert.equal(saved.rememberKey, true);
    assert.equal(chrome.storage.local.data.anthropicApiKey, key);
    assert.equal(chrome.storage.session.data.anthropicApiKey, undefined);
    await saveAISettings({journeyEngine: 'direct'});
    assert.equal((await readAISettings()).journeyBudgetUsd, 3.25);
    assert.equal((await readAISettings()).journeyEngine, 'direct');
    await clearAIKey();
    assert.equal((await readAISettings()).journeyBudgetUsd, 3.25);
  } finally { delete globalThis.chrome; }
});

test('invalid journey settings are rejected atomically and budget boundaries persist', async () => {
  globalThis.chrome = {storage: {session: storage(), local: storage()}};
  try {
    await saveAISettings({journeyEngine: 'managed', journeyBudgetUsd: 0.1});
    assert.equal((await readAISettings()).journeyBudgetUsd, 0.1);
    const before = JSON.stringify(chrome.storage.local.data);
    for (const journeyEngine of ['auto', '', null, 1]) await assert.rejects(saveAISettings({journeyEngine}), /Choose Direct or Claude agents/);
    for (const journeyBudgetUsd of [0, 0.09, 20.01, -1, NaN, Infinity, '2', null]) await assert.rejects(saveAISettings({journeyBudgetUsd}), /between \$0.10 and \$20/);
    assert.equal(JSON.stringify(chrome.storage.local.data), before);
    assert.equal((await saveAISettings({journeyBudgetUsd: 20})).journeyBudgetUsd, 20);
  } finally { delete globalThis.chrome; }
});

test('combined reviewer defaults safely and its independent budget survives journey settings saves', async () => {
  globalThis.chrome = {storage: {session: storage(), local: storage({aiConfig: {journeyEngine: 'managed', journeyBudgetUsd: 20}})}};
  try {
    assert.equal((await readAISettings()).reviewEngine, 'direct');
    assert.equal((await readAISettings()).reviewBudgetUsd, 2);
    await saveAISettings({reviewEngine: 'managed', reviewBudgetUsd: 1.75});
    const saved = await saveAISettings({threshold: 44, journeyBudgetUsd: 5});
    assert.equal(saved.reviewEngine, 'managed'); assert.equal(saved.reviewBudgetUsd, 1.75);
    assert.equal(saved.journeyEngine, 'managed'); assert.equal(saved.journeyBudgetUsd, 5);
    const before = JSON.stringify(chrome.storage.local.data);
    for (const reviewEngine of ['auto', null, 1]) await assert.rejects(saveAISettings({reviewEngine}), /Choose Direct or UX/);
    for (const reviewBudgetUsd of [0, .09, 20.01, '2', null, NaN, Infinity]) await assert.rejects(saveAISettings({reviewBudgetUsd}), /review spending limit/);
    assert.equal(JSON.stringify(chrome.storage.local.data), before);
    assert.equal((await saveAISettings({reviewBudgetUsd: .1})).reviewBudgetUsd, .1);
    assert.equal((await saveAISettings({reviewBudgetUsd: 20})).reviewBudgetUsd, 20);
  } finally { delete globalThis.chrome; }
});

test('switching providers preserves separate keys, engines, budgets, and model choices without exposing secrets', async () => {
  const anthropic = 'sk-ant-test-anthropic-provider-secret';
  const openai = 'sk-proj-test-openai-provider-secret';
  globalThis.chrome = {storage:{session:storage(),local:storage({anthropicApiKey:anthropic,aiConfig:{model:'claude-opus-5-5',rememberKey:true,threshold:42,reviewEngine:'managed',journeyEngine:'managed',journeyBudgetUsd:20}})}};
  try {
    let result = await saveAISettings({provider:'openai',apiKey:openai,rememberKey:true,journeyBudgetUsd:5,reviewBudgetUsd:1});
    assert.equal(result.provider,'openai'); assert.equal(result.model,'gpt-6.1-sol');
    assert.equal(result.managedModel,'gpt-6.1-sol'); assert.equal(result.managedEffort,'max');
    assert.equal(result.connections.anthropic.model,'claude-opus-5-5');
    assert.equal(result.connections.anthropic.journeyBudgetUsd,20);
    assert.equal(result.connections.anthropic.journeyEngine,'managed');
    assert.equal(result.connections.anthropic.hasKey,true); assert.equal(result.connections.openai.hasKey,true);
    assert.equal(chrome.storage.local.data.anthropicApiKey,anthropic);
    assert.equal(chrome.storage.local.data.openaiApiKey,openai);
    assert.equal(JSON.stringify(result).includes('sk-'),false);
    result = await readAISettings({provider:'anthropic',includeKey:true});
    assert.equal(result.provider,'anthropic'); assert.equal(result.activeProvider,'openai'); assert.equal(result.apiKey,anthropic);
    assert.equal(JSON.stringify(result.connections).includes('sk-'),false);
    result = await saveAISettings({provider:'anthropic'});
    assert.equal(result.model,'claude-opus-5-5'); assert.equal(result.journeyBudgetUsd,20);
    assert.equal((await readAISettings({includeKey:true})).apiKey,anthropic);
    await saveAISettings({provider:'openai',rememberKey:false});
    assert.equal(chrome.storage.session.data.openaiApiKey,openai); assert.equal(chrome.storage.local.data.openaiApiKey,undefined);
    assert.equal(chrome.storage.local.data.anthropicApiKey,anthropic);
    await clearAIKey({provider:'openai'});
    assert.equal((await readAISettings()).hasKey,false);
    assert.equal((await readAISettings({provider:'anthropic'})).hasKey,true);
    assert.equal((await readAISettings()).journeyBudgetUsd,5);
  } finally { delete globalThis.chrome; }
});

test('provider validation never saves a key under the wrong account or silently changes provider', async () => {
  globalThis.chrome={storage:{session:storage(),local:storage()}};
  try {
    await saveAISettings({apiKey:'sk-ant-test-valid-anthropic-key',rememberKey:true});
    const before = JSON.stringify(chrome.storage.local.data);
    for(const input of [{provider:'other'},{provider:'openai',apiKey:'sk-ant-test-wrong-provider-key'},{provider:'anthropic',apiKey:'sk-proj-test-wrong-provider-key'},{provider:'openai',model:'claude-opus-5-5'}]) await assert.rejects(saveAISettings(input));
    assert.equal(JSON.stringify(chrome.storage.local.data),before);
    assert.equal((await readAISettings()).provider,'anthropic');
    assert.equal((await readAISettings({provider:'openai'})).hasKey,false);
  } finally { delete globalThis.chrome; }
});
