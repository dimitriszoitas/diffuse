import test from 'node:test';
import assert from 'node:assert/strict';
import {ACCESSIBILITY_KNOWLEDGE_REVISION, ACCESSIBILITY_KNOWLEDGE_SOURCES, ACCESSIBILITY_REVIEW_RULES} from '../extension/accessibility-knowledge.mjs';

const rules = ACCESSIBILITY_REVIEW_RULES;
const criterion = id => rules.find(rule => rule.criterion === id);
const text = rule => `${rule.check} ${rule.evidence}`;

test('all active WCAG 2.2 A and AA criteria have correctly leveled guidance', () => {
  const expected = {
    A: '1.1.1 1.2.1 1.2.2 1.2.3 1.3.1 1.3.2 1.3.3 1.4.1 1.4.2 2.1.1 2.1.2 2.1.4 2.2.1 2.2.2 2.3.1 2.4.1 2.4.2 2.4.3 2.4.4 2.5.1 2.5.2 2.5.3 2.5.4 3.1.1 3.2.1 3.2.2 3.2.6 3.3.1 3.3.2 3.3.7 4.1.2'.split(' '),
    AA: '1.2.4 1.2.5 1.3.4 1.3.5 1.4.3 1.4.4 1.4.5 1.4.10 1.4.11 1.4.12 1.4.13 2.4.5 2.4.6 2.4.7 2.4.11 2.5.7 2.5.8 3.1.2 3.2.3 3.2.4 3.3.3 3.3.4 3.3.8 4.1.3'.split(' '),
  };
  for (const [level, ids] of Object.entries(expected)) {
    assert.deepEqual(rules.filter(rule => rule.level === level).map(rule => rule.criterion).sort(), ids.sort());
  }
  assert.equal(criterion('4.1.1'), undefined, 'Removed Parsing criterion must not appear as an active WCAG 2.2 requirement.');
});

test('every review rule is evidence-qualified and resolves to a checked primary source', () => {
  assert.match(ACCESSIBILITY_KNOWLEDGE_REVISION, /2026-10-24/);
  const sources = new Map(ACCESSIBILITY_KNOWLEDGE_SOURCES.map(source => [source.id, source]));
  assert.equal(sources.size, ACCESSIBILITY_KNOWLEDGE_SOURCES.length);
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  const modes = new Set(['visual', 'dom', 'interaction', 'manual']);
  for (const rule of rules) {
    assert.ok(modes.has(rule.verification), rule.id);
    assert.ok(rule.topic && rule.check && rule.evidence, rule.id);
    assert.ok(rule.sourceIds.length, rule.id);
    for (const id of rule.sourceIds) {
      const source = sources.get(id);
      assert.ok(source, `${rule.id}: unresolved source ${id}`);
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'www.w3.org');
      assert.equal(source.checkedAt, '2026-10-24');
      assert.ok(source.title);
    }
  }
  // Keep the product's local guidance concise rather than reproducing source pages.
  for (const source of sources.values()) {
    const words = rules.filter(rule => rule.sourceIds.includes(source.id)).map(text).join(' ').split(/\s+/).length;
    assert.ok(words <= 190, `${source.id}: ${words} words`);
  }
});

test('contrast requires measurements and cannot claim screenshot compliance', () => {
  assert.equal(criterion('1.4.3').verification, 'dom');
  assert.match(text(criterion('1.4.3')), /4\.5:1.*3:1.*18 pt.*14 pt/);
  assert.match(criterion('1.4.3').evidence, /unrounded calculated ratio/);
  assert.match(criterion('1.4.3').evidence, /Screenshot.*never compliance/);
  assert.match(text(criterion('1.4.11')), /3:1.*inactive-control.*browser-control/);
  assert.match(criterion('1.4.11').evidence, /Do not invent measurements/);
  assert.match(criterion('1.4.11').check, /borders are not always required/);
});

