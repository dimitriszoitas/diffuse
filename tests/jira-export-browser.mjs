// Local UI fixture with injected connections and deliveries. No Atlassian or backend requests.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = join(project, 'artifacts', 'jira-export');
await mkdir(artifacts, {recursive: true});
const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/') { res.setHeader('Content-Type', 'text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/extension/report.css"><link rel="stylesheet" href="/extension/jira-export.css"></head><body><main style="max-width:1000px;margin:24px auto;padding:16px"><h1>Diffuse review fixture</h1><button id="filter" class="button">Show UX issues</button><div id="report"></div></main></body></html>');return; }
    if (!/^\/extension\/[a-z-]+\.(mjs|css)$/.test(path)) { res.writeHead(404);res.end();return; }
    res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');res.end(await readFile(join(project, path)));
  } catch { res.writeHead(404);res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 960}});
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const {createJiraExporter} = await import('/extension/jira-export.mjs');
    const canvas = document.createElement('canvas');canvas.width = 100;canvas.height = 60;canvas.getContext('2d').fillRect(0, 0, 100, 60);
    const evidence = {production: {dataUrl: canvas.toDataURL('image/png')}};
    const review = {id: 'review', comments: [
      {id: crypto.randomUUID(), mode: 'audit', fields: {title: 'Make the Save action easier to find', comment: 'The Save button looks like a secondary action.', expected: 'Use the primary style and place Save beside Cancel.', category: 'design-mismatch', state: 'Editing a project'}, evidence},
      {id: crypto.randomUUID(), mode: 'audit', fields: {title: 'Keep the selected filter after closing the menu', comment: 'The selection resets every time the menu opens.', expected: 'Keep the selection until the user changes it.', category: 'ux-issue', state: 'Filtered list'}, evidence},
    ]};
    const container = document.getElementById('report');
    review.comments.forEach(comment => { const card = document.createElement('article');card.className = 'comment-card';const title = document.createElement('h2');title.textContent = comment.fields.title;const actions = document.createElement('div');actions.className = 'comment-actions';card.append(title, actions);container.append(card); });
    const cards = [...container.children];
    document.getElementById('filter').onclick = () => { cards[0].hidden = !cards[0].hidden; };
    window.jiraRequests = [];const receipts = new Map();const memory = {};
    const siteId = '820b73a3-0e29-45ad-b9e4-72d24a9c83ea';
    const client = {
      listConnections: async () => [{id: 'account', displayName: 'Demo designer', accountId: 'demo:account', sites: [{id: siteId, name: 'Studio workspace', url: 'https://studio.atlassian.net'}]}],
      request: async (_, path, options = {}) => {
        window.jiraRequests.push({path, method: options.method || 'GET'});
        const values = path.startsWith('/v1/projects') ? [{id: '10000', key: 'DES', name: 'Product design'}] : path.startsWith('/v1/issue-types') ? [{id: '10001', name: 'Task'}] : path.startsWith('/v1/create-fields') ? [
          {fieldId: 'summary', name: 'Summary', required: true, schema: {type: 'string'}},
          {fieldId: 'customfield_10010', name: 'Team context', required: true, schema: {type: 'string'}},
          {fieldId: 'priority', name: 'Priority', required: false, schema: {type: 'priority'}, allowedValues: [{id: '3', name: 'Medium'}, {id: '2', name: 'High'}]},
        ] : null;
        if (values) return {values, startAt: 0, maxResults: 50, total: values.length, isLast: true};
        if (path.startsWith('/v1/attachment-settings')) return {enabled: true, uploadLimit: 20000000};
        if (path === '/v1/deliveries') {
          const data = options.body;const id = crypto.randomUUID();
          const receipt = {id, clientDeliveryId: data.clientDeliveryId, commentId: data.commentId, revision: data.revision, status: 'prepared', canSendIssue: !data.attachments.length, issue: null, attachments: data.attachments.map(file => ({...file, status: 'pending', receivedChunks: [], totalChunks: 1, canSend: false}))};receipts.set(id, receipt);return structuredClone(receipt);
        }
        const receipt = receipts.get(path.split('/')[3]);
        if (path.endsWith('/chunks')) { receipt.attachments.find(item => item.id === options.body.attachmentId).receivedChunks.push(options.body.index);receipt.canSendIssue = true; }
        if (path.endsWith('/issue')) { receipt.issue = {id: '10100', key: 'DES-42', url: 'https://studio.atlassian.net/browse/DES-42'};receipt.status = 'issue-created';receipt.canSendIssue = false;receipt.attachments.forEach(item => { item.canSend = true; }); }
        if (path.includes('/attachments/')) { receipt.attachments.find(item => item.id === path.split('/').at(-1)).status = 'uploaded';receipt.status = 'complete'; }
        return structuredClone(receipt);
      },
    };
    createJiraExporter({clientFactory: () => client, storage: {get: async key => ({[key]: memory[key]}), set: async values => Object.assign(memory, values)}}).mount(review, container, cards);
  });
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', {name: 'Show UX issues'}).click();
  await page.getByText('1 selected · 1 hidden by the category filter', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Select visible', exact: true}).click();
  await page.getByText('2 selected · 1 hidden by the category filter', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Send selected to Jira', exact: true}).click();
  await page.getByRole('combobox', {name: /^Project/}).selectOption('10000');
  await page.getByRole('combobox', {name: /^Issue type/}).selectOption('10001');
  await page.getByLabel('Team context (required)', {exact: true}).waitFor();
  assert.equal((await page.evaluate(() => window.jiraRequests)).filter(item => item.method === 'POST').length, 0, 'Opening preview and selecting destination performs no writes');
  await page.getByRole('button', {name: 'Create 2 tickets', exact: true}).click();
  assert.equal((await page.evaluate(() => window.jiraRequests)).filter(item => item.method === 'POST').length, 0, 'Missing required fields block submission');
  await page.getByLabel('Team context (required)', {exact: true}).fill('Design engineering');
  await page.getByRole('combobox', {name: /^Priority/}).selectOption('2');
  await page.screenshot({path: join(artifacts, 'jira-preview-desktop.png')});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.querySelector('.jira-export-dialog').scrollWidth <= document.querySelector('.jira-export-dialog').clientWidth), true, 'Preview reflows at mobile width');
  await page.screenshot({path: join(artifacts, 'jira-preview-mobile.png')});
  await page.setViewportSize({width: 1280, height: 960});
  await page.getByRole('button', {name: 'Create 2 tickets', exact: true}).click();
  await page.getByRole('button', {name: 'All tickets sent', exact: true}).waitFor();
  const requests = await page.evaluate(() => window.jiraRequests);
  assert.equal(requests.filter(item => item.path.endsWith('/issue')).length, 2);
  assert.equal(await page.getByRole('link', {name: 'Open DES-42 in Jira ↗'}).count(), 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Send selected to Jira');
  assert.deepEqual(errors, []);
  console.log('PASS selection survives filters; preview has no writes; required fields gate sending; mobile layout; two explicit deliveries; keyboard/focus restoration.');
} finally { await browser.close();await new Promise(resolve => server.close(resolve)); }
