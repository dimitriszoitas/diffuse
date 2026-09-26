import test from 'node:test';
import assert from 'node:assert/strict';
import {safeSettings, DEFAULT_SETTINGS, sitePattern, viewportWarning} from '../extension/core.mjs';

test('host access is scoped to selected HTTP(S) hosts and rejects browser URLs', () => {
  assert.equal(sitePattern('http://localhost:4178/prototype.html'), 'http://localhost/*');
  assert.equal(sitePattern('https://app.example.com/settings?token=private'), 'https://app.example.com/*');
  assert.throws(() => sitePattern('chrome://extensions'));
  assert.throws(() => sitePattern('javascript:alert(1)'));
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
