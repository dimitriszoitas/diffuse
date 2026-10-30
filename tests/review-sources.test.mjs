import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {safeReviewSourceUrl, reviewAssessmentLabel, reviewSources} from '../extension/review-sources.mjs';
import {aiMetadataRows, formatCommentHtml, formatReviewHtml, formatStandaloneHtml, formatMarkdown} from '../extension/report-format.mjs';

const sourceUrl = 'https://www.nngroup.com/articles/ten-usability-heuristics/';
const unsafeUrls = [
  'http://www.nngroup.com/articles/example/', 'javascript:alert(1)', 'data:text/html,<script>bad()</script>',
  '//www.w3.org/WAI/', 'file:///tmp/test.html', 'https://nngroup.com.evil.test/',
  'https://evil.test/nngroup.com/', 'https://evil.test@www.nngroup.com/', 'https://www.w3.org:444/WAI/',
  'https://members.nngroup.com/', 'https://www.w3.org\\@evil.test/', ' https://www.w3.org/',
  'https://www.w3.org/\nWAI/', 'https://www.w3.org/" onmouseover="bad()', 'https://www.w3.org/<script>',
  'https://www.w3.org/' + 'a'.repeat(2048), '', null, 42,
];

function fixture(ai) {
  return {id: 'review', title: 'UX review', mode: 'audit', createdAt: '2026-10-24T09:00:00Z', comments: [{
    id: 'finding', mode: 'audit', createdAt: '2026-10-24T09:00:01Z',
    fields: {title: 'Clarify the next action', category: 'ux-issue', comment: 'The action label is ambiguous.', expected: 'Describe what the action creates.'},
    ai,
  }]};
}

test('review source URLs permit HTTPS on exact public NN/g and W3C hosts only', () => {
  for (const host of ['nngroup.com', 'www.nngroup.com', 'w3.org', 'www.w3.org']) {
    assert.equal(safeReviewSourceUrl(`https://${host}/reference?part=1&view=2#example`), `https://${host}/reference?part=1&view=2#example`);
  }
  for (const url of unsafeUrls) assert.equal(safeReviewSourceUrl(url), '', String(url));
});

test('source normalization bounds imports, removes duplicates, and does not mutate them', () => {
  const sources = [null, {url: 'javascript:bad()'}, {url: sourceUrl, title: '  Heuristics\nreference\u0000  '},
    {url: sourceUrl, title: 'Duplicate'}, {url: 'https://www.w3.org/WAI/', title: 5},
    ...Array.from({length: 20}, (_, index) => ({url: `https://www.w3.org/reference-${index}`, title: 'x'.repeat(300)}))];
  const original = structuredClone(sources), normalized = reviewSources(sources);
  assert.equal(normalized.length, 8);
  assert.deepEqual(normalized[0], {url: sourceUrl, title: 'Heuristics reference'});
  assert.deepEqual(normalized[1], {url: 'https://www.w3.org/WAI/', title: 'W3C reference'});
  assert.equal(normalized[2].title.length, 240);
  assert.deepEqual(sources, original);
  assert.deepEqual(reviewSources([...Array(32).fill(null), {url: sourceUrl}]), []);
  assert.deepEqual(reviewSources({url: sourceUrl}), []);
  assert.equal(reviewSources([{url: sourceUrl}])[0].title, 'NN/g reference');
});

test('assessment labels distinguish evidence from recommendations without accepting arbitrary or inherited keys', () => {
  assert.equal(reviewAssessmentLabel('observed'), 'Visible observation');
  assert.equal(reviewAssessmentLabel('heuristic'), 'UX recommendation');
  assert.equal(reviewAssessmentLabel('needs-verification'), 'Needs verification');
  for (const value of [null, {}, '__proto__', 'constructor', 'toString', 'verified', '<script>']) assert.equal(reviewAssessmentLabel(value), '');
});

test('HTML and Markdown keep assessment and collapsed sources beside the finding and retain provenance', () => {
  for (const assessment of ['observed', 'heuristic', 'needs-verification']) {
    const review = fixture({assessment, sources: [{title: 'Usability heuristics', url: sourceUrl}],
      ruleIds: ['ux-status', 'a11y-1-1-1'], knowledgeRevision: 'nng-public-2026-10-24-1', checkedAt: '2026-10-24'});
    const before = structuredClone(review);
    for (const html of [formatCommentHtml(review.comments[0]), formatReviewHtml(review), formatStandaloneHtml(review), formatReviewHtml(review, {clipboard: true})]) {
      assert.ok(html.includes(reviewAssessmentLabel(assessment)));
      assert.match(html, /<details class="ai-sources"[^>]*><summary>Sources \(1\)<\/summary>/);
      assert.ok(html.includes(`href="${sourceUrl}" target="_blank" rel="noopener noreferrer"`));
      assert.ok(html.indexOf('class="ai-assessment"') < html.indexOf('class="field observation"'));
      assert.ok(html.includes('ai.knowledgeRevision'));
      assert.ok(html.includes('nng-public-2026-10-24-1'));
      assert.ok(html.includes('ai.checkedAt'));
    }
    const markdown = formatMarkdown(review);
    assert.ok(markdown.includes(`**Assessment:** ${reviewAssessmentLabel(assessment)}`));
    assert.ok(markdown.includes('<summary>Sources (1)</summary>'));
    assert.ok(markdown.includes(`- [Usability heuristics](<${sourceUrl}>)`));
    assert.ok(markdown.indexOf('**Assessment:**') < markdown.indexOf('### Current'));
    assert.ok(markdown.includes('ai.reviewRules: ux-status, a11y-1-1-1'));
    assert.deepEqual(review, before);
  }
});

