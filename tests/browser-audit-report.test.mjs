import test from 'node:test';
import assert from 'node:assert/strict';
import {formatBrowserAuditHtml, formatBrowserAuditStandaloneHtml, formatBrowserAuditIndex, browserAuditNeedsRefresh} from '../extension/browser-audit-report.mjs';

const audit = {id: 'audit-1', reviewId: 'review-1', status: 'completed', createdAt: '2026-10-28T10:00:00Z', page: {title: 'Ingredients', url: 'https://example.test'}, steps: [{id: 'inspect', action: 'measure', description: 'Inspect component styles', status: 'completed', startedAt: '2026-10-28T10:00:00Z', details: 'Collected visible headings'}], evidence: {scope: 'current-page', page: {title: 'Ingredients', url: 'https://example.test', viewport: {width: 1280, height: 800}}, styles: {elementsInspected: 10, typography: [{fontFamily: 'Inter', fontSize: '23px', fontWeight: '600', lineHeight: '30px', color: '#111111', count: 3, examples: [{selector: 'h1', text: 'Ingredients', rect: {x: 20, y: 80, width: 100, height: 30}}]}], colors: [{property: 'color', value: '#1a1a1a', count: 4}], spacing: [{property: 'padding', value: '16px', count: 5}], radii: [{value: '8px', count: 6}]}, accessibility: {engine: 'axe-core', version: '4.10', passesCount: 14, violations: [{id: 'color-contrast', impact: 'serious', help: 'Improve contrast', description: 'Text does not meet contrast requirements', helpUrl: 'https://example.test/contrast', nodes: [{target: ['#save'], failureSummary: 'Ratio too low', html: '<button id="save">Save</button>'}]}], incomplete: [{id: 'label', help: 'Confirm label'}], limitations: ['Screen reader output was not tested.']}, interactions: {hover: [{target: '#save', before: {color: 'black'}, after: {color: 'blue'}, changed: true}], focus: [{target: '#save', role: 'button', name: 'Save', visible: true}]}, screenshots: [{label: 'Captured page', dataUrl: 'data:image/png;base64,AAAA'}], limitations: ['Only the current page was inspected.']}, analysis: {provider: 'Anthropic', model: 'test-model', summary: 'Mixed heading styles', findings: [{title: 'Unexpected heading size', description: 'A 23px heading differs from adjacent pages.', recommendation: 'Check the intended type scale.', severity: 'minor', evidenceIds: ['typography:1', 'accessibility:color-contrast', 'step:inspect']}], limitations: ['This is a heuristic recommendation.']}};

test('report separates measured inventories and accessibility evidence from sourced AI interpretation', () => {
  const html = formatBrowserAuditHtml(audit);
  for (const phrase of ['Measured styles', 'Typography', '23px', '30px', '#1a1a1a', '16px', '8px', '10 elements inspected', 'Accessibility checks', 'Needs verification', 'Screen reader output was not tested.', 'AI interpretation', 'Unexpected heading size', 'Suggested change:', 'Keyboard focus sequence', 'Hover states', 'Step 1 · Inspect component styles', 'Collected visible headings', 'Screenshot', 'Only the current page was inspected.']) assert(html.includes(phrase), phrase);
  assert(html.includes('href="#audit-evidence-typography%3A1"'));
  assert(html.includes('id="audit-evidence-accessibility%3Acolor-contrast"'));
  assert(html.includes('&lt;button id=&quot;save&quot;&gt;Save&lt;/button&gt;'));
});

test('stopped and failed partial audits remain readable even with no analysis or captured sections', () => {
  for (const status of ['stopped', 'error']) {
    const html = formatBrowserAuditHtml({...audit, status, evidence: {}, analysis: null, error: 'Browser disconnected', analysisError: 'Model unavailable'});
    for (const phrase of ['Why it stopped:', 'Browser disconnected', 'Model unavailable', 'Step 1', 'not captured', 'No screenshots']) assert(html.includes(phrase), phrase);
  }
  assert(formatBrowserAuditHtml({...audit, status: 'stopped'}).includes('unrun checks are not treated as passed'));
  assert(formatBrowserAuditHtml({...audit, status: 'running'}).includes('The audit has not finished'));
});

