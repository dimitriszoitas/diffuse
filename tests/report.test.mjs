import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, safePageUrl, localFilePath, safeMediaUrl, evidenceImages, evidenceVideo, metadataRows,
  formatReviewHtml, formatStandaloneHtml, formatMarkdown, fileStem,
  aiMetadataRows, categoryLabel, categoryKey, CATEGORY_PALETTE, commentTitle, recordedFocusCrop,
} from '../extension/report-format.mjs';

const production = 'data:image/png;base64,cHJvZHVjdGlvbg==';
const prototype = 'data:image/png;base64,cHJvdG90eXBl';
const annotated = 'data:image/png;base64,YW5ub3RhdGVk';
const crop = 'data:image/png;base64,Y3JvcA==';
const video = 'data:video/webm;base64,dmlkZW8=';

function fixture() {
  return {
    id: 'review-1', title: 'Account menu polish', createdAt: '2026-09-25T09:30:00.000Z', updatedAt: '2026-09-25T09:40:00.000Z',
    productionUrl: 'https://app.example.test/account', prototypeUrl: 'http://localhost:3000/account',
    comments: [{
      id: 'comment-1', reviewId: 'review-1', createdAt: '2026-09-25T09:31:00.000Z',
      fields: {title: 'Menu spacing is too tight', comment: 'The account menu has less padding.\nThe last item touches the edge.', expected: 'Use the prototype spacing.', component: 'AccountMenu', state: 'expanded', steps: 'Open Account.\nChoose Settings.', severity: 'medium'},
      selection: {schemaVersion: 1, selector: '[data-testid="account-menu"]', tagName: 'div', component: {name: 'AccountMenu', source: 'data-component'}, rect: {viewport: {x: 10, y: 20, width: 100, height: 50}}, styles: {paddingTop: '8px', color: 'rgb(25, 40, 18)'}, states: {expanded: true}, breadcrumb: [{tag: 'main'}]},
      context: {production: {url: 'https://app.example.test/account', viewport: {width: 1280, height: 800, dpr: 2}, scroll: {x: 0, y: 40}}, prototype: {url: 'http://localhost:3000/account', viewport: {width: 1280, height: 800, dpr: 2}}, alignment: {offsetX: 0, offsetY: 3}},
      evidence: {production: {dataUrl: production, annotatedDataUrl: annotated, cropDataUrl: crop, width: 2560, height: 1600, capturedAt: '2026-09-25T09:31:00.000Z'}, prototype: {dataUrl: prototype, width: 2560, height: 1600, capturedAt: '2026-09-25T09:31:00.080Z'}, captureSkewMs: 80, video: {dataUrl: video, mimeType: 'video/webm', durationMs: 5600, filename: 'account-menu.webm', kind: 'comparison-recording', startedAt: '2026-09-25T09:31:00.000Z', stoppedAt: '2026-09-25T09:31:05.600Z'}},
    }],
  };
}

test('escapes all HTML metacharacters in untrusted user content', () => {
  assert.equal(escapeHtml('<img src="x" onerror=\'bad()\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;bad()&#39;&gt;&amp;');
  const review = fixture();
  review.title = '</title><script>alert(1)</script>';
  review.comments[0].id = '"><script>alert(2)</script>';
  review.comments[0].fields.comment = '<img src=x onerror="alert(3)">';
  review.comments[0].fields.severity = '<svg onload=alert(4)>';
  review.comments[0].selection.styles.fontFamily = '</td><script>bad()</script>';
  const html = formatStandaloneHtml(review);
  assert.ok(!/<script\b/i.test(html));
  assert.ok(!/<svg\b/i.test(html));
  assert.ok(!/<img src=x/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(3)&quot;&gt;'));
});

test('page links permit only HTTP and HTTPS and reject control-character obfuscation', () => {
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'blob:https://example.test/a', '//example.test/path', 'java\nscript:alert(1)', ' https://example.test']) assert.equal(safePageUrl(unsafe), '');
  assert.equal(safePageUrl('https://example.test/a?b=c'), 'https://example.test/a?b=c');
  assert.equal(safePageUrl('http://localhost:3000/'), 'http://localhost:3000/');
  const review = fixture();
  review.productionUrl = 'javascript:alert(1)';
  const html = formatReviewHtml(review);
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('<span>javascript:alert(1)</span>'));
});

