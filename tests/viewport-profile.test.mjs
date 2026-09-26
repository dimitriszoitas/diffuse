import test from 'node:test';
import assert from 'node:assert/strict';
import {commentViewportKey, commentMatchesViewport, viewportLabel} from '../extension/viewport-profile.mjs';
import {formatReviewHtml, formatMarkdown} from '../extension/report-format.mjs';
import {jiraIssueFields} from '../extension/jira-format.mjs';

const comment = (width, profile) => ({id:`capture-${width}`,fields:{comment:'Adjust the navigation',state:'Menu open'},context:{production:{viewport:{width,height:844},...(profile?{viewportProfile:{key:profile}}:{})}}});
test('viewport grouping preserves explicit capture view and safely classifies older captures', () => {
  assert.equal(commentViewportKey(comment(390,'phone')), 'phone');
  assert.equal(commentViewportKey(comment(900,'desktop')), 'desktop');
  assert.equal(commentViewportKey(comment(1440)), 'desktop');
  assert.equal(commentViewportKey(comment(1024)), 'tablet');
  assert.equal(commentViewportKey(comment(390)), 'phone');
  assert.equal(commentViewportKey(comment(390,'malicious')), 'phone');
  assert.equal(commentViewportKey({}), 'unknown');
  assert.equal(commentMatchesViewport(comment(390),'desktop'), false);
  assert.equal(commentMatchesViewport(comment(390),'phone'), true);
  assert.equal(commentMatchesViewport({},'desktop'), true);
});
test('reports and Jira retain the viewport beside the same saved observation', () => {
  const capture=comment(390,'phone');
  const review={id:'r',comments:[capture],createdAt:'2026-09-26T12:00:00Z'};
  assert.equal(viewportLabel(capture),'Phone · 390 × 844');
  const html=formatReviewHtml(review);
  assert.match(html,/data-viewport="phone"/);
  assert.match(html,/Phone · 390 × 844/);
  assert.match(formatMarkdown(review),/\*\*Viewport:\*\* Phone · 390 × 844/);
  const jira=JSON.stringify(jiraIssueFields(capture,review));
  assert.match(jira,/Phone · 390 × 844/);
  assert.match(jira,/Adjust the navigation/);
});
