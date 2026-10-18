// Exercise the real Jira preview with a delayed worker response. No provider or Jira calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {res.setHeader('content-type', 'text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/extension/report.css"><link rel="stylesheet" href="/extension/jira-export.css"></head><body><main id="report"></main></body></html>');return;}
    if (!/^\/extension\/[a-z-]+\.(m?js|css)$/.test(path)) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript');res.end(await readFile(join(project, path)));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, args: ['--use-mock-keychain', '--password-store=basic']});
try {
  const page = await browser.newPage({viewport: {width: 1080, height: 900}});
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const {createJiraExporter} = await import('/extension/jira-export.mjs');
    const {jiraTitleSource} = await import('/extension/jira-titles.mjs');
    window.review = {id: 'review', comments: [
      {id: 'legacy', fields: {title: 'Keep my original title', comment: 'Original feedback'}},
      {id: 'generate', fields: {title: '', comment: 'The label still shows the old project after choosing another.'}},
      {id: 'edit', fields: {title: '', comment: 'The save action needs more emphasis.'}},
      {id: 'previous', fields: {title: '', comment: 'This comment was sent to Jira before AI titles existed.'}},
    ]};
    const container = document.querySelector('#report');
    const cards = review.comments.map(() => {const card = document.createElement('article');card.innerHTML = '<div class="comment-actions"></div>';container.append(card);return card;});
    window.requests = [];window.pendingTitles = [];
    window.chrome ||= {};
    window.chrome.runtime = {sendMessage: request => {requests.push(request);return new Promise(resolve => pendingTitles.push(() => resolve({ok: true, reason: 'generated', titles: request.commentIds.map(id => ({commentId: id, source: jiraTitleSource(review.comments.find(comment => comment.id === id)), title: `Suggested ${id} title`}))})));}};
    const saved = {'diffuseJiraDeliveryV1:connection:site:project:task:previous:abcdef': {revision: 'abcdef'}};
    window.savedTitles = saved;
    createJiraExporter({clientFactory: () => ({listConnections: async () => []}), storage: {get: async key => key === null ? saved : {[key]: saved[key]}, set: async values => {Object.assign(saved, values);}}}).mount(review, container, cards);
  });
  assert.equal(await page.evaluate(() => requests.length), 0, 'Mounting a review never generates titles');
  await page.getByRole('button', {name: 'Select visible', exact: true}).click();
  await page.getByRole('button', {name: 'Send selected to Jira', exact: true}).click();
  await page.waitForFunction(() => pendingTitles.length === 1);
  const request = await page.evaluate(() => requests[0]);
  assert.deepEqual(request, {namespace: 'diffuse', target: 'worker', type: 'GENERATE_JIRA_TITLES', reviewId: 'review', commentIds: ['generate', 'edit']});
  const titles = page.getByRole('textbox', {name: 'Ticket title'});
  assert.equal(await titles.nth(0).inputValue(), 'Keep my original title');
  assert.equal(await titles.nth(3).inputValue(), 'This comment was sent to Jira before AI titles existed.', 'A previous delivery keeps its summary and revision');
  await titles.nth(2).fill('My more specific ticket title');
  await page.evaluate(() => pendingTitles.shift()());
  await page.waitForFunction(() => document.querySelectorAll('.jira-export-item input')[1].value === 'Suggested generate title');
  assert.equal(await titles.nth(2).inputValue(), 'My more specific ticket title', 'A slow AI response cannot overwrite an edited title');
  assert.equal(await titles.nth(0).inputValue(), 'Keep my original title');
  assert.equal(await page.evaluate(() => review.comments[2].fields.title), '', 'The review is unchanged');
  await page.getByRole('button', {name: 'Close', exact: true}).first().click();
  await page.getByRole('button', {name: 'Send selected to Jira', exact: true}).click();
  await page.waitForFunction(() => pendingTitles.length === 1);
  assert.deepEqual(await page.evaluate(() => requests.at(-1).commentIds), ['edit'], 'Cached generated titles are reused without changing delivery revisions');
  assert.equal(await titles.nth(1).inputValue(), 'Suggested generate title');
  await page.getByRole('button', {name: 'Close', exact: true}).first().click();
  await page.evaluate(() => pendingTitles.shift()());
  await page.waitForFunction(() => !document.querySelector('.jira-export-dialog'));
  assert.equal(await page.evaluate(() => Object.keys(savedTitles).filter(key => key.startsWith('diffuseJiraTitleV1:')).length), 1, 'A response after closing the preview is not applied or cached');
  assert.deepEqual(errors, []);
  console.log('PASS Jira title generation starts only on export, preserves legacy titles and user edits, caches previews, and ignores responses after close.');
} finally {await browser.close();await new Promise(resolve => server.close(resolve));}
