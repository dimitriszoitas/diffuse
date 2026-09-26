import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanFields, commentDisplayTitle} from '../extension/review-store.mjs';

test('a review requires useful feedback and an explicit state, with title and expected result optional', () => {
  assert.throws(() => cleanFields({}), /Describe/);
  assert.throws(() => cleanFields({title: 'Gap'}), /Describe/);
  assert.throws(() => cleanFields({title: 'Gap', comment: 'Too wide'}), /state/);
  const fields = cleanFields({comment: 'Too wide', state: 'Default'});
  assert.equal(fields.title, '');
  assert.equal(fields.expected, '');
  assert.equal(commentDisplayTitle(fields), 'Too wide');
});

test('comment updates accept only user-editable fields, never evidence or metadata', () => {
  const fields = cleanFields({title: '  Gap  ', comment: 'Too wide', state: 'Menu open', severity: 'super-important', evidence: {production: 'changed'}, selector: 'secret', component: 'Card'});
  assert.equal(fields.title, 'Gap');
  assert.equal(fields.severity, 'minor');
  assert.equal(fields.evidence, undefined);
  assert.equal(fields.selector, undefined);
  assert.equal(fields.component, 'Card');
});

test('unexpected field types and unbounded text are rejected or bounded', () => {
  const fields = cleanFields({title: 'A'.repeat(500), comment: 'B'.repeat(9000), state: 'Hovered', component: {unexpected: true}});
  assert.equal(fields.title.length, 180);
  assert.equal(fields.comment.length, 8000);
  assert.equal(fields.component, '');
});

test('comment categories support design, UX and copy while preserving legacy defaults', () => {
  const fields = {title: 'Navigation label', comment: 'The label is unclear.', state: 'Default'};
  for (const category of ['design-mismatch', 'ux-issue', 'copy-change']) assert.equal(cleanFields({...fields, category}).category, category);
  assert.equal(cleanFields(fields).category, 'design-mismatch');
  assert.equal(cleanFields({...fields, category: 'unknown'}).category, 'design-mismatch');
  assert.equal(cleanFields({...fields, category: {unexpected: true}}).category, 'design-mismatch');
});

test('editable fields cannot change accepted AI provenance or add secret settings', () => {
  const fields = cleanFields({title: 'Gap', comment: 'Too wide', state: 'Default', category: 'ux-issue', ai: {mismatchScore: 100, apiKey: 'should-not-pass'}, apiKey: 'should-not-pass'});
  assert.equal(fields.category, 'ux-issue');
  assert.equal(fields.ai, undefined);
  assert.equal(fields.apiKey, undefined);
});

test('derived display titles use concise observation text without mutating optional title', () => {
  const fields = cleanFields({title: '   ', comment: '\n  The button needs  more space.\nThe description wraps badly.', state: 'Default'});
  assert.equal(commentDisplayTitle(fields), 'The button needs more space.');
  assert.equal(fields.title, '');
  assert.equal(commentDisplayTitle({...fields, title: '  My chosen title  '}), 'My chosen title');
  const long = commentDisplayTitle({comment: 'The account settings button has inconsistent spacing. '.repeat(10)});
  assert.ok(Array.from(long).length <= 120);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.endsWith(' …'));
  assert.equal(commentDisplayTitle({comment: {}}, 3), 'Observation 4');
});
