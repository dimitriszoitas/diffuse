import test from 'node:test';
import assert from 'node:assert/strict';
import {jiraIssueFields, jiraAttachments} from '../extension/jira-format.mjs';

const image = 'data:image/png;base64,YQ==';
const annotation = 'data:image/png;base64,Yg==';
const detail = 'data:image/jpeg;base64,Yw==';
const reference = 'data:image/webp;base64,ZA==';
const recording = 'data:video/webm;codecs=vp9;base64,ZQ==';

function fixture() {
  return {
    id: 'observation-1', mode: 'comparison',
    fields: {title: '', comment: 'The save button is difficult to find.', expected: 'Place Save beside Cancel and use the primary button style.', component: 'Save button', state: 'Editing', steps: 'Open a profile.\nChoose Edit.'},
    context: {production: {url: 'https://app.example.test/profile/2'}, prototype: {url: 'http://localhost:3000/profile/2'}},
    evidence: {production: {dataUrl: image, annotatedDataUrl: annotation, cropDataUrl: detail}, prototype: {dataUrl: reference}, video: {dataUrl: recording, filename: 'Edit profile.webm'}},
  };
}

function validateAdf(doc) {
  assert.equal(doc.version, 1);
  assert.equal(doc.type, 'doc');
  assert.ok(doc.content.length);
  for (const block of doc.content) {
    assert.ok(['heading', 'paragraph'].includes(block.type));
    if (block.type === 'heading') assert.equal(block.attrs.level, 3);
    for (const node of block.content) {
      assert.ok(['text', 'hardBreak'].includes(node.type));
      if (node.type === 'text') assert.ok(typeof node.text === 'string' && node.text.length > 0);
      for (const mark of node.marks || []) {
        assert.equal(mark.type, 'link');
        assert.ok(/^https?:/.test(mark.attrs.href));
      }
    }
  }
}

function allText(doc) {
  return doc.content.flatMap(block => block.content.map(node => node.text || '\n')).join('\n');
}

test('optional titles use the existing observation excerpt and optional expected text stays absent', () => {
  const comment = fixture();
  comment.fields.expected = '';
  const fields = jiraIssueFields(comment);
  assert.equal(fields.summary, comment.fields.comment);
  assert.ok(!allText(fields.description).includes('Requested change'));
  validateAdf(fields.description);
  assert.equal(jiraIssueFields({}, {}, {index: 3}).summary, 'Observation 4');
  comment.fields.title = '👋'.repeat(200);
  const summary = jiraIssueFields(comment).summary;
  assert.ok(summary.length <= 255);
  assert.equal(summary, '👋'.repeat(127) + '…');
});

test('human-readable ADF contains captured details and preserves multiline reproduction steps', () => {
  const fields = jiraIssueFields(fixture());
  validateAdf(fields.description);
  assert.deepEqual(fields.description.content.filter(node => node.type === 'heading').map(node => node.content[0].text), ['Current', 'Requested change', 'Component', 'State', 'Steps to reproduce', 'Page', 'Reference']);
  assert.ok(fields.description.content.some(block => block.content.some(node => node.type === 'hardBreak')));
  assert.equal(jiraIssueFields(fixture()).description.content[3].content[0].text, fixture().fields.expected);
  const classified = fixture();
  classified.fields.category = 'ux-issue';
  classified.fields.severity = 'major';
  const classification = allText(jiraIssueFields(classified).description);
  assert.match(classification, /Category\nUX issue/);
  assert.match(classification, /Severity\nMajor/);
});

test('mixed reviews use each observation’s original page/reference; audit observations inherit no reference', () => {
  const review = {mode: 'audit', productionUrl: 'https://old.example.test/', prototypeUrl: 'https://old-prototype.example.test/'};
  const comment = fixture();
  const content = allText(jiraIssueFields(comment, review).description);
  assert.ok(content.includes(comment.context.production.url));
  assert.ok(content.includes(comment.context.prototype.url));
  assert.ok(!content.includes('old.example'));
  assert.ok(!content.includes('old-prototype'));
  comment.mode = 'audit';
  assert.ok(!allText(jiraIssueFields(comment, review).description).includes('Reference'));
  assert.ok(!jiraAttachments(comment, review).some(item => item.side === 'prototype'));
  delete comment.context;
  assert.ok(allText(jiraIssueFields(comment, review).description).includes(review.productionUrl));
});