test('untrusted source titles remain text and rejected links never appear in exports', () => {
  const title = '<img src=x onerror="bad()"> [fake](javascript:bad()) </summary><script>bad()</script>';
  const review = fixture({assessment: 'heuristic', sources: [
    ...unsafeUrls.map(url => ({url, title: 'Rejected source'})), {url: sourceUrl, title},
  ]});
  for (const html of [formatReviewHtml(review), formatStandaloneHtml(review), formatReviewHtml(review, {clipboard: true})]) {
    assert.match(html, /Sources \(1\)/);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;bad()&quot;&gt;'));
    assert.doesNotMatch(html, /<script\b|<img src=x|href="(?:javascript:|data:|file:|http:)/i);
    assert.ok(!html.includes('Rejected source'));
  }
  const markdown = formatMarkdown(review);
  assert.ok(markdown.includes('&lt;img src=x onerror="bad()"&gt;'));
  assert.ok(markdown.includes('\\[fake\\](javascript:bad())'));
  assert.doesNotMatch(markdown, /<script\b|<img src=x|(?<!\\)\]\((?:javascript:|data:|file:|http:)/i);
  assert.ok(!markdown.includes('Rejected source'));
});

test('legacy comments produce no new assessment or source block and keep existing AI metadata', () => {
  const ai = {provider: 'anthropic', model: 'legacy-model', reason: 'Clarifies the action'};
  assert.deepEqual(aiMetadataRows(ai), [['ai.provider', 'anthropic'], ['ai.model', 'legacy-model'], ['ai.reason', 'Clarifies the action']]);
  for (const metadata of [undefined, ai]) {
    const review = fixture(metadata);
    const html = formatReviewHtml(review), markdown = formatMarkdown(review);
    assert.doesNotMatch(html, /class="ai-assessment"|class="ai-sources"/);
    assert.doesNotMatch(markdown, /\*\*Assessment:\*\*|<summary>Sources/);
    assert.ok(html.includes('The action label is ambiguous.'));
    assert.ok(markdown.includes('### Change to'));
  }
  const invalid = {...ai, assessment: '__proto__', sources: [{url: 'javascript:bad()'}], ruleIds: ['<script>', null]};
  assert.deepEqual(aiMetadataRows(invalid), aiMetadataRows(ai));
  assert.equal(formatReviewHtml(fixture(invalid)), formatReviewHtml(fixture(ai)));
  assert.equal(formatMarkdown(fixture(invalid)), formatMarkdown(fixture(ai)));
});

// Exercise the actual isolated render helpers from both classic controllers.
// The DOM double deliberately forbids innerHTML to catch accidental HTML sinks.
class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.style = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  set innerHTML(_) { throw new Error('Untrusted source content must use textContent'); }
}
function descendants(element, tagName) {
  return element.children.flatMap(child => [...(child.tagName === tagName ? [child] : []), ...descendants(child, tagName)]);
}

for (const filename of ['content.js', 'sidepanel.js']) {
  test(`${filename} renders safe, collapsed sources and assessment labels, including hostile imported data`, async () => {
    const source = await readFile(new URL(`../extension/${filename}`, import.meta.url), 'utf8');
    const start = source.indexOf('  function appendAiReviewGuidance('), end = source.indexOf('\n  function ', start + 3);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({URL, document: {createElement: tagName => new Element(tagName)}});
    const render = vm.runInContext(`(${source.slice(start, end).trim()})`, context);
    for (const assessment of ['observed', 'heuristic', 'needs-verification']) {
      const card = new Element('article'), title = '<img src=x onerror="bad()">';
      render(card, {assessment, sources: [...unsafeUrls.map(url => ({url})), {url: sourceUrl, title}, {url: sourceUrl, title: 'duplicate'}]}, 'note', 'sources');
      assert.equal(card.children[0].textContent, reviewAssessmentLabel(assessment));
      const [details] = descendants(card, 'details');
      assert.ok(details);
      assert.ok(!details.open, 'Sources start collapsed');
      assert.equal(descendants(details, 'summary')[0].textContent, 'Sources (1)');
      const links = descendants(details, 'a');
      assert.equal(links.length, 1);
      assert.equal(links[0].href, sourceUrl);
      assert.equal(links[0].textContent, title);
      assert.equal(links[0].target, '_blank');
      assert.equal(links[0].rel, 'noopener noreferrer');
      assert.equal(descendants(card, 'img').length, 0);
    }
    const legacy = new Element('article');render(legacy, {assessment: '__proto__', sources: [{url: 'javascript:bad()'}]}, 'note', 'sources');
    assert.equal(legacy.children.length, 0);
    const bounded = new Element('article'), sources = Array.from({length: 20}, (_, index) => ({url: `https://www.w3.org/ref-${index}`, title: `Reference ${index}`}));
    render(bounded, {sources}, 'note', 'sources');
    assert.deepEqual(descendants(bounded, 'a').map(link => ({url: link.href, title: link.textContent})), reviewSources(sources));
  });
}
