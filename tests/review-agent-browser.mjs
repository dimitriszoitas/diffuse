// Real settings, worker, screenshot capture, pending cards, acceptance and exports.
// Only Anthropic is replaced by an HTTP fixture; no real key or paid inference.
// Chrome runs in a disposable profile. Product source is never patched in place.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-review-agent-browser-'));
const extension = join(temporary, 'extension');
const artifacts = join(project, 'artifacts', 'review-agent');
const KEY = 'sk-ant-review-browser-fixture-not-a-real-key';
const calls = [], agents = new Map(), sessions = new Map(), errors = [], results = [];
let environment, eventSequence = 0, sessionSequence = 0, failRun = false, holdRun = false;
const event = (type, extra = {}) => ({id: `sevt_review_${++eventSequence}`, type, processed_at: new Date(1792836000000 + eventSequence).toISOString(), ...extra});
const finding = {category: 'ux-issue', title: 'Clarify the primary action', comment: 'The action label does not explain what will happen next.', expected: 'Use a label describing the outcome.', component: 'Primary action', state: 'Current visible screen', severity: 'major', mismatchScore: 85, confidence: .91, region: {x: .1, y: .2, width: .3, height: .2}, ruleIds: ['ux-information-scent'], assessment: 'observed'};
const assessment = {summary: 'Two evidence-scoped candidate findings.', limitations: ['Only the currently captured screen was inspected.'], suggestions: [finding, {...finding, title: 'Measure the helper text contrast', comment: 'Helper text appears faint, but its contrast has not been measured.', expected: 'Measure the actual foreground and background colors before judging compliance.', mismatchScore: 70, ruleIds: ['a11y-1-4-3'], assessment: 'observed'}]};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const send = (body, status = 200) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(body)); };
  if (!url.pathname.startsWith('/v1/')) {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'"});
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Review agent fixture</title><style>body{margin:48px;background:#f5f7fb;color:#152b42;font:20px/1.5 system-ui}main{max-width:700px;padding:32px;border:1px solid #d2dce8;background:white;border-radius:12px}button{padding:14px 24px;font:inherit;color:white;background:#235ed7;border:0;border-radius:6px}.hint{color:#b3bcca;font-size:14px}</style></head><body><main><h1>Create a project</h1><p>Choose a name to get started.</p><label>Project name <input value="Spring recipes"></label><p class="hint">This will create a new shared project.</p><button>Continue</button></main></body></html>');
    return;
  }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({method: request.method, path: url.pathname, body});
    assert.notEqual(url.pathname, '/v1/messages', 'Managed reviews must never fall back to direct Messages');
    assert.equal(request.headers['x-api-key'], KEY);
    assert.equal(request.headers['anthropic-beta'], 'managed-agents-2026-04-01');
    if (url.pathname === '/v1/agents' && request.method === 'POST') {
      assert.equal(body.metadata.diffuse_role, 'ux-accessibility-reviewer');
      assert.deepEqual(body.model, {id: 'claude-opus-5-5', effort: {type: 'max'}});
      assert.deepEqual(body.tools.map(tool => [tool.type, tool.name]), [['custom', 'review_assessment']]);
      assert.deepEqual(body.mcp_servers, []); assert.equal(body.multiagent, null);
      assert.match(body.system, /nngroup\.com/); assert.match(body.system, /w3\.org/);
      const agent = {...body, id: 'agent_review_fixture', version: 1, type: 'agent', archived_at: null};
      agents.set(agent.id, agent); send(agent); return;
    }
    if (url.pathname === '/v1/agents/agent_review_fixture' && request.method === 'GET') {
      assert.equal(url.searchParams.get('version'), '1'); send(agents.get('agent_review_fixture')); return;
    }
    if (url.pathname === '/v1/environments' && request.method === 'POST') {
      assert.deepEqual(body.config.networking, {type: 'limited', allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false});
      environment = {...body, id: 'env_review_fixture', type: 'environment', archived_at: null}; send(environment); return;
    }
    if (url.pathname === '/v1/environments/env_review_fixture') { send(environment); return; }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
      assert.deepEqual(body.agent, {type: 'agent', id: 'agent_review_fixture', version: 1});
      assert.equal(body.environment_id, 'env_review_fixture');
      assert.deepEqual(body.budget, {type: 'limit', max_list_cost: {amount: '200', currency: 'USD'}});
      const session = {id: `sesn_review_${++sessionSequence}`, type: 'session', status: 'idle', events: [], hold: holdRun, fail: failRun};
      holdRun = false; failRun = false; sessions.set(session.id, session);
      send({id: session.id, type: session.type, status: session.status}); return;
    }
    const match = /^\/v1\/sessions\/(sesn_review_\d+)(\/events)?$/.exec(url.pathname);
    assert.ok(match, `Unexpected managed endpoint ${url.pathname}`);
    const session = sessions.get(match[1]); assert.ok(session);
    if (!match[2]) { send({id: session.id, type: session.type, status: session.status}); return; }
    if (request.method === 'GET') {
      const types = url.searchParams.getAll('types[]');
      assert.ok(types.length && types.every(type => !type.startsWith('user.')));
      send({data: session.events.filter(item => types.includes(item.type)), next_page: null}); return;
    }
    assert.equal(body.events.length, 1);
    const incoming = body.events[0];
    if (incoming.type === 'user.interrupt') {
      session.interrupts = (session.interrupts || 0) + 1; session.status = 'idle';
      send({data: [event('user.interrupt')], next_page: null}); return;
    }
    assert.equal(incoming.type, 'user.message', 'Result tools must not be acknowledged into another inference turn');
    const images = incoming.content.filter(block => block.type === 'image');
    assert.equal(images.length, 1, 'A standalone review sends one real browser screenshot');
    assert.equal(images[0].source.type, 'base64');
    assert.ok(Buffer.from(images[0].source.data, 'base64').length > 4000, 'Real screenshot bytes are sent');
    session.images = images.length; session.imageBytes = Buffer.from(images[0].source.data, 'base64').length;
    assert.ok(incoming.content.some(block => block.type === 'text' && block.text.includes('Check the project creation flow.')));
    assert.equal(JSON.stringify(incoming.content).includes(KEY), false);
    if (session.fail) { send({error: {message: `Fixture provider failure must not expose ${KEY}`}}, 403); return; }
    const acknowledgements = [event('user.message', incoming)];
    session.events.push(...acknowledgements);
    if (session.hold) session.status = 'running';
    else {
      const result = event('agent.custom_tool_use', {name: 'review_assessment', input: assessment});
      session.events.push(result, event('session.status_idle', {stop_reason: {type: 'requires_action', event_ids: [result.id]}}));
    }
    send({data: acknowledgements, next_page: null});
  } catch (error) { errors.push(error); send({error: {message: 'Fixture assertion failed.'}}, 500); }
});

