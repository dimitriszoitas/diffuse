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
  await page.keyboard.down('c');
  await page.mouse.move(340, 300); await page.mouse.down(); await page.mouse.move(620, 420, {steps: 8});
  assert.equal(await overlay.locator('#selection-outline').evaluate(element => getComputedStyle(element).borderTopStyle), 'dotted');
  await page.screenshot({path: join(artifacts, 'area-selection.png')});
  await page.mouse.up(); await page.keyboard.up('c');
  await until(() => overlay.locator('#comment-form').isVisible(), 'region evidence composer');
  assert.equal(await overlay.locator('#comment-category').inputValue(), 'ux-issue');
  assert.equal(await overlay.locator('#comment-title').getAttribute('required'), null);
  assert.equal(await overlay.locator('#comment-expected').inputValue(), '');
  assert.equal(await overlay.locator('#evidence-screenshot').getAttribute('aria-pressed'), 'true');
  await overlay.locator('#comment-actual').fill('This selected region needs clearer labels.');
  await overlay.locator('#comment-category').selectOption('copy-change');
  await overlay.locator('#comment-state').fill('Dashboard default');
  await overlay.locator('#save-comment').click();
  await until(() => overlay.locator('.comment-pin').count().then(count => count === 1), 'saved region pin');
  const reviewId = await worker.evaluate(async () => (await chrome.storage.session.get('comparison')).comparison.reviewId);
  const summaries = () => worker.evaluate(async id => {
    const review = await globalThis.__reviews.getReview(id);
    return {mode:review.mode,count:review.count,comments:review.comments.map(item=>({id:item.id,fields:item.fields,selection:item.selection,ai:item.ai,hasPrototype:!!item.evidence.prototype,hasVideo:!!item.evidence.video}))};
  }, reviewId);
  let review = await summaries();
  assert.equal(review.comments[0].fields.title, ''); assert.equal(review.comments[0].fields.expected, '');
  assert.equal(await overlay.locator('.comment-pin').evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(155, 213, 255)');
  assert.match(await overlay.locator('.comment-pin').getAttribute('aria-label'), /Copy change/);
  assert.equal(review.mode, 'audit'); assert.equal(review.comments[0].selection.kind, 'region'); assert.equal(review.comments[0].selection.rect.viewport.width, 280); assert.equal(review.comments[0].fields.category, 'copy-change'); assert.equal(review.comments[0].hasPrototype, false);
  await overlay.locator('.comment-pin').click();
  assert.equal(await overlay.locator('#saved-comment-bubble').isVisible(), true);
  assert.match(await overlay.locator('#saved-comment-text').textContent(), /clearer labels/);
  await page.screenshot({path: join(artifacts, 'audit-comment-pins.png')});
  const before = await overlay.locator('.comment-pin').boundingBox();
  await page.evaluate(() => window.scrollTo(0, 120));
  await until(async () => Math.abs((await overlay.locator('.comment-pin').boundingBox()).y - before.y + 120) < 2, 'pin scroll anchoring');
  await page.evaluate(() => window.scrollTo(0, 0));
  await overlay.locator('#close-saved-comment').click();
  await page.reload();
  await until(() => overlay.locator('.comment-pin').count().then(count => count === 1), 'pin reload recovery');
  pass('C + drag creates a dotted region, captures single-page evidence, saves its category, and opens a persistent anchored comment bubble');
  await command('openAi');
  await until(() => overlay.locator('#ai-config-status').textContent().then(text => text.includes('Add your')), 'missing key explanation');
  const settingsPromise = context.waitForEvent('page');
  await overlay.locator('#ai-settings').click();
  const settings = await settingsPromise; await settings.waitForLoadState();
  await settings.locator('#api-key').fill(fakeKey);
  assert.equal(await settings.locator('#remember-key').isChecked(), false);
  await settings.locator('#save').click();
  await until(() => settings.locator('#feedback').textContent().then(text => text.includes('Settings saved')), 'AI key save');
  assert.equal(await settings.locator('#api-key').inputValue(), '');
  const safeStorage = await worker.evaluate(async () => ({remembered: !!(await chrome.storage.local.get('anthropicApiKey')).anthropicApiKey, temporary: !!(await chrome.storage.session.get('anthropicApiKey')).anthropicApiKey}));
  assert.deepEqual(safeStorage, {remembered: false, temporary: true});
  assert.equal(requests.length, 0);
  pass('AI settings stores a key only for the browser session by default and makes no automatic API request');
  await page.bringToFront(); await overlay.locator('#close-ai').click(); await command('openAi');
  await until(() => overlay.locator('#ai-run').isEnabled(), 'configured AI reviewer');
  await overlay.locator('#ai-instructions').fill('Review hierarchy and visible copy clarity.');
  await overlay.locator('#ai-run').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 1), 'threshold-filtered AI suggestions');
  assert.equal(requests.length, 1); assert.equal(requests[0].images, 1); assert.equal(requests[0].headers['x-api-key'], fakeKey);
  assert.equal(requests[0].body.includes(fakeKey), false);
  assert.equal((await summaries()).count, 1);
  await overlay.locator('#ai-threshold').fill('90');
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 0), 'high threshold hides both AI suggestions');
  const filteredResults = await overlay.locator('#ai-suggestions').textContent();
  assert.match(filteredResults, /2[\s\S]{0,180}(?:hidden|below)/i, 'The empty result explains that two existing suggestions are filtered out');
  assert.equal(await overlay.locator('#ai-show-all').isVisible(), true);
  assert.match(await overlay.locator('#ai-show-all').textContent(), /Show all 2 suggestions/i);
  assert.equal(requests.length, 1, 'Changing the result filter must not request another AI review');
  assert.equal((await summaries()).count, 1, 'Filtered suggestions must remain pending');
  await page.screenshot({path: join(artifacts, 'ai-review-filtered.png')});
  await overlay.locator('#ai-show-all').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 2), 'Show all reveals both existing AI suggestions');
  assert.equal(await overlay.locator('#ai-threshold').inputValue(), '0');
  assert.equal(requests.length, 1, 'Show all must reveal the existing result without an API request');
  assert.equal((await summaries()).count, 1, 'Show all must not accept suggestions or create comments');
  await overlay.locator('#close-ai').click();
  await command('openAi');
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 2), 'Show all filter survives reopening the panel');
  assert.equal(await overlay.locator('#ai-threshold').inputValue(), '0');
  assert.equal(requests.length, 1, 'Reopening the existing review must not make another API request');
  assert.equal((await summaries()).count, 1, 'Reopening the review must not accept its suggestions');
  pass('A high filter explains hidden suggestions; Show all reveals them without another API request or adding comments');
  pass('Show all remains selected after closing and reopening the AI panel');
  await page.screenshot({path: join(artifacts, 'ai-review-queue.png')});
  await overlay.locator('.ai-suggestion').first().locator('[data-action="accept"]').click();
  await until(async () => (await summaries()).count === 2, 'accept AI finding');
  review = await summaries(); assert.equal(review.comments[1].ai.mismatchScore, 85); assert.equal(review.comments[1].ai.confidence, 0.93); assert.equal(review.comments[1].fields.category, 'ux-issue');
  await overlay.locator('.ai-suggestion [data-action="dismiss"]').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 0), 'dismiss low score finding');
  assert.equal((await summaries()).count, 2);
  assert.equal(await overlay.locator('.comment-pin').count(), 2);
  assert.equal(await overlay.locator('.comment-pin').nth(1).evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(255, 210, 138)');
  pass('AI findings stay pending, threshold changes reveal minor issues, acceptance creates one pin, and dismissal creates no comment');
  failNext = true;
  await overlay.locator('#ai-run').click();
  await until(() => overlay.locator('#ai-error').textContent().then(text => text.includes('rejected')), 'provider authentication error');
  assert.equal((await overlay.locator('#ai-error').textContent()).includes(fakeKey), false);
  assert.equal((await summaries()).count, 2);
  pass('Provider failures expose no key and never add comments');
  await overlay.locator('#close-ai').click();
  await command('selectArea');
  await page.mouse.move(700, 280); await page.mouse.down(); await page.mouse.move(880, 380, {steps: 6}); await page.mouse.up();
  await until(() => overlay.locator('#comment-form').isVisible(), 'recording region composer');
  await overlay.locator('#comment-actual').fill('Review this recorded state.');
  await overlay.locator('#comment-steps').fill('Open the panel, then close it.');
  await overlay.locator('#comment-category').selectOption('design-mismatch');
  await overlay.locator('#evidence-recording').click();
  await page.screenshot({path:join(artifacts,'comment-evidence-choice.png')});
  await overlay.locator('#save-comment').click();
  assert.match(await overlay.locator('#comment-error').textContent(), /Record a short clip/);
  await worker.evaluate(() => {
    globalThis.__originalMediaId = chrome.tabCapture.getMediaStreamId;
    globalThis.__mediaCalls = 0;
    chrome.tabCapture.getMediaStreamId = async () => { globalThis.__mediaCalls++; throw new Error('activeTab permission is required'); };
  });
  await overlay.locator('#comment-record').click();
  await until(()=>overlay.locator('#comment-error').textContent().then(text=>text.includes('Enable capture')), 'composer recording permission failure');
  assert.equal(await overlay.locator('#comment-actual').inputValue(), 'Review this recorded state.');
  await overlay.locator('#evidence-screenshot').click();
  await worker.evaluate(async () => {
    const session=(await chrome.storage.session.get('comparison')).comparison;
    await chrome.tabs.sendMessage(session.targetTabId,{namespace:'diffuse',type:'CAPTURE_ACCESS_GRANTED',sessionId:session.id});
  });
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(await worker.evaluate(()=>globalThis.__mediaCalls),1);
  assert.equal(await overlay.locator('#evidence-screenshot').getAttribute('aria-pressed'),'true');
  await worker.evaluate(()=>{chrome.tabCapture.getMediaStreamId=globalThis.__originalMediaId;});
  pass('Recording permission failure retains the comment and choosing Screenshot cancels its pending retry');
  await overlay.locator('#evidence-recording').click();
  await overlay.locator('#comment-record').click();
  await until(() => overlay.locator('#record').textContent().then(text => text.includes('Stop recording')), 'composer recording');
  assert.equal(await overlay.locator('#comment-panel').isVisible(), false);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await page.reload();
  await until(() => overlay.locator('#record').isEnabled().catch(()=>false), 'recording stop after reload');
  await command('toggleRecording');
  await until(() => overlay.locator('#comment-form').isVisible(), 'composer recording restored');
  assert.equal(await overlay.locator('#comment-actual').inputValue(), 'Review this recorded state.');
  assert.equal(await overlay.locator('#comment-title').inputValue(), '');
  assert.equal(await overlay.locator('#comment-steps').inputValue(), 'Open the panel, then close it.');
  assert.equal(await overlay.locator('#comment-category').inputValue(), 'design-mismatch');
  assert.match(await overlay.locator('#selection-summary').textContent(), /180 × 100/);
  assert.equal(await overlay.locator('#recording-preview').isVisible(), true);
  await until(()=>overlay.locator('#recording-preview').evaluate(el=>el.readyState>=1),'recording preview decodes');
  await page.screenshot({path:join(artifacts,'comment-recording-preview.png')});
  await worker.evaluate(async()=>{
    const session=(await chrome.storage.session.get('comparison')).comparison;
    const draft=await globalThis.__reviews.getDraft(session.pendingDraftId);
    await chrome.tabs.sendMessage(session.targetTabId,{namespace:'diffuse',type:'RECORDING_STOPPED',sessionId:session.id,draft,error:'The new recording could not be encoded.'});
  });
  assert.match(await overlay.locator('#comment-error').textContent(),/previous clip is still attached/);
  assert.equal(await overlay.locator('#recording-preview').isVisible(),true);
  pass('Failed re-recording displays its error while preserving the previous playable clip');
  await overlay.locator('#evidence-screenshot').click();
  assert.equal(await overlay.locator('#recording-preview').isVisible(), false);
  await overlay.locator('#evidence-recording').click();
  assert.equal(await overlay.locator('#recording-preview').isVisible(), true);
  await overlay.locator('#save-comment').click();
  await until(async () => (await summaries()).count === 3, 'composer recording save');
  assert.equal((await summaries()).comments[2].hasVideo, true);
  assert.equal((await summaries()).comments[2].selection.kind, 'region');
  assert.equal((await summaries()).comments[2].fields.title, '');
  pass('Composer recording preserves optional fields, selected region and entered text through reload, with a playable preview');
  await command('toggleRecording');
  await until(() => overlay.locator('#record').textContent().then(text=>text.includes('Stop recording')), 'second recording');
  await new Promise(resolve=>setTimeout(resolve,900));
  await command('toggleRecording');
  await until(()=>overlay.locator('#comment-form').isVisible(),'second clip composer');
  await overlay.locator('#comment-actual').fill('Only the screenshot is needed for this comment.');
  await overlay.locator('#evidence-screenshot').click();
  await overlay.locator('#save-comment').click();
  await until(async()=>(await summaries()).count===4,'screenshot-only save');
  assert.equal((await summaries()).comments[3].hasVideo,false);
  pass('Choosing Screenshot excludes the recorded clip from the saved comment');
  const reportPromise = context.waitForEvent('page'); await command('openReport');
  const report = await reportPromise; await report.waitForLoadState();
  await until(() => report.locator('.comment-card').count().then(count => count === 4), 'audit report');
  assert.match(await report.locator('#report-content').textContent(), /Copy change/);
  const downloadPromise = report.waitForEvent('download'); await report.locator('#download-html').click();
  const download = await downloadPromise; const path = join(artifacts, 'example-audit.html'); await download.saveAs(path);
  const exported = await readFile(path, 'utf8'); assert.match(exported, /data:image\/png/); assert.match(exported, /data:video\/webm/); assert.equal(exported.includes(fakeKey), false); assert.equal(exported.includes('Small spacing inconsistency'), false); assert.match(exported, /85/);
  pass('Audit report exports categories, only accepted AI findings, screenshots and video without credentials');
  await page.bringToFront(); await command('stop'); await until(() => overlay.count().then(count => count === 0), 'stop audit');
  const source = await context.newPage(); await source.goto(`${origin}/prototype.html`);
  popup = await openPopup(source);
  const targetTabId = await worker.evaluate(async url => (await chrome.tabs.query({url}))[0].id, page.url());
  await popup.locator('#target-tab').selectOption(String(targetTabId)); await popup.locator('#start-comparison').click();
  await until(() => overlay.locator('#status').textContent({timeout:1000}).then(text=>text==='Live').catch(()=>false), 'comparison restored', 25000);
  await command('openAi'); await until(() => overlay.locator('#ai-run').isEnabled(), 'comparison AI config'); await overlay.locator('#ai-run').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count => count === 1), 'two-screen AI result');
  assert.equal(requests.at(-1).images, 2);
  const requestsBeforeBulk = requests.length;
  const comparisonSnapshot = () => worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    const batch = await globalThis.__reviews.getDraft(session.aiBatchId);
    const review = await globalThis.__reviews.getReview(session.reviewId);
    return {
      batchId: batch.id, model: batch.aiBatch.model, count: review.count,
      suggestions: batch.aiBatch.suggestions.map(item => ({id:item.id, score:item.mismatchScore, status:item.status})),
      comments: review.comments.map(item => ({id:item.id, category:item.fields.category, selection:item.selection.kind, ai:item.ai,
        originalProduction: item.evidence.production.dataUrl === batch.evidence.production.dataUrl,
        originalPrototype: item.evidence.prototype?.dataUrl === batch.evidence.prototype?.dataUrl,
        hasPrototype: !!item.evidence.prototype?.dataUrl,
        annotatedProduction: /^data:image\/png;base64,/.test(item.evidence.production.annotatedDataUrl || ''),
        originalCaptureTime: item.evidence.production.capturedAt === batch.evidence.production.capturedAt,
      })),
    };
  });
  const beforeBulk = await comparisonSnapshot();
  assert.equal(beforeBulk.count, 0);
  await overlay.locator('#ai-threshold').fill('35');
  assert.equal(await overlay.locator('.ai-suggestion').count(), 1);
  assert.equal(await overlay.locator('#ai-accept-all').textContent(), 'Accept all shown (1)');
  await page.screenshot({path: join(artifacts, 'ai-bulk-accept.png')});
  await overlay.locator('#ai-accept-all').click();
  await until(() => overlay.locator('.comment-pin').count().then(count=>count===1), 'bulk acceptance of only the visible mismatch');
  await until(() => overlay.locator('#ai-show-all').isEnabled().catch(()=>false), 'remaining hidden suggestion can be revealed');
  const firstBulk = await comparisonSnapshot();
  assert.equal(firstBulk.count, 1);
  assert.deepEqual(firstBulk.suggestions.filter(item=>item.status==='pending').map(item=>item.score), [12]);
  assert.equal(firstBulk.comments[0].ai.mismatchScore, 85);
  assert.equal(await overlay.locator('.ai-suggestion').count(), 0);
  assert.match(await overlay.locator('#ai-results-status').textContent(), /1[\s\S]{0,180}hidden/i);
  assert.equal(requests.length, requestsBeforeBulk, 'Accepting shown suggestions must not request a new review');
  await overlay.locator('#ai-show-all').click();
  await until(() => overlay.locator('.ai-suggestion').count().then(count=>count===1), 'remaining low-score suggestion');
  assert.equal(await overlay.locator('#ai-threshold').inputValue(), '0');
  assert.match(await overlay.locator('.ai-suggestion').textContent(), /Small spacing inconsistency/);
  assert.equal((await comparisonSnapshot()).count, 1, 'Revealing the remaining suggestion must not accept it');
  assert.equal(await overlay.locator('#ai-accept-all').textContent(), 'Accept all shown (1)');
  await overlay.locator('#ai-accept-all').click();
  await until(() => overlay.locator('.comment-pin').count().then(count=>count===2), 'bulk acceptance of remaining mismatch');
  await until(() => overlay.locator('.ai-suggestion').count().then(count=>count===0), 'bulk queue exhausted');
  const afterBulk = await comparisonSnapshot();
  assert.equal(afterBulk.count, 2);
  assert.deepEqual(afterBulk.suggestions.map(item=>item.status), ['accepted','accepted']);
  assert.deepEqual(afterBulk.comments.map(item=>item.ai.suggestionId).sort(), beforeBulk.suggestions.map(item=>item.id).sort());
  for (const comment of afterBulk.comments) {
    assert.equal(comment.category, 'design-mismatch');
    assert.equal(comment.selection, 'region');
    for (const field of ['originalProduction','originalPrototype','hasPrototype','annotatedProduction','originalCaptureTime']) assert.equal(comment[field], true, field);
    assert.equal(comment.ai.provider, 'anthropic');
    assert.equal(comment.ai.model, beforeBulk.model);
    assert.equal(comment.ai.runId, beforeBulk.batchId);
    assert.equal(comment.ai.mode, 'comparison');
    assert.equal(Number.isFinite(Date.parse(comment.ai.acceptedAt)), true);
  }
  assert.deepEqual(afterBulk.comments.map(item=>item.ai.mismatchScore).sort((a,b)=>a-b), [12,85]);
  assert.deepEqual(afterBulk.comments.map(item=>item.ai.confidence).sort(), [0.72,0.93]);
  assert.equal(requests.length, requestsBeforeBulk, 'Bulk acceptance reuses captured evidence without another API request');
  assert.equal(await overlay.locator('.comment-pin').first().evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(201, 173, 255)');
  pass('Accept all shown respects the filter, then accepts revealed findings with paired screenshots, annotated pins and AI provenance without another API request');
  const duplicateBulk = await worker.evaluate(async ({batchId,suggestionIds}) => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    const [result] = await chrome.scripting.executeScript({target:{tabId:session.targetTabId}, args:[{batchId,suggestionIds,sessionId:session.id}],
      func: async message => chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type:'ACCEPT_AI_SUGGESTIONS',...message}),
    });
    return result.result;
  }, {batchId:beforeBulk.batchId,suggestionIds:beforeBulk.suggestions.map(item=>item.id)});
  assert.equal(duplicateBulk.ok, true);
  assert.equal(duplicateBulk.acceptedCount, 0);
  assert.equal(duplicateBulk.skippedCount, 2);
  assert.deepEqual(duplicateBulk.failures, []);
  const afterDuplicateBulk = await comparisonSnapshot();
  assert.equal(afterDuplicateBulk.count, 2);
  assert.deepEqual(afterDuplicateBulk.comments.map(item=>item.id).sort(), afterBulk.comments.map(item=>item.id).sort());
  assert.equal(await overlay.locator('.comment-pin').count(), 2);
  assert.equal(requests.length, requestsBeforeBulk);
  pass('Repeating bulk acceptance is idempotent: already accepted findings create no duplicate comments or API requests');
  await overlay.locator('#close-ai').click(); await command('stop');
  await settings.bringToFront(); await settings.reload(); await settings.locator('#clear-key').click();
  await until(() => settings.locator('#key-status').textContent().then(text=>text==='No key connected'), 'key removal');
  pass('API key can be removed from both extension storage locations');
  await writeFile(join(artifacts,'audit-test-results.json'),JSON.stringify({passed:results,aiProvider:'Local streamed response fixture; no real API key or paid Anthropic request',nativePermissionDialog:'Temporary extension copy pre-grants fixture hosts and Anthropic origin.'},null,2));
} catch(error) {
  if(page&&!page.isClosed()){await page.screenshot({path:join(artifacts,'audit-failure.png')}).catch(()=>{});console.error('UI:',await overlay?.evaluate(host=>({status:host.shadowRoot.querySelector('#status')?.textContent,warning:host.shadowRoot.querySelector('#warning')?.textContent,error:host.shadowRoot.querySelector('#ai-error')?.textContent,commentError:host.shadowRoot.querySelector('#comment-error')?.textContent,capture:host.shadowRoot.querySelector('#capture-retry-description')?.textContent})).catch(()=>null));}
  throw error;
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