test('local HTML captures retain readable escaped paths without clickable file links or remote file hosts', () => {
  const review = fixture();
  const productionPath = 'file:///Users/designer/My%20demo/current%20%3Cscript%3E.html';
  const referencePath = 'file:///Users/designer/My%20demo/reference%20%5Bapproved%5D.html';
  review.productionUrl = productionPath;
  review.prototypeUrl = referencePath;
  review.comments[0].context.production.url = productionPath;
  review.comments[0].context.prototype.url = referencePath;
  const before = structuredClone(review);
  assert.equal(localFilePath(productionPath), '/Users/designer/My demo/current <script>.html');
  assert.equal(safePageUrl(productionPath), '', 'File locations remain forbidden in hyperlink helpers, including Jira ADF');
  for (const html of [formatReviewHtml(review), formatReviewHtml(review, {clipboard: true}), formatStandaloneHtml(review)]) {
    assert.match(html, /Local file: \/Users\/designer\/My demo\/current &lt;script&gt;\.html/);
    assert.match(html, /Reference for this observation: <span>Local file: \/Users\/designer\/My demo\/reference \[approved\]\.html<\/span>/);
    assert.doesNotMatch(html, /(?:href|src)=["']file:/i);
    assert.doesNotMatch(html, /<script>/);
  }
  const markdown = formatMarkdown(review, {embedMedia: false});
  assert.ok(markdown.includes('Production: Local file: /Users/designer/My demo/current \\<script\\>.html'));
  assert.ok(markdown.includes('Reference for this observation: Local file: /Users/designer/My demo/reference \\[approved\\].html'));
  const rows = new Map(metadataRows(review.comments[0]));
  assert.equal(rows.get('context.production.url'), 'Local file: /Users/designer/My demo/current <script>.html');
  assert.equal(rows.get('context.prototype.url'), 'Local file: /Users/designer/My demo/reference [approved].html');
  for (const unsafe of ['file://server/private.html', 'file:///tmp/%0A.html', 'file:///tmp/%FF.html', 'javascript:alert(1)', 'data:text/html,<script>bad()</script>']) assert.equal(localFilePath(unsafe), '');
  assert.deepEqual(review, before, 'Formatting never rewrites stored capture context');
});

test('media validation accepts only embedded base64 raster images and supported video', () => {
  assert.equal(safeMediaUrl(production), production);
  assert.equal(safeMediaUrl('data:image/jpeg;base64,YQ=='), 'data:image/jpeg;base64,YQ==');
  assert.equal(safeMediaUrl('data:video/webm;codecs=vp9;base64,YQ==', 'video'), 'data:video/webm;codecs=vp9;base64,YQ==');
  assert.equal(safeMediaUrl(video, 'video'), video);
  for (const unsafe of ['https://example.test/tracker.png', 'blob:https://example.test/a', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,YQ==', 'data:image/png;base64,YQ==" onerror="bad()', 'data:image/png,<svg>', 'javascript:alert(1)']) assert.equal(safeMediaUrl(unsafe), '');
  assert.equal(safeMediaUrl(video), '');
  assert.equal(safeMediaUrl(production, 'video'), '');
  assert.equal(safeMediaUrl(production, 'anything'), '');
});

test('default screenshot evidence includes both sides and the selected-region crop', () => {
  const review = fixture();
  const images = evidenceImages(review.comments[0]);
  assert.equal(images.length, 3);
  assert.equal(images[0].side, 'production');
  assert.equal(images[0].dataUrl, annotated);
  assert.equal(images[0].originalDataUrl, production);
  assert.equal(images[1].side, 'prototype');
  assert.equal(images[1].dataUrl, prototype);
  assert.equal(images[2].kind, 'crop');
  assert.equal(images[2].dataUrl, crop);
  const html = formatReviewHtml(review);
  assert.ok(html.includes(`src="${annotated}"`));
  assert.ok(html.includes(`src="${crop}"`));
  assert.ok(html.includes(`src="${prototype}"`));
  assert.ok(html.includes('selected element highlighted'));
});

test('falls back to original image when annotation is absent or unsafe', () => {
  const comment = fixture().comments[0];
  comment.evidence.production.annotatedDataUrl = 'javascript:alert(1)';
  delete comment.evidence.production.cropDataUrl;
  const images = evidenceImages(comment);
  assert.equal(images.length, 2);
  assert.equal(images[0].dataUrl, production);
});

test('self-contained HTML includes playable video and embedded screenshots without external dependencies', () => {
  const html = formatStandaloneHtml(fixture());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes(`src="${video}"`));
  assert.ok(html.includes(`poster="${annotated}"`));
  assert.ok(html.includes('controls preload="metadata"'));
  assert.ok(html.includes('account-menu.webm'));
  assert.equal(html.split(video).length - 1, 1, 'Do not double the report size with a duplicate video download URL');
  assert.ok(html.includes('5.6 seconds'));
  assert.ok(!/(?:src|href)="blob:/i.test(html));
  assert.ok(!/<(?:script|link)\b/i.test(html));
  assert.ok(!/<img[^>]+src="https?:/i.test(html));
});

test('clipboard HTML includes screenshot poster and recording filename but no video payload', () => {
  const html = formatReviewHtml(fixture(), {clipboard: true});
  assert.ok(html.includes(annotated));
  assert.ok(html.includes(prototype));
  assert.ok(html.includes('account-menu.webm'));
  assert.ok(!html.includes('<video'));
  assert.ok(!html.includes(video));
  assert.ok(html.includes('arbitrary documents do not preserve playable video'));
  assert.ok(/<details class="engineering-context"(?:\s[^>]*)?>/.test(html));
  assert.ok(!/<details class="engineering-context"[^>]*\bopen(?:\s|>)/.test(html));
});

test('engineering metadata includes selection, state, geometry, context, and recording timing', () => {
  const rows = new Map(metadataRows(fixture().comments[0]));
  assert.equal(rows.get('element.component.name'), 'AccountMenu');
  assert.equal(rows.get('element.rect.viewport.width'), '100');
  assert.equal(rows.get('element.states.expanded'), 'true');
  assert.equal(rows.get('context.production.viewport.dpr'), '2');
  assert.equal(rows.get('context.alignment.offsetY'), '3');
  assert.equal(rows.get('capture.skewMs'), '80');
  assert.equal(rows.get('capture.production.pixels'), '2560 × 1600');
  assert.equal(rows.get('capture.recording.kind'), 'comparison-recording');
  assert.ok(rows.has('capture.recording.startedAt'));
  assert.ok(![...rows.values()].some((value) => value.includes('base64,')));
});

test('formatting never mutates original review or evidence', () => {
  const review = fixture();
  const original = structuredClone(review);
  formatReviewHtml(review);
  formatStandaloneHtml(review);
  formatMarkdown(review);
  metadataRows(review.comments[0]);
  assert.deepEqual(review, original);
});

test('Markdown export embeds both images and region while text clipboard stays readable', () => {
  const review = fixture();
  const markdown = formatMarkdown(review);
  assert.ok(markdown.includes(`](${annotated})`));
  assert.ok(markdown.includes(`](${crop})`));
  assert.ok(markdown.includes(`](${prototype})`));
  assert.ok(markdown.includes('account-menu.webm'));
  assert.ok(!markdown.includes(video));
  assert.ok(!markdown.includes('blob:'));
  const plain = formatMarkdown(review, {embedMedia: false});
  assert.ok(!plain.includes('data:image'));
  assert.ok(plain.includes('Screenshot: Production'));
  assert.ok(plain.includes('Copy image'));
});

test('Markdown escapes HTML and executable Markdown link syntax', () => {
  const review = fixture();
  review.comments[0].fields.comment = '<script>alert(1)</script> [click](javascript:alert(2)) ![x](data:image/svg+xml,bad)';
  const markdown = formatMarkdown(review);
  assert.ok(markdown.includes('\\<script\\>'));
  assert.ok(markdown.includes('\\[click\\]'));
  assert.ok(markdown.includes('\\!\\[x\\]'));
});

test('export includes every comment and handles missing screenshots and whole-page selection', () => {
  const review = fixture();
  review.comments.push({id: 'comment-2', fields: {title: 'Whole page observation', comment: 'A loading transition looks different.'}, selection: null});
  const html = formatReviewHtml(review);
  assert.ok(html.includes('2 observations'));
  assert.ok(html.includes('Whole page observation'));
  assert.ok(html.includes('No screenshot evidence was recorded'));
  assert.doesNotThrow(() => formatMarkdown(review));
  assert.ok(formatReviewHtml({comments: []}).includes('No observations in this review yet.'));
});

test('video filenames and report download stems cannot become paths or markup', () => {
  const comment = fixture().comments[0];
  comment.evidence.video.filename = '../../evil" onerror="boom.webm';
  const info = evidenceVideo(comment);
  assert.equal(info.filename, 'evil-onerror-boom.webm');
  assert.equal(fileStem('../../<report>'), 'report');
  assert.equal(fileStem('💚'), 'diffuse-review');
  assert.ok(!formatReviewHtml({comments: [comment]}).includes('download="../../'));
});

test('cyclic or deeply nested metadata does not crash exports', () => {
  const comment = {fields: {}, context: {}};
  comment.context.recursive = comment.context;
  assert.doesNotThrow(() => formatReviewHtml({comments: [comment]}));
  assert.ok(metadataRows(comment).some(([, value]) => value === '[Repeated object]'));
});

test('a multi-comment report keeps every screenshot and recording payload', () => {
  const review = fixture();
  const template = review.comments[0];
  review.comments = Array.from({length: 16}, (_, index) => {
    const comment = structuredClone(template);
    comment.id = `comment-${index}`;
    comment.fields.title = `Recorded observation ${index}`;
    comment.evidence.production.annotatedDataUrl = `data:image/png;base64,${Buffer.from(`production-${index}`).toString('base64')}`;
    comment.evidence.prototype.dataUrl = `data:image/png;base64,${Buffer.from(`prototype-${index}`).toString('base64')}`;
    comment.evidence.video.dataUrl = `data:video/webm;base64,${Buffer.from(`recording-${index}`).toString('base64')}`;
    return comment;
  });
  const html = formatStandaloneHtml(review);
  assert.equal((html.match(/<article class="comment-card"/g) || []).length, 16);
  assert.equal((html.match(/<video controls/g) || []).length, 16);
  for (const comment of review.comments) {
    assert.ok(html.includes(comment.evidence.production.annotatedDataUrl));
    assert.ok(html.includes(comment.evidence.prototype.dataUrl));
    assert.ok(html.includes(comment.evidence.video.dataUrl));
  }
});

test('single-page audits export their one page without missing prototype or paired language', () => {
  const review = fixture();
  review.mode = 'audit';
  review.prototypeUrl = '';
  delete review.comments[0].context.prototype;
  delete review.comments[0].evidence.prototype;
  review.comments[0].fields.category = 'ux-issue';
  const html = formatStandaloneHtml(review);
  const clipboard = formatReviewHtml(review, {clipboard: true});
  const markdown = formatMarkdown(review);
  for (const text of [html, clipboard, markdown]) {
    assert.ok(/design audit/i.test(text));
    assert.ok(text.includes('UX issue'));
    assert.ok(!text.includes('Prototype</dt>'));
    assert.ok(!text.includes('Prototype:'));
    assert.ok(!text.includes('The two apps'));
    assert.ok(!text.includes('live reference and comparison controls'));
  }
  assert.ok(html.includes('<dt>Page</dt>'));
  assert.ok(html.includes('Page · selected element highlighted'));
  assert.ok(markdown.includes('Page: https://app.example.test/account'));
});

test('all comment categories have friendly export labels and legacy reports keep design mismatch', () => {
  assert.equal(categoryLabel(), 'Design mismatch');
  const review = fixture();
  for (const [category, label] of [['design-mismatch', 'Design mismatch'], ['ux-issue', 'UX issue'], ['copy-change', 'Copy change']]) {
    review.comments[0].fields.category = category;
    assert.ok(formatReviewHtml(review).includes(label));
    assert.ok(formatMarkdown(review).includes(`Category: ${label}`));
  }
});

test('accepted AI metadata is allowlisted and separates estimate score from confidence', () => {
  const review = fixture();
  review.comments[0].ai = {provider: 'anthropic', model: 'claude-test', runId: 'run-7', suggestionId: 'finding-3', mismatchScore: 24, confidence: 0.82, reason: 'Visible padding difference', acceptedAt: '2026-09-25T10:00:00Z', mode: 'comparison', apiKey: 'NEVER_EXPORT_THIS_KEY', request: {headers: {authorization: 'NEVER_EXPORT_THIS_HEADER'}}, settings: {apiKey: 'NEVER_EXPORT_SETTINGS'}};
  const rows = new Map(aiMetadataRows(review.comments[0].ai));
  assert.equal(rows.get('ai.provider'), 'anthropic');
  assert.equal(rows.get('ai.confidence'), '0.82');
  assert.equal(rows.get('ai.estimatedDifferenceScore'), '24/100 (AI estimate, not pixel accuracy)');
  assert.equal(rows.get('ai.reviewStatus'), 'Accepted by the reviewer');
  for (const text of [formatReviewHtml(review), formatStandaloneHtml(review), formatMarkdown(review)]) {
    assert.ok(text.includes('anthropic'));
    assert.ok(text.includes('accepted by the reviewer') || text.includes('Accepted by the reviewer'));
    assert.ok(!text.includes('NEVER_EXPORT'));
    assert.ok(text.includes('24/100 (AI estimate, not pixel accuracy)'));
  }
  assert.equal(aiMetadataRows({mismatchScore: 500, confidence: -1}).length, 0);
});

test('selected region exports bounds without inventing element or component metadata', () => {
  const review = fixture();
  review.mode = 'audit';
  const comment = review.comments[0];
  comment.selection.kind = 'region';
  comment.selection.component = {name: 'UNVERIFIED_COMPONENT'};
  comment.fields.component = '';
  const rows = new Map(metadataRows(comment));
  assert.equal(rows.get('region.kind'), 'region');
  assert.equal(rows.get('region.rect.viewport.width'), '100');
  assert.ok(!rows.has('element.selector'));
  assert.ok(![...rows.values()].includes('UNVERIFIED_COMPONENT'));
  const html = formatReviewHtml(review);
  assert.ok(html.includes('selected region highlighted'));
  assert.ok(html.includes('no component identity or DOM measurements are inferred'));
  assert.ok(!html.includes('UNVERIFIED_COMPONENT'));
});

test('engineering context omits known credential containers from malformed imported metadata', () => {
  const review = fixture();
  review.comments[0].context.apiKey = 'NEVER_EXPORT_CONTEXT_KEY';
  review.comments[0].context.production.headers = {authorization: 'NEVER_EXPORT_AUTH'};
  assert.ok(!formatReviewHtml(review).includes('NEVER_EXPORT'));
  assert.ok(!formatMarkdown(review).includes('NEVER_EXPORT'));
});

test('omitted titles produce meaningful escaped headings in every export without rewriting saved fields', () => {
  const review = fixture();
  const comment = review.comments[0];
  comment.fields.title = '';
  comment.fields.expected = '';
  comment.fields.comment = '\n  The button needs more space.\nIts baseline is misaligned.';
  assert.equal(commentTitle(comment), 'The button needs more space.');
  for (const text of [formatReviewHtml(review), formatStandaloneHtml(review), formatMarkdown(review)]) assert.ok(text.includes('The button needs more space.'));
  assert.ok(!formatReviewHtml(review).includes('<h2>Observation 1</h2>'));
  assert.ok(!formatReviewHtml(review).includes('<h3>Expected result</h3>'));
  assert.equal(comment.fields.title, '');
  comment.fields.comment = '<img src=x onerror="alert(1)"> should not render';
  const html = formatReviewHtml(review);
  assert.ok(html.includes('<h2>&lt;img'));
  assert.ok(!html.includes('<h2><img'));
  assert.ok(!formatMarkdown(review).includes('## 1. <img'));
});

test('category badges keep their distinct colors and visible labels in rich copy and standalone HTML', () => {
  const review = fixture();
  for (const [category, colors] of Object.entries(CATEGORY_PALETTE)) {
    review.comments[0].fields.category = category;
    for (const html of [formatReviewHtml(review, {clipboard: true}), formatStandaloneHtml(review)]) {
      assert.ok(html.includes(`data-category="${category}"`));
      assert.ok(html.includes(`background-color:${colors.background};color:${colors.color}`));
      assert.ok(html.includes(categoryLabel(category)));
    }
  }
  assert.equal(categoryKey('__proto__'), 'design-mismatch');
  assert.equal(categoryKey('" onclick="bad()'), 'design-mismatch');
  assert.equal(categoryLabel('__proto__'), 'Design mismatch');
});

test('report hierarchy puts the observation and requested change before evidence and collapsed technical detail', () => {
  const review = fixture();
  review.comments[0].ai = {provider: 'anthropic', acceptedAt: '2026-09-25T10:00:00Z'};
  for (const html of [formatReviewHtml(review), formatReviewHtml(review, {clipboard: true})]) {
    const issue = html.slice(html.indexOf('<article'));
    assert.ok(issue.includes('class="issue-number"'));
    assert.ok(issue.includes('>01</span>'));
    assert.ok(issue.indexOf('>Current</h3>') < issue.indexOf('>Change to</h3>'));
    assert.ok(issue.indexOf('>Change to</h3>') < issue.indexOf('class="issue-context"'));
    assert.ok(issue.includes('<li>Open Account.</li><li>Choose Settings.</li>'));
    assert.ok(issue.indexOf('class="issue-context"') < issue.indexOf('class="evidence-section'));
    assert.ok(issue.indexOf('class="video-evidence"') < issue.indexOf('class="ai-provenance"'));
    assert.ok(issue.indexOf('class="ai-provenance"') < issue.indexOf('class="engineering-context"'));
    assert.ok(!/<details[^>]*\bopen(?:\s|>)/.test(issue));
  }
});

test('focused crops lead the evidence without changing the source index used by copy and download actions', () => {
  const review = fixture();
  const html = formatReviewHtml(review);
  const imageIndexes = [...html.matchAll(/data-image-index="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(imageIndexes, [2, 0, 1]);
  assert.ok(html.indexOf(`src="${crop}"`) < html.indexOf(`src="${annotated}"`));
  assert.ok(html.indexOf('>Focused evidence</h3>') < html.indexOf('Full screenshots'));
  const markdown = formatMarkdown(review);
  assert.ok(markdown.indexOf('### Change to') < markdown.indexOf('### Focused evidence'));
  assert.ok(markdown.indexOf(`](${crop})`) < markdown.indexOf(`](${annotated})`));
  assert.ok(markdown.includes('1. Open Account.\n2. Choose Settings.'));
  assert.ok(markdown.includes('<details>\n<summary>Technical details</summary>'));
});

test('category navigation accounts for all observations and safely targets stable issue numbers', () => {
  const review = fixture();
  const base = review.comments[0];
  review.comments = ['design-mismatch', 'ux-issue', 'ux-issue', 'copy-change'].map((category, index) => ({...base, id: `comment-${index}`, fields: {...base.fields, category}}));
  const html = formatReviewHtml(review);
  assert.ok(html.includes('aria-label="Observation categories"'));
  assert.ok(html.includes('data-category-filter="all"><span'));
  assert.ok(html.includes('<span>All observations</span><strong>4</strong>'));
  assert.ok(html.includes('<span>UX issue</span><strong>2</strong>'));
  assert.ok(html.includes('href="#issue-2" data-category-filter="ux-issue"'));
  assert.equal((html.match(/<article class="comment-card"/g) || []).length, 4);
  assert.ok(formatMarkdown(review).includes('Design mismatch: 1 · UX issue: 2 · Copy change: 1'));
});

test('rich clipboard retains readable typography and requested-change emphasis without an external stylesheet', () => {
  const html = formatReviewHtml(fixture(), {clipboard: true});
  assert.ok(html.includes('font-size:16px;line-height:1.65;color:#211A35'));
  assert.ok(html.includes('font-size:26px;line-height:1.3;color:#211A35'));
  assert.ok(html.includes('background:#FFF0EB;border-left:4px solid #EF785C'));
  assert.ok(html.includes('role="presentation" style="width:100%;table-layout:fixed;'));
  assert.equal((html.match(/<td style="width:50%;vertical-align:top/g) || []).length, 2, 'Keep paired evidence side by side when rich-copy destinations retain basic HTML tables');
  assert.ok(!/font-size:(?:[0-9]|1[0-3])px/.test(html));
});


test('legacy prose is preserved verbatim under Current and Change to without splitting or guessing corrections', () => {
  const review = fixture();
  const comment = review.comments[0];
  comment.fields.comment = 'The heading, button and empty-state copy differ.';
  comment.fields.expected = 'Use the prototype copy in these places.';
  const before = structuredClone(review);
  for (const html of [formatReviewHtml(review), formatReviewHtml(review, {clipboard: true}), formatStandaloneHtml(review)]) {
    assert.ok(html.includes('>Current</h3>'));
    assert.ok(html.includes('>Change to</h3>'));
    assert.ok(html.includes(comment.fields.comment));
    assert.ok(html.includes(comment.fields.expected));
    assert.equal((html.match(/<article class="comment-card"/g)||[]).length, 1);
    assert.ok(!html.includes('LATEST CHATS'));
  }
  assert.deepEqual(review, before);
});

test('manual comments with no requested change do not fabricate one', () => {
  const review = fixture();delete review.comments[0].fields.expected;
  const html = formatReviewHtml(review);
  assert.ok(!html.includes('>Change to</h3>'));
  assert.ok(html.includes('No requested change was recorded'));
  assert.ok(html.includes(review.comments[0].fields.comment.replace('\n','<br>')));
});

test('full screenshots are collapsed context while explicit paired crops lead both export formats', () => {
  const review = fixture();
  review.comments[0].evidence.prototype.cropDataUrl = 'data:image/png;base64,cmVmZXJlbmNlY3JvcA==';
  review.comments[0].evidence.prototype.crop = {x: 350, y: 210, width: 400, height: 100};
  const html = formatStandaloneHtml(review);
  assert.match(html, /<details class="evidence-section full-evidence"><summary>Full screenshots/);
  assert.doesNotMatch(html, /<details class="evidence-section full-evidence"[^>]* open/);
  assert.ok(html.includes('Prototype · focused detail'));
  assert.ok(!html.includes('A prototype close-up was not recorded'));
  assert.ok(html.indexOf('Prototype · focused detail') < html.indexOf('Full screenshots'));
  const clipboard = formatReviewHtml(review, {clipboard: true});
  assert.match(clipboard, /<section class="evidence-section full-evidence">/);
  assert.ok(clipboard.includes(review.comments[0].evidence.prototype.dataUrl));
});

test('old production bounds never stand in for an unknown prototype area', () => {
  const comment = fixture().comments[0];
  const html = formatReviewHtml({comments:[comment]});
  assert.ok(html.includes('A prototype close-up was not recorded'));
  assert.equal(recordedFocusCrop(comment, 'prototype'), null);
  assert.ok(!evidenceImages(comment).some(image => image.side === 'prototype' && image.kind === 'crop'));
});

test('legacy focus recovery uses captured viewport scaling and clamps to the saved screenshot', () => {
  const comment = fixture().comments[0];
  const before = structuredClone(comment);
  assert.deepEqual(recordedFocusCrop(comment), {x:0,y:0,width:268,height:188});
  comment.selection.rect.viewport = {x:1270,y:790,width:50,height:50};
  assert.deepEqual(recordedFocusCrop(comment), {x:2492,y:1532,width:68,height:68});
  assert.deepEqual(before, fixture().comments[0]);
  for (const missing of ['selection','context']) {
    const broken = fixture().comments[0];delete broken[missing];
    assert.equal(recordedFocusCrop(broken), null);
  }
  for (const rect of [{x:0,y:0,width:NaN,height:20},{x:0,y:0,width:-3,height:20},{x:1300,y:0,width:20,height:20}]) {
    const broken=fixture().comments[0];broken.selection.rect.viewport=rect;assert.equal(recordedFocusCrop(broken),null);
  }
});

test('a review that gained a reference renders each observation using its captured mode', () => {
  const review = fixture(); review.mode = 'audit'; review.prototypeUrl = '';
  const page = review.comments[0]; page.mode = 'audit'; delete page.context.prototype; delete page.evidence.prototype;
  const compared = fixture().comments[0]; compared.id = 'compared-comment'; compared.mode = 'comparison';
  review.comments.push(compared);
  const original = structuredClone(review);
  const html = formatReviewHtml(review);
  const cards = [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(match => match[0]);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /Page · selected element highlighted/);
  assert.match(cards[0], />Page recording<\/h3>/);
  assert.doesNotMatch(cards[0], /Reference for this observation/);
  assert.match(cards[1], /Production · selected element highlighted/);
  assert.match(cards[1], /Reference for this observation: <a href="http:\/\/localhost:3000\/account"/);
  assert.match(cards[1], />Live comparison recording<\/h3>/);
  assert.match(html, /DIFFUSE \/ DESIGN REVIEW/);
  const markdown = formatMarkdown(review);
  const sections = markdown.split(/^## /m);
  assert.doesNotMatch(sections[1], /Reference for this observation/);
  assert.match(sections[2], /Reference for this observation: http:\/\/localhost:3000\/account/);
  assert.match(sections[1], /Screenshot: Page|!\[Page/);
  assert.match(sections[2], /Screenshot: Production|!\[Production/);
  assert.deepEqual(review, original);
});

test('changing references keeps each recorded URL attached to its own observation', () => {
  const review = fixture();
  review.prototypeUrl = 'https://obsolete.example.test/old';
  review.comments[0].mode = 'comparison'; review.comments[0].context.prototype.url = 'https://reference.example.test/first';
  const second = fixture().comments[0]; second.mode = 'comparison'; second.id = 'second'; second.context.prototype.url = 'https://reference.example.test/second';
  review.comments.push(second);
  const before = structuredClone(review);
  for (const html of [formatReviewHtml(review), formatReviewHtml(review, {clipboard: true}), formatStandaloneHtml(review)]) {
    const cards = [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(match => match[0]);
    assert.match(cards[0], /Reference for this observation: <a href="https:\/\/reference.example.test\/first"/);
    assert.match(cards[1], /Reference for this observation: <a href="https:\/\/reference.example.test\/second"/);
    assert.doesNotMatch(html, /obsolete.example.test/);
  }
  assert.doesNotMatch(formatMarkdown(review), /obsolete.example.test/);
  assert.deepEqual(review, before);
});