const pass = message => { results.push(message); console.log(`PASS ${message}`); };
async function until(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (errors.length) throw errors[0];
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
let context, worker, page, overlay;
async function command(action) {
  const result = await worker.evaluate(async action => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    return chrome.tabs.sendMessage(session.targetTabId, {namespace: 'diffuse', type: 'PANEL_COMMAND', sessionId: session.id, action});
  }, action);
  assert.equal(result?.ok, true, result?.error); return result;
}
async function snapshot() {
  return worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    const review = await globalThis.__reviewSmoke.getReview(session.reviewId);
    const batch = session.aiBatchId ? await globalThis.__reviewSmoke.getDraft(session.aiBatchId) : null;
    return {reviewId: review.id, count: review.count, comments: review.comments.map(item => ({ai: item.ai, fields: item.fields, image: item.evidence.production.dataUrl.startsWith('data:image/png'), annotated: !!item.evidence.production.annotatedDataUrl})), batchId: batch?.id, metadata: batch?.aiBatch, aiRunning: session.aiRunning};
  });
}
try {
  await mkdir(artifacts, {recursive: true});
  await cp(join(project, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.anthropic.com/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const workerPath = join(extension, 'background.js');
  await writeFile(workerPath, (await readFile(workerPath, 'utf8')) + '\nglobalThis.__reviewSmoke = reviews;\n');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {executablePath: chromium.executablePath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000', '--use-mock-keychain', '--password-store=basic']});
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(origin => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (url, init) => {
      const value = String(url);
      if (value.startsWith('https://api.anthropic.com/v1/')) return nativeFetch(origin + new URL(value).pathname + new URL(value).search, init);
      if (value.startsWith('chrome-extension:') || value.startsWith(origin + '/')) return nativeFetch(url, init);
      throw new Error('External network is disabled in the review agent test.');
    };
  }, origin);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/ai-settings.html`);
  await settings.waitForFunction(() => document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  await settings.locator('#api-key').fill(KEY);
  await settings.locator('#review-engine-managed').check();
  assert.equal(await settings.locator('#review-budget').inputValue(), '2');
  assert.equal(await settings.locator('#review-agent-options .journey-agent-model strong').textContent(), 'Claude Opus 5.5 · Max effort');
  await settings.locator('#setup-review-agent').click();
  await until(() => settings.locator('#review-agent-status').textContent().then(text => text === 'Reviewer ready'), 'reviewer setup');
  await settings.waitForFunction(() => document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  assert.equal(await settings.locator('#api-key').inputValue(), '');
  let saved = await worker.evaluate(() => chrome.storage.local.get(['aiConfig', 'diffuseReviewAgent', 'diffuseJourneyAgents', 'anthropicApiKey']));
  assert.equal(saved.aiConfig.reviewEngine, 'managed'); assert.equal(saved.aiConfig.journeyEngine, 'direct');
  assert.equal(saved.diffuseJourneyAgents, undefined); assert.equal(saved.anthropicApiKey, undefined);
  assert.equal(saved.diffuseReviewAgent.verified, true); assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.equal(calls.filter(call => call.path === '/v1/sessions').length, 0, 'Setup incurs no inference');
  pass('Real settings set up one combined reviewer, enable it, retain a session-only key and leave journeys unchanged');

  await settings.reload();
  await settings.waitForFunction(() => document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  await settings.locator('#setup-review-agent').click();
  await settings.waitForFunction(() => document.querySelector('#ai-settings-form').getAttribute('aria-busy') === 'false');
  assert.match(await settings.locator('#ai-feedback').textContent(), /ready and enabled/);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/agents').length, 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/v1/environments').length, 1);
  pass('Reload and Check reviewer verify the same pinned agent and environment without duplicating resources');

  for (const theme of ['light', 'dark']) {
    await settings.setViewportSize({width: 320, height: 850});
    await settings.evaluate(theme => DiffuseTheme.setPreference(theme), theme);
    await until(() => settings.locator('html').getAttribute('data-theme').then(value => value === theme), `settings ${theme} theme`);
    assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px settings has no horizontal overflow');
    await settings.locator('#review-agent-heading').scrollIntoViewIfNeeded();
    await settings.locator('[aria-labelledby="review-agent-heading"]').screenshot({path: join(artifacts, `settings-${theme}-320.png`)});
  }
  pass('Reviewer settings fit a 320px viewport in both light and dark themes');

  const browserCDP = await context.browser().newBrowserCDPSession();
  page = context.pages()[0]; await page.goto(`${origin}/review.html`); await page.bringToFront();
  const {targetInfos} = await browserCDP.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  await browserCDP.send('Extensions.triggerAction', {id: extensionId, targetId: targetInfos.find(item => item.url === page.url()).targetId});
  const popup = await context.newPage(); await page.bringToFront(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#start-comparison').click();
  overlay = page.locator('diffuse-live-overlay');
  await until(() => overlay.locator('#status').textContent({timeout: 1000}).then(text => text === 'Review ready').catch(() => false), 'review starts');
  await worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    const tab = await chrome.tabs.get(session.targetTabId); await chrome.sidePanel.close({windowId: tab.windowId});
  });
  await page.bringToFront();
  await until(() => overlay.getAttribute('data-docked').then(value => value === null), 'native drawer closes');
  let previous, stable = 0;
  await until(async () => { const size = await page.evaluate(() => `${innerWidth}x${innerHeight}`); stable = size === previous ? stable + 1 : 0; previous = size; return stable >= 4; }, 'capture viewport settles');
  await command('openAi');
  await until(() => overlay.locator('#ai-run').isEnabled(), 'managed reviewer available');
  await overlay.locator('#ai-instructions').fill('Check the project creation flow.');
  await overlay.locator('#ai-run').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 2), 'managed suggestions render');
  assert.equal(calls.filter(call => call.path === '/v1/messages').length, 0);
  const initial = await snapshot();
  assert.equal(initial.count, 0); assert.equal(initial.metadata.model, 'claude-opus-5-5');
  assert.equal(initial.metadata.checkedAt, '2026-10-24'); assert.match(initial.metadata.knowledgeRevision, /2026-10-24/);
  assert.deepEqual(initial.metadata.suggestions.map(item => item.assessment), ['heuristic', 'needs-verification']);
  assert.match(initial.metadata.limitations.join(' '), /not a WCAG conformance audit/);
  assert.equal([...sessions.values()][0].interrupts, 1);
  const cards = overlay.locator('.ai-suggestion');
  assert.match(await cards.first().textContent(), /UX recommendation/);
  assert.match(await cards.nth(1).textContent(), /Needs verification/);
  await cards.first().locator('details > summary').click();
  await cards.nth(1).locator('details > summary').click();
  const links = await cards.locator('details a').evaluateAll(items => items.map(item => ({href: item.href, rel: item.rel, target: item.target})));
  assert.equal(links.length, 2);
  assert.ok(links.some(link => link.href === 'https://www.nngroup.com/articles/information-scent/'));
  assert.ok(links.some(link => link.href === 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html'));
  assert.ok(links.every(link => link.target === '_blank' && link.rel.includes('noopener')));
  await cards.first().screenshot({path: join(artifacts, 'pending-ux-sources-dark.png')});
  await cards.nth(1).screenshot({path: join(artifacts, 'pending-accessibility-sources-dark.png')});
  pass('Actual runAIReview captures the page, uses the managed agent and displays curated sources with evidence limits');

  await overlay.locator('#ai-accept-all').click();
  await until(async () => (await snapshot()).count === 2, 'findings accepted');
  const accepted = await snapshot();
  for (const comment of accepted.comments) {
    assert.ok(comment.image && comment.annotated); assert.equal(comment.ai.model, 'claude-opus-5-5');
    assert.equal(comment.ai.knowledgeRevision, initial.metadata.knowledgeRevision);
    assert.equal(comment.ai.checkedAt, '2026-10-24'); assert.equal(comment.ai.sources.length, 1);
  }
  const reportPromise = context.waitForEvent('page'); await command('openReport');
  const report = await reportPromise; await report.waitForLoadState();
  await until(() => report.locator('.comment-card').count().then(count => count === 2), 'accepted report');
  assert.match(await report.locator('#report-content').textContent(), /Needs verification/);
  const downloads = {};
  for (const [button, name] of [['download-html', 'managed-review.html'], ['export-review', 'managed-review.diffuse-review.json']]) {
    const downloadPromise = report.waitForEvent('download');
    await report.locator('#review-actions-toggle').click(); await report.locator(`#${button}`).click();
    const download = await downloadPromise; const path = join(artifacts, name); await download.saveAs(path);
    downloads[button] = await readFile(path, 'utf8');
    assert.equal(downloads[button].includes(KEY), false);
    assert.match(downloads[button], /nngroup\.com\/articles\/information-scent/);
    assert.match(downloads[button], /w3\.org\/WAI\/WCAG22\/Understanding\/contrast-minimum/);
  }
  assert.match(downloads['download-html'], /Needs verification/);
  const bundle = JSON.parse(downloads['export-review']);
  assert.equal(bundle.review.comments.length, 2);
  assert.deepEqual(bundle.review.comments.map(item => item.ai.assessment).sort(), ['heuristic', 'needs-verification']);
  assert.equal(bundle.review.comments.find(item => item.ai.ruleIds.includes('ux-information-scent')).ai.assessment, 'heuristic');
  assert.equal(bundle.review.comments.find(item => item.ai.ruleIds.includes('a11y-1-4-3')).ai.assessment, 'needs-verification');
  assert.ok(bundle.review.comments.every(item => item.ai.checkedAt === '2026-10-24' && item.ai.ruleIds.length === 1));
  pass('Accepted comments preserve screenshot evidence, rule IDs and source links in the report, HTML and portable JSON');

  await page.bringToFront();
  await command('openAi'); await until(() => overlay.locator('#ai-run').isEnabled(), 'repeat review ready');
  failRun = true; await overlay.locator('#ai-run').click();
  await until(() => overlay.locator('#ai-error').textContent().then(text => /access|permission/i.test(text)), 'provider failure shown');
  const errorText = await overlay.locator('#ai-error').textContent();
  assert.doesNotMatch(errorText, /Fixture provider failure|sk-ant-/);
  assert.equal((await snapshot()).count, 2); assert.equal((await snapshot()).batchId, initial.batchId);
  assert.equal(calls.filter(call => call.path === '/v1/messages').length, 0);
  assert.equal([...sessions.values()][1].interrupts, 1);
  pass('Provider failure keeps the accepted review, sanitizes the error and cleans up without direct fallback');

  holdRun = true; await overlay.locator('#ai-run').click();
  await until(() => [...sessions.values()].some(session => session.hold && session.images === 1), 'pending managed inference');
  await command('stop');
  await until(() => overlay.count().then(count => count === 0), 'review stopped');
  await until(() => [...sessions.values()].find(session => session.hold)?.interrupts === 1, 'cancelled managed session interrupted');
  assert.equal(await worker.evaluate(() => chrome.storage.session.get('comparison').then(result => !!result.comparison)), false);
  assert.equal(calls.filter(call => call.path === '/v1/messages').length, 0);
  assert.equal(calls.filter(call => call.path === '/v1/agents' && call.method === 'POST').length, 1);
  assert.ok([...sessions.values()].every(session => session.interrupts === 1));
  assert.equal(errors.length, 0);
  pass('Stopping an in-flight review interrupts its provider session exactly once and removes the page overlay');
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({passed: results, sessions: sessions.size, screenshotBytes: [...sessions.values()].map(item => item.imageBytes), paidRequests: 0, limitations: ['Provider responses are deterministic local fixtures; live Anthropic behavior and workspace entitlements are not tested.', 'This test does not perform a WCAG conformance audit or exercise assistive technology.']}, null, 2));
  console.log(`PASS ${results.length} browser integration checks; artifacts: ${artifacts}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({path: join(artifacts, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
