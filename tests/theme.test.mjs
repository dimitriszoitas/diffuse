import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/theme.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => structuredClone(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function event() {
  return {listeners: [], addListener(listener) {this.listeners.push(listener);},
    emit(...args) {for (const listener of this.listeners) listener(...args);}};
}
function harness({stored, protocol = 'chrome-extension:', dark = false, read, write,
  storageEvents = event(), runtimeRead, noChrome = false, noMedia = false} = {}) {
  const document = {documentElement: {dataset: {}}};
  const mediaEvents = event(), runtimeEvents = event(), selectCalls = [], writes = [], requests = [];
  const media = {matches: dark, addEventListener(type, listener) {
    assert.equal(type, 'change'); mediaEvents.addListener(listener);
  }};
  const chrome = noChrome ? undefined : {runtime: {id: 'diffuse-test-extension', onMessage: runtimeEvents,
    sendMessage: async message => {requests.push(plain(message)); return runtimeRead ? runtimeRead(message) : {preference: stored};},
  }, storage: {onChanged: storageEvents, local: {
    get: read || (async key => {assert.equal(key, 'diffuseTheme'); return {diffuseTheme: stored};}),
    set: async values => {writes.push(plain(values)); await write?.(plain(values));},
  }}};
  if (chrome && protocol !== 'chrome-extension:') Object.defineProperty(chrome, 'storage', {
    get() {throw new Error('Content scripts must not access trusted extension storage');},
  });
  const context = vm.createContext({chrome, document, location: {protocol},
    matchMedia: noMedia ? undefined : query => {assert.equal(query, '(prefers-color-scheme: dark)'); return media;},
    DiffuseSelect: {setTheme(root, theme) {selectCalls.push({root, theme});}},
  });
  const load = () => vm.runInContext(source, context, {filename: 'theme.js'});
  load();
  return {api: context.DiffuseTheme, document, writes, selectCalls, storageEvents, runtimeEvents, requests, load,
    relay(preference) {runtimeEvents.emit({namespace: 'diffuse', type: 'APPEARANCE_CHANGED', preference}, {id: 'diffuse-test-extension'});},
    mediaEvents, setSystemDark(value) {media.matches = value; mediaEvents.emit({matches: value});}};
}

test('appearance starts light even on a dark system and defaults to light without a saved preference', async () => {
  const h = harness({dark: true});
  assert.deepEqual(plain(h.api.getState()), {preference: 'light', theme: 'light'});
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  await flush();
  assert.deepEqual(h.document.documentElement.dataset, {theme: 'light', themePreference: 'light'});
  assert.equal(h.selectCalls.at(-1).root, h.document);
  assert.equal(h.selectCalls.at(-1).theme, 'light');
});

test('stored dark appearance applies to extension documents and custom dropdown roots', async () => {
  const h = harness({stored: 'dark'});
  await flush();
  assert.deepEqual(plain(h.api.getState()), {preference: 'dark', theme: 'dark'});
  assert.deepEqual(h.document.documentElement.dataset, {theme: 'dark', themePreference: 'dark'});
  assert.equal(h.selectCalls.at(-1).theme, 'dark');
});

test('system preference follows media changes; explicit preferences ignore them', async () => {
  const h = harness({stored: 'system'});
  await flush();
  const observed = [];
  h.api.subscribe(value => observed.push(plain(value)));
  h.setSystemDark(true);
  assert.deepEqual(observed.at(-1), {preference: 'system', theme: 'dark'});
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  await h.api.setPreference('light');
  const count = observed.length;
  h.setSystemDark(false); h.setSystemDark(true);
  assert.equal(observed.length, count);
  assert.deepEqual(h.document.documentElement.dataset, {theme: 'light', themePreference: 'light'});
  assert.deepEqual(h.writes, [{diffuseTheme: 'light'}]);
});

test('storage and the trusted runtime relay synchronize surfaces without touching the webpage', async () => {
  const changed = event();
  const popup = harness({storageEvents: changed});
  const webpage = harness({storageEvents: changed, protocol: 'https:'});
  const shadowRoot = {}, host = {dataset: {}, shadowRoot};
  webpage.api.attach(host);
  await flush();
  changed.emit({diffuseTheme: {oldValue: 'light', newValue: 'dark'}}, 'local');
  webpage.relay('dark');
  assert.equal(popup.document.documentElement.dataset.theme, 'dark');
  assert.equal(host.dataset.theme, 'dark');
  assert.deepEqual(webpage.document.documentElement.dataset, {});
  assert.ok(webpage.selectCalls.every(call => call.root === shadowRoot));
  const count = popup.selectCalls.length;
  changed.emit({diffuseTheme: {newValue: 'light'}}, 'session');
  changed.emit({unrelated: {newValue: 'light'}}, 'local');
  assert.equal(popup.selectCalls.length, count);
  changed.emit({diffuseTheme: {oldValue: 'dark'}}, 'local');
  webpage.relay(undefined);
  assert.equal(host.dataset.theme, 'light', 'Removing the saved preference restores the default.');
});

test('shadow hosts apply the current theme immediately and stop updating when detached', async () => {
  const h = harness({protocol: 'https:', stored: 'dark'});
  await flush();
  const root = {}, host = {dataset: {}, shadowRoot: root};
  const detach = h.api.attach(host);
  assert.deepEqual(host.dataset, {theme: 'dark', themePreference: 'dark'});
  assert.equal(h.selectCalls.at(-1).root, root);
  detach();
  h.relay('light');
  assert.equal(host.dataset.theme, 'dark');
  assert.equal(h.selectCalls.length, 1);
  h.api.attach(host, root);
  assert.equal(host.dataset.theme, 'light');
  assert.deepEqual(h.document.documentElement.dataset, {});
});

test('content reads only the public appearance message and cannot save settings', async () => {
  const h = harness({protocol: 'https:', stored: 'system', dark: true});
  await flush();
  assert.deepEqual(h.requests, [{namespace: 'diffuse', target: 'worker', type: 'GET_APPEARANCE'}]);
  assert.deepEqual(plain(h.api.getState()), {preference: 'system', theme: 'dark'});
  assert.equal(h.storageEvents.listeners.length, 0);
  assert.deepEqual(h.document.documentElement.dataset, {});
  await assert.rejects(h.api.setPreference('light'), /Open Diffuse settings in Chrome/);
});

test('content ignores unrelated, targeted and foreign-sender appearance messages', async () => {
  const h = harness({protocol: 'https:'});
  await flush();
  const message = {namespace: 'diffuse', type: 'APPEARANCE_CHANGED', preference: 'dark'};
  const sender = {id: 'diffuse-test-extension'};
  for (const [value, from] of [[message, {id: 'another-extension'}], [message, {}],
    [{...message, namespace: 'other'}, sender], [{...message, target: 'worker'}, sender],
    [{...message, type: 'UNRELATED'}, sender]]) h.runtimeEvents.emit(value, from);
  assert.equal(h.api.getState().theme, 'light');
  let response;
  h.runtimeEvents.emit(message, sender, value => {response = plain(value);});
  assert.equal(h.api.getState().theme, 'dark');
  assert.deepEqual(response, {ok: true});
});

test('a late public appearance response cannot overwrite a newer verified relay', async () => {
  const initial = deferred();
  const h = harness({protocol: 'https:', runtimeRead: () => initial.promise});
  h.relay('dark');
  initial.resolve({preference: 'light'});
  await flush();
  assert.deepEqual(plain(h.api.getState()), {preference: 'dark', theme: 'dark'});
});

test('subscriptions receive an immediate snapshot and can unsubscribe', async () => {
  const h = harness();
  await flush();
  const values = [];
  const unsubscribe = h.api.subscribe(value => values.push(plain(value)));
  assert.deepEqual(values, [{preference: 'light', theme: 'light'}]);
  await h.api.setPreference('dark');
  assert.deepEqual(values.at(-1), {preference: 'dark', theme: 'dark'});
  unsubscribe();
  await h.api.setPreference('light');
  assert.equal(values.length, 2);
});

test('late initial storage reads cannot overwrite a newer cross-surface preference', async () => {
  const initial = deferred();
  const h = harness({read: () => initial.promise});
  h.storageEvents.emit({diffuseTheme: {newValue: 'dark'}}, 'local');
  initial.resolve({diffuseTheme: 'light'});
  await flush();
  assert.deepEqual(plain(h.api.getState()), {preference: 'dark', theme: 'dark'});
});

test('late initial storage reads cannot overwrite a successfully saved local preference', async () => {
  const initial = deferred();
  const h = harness({read: () => initial.promise});
  await h.api.setPreference('dark');
  initial.resolve({diffuseTheme: 'light'});
  await flush();
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
});

test('rejected saves preserve the applied preference and surface the failure', async () => {
  const h = harness({stored: 'dark', write: async () => {throw new Error('Storage unavailable');}});
  await flush();
  const values = [];
  h.api.subscribe(value => values.push(plain(value)));
  await assert.rejects(h.api.setPreference('light'), /Storage unavailable/);
  assert.deepEqual(plain(h.api.getState()), {preference: 'dark', theme: 'dark'});
  assert.equal(values.length, 1);
});

test('a delayed save completion cannot roll back a more recent storage update', async () => {
  const saved = deferred();
  const h = harness({write: () => saved.promise});
  await flush();
  const saving = h.api.setPreference('dark');
  // Chrome may notify a surface before resolving the caller's save promise.
  h.storageEvents.emit({diffuseTheme: {newValue: 'dark'}}, 'local');
  h.storageEvents.emit({diffuseTheme: {oldValue: 'dark', newValue: 'light'}}, 'local');
  saved.resolve();
  await saving;
  assert.deepEqual(plain(h.api.getState()), {preference: 'light', theme: 'light'});
});

test('failed initial storage reads and missing browser APIs keep the safe light default', async () => {
  const h = harness({read: async () => {throw new Error('Storage unavailable');}});
  const standalone = harness({noChrome: true, noMedia: true, protocol: 'https:'});
  await flush();
  assert.deepEqual(plain(h.api.getState()), {preference: 'light', theme: 'light'});
  assert.deepEqual(plain(standalone.api.getState()), {preference: 'light', theme: 'light'});
  assert.deepEqual(standalone.document.documentElement.dataset, {});
  await assert.rejects(standalone.api.setPreference('dark'), /Open Diffuse settings in Chrome/);
});

test('unsupported preferences normalize to light and repeated injection installs only once', async () => {
  const h = harness({stored: 'unsupported'});
  await flush();
  assert.equal(h.api.getState().theme, 'light');
  await h.api.setPreference('unsupported');
  assert.deepEqual(h.writes, [{diffuseTheme: 'light'}]);
  h.load();
  assert.equal(h.storageEvents.listeners.length, 1);
  assert.equal(h.mediaEvents.listeners.length, 1);
  assert.equal(Object.isFrozen(h.api), true);
});
