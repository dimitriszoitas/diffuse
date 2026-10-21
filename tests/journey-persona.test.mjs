import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_JOURNEY_PERSONA, JOURNEY_PERSONA_TRAITS, normalizeJourneyPersona, journeyPersonaSummary} from '../extension/journey-persona.mjs';

test('older clients receive independent defaults and explicit profiles are normalized without mutation', () => {
  const first = normalizeJourneyPersona(), second = normalizeJourneyPersona();
  assert.deepEqual(first, {description: 'First-time user', technicalConfidence: 3, productFamiliarity: 1, taskFamiliarity: 3, persistence: 3});
  first.persistence = 1;
  assert.equal(second.persistence, 3);
  assert.equal(DEFAULT_JOURNEY_PERSONA.persistence, 3);
  const input = {...second, description: '  First visit to a stock-management tool.\u0000  '};
  assert.equal(normalizeJourneyPersona(input).description, 'First visit to a stock-management tool.');
  assert.equal(input.description.endsWith('  '), true);
  assert.deepEqual(JOURNEY_PERSONA_TRAITS.map(item => item.key), Object.keys(DEFAULT_JOURNEY_PERSONA).slice(1));
});

test('explicit personas reject incomplete, coerced, out-of-range or unexpected inputs', () => {
  const base = {...DEFAULT_JOURNEY_PERSONA};
  const invalid = [null, [], 'novice', {}, {...base, description: ''}, {...base, description: '\u0000 '}, {...base, description: 'x'.repeat(1501)}, {...base, description: 9}, {...base, goal: 'Unapproved override'}];
  for (const {key} of JOURNEY_PERSONA_TRAITS) {
    for (const value of [undefined, null, '3', 0, 6, 1.5, NaN, Infinity]) invalid.push({...base, [key]: value});
    const missing = {...base}; delete missing[key]; invalid.push(missing);
  }
  for (const value of invalid) assert.throws(() => normalizeJourneyPersona(value), error => error.code === 'JOURNEY_PERSONA');
  assert.equal(normalizeJourneyPersona({...base, description: 'x'.repeat(1500), technicalConfidence: 1, persistence: 5}).persistence, 5);
});

test('recipient summary includes every configured trait and labels the perspective as simulated', () => {
  const value = {...DEFAULT_JOURNEY_PERSONA, description: 'A restaurant manager reviewing stock', taskFamiliarity: 5, technicalConfidence: 2};
  const summary = journeyPersonaSummary(value);
  assert.match(summary, /A restaurant manager reviewing stock/);
  for (const {key, label} of JOURNEY_PERSONA_TRAITS) assert(summary.includes(`${label}: ${value[key]}/5`));
  assert.match(summary, /AI-simulated perspective, not a real participant/);
});
