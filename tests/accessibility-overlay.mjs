import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = join(project, 'artifacts');
await mkdir(artifacts, {recursive: true});
const temp = await mkdtemp(join(tmpdir(), 'diffuse-audit-e2e-'));
const extension = join(temp, 'extension');
await cp(join(project, 'extension'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.anthropic.com/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const workerPath = join(extension, 'background.js');
await writeFile(workerPath, (await readFile(workerPath, 'utf8')).replace("import * as reviews from './review-store.mjs';", "import * as reviews from './review-store.mjs';\nglobalThis.__reviews = reviews;"));
const fakeKey = 'sk-ant-test-key-for-isolated-local-fixture';
const requests = [];
let failNext = false;
const results = [];
const pass = message => { results.push(message); console.log(`PASS ${message}`); };
const assets = new Map([['/production.html', 'text/html'], ['/prototype.html', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript']]);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/mock-anthropic' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const images = request.messages[0].content.filter(item => item.type === 'image');
    requests.push({images: images.length, body, headers: req.headers});
    if (failNext) { failNext = false; res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: `Do not expose ${fakeKey}`}})); return; }
    const finding = {category: images.length === 2 ? 'design-mismatch' : 'ux-issue', title: 'Primary action lacks hierarchy', comment: 'The main action competes with adjacent controls.', expected: 'Make the primary action easier to distinguish.', component: 'Primary action', state: 'Current visible screen', severity: 'major', mismatchScore: 85, confidence: 0.93, region: {x: 0.22, y: 0.25, width: 0.25, height: 0.16}};
    const output = JSON.stringify({summary: 'Two candidate observations.', limitations: ['Only the visible screenshot state was reviewed.'], suggestions: [finding, {...finding, title: 'Small spacing inconsistency', mismatchScore: 12, severity: 'minor', confidence: 0.72}]});
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    for (const event of [{type: 'message_start'}, {type: 'content_block_start', content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', delta: {type: 'text_delta', text: output.slice(0, 200)}}, {type: 'content_block_delta', delta: {type: 'text_delta', text: output.slice(200)}}, {type: 'message_delta', delta: {stop_reason: 'end_turn'}}, {type: 'message_stop'}]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end(); return;
  }
  if (!assets.has(pathname)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type': assets.get(pathname), 'Content-Security-Policy': "frame-ancestors 'none'"});
  res.end(await readFile(join(project, 'demo', pathname.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// The disposable copy points to a local response fixture: no API call or paid key is used.
const clientPath = join(extension, 'ai-client.mjs');
await writeFile(clientPath, (await readFile(clientPath, 'utf8')).replace('https://api.anthropic.com/v1/messages', `${origin}/mock-anthropic`));
let context, worker, page, overlay;
// Drive the same command contract as the native drawer; the on-page toolbar is hidden.
async function command(action, payload = {}) {
  const result = await worker.evaluate(async ({action, payload}) => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    if (action === 'toggleRecording') action = session.recording ? 'stopRecording' : 'record';
    return chrome.tabs.sendMessage(session.targetTabId, {namespace: 'diffuse', type: 'PANEL_COMMAND', sessionId: session.id, action, ...payload});
  }, {action, payload});
  assert.equal(result?.ok, true, result?.error);
  return result;
}
async function until(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {executablePath: chromium.executablePath(), headless: true, viewport: null, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000', '--use-mock-keychain', '--password-store=basic']});
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const browserCDP = await context.browser().newBrowserCDPSession();
  page = context.pages()[0]; await page.goto(`${origin}/production.html`);
  const openPopup = async target => {
    await target.bringToFront();
    const {targetInfos} = await browserCDP.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
    await browserCDP.send('Extensions.triggerAction', {id, targetId: targetInfos.find(item => item.url === target.url()).targetId});
    const popup = await context.newPage(); await target.bringToFront(); await popup.goto(`chrome-extension://${id}/popup.html`); return popup;
  };
  let popup = await openPopup(page);
  await popup.locator('#mode-audit').click();
  await popup.locator('#start-comparison').click();
  overlay = page.locator('diffuse-live-overlay');
  await until(() => overlay.locator('#status').textContent({timeout: 1000}).then(text => text === 'Review ready').catch(() => false), 'audit start');
  assert.equal(await overlay.locator('#layer').isVisible(), false);
  assert.equal(await overlay.locator('#source').isVisible(), false);
  pass('Standalone audit starts with one page and no prototype stream');

  const inspect = async () => overlay.evaluate(host => {
    const root=host.shadowRoot;
    const visible=node=>!!node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';
    const text=[...root.querySelectorAll('*')].filter(node=>visible(node)&&[...node.childNodes].some(child=>child.nodeType===3&&child.textContent.trim()));
    return {small:text.filter(node=>parseFloat(getComputedStyle(node).fontSize)<14).map(node=>({id:node.id,font:getComputedStyle(node).fontSize})),buttons:[...root.querySelectorAll('button')].filter(visible).map(node=>({id:node.id,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})),panel:root.querySelector('#ai-panel').getBoundingClientRect().toJSON()};
  });
  let inspection=await inspect();assert.deepEqual(inspection.small,[]);assert.ok(inspection.buttons.every(button=>button.width>=44&&button.height>=44));
  pass('Overlay uses at least 14px text and 44px button targets');
  await command('openAi');
  await until(()=>overlay.locator('#ai-config-status').textContent().then(text=>text.includes('Add your')), 'AI settings response');
  assert.equal(await overlay.locator('#ai-panel').getAttribute('aria-modal'),'true');
  assert.equal(await overlay.locator('#toolbar').evaluate(node=>node.inert),true);
  await overlay.locator('#close-ai').focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await overlay.evaluate(host=>host.shadowRoot.activeElement.id),'ai-settings');
  await page.keyboard.press('Tab');assert.equal(await overlay.evaluate(host=>host.shadowRoot.activeElement.id),'close-ai');
  await page.keyboard.press('Escape');assert.equal(await overlay.locator('#ai-panel').isVisible(),false);assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  pass('AI dialog contains keyboard focus, closes with Escape, without revealing the old toolbar');
  await command('selectArea');
  await page.keyboard.press('Enter');
  for(const [id,value] of Object.entries({'area-x':'340','area-y':'300','area-width':'200','area-height':'100'}))await overlay.locator('#'+id).fill(value);
  await overlay.locator('#area-form button').click();
  await until(()=>overlay.locator('#comment-form').isVisible(),'non-drag area comment');
  assert.match(await overlay.locator('#selection-summary').textContent(),/200 × 100/);
  await overlay.locator('#save-comment').focus();await page.keyboard.press('Tab');assert.equal(await overlay.evaluate(host=>host.shadowRoot.activeElement.id),'close-comment');
  await page.keyboard.press('Shift+Tab');assert.equal(await overlay.evaluate(host=>host.shadowRoot.activeElement.id),'save-comment');
  await overlay.locator('#comment-actual').fill('The area can be selected without dragging.');
  await overlay.locator('#save-comment').click();
  await until(()=>overlay.locator('.comment-pin').count().then(count=>count===1),'accessible area comment pin');
  pass('Area dimensions provide a keyboard and single-pointer alternative to dragging, with a focus-contained composer');
  await command('selectElement');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await until(()=>overlay.locator('#comment-form').isVisible(),'keyboard element capture');
  assert.notEqual(await overlay.locator('#comment-component').inputValue(),'Page');
  await page.keyboard.press('Escape');assert.equal(await overlay.locator('#comment-panel').isVisible(),false);
  pass('Element selection supports arrow keys and Enter without clicking the page');
  const targetId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,page.url());
  await worker.evaluate(async id=>chrome.tabs.setZoom(id,2),targetId);
  await command('openAi');
  await until(()=>overlay.locator('#ai-panel').isVisible(),'zoomed panel');
  inspection=await inspect();assert.deepEqual(inspection.small,[]);
  const vw=await page.evaluate(()=>innerWidth);assert.ok(inspection.panel.width<=vw&&inspection.panel.x>=0);
  assert.equal(await overlay.locator('#ai-panel').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  await page.screenshot({path:join(artifacts,'accessible-overlay-zoom.png')});
  await overlay.locator('#close-ai').click();await worker.evaluate(async id=>chrome.tabs.setZoom(id,1),targetId);
  await page.setViewportSize({width:320,height:900});
  await command('openAi');
  await until(()=>overlay.locator('#ai-panel').isVisible(),'320px panel');
  assert.equal(await overlay.locator('#ai-panel').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  inspection=await inspect();assert.deepEqual(inspection.small,[]);assert.ok(inspection.panel.x>=0&&inspection.panel.right<=321);
  await page.screenshot({path:join(artifacts,'accessible-overlay-narrow.png')});
  pass('Panels reflow at real 200% Chrome zoom and 320 CSS pixels without horizontal overflow');
  await overlay.locator('#close-ai').click();await page.setViewportSize({width:1440,height:1000});
  await command('stop');
  await writeFile(join(artifacts,'accessibility-overlay-results.json'),JSON.stringify({passed:results,scope:'Targeted keyboard, sizing and reflow checks. Not a formal WCAG certification.'},null,2));
} catch(error) {
  if(page&&!page.isClosed())await page.screenshot({path:join(artifacts,'accessibility-overlay-failure.png')}).catch(()=>{});
  throw error;
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
