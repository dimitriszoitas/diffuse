import test from 'node:test';
import assert from 'node:assert/strict';
import {cloneReviewAdf} from '../backend/review-adf.mjs';
import {jiraIssueFields} from '../extension/jira-format.mjs';
const text = value => ({type: 'text', text: value});
const paragraph = value => ({type: 'paragraph', content: [text(value)]});
const doc = (...content) => ({type: 'doc', version: 1, content});
const listItem = {type: 'listItem', content: [paragraph('Open the page.')]};
const panel = {type: 'panel', attrs: {panelType: 'info'}, content: [paragraph('Change to the reference label.')]};

test('review descriptions and plaintext AI prompts are cloned without changing their structure', () => {
  const description = jiraIssueFields({fields: {comment: 'The label is incorrect.', expected: 'Use Save changes.', component: 'Save button', state: 'Editing', steps: 'Open settings.\nEdit a value.'}}).description;
  description.content.push({type: 'codeBlock', attrs: {language: 'text', wrap: true, hideLineNumbers: true}, content: [text('<script>literal text</script>\n1. Follow the accepted change.')]});
  const result = cloneReviewAdf(description);
  assert.deepEqual(result, description);
  result.content[0].content[0].text = 'A different label';
  assert.equal(description.content[0].content[0].text, 'Current');
});

test('nested blocks are accepted only in their valid supported positions', () => {
  assert.doesNotThrow(() => cloneReviewAdf(doc({...panel, content: [{type: 'orderedList', attrs: {order: 1}, content: [listItem]}]})));
  for (const block of [
    {...panel, content: [panel]},
    {...panel, content: [{type: 'codeBlock', content: [text('Nested code is outside this subset.')]}]},
    {type: 'orderedList', content: [paragraph('Missing list item')]},
    {type: 'bulletList', content: []},
    listItem,
    {type: 'bulletList', content: [{...listItem, content: [text('Missing paragraph')]}]},
    {type: 'table', content: []},
    {type: 'mediaSingle', content: []},
  ]) assert.throws(() => cloneReviewAdf(doc(block)), /Invalid Jira description/);
});

test('rich containers cannot smuggle marks, attributes, content types or unsafe links', () => {
  for (const block of [
    {...panel, attrs: {panelType: 'custom'}},
    {...panel, attrs: {panelType: 'info', onClick: 'bad'}},
    {...panel, marks: [{type: 'link', attrs: {href: 'https://example.test'}}]},
    {type: 'orderedList', attrs: {order: -1}, content: [listItem]},
    {type: 'orderedList', attrs: {order: 1, reversed: true}, content: [listItem]},
    {...panel, content: [{type: 'paragraph', content: [{...text('Unsafe'), marks: [{type: 'link', attrs: {href: 'javascript:alert(1)'}}]}]}]},
    {...panel, content: [{type: 'paragraph', content: [{...text('Unsafe'), marks: [{type: 'link', attrs: {href: 'https://user:secret@example.test'}}]}]}]},
  ]) assert.throws(() => cloneReviewAdf(doc(block)), /Invalid Jira description/);
});

test('code blocks remain literal text with bounded, allowlisted presentation settings', () => {
  for (const block of [
    {type: 'codeBlock', content: []},
    {type: 'codeBlock', attrs: {language: 'javascript'}, content: [text('not executable')]},
    {type: 'codeBlock', attrs: {wrap: 'yes'}, content: [text('literal')]},
    {type: 'codeBlock', content: [{...text('literal'), marks: [{type: 'link', attrs: {href: 'https://example.test'}}]}]},
    {type: 'codeBlock', content: [{type: 'hardBreak'}]},
    {type: 'codeBlock', content: [text('x'.repeat(32769))]},
  ]) assert.throws(() => cloneReviewAdf(doc(block)), /Invalid Jira description/);
});

test('documents reject excessive encoded size, node count, control characters and cycles', () => {
  assert.throws(() => cloneReviewAdf(doc(paragraph('hello')), {maxBytes: 20}));
  const many = Array.from({length: 500}, () => ({type: 'paragraph', content: Array.from({length: 10}, () => text('x'))}));
  assert.throws(() => cloneReviewAdf(doc(...many)));
  assert.throws(() => cloneReviewAdf(doc(paragraph('bad\u0000text'))));
  const cyclic = {...panel, content: []};cyclic.content.push(cyclic);
  assert.throws(() => cloneReviewAdf(doc(cyclic)));
});