test('page, model and node contents cannot inject markup, fetch remote images or run scripts', () => {
  const hostile = structuredClone(audit);
  hostile.evidence.page.title = '<script>evil()</script>';
  hostile.evidence.page.url = 'javascript:evil()';
  hostile.evidence.styles.typography[0].fontFamily = '"><img src="https://evil.test/track">';
  hostile.evidence.screenshots = [{label: '<svg onload=evil()>', dataUrl: 'https://evil.test/image'}, {dataUrl: 'data:image/svg+xml;base64,AAAA'}];
  hostile.evidence.accessibility.violations[0].helpUrl = 'javascript:evil()';
  hostile.analysis.findings[0].title = '<iframe src=x>';
  hostile.analysis.findings[0].evidenceIds.push('" onclick="evil()');
  const html = formatBrowserAuditHtml(hostile);
  assert(!html.includes('<script>'));
  assert(!html.includes('<iframe'));
  assert(!html.includes('src="https://evil'));
  assert(!html.includes('src="data:image/svg'));
  assert(!html.includes('href="javascript:'));
  assert(html.includes('&lt;script&gt;'));
  assert(html.includes('Unverified reference:'));
});

test('unmatched evidence references do not look like verified links and incomplete references are separate', () => {
  const data = structuredClone(audit);
  data.analysis.findings[0].evidenceIds = ['accessibility-incomplete:label', 'typography:999', 'focus:1'];
  const html = formatBrowserAuditHtml(data);
  assert(html.includes('href="#audit-evidence-accessibility-incomplete%3Alabel"'));
  assert(html.includes('href="#audit-evidence-focus%3A1"'));
  assert(!html.includes('href="#audit-evidence-typography%3A999"'));
  assert(html.includes('Unverified reference: typography:999'));
});

test('offline HTML embeds only local images with a restrictive CSP and readable audit ledgers', () => {
  const html = formatBrowserAuditStandaloneHtml({...audit, evidenceArchived: true});
  assert(html.startsWith('<!doctype html>'));
  assert(html.includes("default-src 'none'; img-src data:"));
  assert(html.includes('src="data:image/png;base64,AAAA"'));
  assert(!html.includes('<script'));
  assert(html.includes('every recorded step remain saved'));
  assert(html.includes('Collected visible headings'));
});

test('review index lists stopped/error audits with safe canonical result links even without observations', () => {
  const html = formatBrowserAuditIndex([{...audit, id: 'x"><script>', status: 'stopped', stepCount: 4}, {...audit, id: 'error', status: 'error', stepCount: 0}]);
  assert(html.includes('aria-label="Interactive audits"'));
  assert(html.includes('Stopped · 4 steps'));
  assert(html.includes('Interrupted by an error · 0 steps'));
  assert(html.includes('browser-audit-report.html?audit=x%22%3E%3Cscript%3E'));
  assert(!html.includes('<script>'));
  assert.equal(formatBrowserAuditIndex([]), '');
});

test('reports keep recovering pending analyses and unconfirmed stops after browser collection ends', () => {
  for (const status of ['opening', 'ready', 'running']) assert.equal(browserAuditNeedsRefresh({status}), true);
  for (const status of ['completed', 'stopped', 'error']) {
    assert.equal(browserAuditNeedsRefresh({status}), false);
    assert.equal(browserAuditNeedsRefresh({status, analysisStatus: 'running'}), true);
    assert.equal(browserAuditNeedsRefresh({status, stopUnconfirmed: true, syncError: 'Helper is offline'}), true);
    assert.equal(browserAuditNeedsRefresh({status, analysisStatus: 'completed', stopUnconfirmed: false}), false);
  }
  assert.equal(browserAuditNeedsRefresh(null), false);
});