test('AA thresholds are not confused with optional AAA enhancements', () => {
  assert.match(criterion('2.5.8').check, /24 by 24 CSS px/);
  assert.match(criterion('2.5.8').check, /spacing.*equivalent.*inline.*browser.*essential/);
  assert.match(criterion('2.5.8').evidence, /24-pixel-diameter circles/);
  assert.equal(criterion('2.5.5').level, 'AAA');
  assert.match(criterion('2.5.5').check, /44 by 44 CSS px/);
  assert.match(criterion('2.5.5').evidence, /Do not call.*AA failure/);
  assert.match(criterion('2.4.11').check, /AA permits partial obscuring/);
  assert.equal(criterion('2.4.13').level, 'AAA');
  assert.match(criterion('2.4.13').evidence, /Do not impose.*AA/);
  assert.equal(criterion('2.3.3').level, 'AAA');
  assert.match(criterion('2.3.3').check, /Do not label.*AA/);
});

test('keyboard, states, announcements and semantics demand the missing test modality', () => {
  for (const id of ['2.1.1', '2.1.2', '2.1.4', '2.4.3', '2.4.7', '2.4.11', '1.4.13']) {
    assert.equal(criterion(id).verification, 'interaction');
  }
  for (const id of ['1.1.1', '1.3.1', '1.3.2', '2.5.3', '4.1.2']) {
    assert.equal(criterion(id).verification, 'dom');
  }
  assert.equal(criterion('4.1.3').verification, 'manual');
  assert.match(criterion('4.1.3').evidence, /test announcement with assistive technology/);
  assert.match(criterion('2.1.1').evidence, /pointer click.*does not verify keyboard/);
  assert.match(criterion('1.3.1').evidence, /limited DOM capture is unknown/);
  assert.match(criterion('2.4.7').evidence, /pointer-only screenshot is not a failure/);
});

test('resize and spacing checks require real transformations rather than image scaling', () => {
  assert.match(criterion('1.4.4').check, /200%/);
  assert.match(criterion('1.4.4').evidence, /scaling an image does not test/);
  assert.match(criterion('1.4.10').check, /320 CSS px.*256 CSS px/);
  assert.match(criterion('1.4.10').check, /two-dimensional.*exceptions/);
  assert.match(criterion('1.4.12').check, /1\.5.*2.*0\.12.*0\.16/);
  assert.match(criterion('1.4.12').check, /override tests, not required default styles/);
  assert.match(criterion('1.4.12').evidence, /all four overrides together/);
});

test('new criteria retain their applicable scope and exceptions', () => {
  assert.match(criterion('2.5.7').check, /single-pointer.*does not require dragging/);
  assert.match(criterion('2.5.7').check, /Keyboard access is a separate/);
  assert.match(criterion('3.2.6').check, /does not require adding help/);
  assert.equal(criterion('3.3.7').level, 'A');
  assert.match(criterion('3.3.7').check, /same process.*essential.*security.*no-longer-valid/);
  assert.match(criterion('3.3.8').check, /alternative.*assistance.*object-recognition.*personal-content/);
  assert.match(criterion('3.3.8').evidence, /Never collect credentials or bypass/);
});

test('APG and partial reviews cannot be represented as automatic conformance certification', () => {
  const scope = rules.find(rule => rule.id === 'a11y-audit-scope');
  assert.equal(scope.verification, 'manual');
  assert.match(scope.check, /not automatic conformance certification/);
  assert.match(scope.check, /unverified.*empty finding list is not a pass/);
  assert.match(scope.evidence, /Screenshot plus limited visible DOM/);
  const aria = rules.find(rule => rule.id === 'a11y-aria-support');
  assert.match(aria.check, /not additional WCAG success criteria/);
  for (const id of ['modal-dialog', 'combobox', 'tabs', 'accordion', 'menu-button', 'listbox']) {
    const rule = rules.find(item => item.id === `a11y-${id}`);
    assert.equal(rule.verification, 'interaction');
    assert.equal(rule.level, undefined);
    assert.equal(rule.criterion, undefined);
  }
});
