// Exercise the real drawer and audit controllers in an isolated browser.
// Worker and local-helper responses are fixtures; no real sites or AI calls.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/interactive-audit');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({headless: true, args: ['--use-mock-keychain', '--password-store=basic']});
const context = await browser.newContext({viewport: {width: 390, height: 1000}, colorScheme: 'dark'});
const errors = [];
await context.route('https://diffuse.test/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  let body = await readFile(resolve(root, 'extension', name), 'utf8');
  if (name === 'sidepanel.html') body = body.replace(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g, (tag, file) => ['sidepanel.js', 'journey-panel.js', 'journey-persona-ui.js', 'interactive-audit-panel.js', 'theme.js'].includes(file) ? tag : '');
  await route.fulfill({contentType: {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript'}[extname(name)] || 'text/plain', body});
});
await context.addInitScript(() => {
  const event = () => ({addListener() {}});
  window.session = {id: 'review-1', mode: 'audit', target: {title: 'Atlas', url: 'https://atlas.example/projects'}, settings: {}, comments: []};
  window.pageState = {view: 'controls', active: true, available: true, ai: {config: {hasKey: true, model: 'fixture'}, threshold: 35}};
  window.auditConfig = {paired: false, endpoint: 'http://127.0.0.1:8932'};
  window.aiConfig = {provider: 'openai', hasKey: true, model: 'gpt-6.1-sol'};
  window.fixtureAudit = null;
  window.messages = [];
  window.failConnection = false;
  window.allowLocalAccess = false;
  window.localPermissionRequests = [];
  window.syncError = '';
  window.sourceTab = {};
  window.loadTabs = async () => {};
  window.renderSession = () => { document.querySelector('#loading').hidden = true; };
  window.chrome = {
    runtime: {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      connect() {
        const port = {postMessage() {queueMicrotask(() => port.listener?.({type: 'ATTACHED'}));}, onMessage: {addListener(fn) {port.listener = fn;}}, onDisconnect: event()};
        return port;
      },
      async sendMessage(message) {
        window.messages.push(message);
        if (message.type === 'GET_AI_CONFIG') return {ok: true, config: window.aiConfig};
        if (message.type === 'JOURNEY_STATE') return {ok: true, run: null};
        if (message.type === 'JOURNEY_HISTORY') return {ok: true, runs: []};
        if (message.type === 'BROWSER_AUDIT_CONFIG') return {ok: true, config: window.auditConfig, ai: window.aiConfig};
        if (message.type === 'BROWSER_AUDIT_PAIR') {
          window.auditConfig = {...window.auditConfig, paired: true, connected: true};
          return {ok: true, config: window.auditConfig};
        }
        if (message.type === 'BROWSER_AUDIT_CHECK') return window.failConnection ? {ok: false, error: 'Start the local browser helper and check again.'} : {ok: true, health: {ok: true}};
        if (message.type === 'BROWSER_AUDIT_STATE') return {ok: true, audit: window.fixtureAudit, syncError: window.syncError};
        if (message.type === 'BROWSER_AUDIT_OPEN') {
          window.fixtureAudit = {id: 'audit-1', status: 'ready', url: message.url, checks: message.checks, steps: [{id: 's1', action: 'open', description: 'Opened the audit browser', status: 'completed'}]};
          return {ok: true, audit: window.fixtureAudit};
        }
        if (message.type === 'BROWSER_AUDIT_RUN') {
          window.fixtureAudit = {...window.fixtureAudit, status: 'running'};
          return {ok: true, audit: window.fixtureAudit};
        }
        if (message.type === 'BROWSER_AUDIT_STOP') {
          window.fixtureAudit = {...window.fixtureAudit, status: 'stopped', stopReason: 'Stopped by reviewer', evidence: {styles: {typography: [{count: 4}], colors: [{count: 6}], spacing: [], radii: []}}, steps: [...window.fixtureAudit.steps, {id: 's2', action: 'styles', description: 'Collected typography and colors', status: 'completed'}]};
          return {ok: true, audit: window.fixtureAudit};
        }
        if (message.type === 'BROWSER_AUDIT_ANALYZE') {
          window.fixtureAudit = {...window.fixtureAudit, analysisStatus: 'running'};
          return {ok: true, audit: window.fixtureAudit};
        }
        if (message.type === 'BROWSER_AUDIT_REPORT') return {ok: true};
        if (message.type === 'BROWSER_AUDIT_DISCONNECT') {
          window.auditConfig = {...window.auditConfig, paired: false, connected: false};
          return {ok: true, config: window.auditConfig};
        }
        return {ok: true, session: window.session, state: window.pageState};
      }
    },
    storage: {local: {async get() {return {};}, async set() {}}, onChanged: event()},
    permissions: {request: async value => { window.localPermissionRequests.push(value); return window.allowLocalAccess; }}, tabs: {onActivated: event(), onUpdated: event()}, windows: {getCurrent: async () => ({id: 1})}
  };
});
try {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://diffuse.test/sidepanel.html');
  await page.locator('#open-ai-entry:not([disabled])').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.locator('#open-ai-entry').click();
  await page.locator('#panel-interactive-audit').click();
  await page.locator('#panel-interactive-audit-view').waitFor();
  await page.waitForFunction(() => document.querySelector('#interactive-audit-connection-label').textContent === 'Not connected');
  assert.equal(await page.locator('#panel-ai-entry').isVisible(), false);
  assert.equal(await page.locator('#interactive-audit-title').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#interactive-audit-url').inputValue(), 'https://atlas.example/projects');
  assert.equal(await page.locator('#interactive-audit-open').isDisabled(), true);
  await page.screenshot({path: resolve(out, 'setup-dark.png'), fullPage: true});
  await page.locator('#interactive-audit-token').fill('fixture-local-token');
  await page.locator('#interactive-audit-pair').click();
  await page.locator('#interactive-audit-error').waitFor();
  assert.match(await page.locator('#interactive-audit-error').textContent(), /No token was sent/);
  assert.equal(await page.evaluate(() => messages.some(m => m.type === 'BROWSER_AUDIT_PAIR')), false, 'Denied local permission does not send the token');
  assert.deepEqual(await page.evaluate(() => localPermissionRequests[0]), {origins: ['http://127.0.0.1/*']});
  await page.evaluate(() => window.allowLocalAccess = true);
  await page.locator('#interactive-audit-token').fill('fixture-local-token');
  await page.locator('#interactive-audit-pair').click();
  await page.locator('#interactive-audit-open:not([disabled])').waitFor();
  assert.equal(await page.locator('#interactive-audit-token').inputValue(), '');
  assert.equal(await page.locator('body').textContent().then(value => value.includes('fixture-local-token')), false);
  for (const id of ['styles', 'accessibility', 'interactions']) await page.locator(`#interactive-audit-${id}`).uncheck();
  assert.equal(await page.locator('#interactive-audit-open').isDisabled(), true);
  await page.locator('#interactive-audit-styles').check();
  await page.locator('#interactive-audit-open').click();
  await page.locator('#interactive-audit-ready').waitFor();
  assert.equal(await page.locator('#interactive-audit-new').isDisabled(), true, 'Only one audit browser can be active, including while waiting for login');
  assert.equal(await page.locator('#interactive-audit-stop').isEnabled(), true, 'A ready browser can be stopped without collecting');
  const sentOpen = await page.evaluate(() => messages.find(m => m.type === 'BROWSER_AUDIT_OPEN'));
  assert.deepEqual(sentOpen.checks, {styles: true, accessibility: false, interactions: false});
  assert.equal(sentOpen.sessionId, 'review-1');
  assert.equal(await page.evaluate(() => messages.some(m => ['BROWSER_AUDIT_RUN', 'BROWSER_AUDIT_ANALYZE'].includes(m.type))), false, 'Opening waits for login and explicit collection');
  await page.locator('#interactive-audit-collect').click();
  await page.locator('#interactive-audit-stop').waitFor();
  // The original reviewed tab can go away without hiding the audit controls.
  await page.evaluate(() => { pageState.available = false; window.dispatchEvent(new Event('diffuse-refresh')); });
  assert.equal(await page.locator('#panel-interactive-audit-view').isVisible(), true);
  await page.locator('#interactive-audit-stop').click();
  await page.waitForFunction(() => document.querySelector('#interactive-audit-status').textContent === 'Stopped');
  assert.match(await page.locator('#interactive-audit-progress').textContent(), /Stopped by reviewer/);
  assert.equal(await page.locator('#interactive-audit-report').isEnabled(), true);
  assert.equal(await page.locator('#interactive-audit-analyze').isEnabled(), true);
  assert.equal(await page.evaluate(() => messages.some(m => m.type === 'BROWSER_AUDIT_ANALYZE')), false, 'Collection never automatically sends evidence to AI');
  assert.match(await page.locator('#interactive-audit-ai-disclosure').textContent(), /OpenAI.*Screenshots stay local.*gpt-6.1-sol/);
  await page.locator('#interactive-audit-steps-section summary').click();
  assert.equal(await page.locator('#interactive-audit-steps li').count(), 2);
  await page.locator('#interactive-audit-instructions').fill('Explain heading consistency');
  await page.locator('#interactive-audit-analyze').click();
  await page.waitForFunction(() => document.querySelector('#interactive-audit-status').textContent === 'Analyzing evidence');
  assert.equal(await page.locator('#interactive-audit-stop').isEnabled(), true, 'AI analysis can be stopped');
  const analysisMessage = await page.evaluate(() => messages.find(m => m.type === 'BROWSER_AUDIT_ANALYZE'));
  assert.equal(analysisMessage.expectedProvider, 'openai');
  assert.equal(analysisMessage.instructions, 'Explain heading consistency');
  await page.evaluate(() => { syncError = 'Browser helper connection interrupted'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#interactive-audit-error').textContent === 'Browser helper connection interrupted');
  await page.evaluate(() => {
    syncError = '';
    fixtureAudit = {...fixtureAudit, analysisStatus: 'completed', analysis: {provider: 'openai', model: 'gpt-6.1-sol', summary: 'Heading styles are inconsistent.', limitations: ['Only the audited page was checked.'], findings: [{title: '<img src=x onerror=alert(1)>', description: 'Two heading sizes are used for the same role.', recommendation: 'Use one heading style.'}]}};
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#interactive-audit-analysis').waitFor();
  assert.equal(await page.locator('#interactive-audit-findings img').count(), 0, 'Evidence and AI output are text, never executable HTML');
  await page.locator('#interactive-audit-report').click();
  assert.equal(await page.evaluate(() => messages.some(m => m.type === 'BROWSER_AUDIT_REPORT' && m.id === 'audit-1')), true);
  await page.setViewportSize({width: 320, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Audit fits a narrow drawer');
  await page.screenshot({path: resolve(out, 'stopped-audit-dark.png'), fullPage: true});
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({path: resolve(out, 'stopped-audit-light.png'), fullPage: true});
  await page.evaluate(() => { pageState.available = true; window.dispatchEvent(new Event('diffuse-refresh')); });
  await page.locator('#interactive-audit-back').click();
  await page.locator('#panel-ai-entry').waitFor();
  assert.equal(await page.locator('#panel-interactive-audit').evaluate(el => el === document.activeElement), true);
  await page.locator('#panel-interactive-audit').click();
  await page.locator('#interactive-audit-run').waitFor();
  assert.match(await page.locator('#interactive-audit-status').textContent(), /Stopped/);
  await page.locator('#interactive-audit-connection summary').click();
  await page.evaluate(() => window.failConnection = true);
  await page.locator('#interactive-audit-check').click();
  await page.locator('#interactive-audit-error').waitFor();
  assert.match(await page.locator('#interactive-audit-error').textContent(), /Start the local browser helper/);
  await page.locator('#interactive-audit-new').click();
  assert.equal(await page.locator('#interactive-audit-open').isDisabled(), true, 'Unavailable helper cannot start another audit');
  await page.evaluate(() => { session = {...session, id: 'review-2', target: {url: 'https://second.example'}}; window.dispatchEvent(new Event('diffuse-refresh')); });
  await page.locator('#panel-controls').waitFor();
  assert.equal(await page.locator('#panel-interactive-audit-view').isVisible(), false);
  assert.equal(await page.locator('#interactive-audit-url').inputValue(), 'https://second.example');
  assert.deepEqual(errors, []);
  console.log('PASS interactive audit pairing, explicit collection and analysis, stop/report persistence, provider binding, safe output, unavailable helper and narrow dark/light layout.');
} finally { await context.close(); await browser.close(); }
