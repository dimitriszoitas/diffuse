import test from 'node:test';
import assert from 'node:assert/strict';
import {generateJiraTitles, hasJiraTitle, cleanJiraTitle, jiraTitleSource} from '../extension/jira-titles.mjs';
import {prepareDelivery} from '../extension/jira-export.mjs';

const apiKey = 'sk-ant-test-not-a-real-key';
const comment = {id: 'comment-1', fields: {comment: 'The action at the top looks fine at first. After choosing a different project, the label still shows the old project.', expected: 'Keep the label in sync with the selected project.', steps: 'Open the project selector.\nChoose another project.', component: 'PRIVATE-COMPONENT', state: 'PRIVATE-STATE'}, evidence: {production: {dataUrl: 'PRIVATE-IMAGE'}}, context: {production: {url: 'https://private.test/'}}};
function response(titles, extra = {}) { return new Response(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({titles})}], ...extra}), {headers: {'content-type': 'application/json'}}); }

test('titles use the configured model and all authored feedback, without page data, evidence or credentials in the prompt', async () => {
  let request;
  const result = await generateJiraTitles([comment], {apiKey, model: 'claude-sonnet-5'}, {fetchImpl: async (url, options) => {
    request = {url, ...options};return response([{index: 0, title: 'Update the label when switching projects'}]);
  }});
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], apiKey);
  assert.equal(request.credentials, 'omit');assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'claude-sonnet-5');
  assert.deepEqual(JSON.parse(body.messages[0].content), [{index: 0, comment: comment.fields.comment, expected: comment.fields.expected, steps: comment.fields.steps}]);
  assert.doesNotMatch(request.body, /PRIVATE|private\.test|sk-ant-test/);
  assert.match(body.system, /untrusted feedback/);
  assert.deepEqual(result, {reason: 'generated', titles: [{commentId: comment.id, source: jiraTitleSource(comment), title: 'Update the label when switching projects'}]});
});

test('missing settings and provider failures return a safe fallback signal, without exposing provider messages', async () => {
  let calls = 0;
  assert.deepEqual(await generateJiraTitles([comment], {}, {fetchImpl: async () => {calls++;}}), {titles: [], reason: 'not-configured'});
  assert.equal(calls, 0);
  for (const fetchImpl of [async () => {throw new Error(apiKey);}, async () => new Response(apiKey, {status: 429}), async () => response([{index: 0, title: apiKey}])]) {
    assert.deepEqual(await generateJiraTitles([comment], {apiKey}, {fetchImpl}), {titles: [], reason: 'unavailable'});
  }
});

test('the request times out and tickets may still use the authored comment', async () => {
  let aborted = false;
  const result = await generateJiraTitles([comment], {apiKey}, {timeoutMs: 5, fetchImpl: async (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => {aborted = true;reject(new Error('aborted'));}))});
  assert.equal(aborted, true);assert.equal(result.reason, 'unavailable');
});

test('invalid, incomplete, oversized or duplicate output is discarded as a whole', async () => {
  const comments = [comment, {...comment, id: 'comment-2'}];
  const bad = [
    response([{index: 0, title: 'Missing second title'}]),
    response([{index: 0, title: 'First'}, {index: 0, title: 'Duplicate'}]),
    response([{index: 0, title: 'First'}, {index: 1, title: 'x'.repeat(181)}]),
    response([{index: 0, title: 'First'}, {index: 1, title: 'Line one\nLine two'}]),
    response([{index: 0, title: 'First'}, {index: 1, title: 'Second'}], {stop_reason: 'max_tokens'}),
    new Response('x'.repeat(40 * 1024)),
  ];
  for (const value of bad) assert.deepEqual(await generateJiraTitles(comments, {apiKey}, {fetchImpl: async () => value}), {titles: [], reason: 'unavailable'});
});

test('batch indexes identify the correct saved comments even if output order changes', async () => {
  const result = await generateJiraTitles([comment, {...comment, id: 'second'}], {apiKey}, {fetchImpl: async () => response([{index: 1, title: 'Second'}, {index: 0, title: 'First'}])});
  assert.deepEqual(result.titles.map(item => [item.commentId, item.title]), [['second', 'Second'], ['comment-1', 'First']]);
});

test('pasted API keys never leave the worker in a comment body', async () => {
  let called = false;
  const result = await generateJiraTitles([{...comment, fields: {...comment.fields, comment: apiKey}}], {apiKey}, {fetchImpl: async () => {called = true;}});
  assert.equal(called, false);assert.equal(result.reason, 'unavailable');
});

test('empty and excessive batches do not contact the provider', async () => {
  let called = false;
  for (const comments of [[], Array.from({length: 21}, () => comment)]) {
    assert.equal((await generateJiraTitles(comments, {apiKey}, {fetchImpl: async () => {called = true;}})).reason, 'unavailable');
  }
  assert.equal(called, false);
});

test('legacy titles remain distinguishable and plain summaries do not split emoji', () => {
  assert.equal(hasJiraTitle(comment), false);
  assert.equal(hasJiraTitle({...comment, fields: {title: 'Existing title'}}), true);
  assert.equal(hasJiraTitle({fields: {title: '  '}}), false);
  assert.equal(cleanJiraTitle(' A\nB\u0000C '), 'A B C');
  assert.equal(cleanJiraTitle('👋'.repeat(200)), '👋'.repeat(127));
});

test('the reviewed Jira summary is sent and participates in the delivery revision without changing the review', async () => {
  const saved = {...comment, evidence: {}};
  const before = structuredClone(saved);
  const destination = {cloudId: 'site', projectId: 'project', issueTypeId: 'bug'};
  const first = await prepareDelivery(saved, {}, destination, {}, {summary: 'Update the project label'});
  const repeat = await prepareDelivery(saved, {}, destination, {}, {summary: 'Update the project label'});
  const edited = await prepareDelivery(saved, {}, destination, {}, {summary: 'Keep the selected project visible'});
  assert.equal(first.payload.summary, 'Update the project label');
  assert.equal(first.payload.revision, repeat.payload.revision);
  assert.notEqual(first.payload.revision, edited.payload.revision);
  assert.deepEqual(saved, before);
  await assert.rejects(prepareDelivery(saved, {}, destination, {}, {summary: ' '}), /ticket title/);
});
