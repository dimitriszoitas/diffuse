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
const temp = await mkdtemp(join(tmpdir(), 'diffuse-e2e-'));
const extension = join(temp, 'extension');
await cp(join(project, 'extension'), extension, {recursive: true});
// Only the temporary test copy gets pre-granted fixture hosts. Native Chrome
// permission dialogs are deliberately not auto-accepted by browser automation.
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
// Diagnostics exist only in the disposable test copy.
let diagnosticWorker = await readFile(join(extension, 'background.js'), 'utf8');
diagnosticWorker = diagnosticWorker.replace("import * as reviews from './review-store.mjs';", "import * as reviews from './review-store.mjs';\nglobalThis.__reviewStore = reviews;");
for (const [needle, stage] of [['const prepared = await', 'prepare'], ['const referenceContext = await', 'reference-context'], ['const dataUrl = await chrome.tabs.captureVisibleTab', 'screenshot'], ["const {evidence} = await mediaMessage('SNAPSHOT_EVIDENCE'", 'evidence-processing'], ['await reviews.putDraft(draft,', 'draft-storage'], ["await softTabMessage(current.targetTabId, 'RESTORE_EVIDENCE'", 'restore']]) {
  diagnosticWorker = diagnosticWorker.replace(needle, `globalThis.__captureStage = '${stage}'; ${needle}`);
}
await writeFile(join(extension, 'background.js'), diagnosticWorker);
let diagnosticMedia = await readFile(join(extension, 'offscreen.js'), 'utf8');
for (const [needle, stage] of [['const canvas = document.createElement', 'source-canvas'], ['const image = new Image()', 'image-decode'], ['const result = {dataUrl:', 'annotation'], ['return {ok: true, evidence:', 'processed']]) {
  diagnosticMedia = diagnosticMedia.replace(needle, `globalThis.__mediaStage = '${stage}'; ${needle}`);
}
diagnosticMedia = diagnosticMedia.replace('async function receive(message) {', "async function receive(message) { if (message.type === 'TEST_DIAGNOSTICS') return {ok:true,stage:globalThis.__mediaStage,video:sourceVideo ? {ready:sourceVideo.readyState,width:sourceVideo.videoWidth,time:sourceVideo.currentTime}:null};");
await writeFile(join(extension, 'offscreen.js'), diagnosticMedia);
const assets = new Map([['/production.html', 'text/html'], ['/prototype.html', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript']]);
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (!assets.has(pathname)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, {'Content-Type': assets.get(pathname), 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY'});
  response.end(await readFile(join(project, 'demo', pathname.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
let production;
let worker;
let popup;
const results = [];
const record = label => { results.push(label); console.log(`PASS ${label}`); };

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
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    executablePath: chromium.executablePath(), headless: process.env.DIFFUSE_HEADED !== '1', viewport: null,
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000', '--use-mock-keychain', '--password-store=basic']
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const browserCDP = await context.browser().newBrowserCDPSession();
  const source = context.pages()[0];
  production = await context.newPage();
  await production.goto(`${origin}/production.html`);
  await source.goto(`${origin}/prototype.html`);
  await production.evaluate(() => window.scrollTo(0, 280));
  await source.bringToFront();
  const {targetInfos} = await browserCDP.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const sourceTarget = targetInfos.find(target => target.url === source.url());
  await browserCDP.send('Extensions.triggerAction', {id: extensionId, targetId: sourceTarget.targetId});
  // Keep a regular extension page available for stable popup UI automation.
  popup = await context.newPage();
  await source.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(() => popup.locator('#source-url').textContent().then(text => text.includes('prototype.html')), 'source selection');
  const targetTabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, production.url());
  await popup.locator('#target-tab').selectOption(String(targetTabId));
  await popup.locator('#popup').screenshot({path: join(artifacts, 'popup.png')});
  await popup.locator('#start-comparison').click();
  const overlay = production.locator('diffuse-live-overlay');
  await until(async () => {
    if (!popup.isClosed()) {
      const feedback = await popup.locator('#feedback').textContent();
      if (feedback) throw new Error(`Popup: ${feedback}`);
    }
    return (await overlay.count()) > 0;
  }, 'overlay injection');
  await overlay.waitFor({timeout: 15000});
  await until(() => overlay.locator('#status').textContent().then(text => text === 'Live'), 'live stream', 25000);
  await until(() => overlay.locator('#reference').evaluate(video => video.videoWidth > 0 && video.readyState >= 2), 'decoded stream');
  record('Real Chrome action grant, source capture, local WebRTC, and live production overlay');
  await until(() => source.evaluate(() => scrollY === 280), 'initial scroll alignment');
  await production.evaluate(() => window.scrollTo(0, 0));
  await until(() => source.evaluate(() => scrollY === 0), 'initial reset alignment');
  record('Starting on an already-scrolled production page aligns the prototype immediately');
  await production.screenshot({path: join(artifacts, 'live-comparison.png')});
  const dimensions = await overlay.locator('#reference').evaluate(video => ({width: video.videoWidth, height: video.videoHeight, cssWidth: parseInt(video.style.width), cssHeight: parseInt(video.style.height)}));
  const sourceDimensions = await source.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio}));
  assert.equal(dimensions.cssWidth, sourceDimensions.width);
  assert.equal(dimensions.cssHeight, sourceDimensions.height);
  assert.ok(Math.abs(dimensions.width - sourceDimensions.width * sourceDimensions.dpr) <= 2, JSON.stringify(dimensions));
  assert.ok(Math.abs(dimensions.height - sourceDimensions.height * sourceDimensions.dpr) <= 2, JSON.stringify(dimensions));
  record('Source size preserved, with at most two device pixels of codec rounding');

  const pixel = () => overlay.locator('#reference').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    return [...ctx.getImageData(5, 5, 1, 1).data];
  });
  await source.evaluate(() => {
    const marker = document.createElement('div'); marker.id = 'diffuse-test-marker';
    marker.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;background:rgb(255,0,0);z-index:2147483647';
    document.documentElement.append(marker);
  });
  await until(async () => { const p = await pixel(); return p[0] > 200 && p[2] < 60; }, 'red background frame');
  await source.evaluate(() => { document.querySelector('#diffuse-test-marker').style.background = 'rgb(0,0,255)'; });
  await until(async () => { const p = await pixel(); return p[2] > 200 && p[0] < 60; }, 'blue background frame');
  await source.evaluate(() => document.querySelector('#diffuse-test-marker').remove());
  record('A changing background prototype updates the stream without tab switching');

  await command('settings', {settings: {opacity: .3}});
  await until(() => overlay.locator('#layer').evaluate(layer => layer.style.opacity === '0.3'), 'opacity');
  await overlay.locator('#handle').focus(); await production.keyboard.press('Home');
  await until(() => overlay.locator('#layer').evaluate(layer => layer.style.clipPath.includes('0%')), 'reveal');
  await command('settings', {settings: {hidden: true}});
  assert.equal(await overlay.locator('#layer').isVisible(), false);
  await command('settings', {settings: {hidden: false}});
    await command('settings', {settings: {offsetX: 14}});
  await until(() => overlay.locator('#reference').evaluate(video => video.style.transform.includes('14px')), 'alignment');
  await command('settings', {settings: {offsetX: 0, offsetY: 0}});
    record('Opacity, keyboard reveal, hide/show, and alignment controls');

  await command('settings', {settings: {linked: true}});
  await production.evaluate(() => window.scrollTo(0, 340));
  await until(() => source.evaluate(() => Math.abs(scrollY - 340) < 2), 'linked root scroll');
  await production.locator('[data-diffuse-scroll="activity"]').evaluate(element => { element.scrollTop = 180; });
  await until(() => source.locator('[data-diffuse-scroll="activity"]').evaluate(element => element.scrollTop === 180), 'linked nested scroll');
  await command('settings', {settings: {linked: false}});
  await new Promise(resolve => setTimeout(resolve, 200));
  await production.evaluate(() => window.scrollTo(0, 500));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await source.evaluate(() => scrollY), 340);
  await command('settings', {settings: {linked: true}});
  await production.evaluate(() => window.scrollTo(0, 0));
  await until(() => source.evaluate(() => scrollY === 0), 'return root scroll');
  record('Root and matching nested scrolling, with independent-scroll fallback');

  await production.locator('#period-toggle').click();
  assert.equal(await production.locator('#period-menu').isVisible(), true);
  assert.equal(await source.locator('#period-menu').isVisible(), false);
  await production.keyboard.press('Escape');
  record('Page interaction stays with production and does not replay clicks into the prototype');

  await production.locator('#new-project').click();
  assert.equal(await production.locator('#project-dialog').isVisible(), true);
  await until(() => production.locator('diffuse-live-overlay').evaluate(host => host.parentElement.matches('dialog:modal') && host.matches(':popover-open')), 'modal layering');
  await command('settings', {settings: {hidden: true}});
  await command('settings', {settings: {hidden: false}});
  await production.locator('#project-name').fill('Live modal comparison');
  await production.screenshot({path: join(artifacts, 'modal-comparison.png')});
  await production.locator('#cancel-dialog').click();
  await until(() => production.locator('diffuse-live-overlay').evaluate(host => host.parentElement === document.documentElement), 'modal close recovery');
  record('Native modal remains interactive and comparison controls stay above it');

  const pageCDP = await context.newCDPSession(production);
  const {windowId} = await pageCDP.send('Browser.getWindowForTarget');
  await browserCDP.send('Browser.setWindowBounds', {windowId, bounds: {width: 1280, height: 900}});
  await until(() => production.locator('diffuse-live-overlay #warning').textContent().then(text => text.includes('Viewports differ')), 'viewport mismatch warning');
  const sourceCDP = await context.newCDPSession(source);
  const sourceWindow = await sourceCDP.send('Browser.getWindowForTarget');
  await browserCDP.send('Browser.setWindowBounds', {windowId: sourceWindow.windowId, bounds: {width: 1280, height: 900}});
  await source.bringToFront();
  await until(() => source.evaluate(() => innerWidth === 1280), 'source resize');
  await production.bringToFront();
  await until(() => production.locator('diffuse-live-overlay #reference').evaluate(video => parseInt(video.style.width) === 1280 && Math.abs(video.videoWidth - 1280) <= 2), 'capture resize');
  await source.evaluate(() => {
    const marker = document.createElement('div'); marker.id = 'diffuse-resize-marker';
    marker.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;background:rgb(0,0,255);z-index:2147483647';
    document.documentElement.append(marker);
  });
  await until(async () => { const p = await pixel(); return p[2] > 200 && p[0] < 60; }, 'live pixels after resize');
  await source.evaluate(() => document.querySelector('#diffuse-resize-marker').remove());
  record('Window resizing updates both source metrics and the live capture resolution');

  await production.reload();
  await until(() => production.locator('diffuse-live-overlay #status').textContent({timeout: 1000}).then(text => text === 'Live').catch(() => false), 'production reload recovery', 25000);
  await until(() => production.locator('diffuse-live-overlay #reference').evaluate(video => video.videoWidth > 0 && video.readyState >= 2), 'reloaded video');
  record('Production reload reconnects to the existing capture');
  await production.evaluate(() => window.scrollTo(0, 320));
  await until(() => source.evaluate(() => scrollY === 320), 'pre-reload scroll');
  await source.evaluate(() => window.scrollTo(0, 0));
  await source.reload();
  await until(() => production.locator('diffuse-live-overlay #status').textContent().then(text => text === 'Live'), 'prototype reload recovery');
  await until(() => source.evaluate(() => Boolean(globalThis.__diffuseLiveController) === false), 'isolated content remains separate');
  await until(() => source.evaluate(() => scrollY === 320), 'source reload scroll resync');
  record('Prototype reload resumes comparison');
  await production.screenshot({path: join(artifacts, 'verified-live-comparison.png')});

  await production.evaluate(() => window.scrollTo(0, 0));
  await until(() => source.evaluate(() => scrollY === 0), 'evidence scroll alignment');
  await production.locator('#new-project').evaluate(element => element.dataset.component = 'CreateProjectButton');
  await command('selectElement');
  await production.locator('#new-project').click();
  assert.equal(await production.locator('#project-dialog').isVisible(), false);
  await until(() => overlay.locator('#capture-retry').isVisible(), 'capture permission explanation');
  assert.match(await overlay.locator('#capture-retry-description').textContent(), /Chrome|toolbar|Diffuse/);
  record('Picker suppresses the selected app action and explains missing capture permission');

  const productionTargets = await browserCDP.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const productionTarget = productionTargets.targetInfos.find(target => target.url === production.url());
  await browserCDP.send('Extensions.triggerAction', {id: extensionId, targetId: productionTarget.targetId});
  popup = await context.newPage();
  await production.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#enable-capture').waitFor({state: 'visible'});
  await popup.locator('#enable-capture').click();
  await until(() => overlay.locator('#comment-form').isVisible(), 'permission retry and paired capture');
  assert.equal(await overlay.locator('#comment-component').inputValue(), 'CreateProjectButton');
  await until(() => overlay.locator('#production-preview').evaluate(image => image.complete && image.naturalWidth > 0), 'production screenshot');
  await until(() => overlay.locator('#prototype-preview').evaluate(image => image.complete && image.naturalWidth > 0), 'prototype screenshot');
  await overlay.locator('#comment-title').fill('Create project button spacing');
  await overlay.locator('#comment-actual').fill('The button is too tall and sits below the heading.');
  await overlay.locator('#comment-expected').fill('Match the prototype height and baseline.');
  await overlay.locator('#comment-state').fill('Dashboard / default');
  await overlay.locator('#comment-steps').fill('Open the dashboard. Compare the Create project button.');
  await overlay.locator('#comment-severity').selectOption('major');
  await production.screenshot({path: join(artifacts, 'comment-composer.png')});
  await overlay.locator('#save-comment').click();
  await until(() => overlay.locator('#comment-panel').isVisible().then(visible => !visible), 'comment save');
  const reviewId = await worker.evaluate(async () => (await chrome.storage.session.get('comparison')).comparison.reviewId);
  const reviewSummary = () => worker.evaluate(async id => {
    const {getReview} = globalThis.__reviewStore;
    const review = await getReview(id);
    return {count: review.count, comments: await Promise.all(review.comments.map(async comment => ({
      id: comment.id, fields: comment.fields, selection: comment.selection, context: comment.context,
      images: {production: comment.evidence.production.width, prototype: comment.evidence.prototype.width, crop: !!comment.evidence.production.cropDataUrl},
      hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(comment.evidence.production.dataUrl)))].join(','),
      video: comment.evidence.video ? {...comment.evidence.video, dataUrl: undefined} : null
    })))};
  }, reviewId);
  let summary = await reviewSummary();
  assert.equal(summary.count, 1);
  assert.equal(summary.comments[0].selection.component.name, 'CreateProjectButton');
  assert.equal(summary.comments[0].selection.selector, '#new-project');
  assert.ok(summary.comments[0].selection.styles.fontSize);
  assert.equal(typeof summary.comments[0].selection.states.disabled, 'boolean');
  assert.equal(summary.comments[0].context.production.url, production.url());
  assert.ok(summary.comments[0].images.production > 0 && summary.comments[0].images.prototype > 0 && summary.comments[0].images.crop);
  const originalEvidenceHash = summary.comments[0].hash;
  record('Comment saves paired screenshots, annotated crop, component, selector, styles, state, and page context');

  await command('toggleRecording');
  await until(() => overlay.locator('#record').textContent().then(text => text.includes('Stop')), 'recording start');
  await production.locator('#new-project').click();
  await production.locator('#project-name').fill('Recorded state transition');
  await new Promise(resolve => setTimeout(resolve, 1600));
  await production.locator('#cancel-dialog').click();
  await command('toggleRecording');
  await until(() => overlay.locator('#comment-form').isVisible(), 'recording composer');
  await overlay.locator('#comment-title').fill('Dialog entrance and spacing');
  await overlay.locator('#comment-actual').fill('The dialog transition and input spacing differ.');
  await overlay.locator('#comment-state').fill('Create project / open then closed');
  await overlay.locator('#save-comment').click();
  await until(() => overlay.locator('#comment-panel').isVisible().then(visible => !visible), 'recording save');
  summary = await reviewSummary();
  assert.equal(summary.count, 2);
  assert.ok(summary.comments[1].video.bytes > 1000);
  assert.ok(summary.comments[1].video.durationMs >= 1500);
  assert.equal(summary.comments[1].video.kind, 'comparison-recording');
  record('Real silent WebM recording captures interactions and attaches to a comment with paired screenshots');

  const reportPagePromise = context.waitForEvent('page');
  await command('openReport');
  const reportPage = await reportPagePromise;
  await reportPage.waitForLoadState();
  await until(() => reportPage.locator('.comment-card').count().then(count => count === 2), 'saved review report');
  await until(() => reportPage.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'playable report recording');
  await reportPage.screenshot({path: join(artifacts, 'review-report.png'), fullPage: true});
  await reportPage.locator('.comment-card').first().getByRole('button', {name: 'Edit observation'}).click();
  await reportPage.locator('#edit-form [name="comment"]').fill('Updated feedback with the original evidence retained.');
  await reportPage.locator('#save-comment').click();
  await until(() => reportPage.locator('#edit-dialog').isVisible().then(visible => !visible), 'report edit');
  summary = await reviewSummary();
  assert.equal(summary.comments[0].fields.comment, 'Updated feedback with the original evidence retained.');
  assert.equal(summary.comments[0].hash, originalEvidenceHash);
  record('Review edits preserve the original capture and recorded evidence');

  await reportPage.bringToFront();
  await reportPage.locator('#copy-report').click();
  await until(() => reportPage.locator('#notice').textContent().then(text => text.includes('Report copied with screenshots')), 'rich clipboard export');
  await context.grantPermissions(['clipboard-read']);
  const clipboard = await reportPage.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find(item => item.types.includes('text/html'));
    return item ? {types: item.types, html: await (await item.getType('text/html')).text()} : null;
  });
  assert.ok(clipboard?.types.includes('text/plain'));
  assert.match(clipboard.html, /data:image\/png;base64,/);
  assert.match(clipboard.html, /Updated feedback/);
  assert.match(clipboard.html, /\.webm/);
  record('Copy entire report writes rich HTML and plain text, with embedded screenshots and clip references');

  const downloadPromise = reportPage.waitForEvent('download');
  await reportPage.locator('#download-html').click();
  const download = await downloadPromise;
  const exportedPath = join(artifacts, 'example-review.html');
  await download.saveAs(exportedPath);
  const exported = await readFile(exportedPath, 'utf8');
  assert.match(exported, /data:image\/png;base64,/);
  assert.match(exported, /data:video\/webm/);
  const offline = await context.newPage();
  const externalRequests = [];
  offline.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await offline.goto(`file://${exportedPath}`);
  await until(() => offline.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'offline recording decode');
  assert.equal(await offline.locator('.comment-card').count(), 2);
  assert.equal(externalRequests.length, 0);
  await offline.close();
  record('Downloaded report opens offline with embedded screenshots and a playable recording');

  reportPage.once('dialog', dialog => dialog.accept());
  await reportPage.locator('.comment-card').last().getByRole('button', {name: 'Delete', exact: true}).click();
  await until(() => reportPage.locator('.comment-card').count().then(count => count === 1), 'delete comment');
  assert.equal((await reviewSummary()).count, 1);
  record('Comment deletion updates persistent review counts');
  await production.bringToFront();
  await command('toggleRecording');
  await until(() => overlay.locator('#record').textContent().then(text => text.includes('Stop')), 'automatic recording start');
  const deleteWhileRecording = await reportPage.evaluate(reviewId => chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type: 'DELETE_REVIEW', reviewId}), reviewId);
  assert.equal(deleteWhileRecording.ok, false);
  assert.match(deleteWhileRecording.error, /Stop the recording/);
  await production.reload();
  await until(() => overlay.locator('#record').textContent({timeout: 1000}).then(text => text.includes('Stop')).catch(() => false), 'recording reload recovery');
  await until(() => overlay.locator('#comment-form').isVisible(), '30-second automatic stop', 35000);
  assert.match(await overlay.locator('#composer-title').textContent(), /recording/);
  await production.reload();
  await until(() => overlay.locator('#comment-form').isVisible(), 'pending recording draft reload recovery');
  await overlay.locator('#comment-title').fill('Automatic recording limit');
  await overlay.locator('#comment-actual').fill('Evidence is retained after navigating during and after recording.');
  await overlay.locator('#comment-state').fill('Dashboard / reload');
  await overlay.locator('#save-comment').click();
  await until(() => overlay.locator('#comment-panel').isVisible().then(visible => !visible), 'automatic recording save');
  summary = await reviewSummary();
  assert.equal(summary.count, 2);
  assert.equal(summary.comments[1].video.stopReason, 'time-limit');
  assert.ok(summary.comments[1].video.durationMs >= 29500 && summary.comments[1].video.durationMs < 35000);
  record('Recording survives page reload, stops at 30 seconds, restores its draft after reload, and prevents review deletion while active');
  await command('stop');
  await until(() => production.locator('diffuse-live-overlay').count().then(count => count === 0), 'overlay cleanup');
  await until(() => worker.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).every(tab => tab.status !== 'active')), 'capture cleanup');
  record('Stop removes the overlay and releases tab capture');
  await reportPage.reload();
  await until(() => reportPage.locator('.comment-card').count().then(count => count === 2), 'review persistence');
  assert.match(await reportPage.locator('.comment-card').first().textContent(), /Updated feedback/);
  assert.equal((await reviewSummary()).comments[0].hash, originalEvidenceHash);
  record('Review and original screenshot survive stopping the comparison and reloading the report');
  await writeFile(join(artifacts, 'test-results.json'), JSON.stringify({passed: results, dimensions, sourceDimensions, nativePermissionDialog: 'Not automated; temporary test copy pre-grants fixture origins.'}, null, 2));
} catch (error) {
  if (production && !production.isClosed()) console.error('Page diagnostics:', await production.locator('diffuse-live-overlay').evaluate(async host => ({visibility: document.visibilityState, focus: document.hasFocus(), frames: await Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))), new Promise(resolve => setTimeout(() => resolve(false), 1200))]), hidden: host.hasAttribute('data-evidence-hidden'), error: host.shadowRoot?.querySelector('#comment-error')?.textContent})).catch(() => null));
  if (worker) console.error('Capture diagnostics:', await worker.evaluate(async () => ({stage: globalThis.__captureStage, activeTabs: (await chrome.tabs.query({active: true})).map(tab => ({id:tab.id,url:tab.url})), contexts: await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})})).catch(() => null));
  if (worker) console.error('Media diagnostics:', await worker.evaluate(() => chrome.runtime.sendMessage({namespace:'diffuse',target:'offscreen',type:'TEST_DIAGNOSTICS'})).catch(() => null));
  if (popup && !popup.isClosed()) await popup.screenshot({path: join(artifacts, 'popup-failure.png')}).catch(() => {});
  if (production && !production.isClosed()) await production.screenshot({path: join(artifacts, 'test-failure.png')}).catch(() => {});
  if (worker) console.error('Session:', await worker.evaluate(() => chrome.storage.session.get('comparison')).catch(() => null));
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, {recursive: true, force: true});
}
