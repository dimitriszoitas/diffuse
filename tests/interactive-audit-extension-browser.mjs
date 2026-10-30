// Actual extension UI -> actual worker -> paired companion -> Playwright MCP.
// Both Chrome profiles and helper storage are disposable. Only a local fixture
// is visited; provider requests are blocked, never billed or sent externally.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createCompanion} from '../local-browser/server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-interactive-extension-'));
const extension = join(temporary, 'extension');
const artifacts = join(root, 'artifacts', 'interactive-audit-extension');
await mkdir(artifacts, {recursive: true});
await cp(join(root, 'extension'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const fixture = http.createServer((_request, response) => {
  response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  response.end(`<!doctype html><html lang="en"><head><title>Atlas audit fixture</title><style>
body{margin:48px;font:16px Arial;background:#fff;color:#112233}h1{font-size:32px;line-height:40px}h2{font-size:23px;line-height:30px}button{padding:12px 24px;border-radius:8px;background:#eee;color:#111;border:1px solid #888}button:hover{background:#123456;color:white}button:focus-visible{outline:3px solid #00f}input{padding:12px;margin-top:20px}.bad{color:#ddd;background:white}
</style></head><body><main><h1>Account settings</h1><h2>Different heading</h2><button id="save">Save preferences</button><a href="#details">More information</a><br><input><p class="bad">Low contrast text</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><div id="details">Details</div></main><script>window.fixtureActivations=0;document.querySelector('#save').onclick=()=>{window.fixtureActivations++}</script></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const companion = await createCompanion({directory: join(temporary, 'helper'), port: 0, headless: true, executablePath: chromium.executablePath()});
const address = await companion.listen();
const helperOrigin = `http://127.0.0.1:${address.port}`;
let context, worker, cdp, panel, production, extensionId, sequence = 0;
const requests = new Map(), errors = [], results = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { results.push(label); console.log(`PASS ${label}`); }
function sendNative(sessionId, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {requests.delete(id); reject(new Error(`Native view timeout: ${method}`));}, 10000);
    requests.set(id, {resolve, reject, timer});
    cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(error => {clearTimeout(timer); requests.delete(id); reject(error);});
  });
}
async function nativeView(path) {
  let target;
  await until(async () => {target = (await cdp.send('Target.getTargets', {filter: [{exclude: false}]})).targetInfos.find(item => item.type === 'page' && item.url === `chrome-extension://${extensionId}/${path}`); return target;}, `native ${path}`);
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  const send = (method, params) => sendNative(sessionId, method, params);
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Runtime.enable');
  return {
    evaluate,
    visible: selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`),
    text: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`),
    fill: (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`),
    async click(selector) {
      const bounds = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el?.checkVisibility()||el.disabled)throw new Error('Unavailable control '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...bounds});
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds});
    },
    async screenshot(name) {const {data} = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}); await writeFile(join(artifacts, `${name}.png`), Buffer.from(data, 'base64'));}
  };
}
const currentSession = () => worker.evaluate(async () => (await chrome.storage.session.get('comparison')).comparison);
try {
  context = await chromium.launchPersistentContext(join(temporary, 'chrome-profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000', '--use-mock-keychain', '--password-store=basic']
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
  extensionId = new URL(worker.url()).host;
  assert.equal(extensionId, 'gdoidkknjbnfmeikloaafdohpjlafgbj');
  await worker.evaluate(({origin, helperOrigin}) => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.__blockedProviderRequests = 0;
    globalThis.fetch = (url, options) => {
      const value = String(url);
      if (value.startsWith('http://127.0.0.1:8932/')) return nativeFetch(helperOrigin + value.slice('http://127.0.0.1:8932'.length), options);
      if (value.startsWith(origin + '/') || value.startsWith('chrome-extension:')) return nativeFetch(url, options);
      if (/anthropic\.com|openai\.com/.test(value)) globalThis.__blockedProviderRequests++;
      throw new Error('External network disabled in interactive audit smoke test.');
    };
  }, {origin, helperOrigin});
  cdp = await context.browser().newBrowserCDPSession();
  cdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message), entry = requests.get(message.id);
    if (entry) {clearTimeout(entry.timer); requests.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);}
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  production = context.pages()[0]; await production.goto(origin); await production.bringToFront();
  const targets = await cdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const target = targets.targetInfos.find(item => item.url === production.url()); assert.ok(target);
  await cdp.send('Extensions.triggerAction', {id: extensionId, targetId: target.targetId});
  const popup = await nativeView('popup.html');
  await until(() => popup.evaluate(`document.querySelector('#popup')?.getAttribute('aria-busy') === 'false'`), 'popup initialized');
  await popup.click('#start-comparison');
  panel = await nativeView('sidepanel.html');
  await until(async () => (await currentSession())?.status === 'live', 'review starts');
  await until(() => panel.visible('#open-ai-entry'), 'review controls available');
  await panel.click('#open-ai-entry');
  await panel.click('#panel-interactive-audit');
  await until(() => panel.visible('#interactive-audit-pair'), 'audit connection visible');
  await panel.fill('#interactive-audit-token', companion.token);
  await panel.click('#interactive-audit-pair');
  await until(() => panel.evaluate(`!document.querySelector('#interactive-audit-open').disabled`), 'helper paired');
  assert.equal(await panel.evaluate(`document.querySelector('#interactive-audit-token').value`), '');
  pass('Native popup and sidebar start a real review and pair its actual worker with the local helper');
  await panel.click('#interactive-audit-open');
  await until(() => panel.visible('#interactive-audit-ready'), 'MCP browser ready', 60000);
  const first = companion.manager.active.job.id;
  assert.equal(companion.manager.active.job.status, 'ready');
  assert.equal(await worker.evaluate(() => __blockedProviderRequests), 0);
  await panel.screenshot('ready');
  await panel.click('#interactive-audit-collect');
  await until(async () => {
    const status = await panel.text('#interactive-audit-status');
    if (status === 'Audit interrupted') throw new Error(await panel.text('#interactive-audit-progress'));
    return status === 'Evidence collected';
  }, 'actual evidence collection', 90000);
  const completed = companion.manager.jobs.get(first);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.evidence.styles.typography.some(style => style.fontSize === '23px'));
  assert.ok(completed.evidence.accessibility.violations.some(item => item.id === 'label'));
  assert.ok(completed.evidence.interactions.hover.some(item => item.changed));
  assert.equal(completed.evidence.interactions.focus.length, 6);
  assert.equal(completed.evidence.screenshots.length, 2);
  assert.equal(await panel.evaluate(`document.querySelector('#interactive-audit-analyze').disabled`), true, 'No AI key required for local collection');
  assert.equal(await worker.evaluate(() => __blockedProviderRequests), 0);
  await panel.screenshot('completed');
  pass('Actual Playwright MCP collects typography, axe findings, hover/focus samples and screenshots without AI requests');
  await panel.click('#interactive-audit-report');
  let report;
  await until(() => {report = context.pages().find(page => page.url().includes(`/browser-audit-report.html?audit=${first}`)); return report;}, 'audit report opens');
  await report.waitForSelector('.browser-audit-report');
  assert.match(await report.locator('#audit-report').textContent(), /23px/);
  assert.ok(await report.locator('#audit-report img').count() >= 2);
  await report.screenshot({path: join(artifacts, 'report.png')});
  const reviewId = (await currentSession()).reviewId;
  const reviewReport = await context.newPage();
  await reviewReport.goto(`chrome-extension://${extensionId}/report.html?review=${reviewId}`);
  await reviewReport.waitForSelector('.interactive-audit-link');
  assert.equal(await reviewReport.locator('.interactive-audit-link').count(), 1);
  pass('Collected audit is saved in actual extension IndexedDB and linked from Review Reports');
  await production.bringToFront();
  await panel.click('#interactive-audit-new');
  await panel.click('#interactive-audit-open');
  await until(() => panel.visible('#interactive-audit-ready'), 'second audit ready', 60000);
  const second = companion.manager.active.job.id;
  await panel.click('#interactive-audit-stop');
  await until(async () => await panel.text('#interactive-audit-status') === 'Stopped', 'audit stopped');
  assert.equal(companion.manager.jobs.get(second).status, 'stopped');
  await reviewReport.reload();
  await reviewReport.waitForSelector('.interactive-audit-link');
  assert.equal(await reviewReport.locator('.interactive-audit-link').count(), 2);
  assert.match(await reviewReport.locator('.interactive-audits-index').textContent(), /Stopped/);
  assert.equal(await worker.evaluate(() => __blockedProviderRequests), 0);
  assert.deepEqual(errors, []);
  pass('Stopped attempts remain separate in Review Reports with steps and the reason for stopping');
  await writeFile(join(artifacts, 'verification.json'), JSON.stringify({browserVersion: context.browser().version(), results, completedSteps: completed.steps.length, aiRequests: 0, disposableProfiles: true}, null, 2));
} catch (error) {
  if (panel) { await panel.screenshot('failure').catch(() => {}); console.error('Panel status:', await panel.text('#interactive-audit-status').catch(() => 'unavailable'), await panel.text('#interactive-audit-error').catch(() => '')); }
  throw error;
} finally {
  for (const entry of requests.values()) {clearTimeout(entry.timer); entry.reject(new Error('Test ended'));} requests.clear();
  await context?.close(); await companion.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
