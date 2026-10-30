import test from 'node:test';
import assert from 'node:assert/strict';
import {UX_KNOWLEDGE_REVISION, UX_KNOWLEDGE_SOURCES, UX_REVIEW_RULES} from '../extension/ux-knowledge.mjs';

test('UX references are dated canonical primary sources with distinct identifiers', () => {
  assert.match(UX_KNOWLEDGE_REVISION, /^nng-public-\d{4}-\d{2}-\d{2}-\d+$/);
  assert.ok(UX_KNOWLEDGE_SOURCES.length >= 30);
  assert.equal(new Set(UX_KNOWLEDGE_SOURCES.map(source => source.id)).size, UX_KNOWLEDGE_SOURCES.length);
  assert.equal(new Set(UX_KNOWLEDGE_SOURCES.map(source => source.url)).size, UX_KNOWLEDGE_SOURCES.length);
  for (const source of UX_KNOWLEDGE_SOURCES) {
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'www.nngroup.com');
    assert.match(url.pathname, /^\/articles\/[^/]+\/$/);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.ok(source.title.length > 5);
    assert.equal(source.checkedAt, '2026-10-24');
    for (const key of ['publishedAt', 'reviewedAt']) if (source[key]) {
      assert.match(source[key], /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(source[key] <= source.checkedAt, `${source.id}: date is not in the future`);
    }
    if (source.reviewedAt) assert.ok(source.reviewedAt >= source.publishedAt);
  }
});

test('every review check has evidence requirements and resolves to a used source', () => {
  const sources = new Set(UX_KNOWLEDGE_SOURCES.map(source => source.id));
  const used = new Set();
  assert.equal(new Set(UX_REVIEW_RULES.map(rule => rule.id)).size, UX_REVIEW_RULES.length);
  for (const rule of UX_REVIEW_RULES) {
    assert.match(rule.id, /^ux-[a-z-]+$/);
    assert.ok(rule.topic && rule.check.length > 40 && rule.evidence.length > 40);
    assert.ok(rule.sourceIds.length);
    for (const id of rule.sourceIds) {
      assert.ok(sources.has(id), `${rule.id}: unresolved source ${id}`);
      used.add(id);
    }
  }
  assert.deepEqual(used, sources, 'No source is listed merely to inflate research coverage.');
});

test('reference summaries stay compact and do not contain archived articles', () => {
  for (const source of UX_KNOWLEDGE_SOURCES) {
    const summary = UX_REVIEW_RULES.filter(rule => rule.sourceIds.includes(source.id))
      .map(rule => `${rule.check} ${rule.evidence}`).join(' ');
    assert.ok(summary.split(/\s+/).length <= 175, `${source.id}: source-derived summary is too long`);
  }
  assert.ok(JSON.stringify(UX_REVIEW_RULES).length < 22000, 'Guidance fits in a bounded review context.');
});

test('UX coverage includes interaction states and explicitly limits simulated research claims', () => {
  const byId = Object.fromEntries(UX_REVIEW_RULES.map(rule => [rule.id, rule]));
  for (const topic of ['forms', 'navigation', 'tables', 'errors', 'interaction-states', 'mobile', 'inclusion', 'research-validity']) {
    assert.ok(UX_REVIEW_RULES.some(rule => rule.topic === topic), `Missing ${topic}`);
  }
  assert.match(byId['ux-control-states'].evidence, /not tested/);
  assert.match(byId['ux-image-purpose'].evidence, /Do not infer.*screenshot/);
  assert.match(byId['ux-scroll-discovery'].evidence, /available scroll paths/);
  assert.match(byId['ux-interaction-effort'].evidence, /separately from human task time/);
  assert.match(byId['ux-rating-validity'].check, /do not manufacture/);
  assert.match(byId['ux-task-outcome'].evidence, /Do not.*success rate/);
});

test('shared reference data cannot be mutated by an individual review', () => {
  assert.throws(() => UX_KNOWLEDGE_SOURCES.push({}), TypeError);
  assert.throws(() => {UX_KNOWLEDGE_SOURCES[0].url = 'https://example.com';}, TypeError);
  assert.throws(() => {UX_REVIEW_RULES[0].check = 'Changed';}, TypeError);
  assert.throws(() => UX_REVIEW_RULES[0].sourceIds.push('untrusted'), TypeError);
});