test('user markup remains literal text and no metadata, secret fields, AI prompts or media enter ADF', () => {
  const comment = fixture();
  comment.fields.comment = '<script>alert("hello")</script> [link](javascript:bad) {"type":"mention"}';
  comment.ai = {instructions: 'private prompt', apiKey: 'secret-key'};
  comment.context.production.headers = {authorization: 'private auth'};
  comment.selection = {styles: {color: 'rgb(1 2 3)'}, html: '<input value="private" />'};
  comment.fields.apiKey = 'another-secret';
  const fields = jiraIssueFields(comment);
  const roundTrip = JSON.parse(JSON.stringify(fields));
  assert.equal(roundTrip.description.content[1].content[0].text, comment.fields.comment);
  validateAdf(roundTrip.description);
  assert.ok(!/private prompt|secret-key|private auth|rgb\(|another-secret|data:image|data:video/.test(JSON.stringify(fields)));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'summary']);
});

test('invalid and credential-bearing URLs are omitted instead of replaced with another captured page', () => {
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test/', 'file:///tmp/private', ' https://example.test/', 'https://example.test/\npath', 'data:text/html,anything']) {
    const comment = fixture();
    comment.context.production.url = url;
    comment.context.prototype.url = url;
    const fields = jiraIssueFields(comment, {productionUrl: 'https://wrong.example/', prototypeUrl: 'https://wrong-reference.example/'});
    assert.ok(!fields.description.content.some(block => block.content.some(node => node.marks?.length)));
    assert.ok(!allText(fields.description).includes('wrong.example'));
  }
});

test('attachments include highlighted screenshot, focused crop, reference and recording with correct MIME filenames', () => {
  const comment = fixture();
  comment.evidence.video.apiKey = 'never copied';
  const items = jiraAttachments(comment);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(item => item.mimeType), ['image/png', 'image/webp', 'image/jpeg', 'video/webm']);
  assert.equal(items[0].dataUrl, annotation);
  assert.ok(!items.some(item => item.dataUrl === image));
  assert.ok(items[2].filename.endsWith('-production-detail.jpg'));
  assert.equal(items[3].filename, 'Edit-profile.webm');
  assert.ok(items.every(item => !/[/\\\s]/.test(item.filename)));
  assert.ok(!JSON.stringify(items).includes('never copied'));
});

test('invalid media is omitted, repeated payloads deduplicated, and original screenshot is a safe annotation fallback', () => {
  const comment = fixture();
  comment.evidence.production.annotatedDataUrl = 'https://tracker.example/image.png';
  comment.evidence.production.cropDataUrl = 'data:image/svg+xml;base64,PHN2Zz4=';
  comment.evidence.prototype.dataUrl = image;
  comment.evidence.video.dataUrl = 'data:video/webm;base64,YQ=';
  const items = jiraAttachments(comment);
  assert.equal(items.length, 1);
  assert.equal(items[0].dataUrl, image);
  comment.evidence.production.dataUrl = 'javascript:alert(1)';
  comment.evidence.prototype.dataUrl = 'blob:https://example.test/id';
  assert.deepEqual(jiraAttachments(comment), []);
});

test('conversion does not mutate saved observations or review fallbacks', () => {
  const comment = fixture();
  const review = {mode: 'comparison', productionUrl: 'https://example.test/', prototypeUrl: 'https://prototype.example.test/'};
  const before = structuredClone({comment, review});
  jiraIssueFields(comment, review);
  jiraAttachments(comment, review);
  assert.deepEqual({comment, review}, before);
});
