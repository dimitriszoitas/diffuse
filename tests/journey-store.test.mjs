import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedJourneyIds} from '../extension/journey-store.mjs';

const saved = (index, extra = {}) => ({id: `run-${index}`, reviewId: 'review', updatedAt: new Date(1000 * index).toISOString(), ...extra});

test('forking the oldest of ten retained runs preserves the original and evicts another old run', () => {
  const previous = Array.from({length: 10}, (_, index) => saved(index));
  const original = structuredClone(previous);
  const child = saved(10, {fork: {parentRunId: 'run-0', instructions: 'Try another route.'}});
  const kept = retainedJourneyIds([...previous, child], child.id);
  assert.equal(kept.size, 10);
  assert(kept.has('run-0'));
  assert(kept.has(child.id));
  assert.equal(kept.has('run-1'), false);
  assert.deepEqual(previous, original, 'Retention must not mutate source records or their dates');
});

test('recording finalization retains child and direct parent even when their pair exceeds the approximate budget', () => {
  const parent = saved(0, {video: {dataUrl: 'p'.repeat(500)}});
  const sibling = saved(1);
  const child = saved(2, {fork: {parentRunId: parent.id, instructions: 'Try search.'}});
  const budget = JSON.stringify(parent).length + JSON.stringify(sibling).length + JSON.stringify(child).length;
  assert.equal(retainedJourneyIds([parent, sibling, child], child.id, {maxBytes: budget}).size, 3);
  child.video = {dataUrl: 'v'.repeat(1000)};
  const kept = retainedJourneyIds([parent, sibling, child], child.id, {maxBytes: budget});
  assert.deepEqual([...kept].sort(), [parent.id, child.id].sort());
});

test('retention protects one direct parent without recursively retaining an unlimited fork ancestry', () => {
  const ancestor = saved(0);
  const parent = saved(1, {fork: {parentRunId: ancestor.id}});
  const child = saved(2, {fork: {parentRunId: parent.id}});
  const kept = retainedJourneyIds([ancestor, parent, child], child.id, {maxBytes: 1});
  assert.deepEqual([...kept].sort(), [parent.id, child.id].sort());
  const later = saved(3);
  assert.deepEqual([...retainedJourneyIds([ancestor, parent, child, later], later.id, {maxBytes: 1})], [later.id]);
});

test('normal writes obey count and byte budgets and cannot retain an unrelated review as their parent', () => {
  const runs = Array.from({length: 12}, (_, index) => saved(index));
  assert.equal(retainedJourneyIds(runs, 'run-11').size, 10);
  const current = saved(12, {fork: {parentRunId: 'other'}});
  const other = saved(0, {id: 'other', reviewId: 'other-review'});
  assert.deepEqual([...retainedJourneyIds([other, current], current.id, {maxBytes: 1})], [current.id]);
});
