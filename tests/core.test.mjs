import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSettings, DEFAULT_SETTINGS, sitePattern, viewportWarning, isReviewableUrl, isFileUrl, pageLocation, pageAccess, assertPageAccess, requestPageAccess, extensionSettingsUrl} from '../extension/core.mjs';

test('page access scopes selected HTTP(S) hosts and local files while rejecting browser URLs', () => {
  assert.equal(sitePattern('http://localhost:4178/prototype.html'), 'http://localhost/*');
  assert.equal(sitePattern('https://app.example.com/settings?token=private'), 'https://app.example.com/*');
  assert.equal(sitePattern('file:///Users/example/Downloads/demo%20pages/prototype.html'), 'file:///*');
  assert.throws(() => sitePattern('chrome://extensions'));
  assert.throws(() => sitePattern('javascript:alert(1)'));
});

test('popup, drawer and Diff share eligibility and readable local-file labels', () => {
  for (const url of ['http://localhost:3000/', 'https://example.test/', 'file:///tmp/page.html']) assert.equal(isReviewableUrl(url), true);
  for (const url of ['chrome://extensions', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html', 'about:blank', 'javascript:alert(1)', 'data:text/html,Hello', '', undefined]) assert.equal(isReviewableUrl(url), false);
  assert.equal(isFileUrl('file:///tmp/page.html'), true);
  assert.equal(isFileUrl('https://example.test/file:///tmp/page.html'), false);
  assert.equal(pageLocation('file:///Users/example/Demo%20pages/prototype.html'), 'Local file · /Users/example/Demo pages/prototype.html');
  assert.equal(pageLocation('http://localhost:3000/prototype.html'), 'localhost:3000/prototype.html');
  assert.equal(extensionSettingsUrl('abcdefghijklmnopabcdefghijklmnop'), 'chrome://extensions/?id=abcdefghijklmnopabcdefghijklmnop');
  assert.throws(() => extensionSettingsUrl('bad&id=another'));
});

test('local files require Chrome’s explicit toggle even when a host grant exists', async () => {
  let permissionChecks = 0;
  const api = {extension: {isAllowedFileSchemeAccess: async () => false}, permissions: {contains: async () => {permissionChecks++;return true;}}};
  const blocked = await pageAccess('file:///tmp/page.html', api);
  assert.equal(blocked.supported, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.needsFileAccess, true);
  assert.match(blocked.message, /Allow access to file URLs/);
  await assert.rejects(assertPageAccess('file:///tmp/page.html', api), error => error.code === 'FILE_ACCESS_REQUIRED');
  assert.equal(permissionChecks, 0);
  api.extension.isAllowedFileSchemeAccess = async () => true;
  assert.equal((await pageAccess('file:///tmp/page.html', api)).allowed, true);
  assert.equal(await assertPageAccess('file:///tmp/page.html', api), 'file:///*');
  assert.equal(permissionChecks, 1);
});

test('file toggle failures fail closed, while localhost never depends on that toggle', async () => {
  let fileChecks = 0;
  const api = {extension: {isAllowedFileSchemeAccess: async () => {fileChecks++;throw new Error('Unavailable');}}, permissions: {contains: async () => true}};
  assert.equal((await pageAccess('file:///tmp/page.html', api)).needsFileAccess, true);
  assert.equal(await assertPageAccess('http://localhost:4178/page.html', api), 'http://localhost/*');
  assert.equal(fileChecks, 1);
  await assert.rejects(assertPageAccess('chrome://extensions', api), error => error.code === 'UNSUPPORTED_PAGE');
});

test('host permission requests retain the gesture and recheck the file toggle afterwards', async () => {
  const calls = [];
  const api = {extension: {isAllowedFileSchemeAccess: async () => {calls.push('toggle');return true;}}, permissions: {request: args => {calls.push(args);return Promise.resolve(true);}}};
  const result = requestPageAccess('file:///tmp/page.html', api);
  assert.deepEqual(calls, [{origins: ['file:///*']}]);
  assert.equal(await result, true);
  assert.equal(calls[1], 'toggle');
  api.extension.isAllowedFileSchemeAccess = async () => false;
  await assert.rejects(requestPageAccess('file:///tmp/page.html', api), error => error.code === 'FILE_ACCESS_REQUIRED');
  api.permissions.request = async () => false;
  assert.equal(await requestPageAccess('http://localhost:4178/page.html', api), false);
});

test('bad control input cannot poison visual settings or inject extra state', () => {
  assert.deepEqual(safeSettings({opacity: NaN, reveal: Infinity, linked: 'true', id: 'bad'}), DEFAULT_SETTINGS);
  assert.deepEqual(safeSettings({opacity: 10, reveal: -10, offsetX: 5000, offsetY: -5000, hidden: true}), {...DEFAULT_SETTINGS, opacity: 1, reveal: 0, offsetX: 3000, offsetY: -3000, hidden: true});
});

test('viewport mismatches and display-scale mismatches remain visible', () => {
  const size = {width: 1200, height: 800, dpr: 2};
  assert.equal(viewportWarning(size, size), '');
  assert.match(viewportWarning(size, {...size, width: 1000}), /Viewports differ/);
  assert.match(viewportWarning(size, {...size, dpr: 1}), /Zoom or display scale differs/);
});
