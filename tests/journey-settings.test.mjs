import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_JOURNEY_SETTINGS, JOURNEY_FOCUS_CHECKS, normalizeJourneySettings} from '../extension/journey-settings.mjs';

test('journey options default safely and validate explicit scope without coercion', () => {
  assert.deepEqual(normalizeJourneySettings(), DEFAULT_JOURNEY_SETTINGS);
  const first = normalizeJourneySettings(); first.focusChecks.push('layout');
  assert.deepEqual(normalizeJourneySettings().focusChecks, ['completion', 'discoverability', 'feedback']);
  assert.deepEqual(normalizeJourneySettings({exploration: 'thorough', allowRecordMoves: true, extraInstructions: '  Move only my sample recipe. ', focusChecks: ['interaction', 'layout']}), {
    exploration: 'thorough', allowRecordMoves: true, extraInstructions: 'Move only my sample recipe.', focusChecks: ['interaction', 'layout'],
  });
  for (const input of [{exploration: null}, {exploration: 'unlimited'}, {allowRecordMoves: 'true'}, {allowRecordMoves: null}, {extraInstructions: null}, {extraInstructions: 'a'.repeat(2001)}, {focusChecks: []}, {focusChecks: ['completion', 'completion']}, {focusChecks: 'all'}, {focusChecks: ['performance']}, {focusChecks: null}]) assert.throws(() => normalizeJourneySettings(input));
  assert.equal(normalizeJourneySettings({focusChecks: JOURNEY_FOCUS_CHECKS.map(item => item.key)}).focusChecks.length, 6);
});
