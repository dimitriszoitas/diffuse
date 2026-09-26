import assert from 'node:assert/strict';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {formatStandaloneHtml} from '../extension/report-format.mjs';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = join(project, 'artifacts', 'report-clarity');
await mkdir(artifacts, {recursive: true});
const temp = await mkdtemp(join(tmpdir(), 'diffuse-report-clarity-'));
const extension = join(temp, 'extension');
await cp(join(project, 'extension'), extension, {recursive: true});
const results = [], errors = [], externalRequests = [];
const pass = message => {results.push(message); console.log(`PASS ${message}`);};
const title = 'Illustrative review fixture — no AI request';
const capturedAt = '2026-09-26T10:00:00.000Z';
const viewport = {width: 1280, height: 800, dpr: 1};
const fixtureMarkup = side => {
  const prototype = side === 'prototype';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} — ${side}</title><style>
  *{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;color:#211a35;background:#f7f4fc}.fixture-banner{height:46px;background:#fff0eb;border-bottom:1px solid #ef785c;color:#823423;font-size:14px;padding:11px 28px;letter-spacing:.1px}.workspace{display:grid;grid-template-columns:230px 1fr;min-height:754px}.sidebar{background:#211a35;color:#d4c7ed;padding:32px 22px}.brand{font-size:28px;font-weight:750;color:white;margin:0 0 44px}.nav{padding:14px;border-radius:9px;margin:10px 0}.nav.active{background:#4b366f;color:white}.profile{margin-top:300px;font-size:14px}.main{padding:48px 54px}.eyebrow{font-size:14px;font-weight:700;color:#6941c6;letter-spacing:1px}.topline{display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:34px;gap:24px}h1{display:inline-block;margin:0;font-size:36px;letter-spacing:-1px;font-weight:720;line-height:1.2}.action{font:600 16px system-ui;background:#6941c6;border:1px solid #6941c6;border-radius:10px;color:white;padding:15px 21px;white-space:nowrap}.panel{border:1px solid #d8cfe5;background:white;border-radius:16px;min-height:350px;display:grid;place-items:center;padding:42px}.empty{text-align:center;max-width:490px}.symbol{width:52px;height:52px;border-radius:13px;background:#eee7fa;color:#6941c6;font-size:30px;margin:0 auto 22px;display:grid;place-items:center}.empty h2{font-size:23px;line-height:1.35;margin:0 0 12px}.empty p{margin:0;color:#625870;font-size:17px}.hint{font-size:14px;color:#625870;margin:22px 0}.fixture-chip{display:inline-block;background:#eee7fa;color:#6941c6;font-size:14px;font-weight:600;border-radius:5px;padding:3px 9px;margin-bottom:10px}
  </style><div class="fixture-banner">${title}. Hand-authored demonstration; fictional workspace.</div><div class="workspace"><aside class="sidebar"><p class="brand">Conversation</p><div class="nav active">Workspace</div><div class="nav">Team library</div><div class="nav">Settings</div><p class="profile">Example workspace<br>Fictional content</p></aside><main class="main"><span class="fixture-chip">${prototype ? 'Prototype reference' : 'Production example'}</span><div class="eyebrow">YOUR WORKSPACE</div><div class="topline"><h1 id="heading">${prototype ? 'Recent conversations' : 'Latest chats'}</h1><button id="action" class="action">${prototype ? 'Start a conversation' : 'Create new'}</button></div><section class="panel"><div class="empty"><div class="symbol" aria-hidden="true">◌</div><h2>No conversations yet</h2><p id="empty-copy">${prototype ? 'Start your first conversation to keep your ideas together.' : 'Nothing here. Create something to begin.'}</p></div></section><p class="hint">All differences in this example were written specifically to demonstrate the review format.</p></main></div></html>`;
};

let context, report;
try {
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: {width: 1440, height: 1080},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-mock-keychain', '--password-store=basic'],
  });
  await context.route(/^https?:\/\//, route => {externalRequests.push(route.request().url()); return route.abort();});
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const frames = {};
  const canvasPage = await context.newPage();
  await canvasPage.setViewportSize({width: viewport.width, height: viewport.height});
  for (const side of ['production', 'prototype']) {
    const html = fixtureMarkup(side);
    await writeFile(join(artifacts, `fixture-${side}.html`), html);
    await canvasPage.setContent(html);
    await canvasPage.evaluate(() => document.fonts.ready);
    const png = await canvasPage.screenshot({path: join(artifacts, `fixture-${side}.png`)});
    const details = {};
    for (const key of ['heading', 'action', 'empty-copy']) {
      const box = await canvasPage.locator(`#${key}`).boundingBox();
      const x = Math.max(0, Math.floor(box.x - 24)), y = Math.max(0, Math.floor(box.y - 24));
      const width = Math.min(viewport.width, Math.ceil(box.x + box.width + 24)) - x;
      const height = Math.min(viewport.height, Math.ceil(box.y + box.height + 24)) - y;
      const crop = {x, y, width, height};
      const cropPng = await canvasPage.screenshot({clip: crop});
      details[key] = {box, crop, cropDataUrl: `data:image/png;base64,${cropPng.toString('base64')}`};
    }
    frames[side] = {dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: viewport.width, height: viewport.height, capturedAt, details};
  }
  await canvasPage.close();
  const texts = [
    {key: 'heading', title: 'Use the reference heading for the conversation section', current: 'The conversation section heading currently reads “Latest chats”.', change: 'In the conversation section heading, replace “Latest chats” with “Recent conversations”. This preserves the reference’s description of the section and its terminology for a conversation. Verify that the heading reads “Recent conversations” and remains the section’s heading.'},
    {key: 'action', title: 'Name the conversation action explicitly', current: 'The primary action beside the conversation heading currently reads “Create new”.', change: 'In the primary action beside the conversation heading, replace “Create new” with “Start a conversation”. This names the action’s object using the reference wording. Verify that the button reads “Start a conversation” without clipping its label.'},
    {key: 'empty-copy', title: 'Use the reference’s empty-state guidance', current: 'The empty-state description currently reads “Nothing here. Create something to begin.”', change: 'Under “No conversations yet”, replace “Nothing here. Create something to begin.” with “Start your first conversation to keep your ideas together.” This gives the same next-step guidance as the reference. Verify that the full replacement sentence appears beneath the empty-state heading.'},
  ];
  const review = {id: 'illustrative-report-clarity', title, mode: 'comparison', createdAt: capturedAt, updatedAt: capturedAt, productionUrl: 'https://fixture.example.test/production', prototypeUrl: 'https://fixture.example.test/prototype'};
  const drafts = texts.map((text, index) => {
    const evidence = Object.fromEntries(['production', 'prototype'].map(side => {
      const {dataUrl, width, height, capturedAt, details} = frames[side];
      // The first finding deliberately represents a legacy saved review with no crop.
      return [side, {dataUrl, width, height, capturedAt, ...(index ? {crop: details[text.key].crop, cropDataUrl: details[text.key].cropDataUrl} : {})}];
    }));
    return {id: `fixture-draft-${index}`, reviewId: review.id, mode: 'comparison', createdAt: `2026-09-26T10:0${index}:00.000Z`,
      selection: {schemaVersion: 1, kind: 'region', rect: {viewport: frames.production.details[text.key].box}},
      context: {production: {url: review.productionUrl, viewport}, prototype: {url: review.prototypeUrl, viewport}}, evidence,
      fields: {category: 'copy-change', title: text.title, comment: text.current, expected: text.change, component: text.key === 'action' ? 'Conversation action' : text.key === 'heading' ? 'Conversation section heading' : 'Conversation empty state', state: 'Illustrative empty workspace', severity: 'minor', steps: ''},
    };
  });
  report = await context.newPage();
  report.on('pageerror', error => errors.push(error.message));
  await report.goto(`chrome-extension://${extensionId}/report.html`);
  const storedBefore = await report.evaluate(async ({review, drafts}) => {
    const store = await import(chrome.runtime.getURL('review-store.mjs'));
    for (const draft of drafts) {const {fields, ...capture} = draft; await store.putDraft(capture, review); await store.addComment(capture.id, fields);}
    return store.getReview(review.id);
  }, {review, drafts});
  await report.goto(`chrome-extension://${extensionId}/report.html?review=${review.id}`);
  await report.waitForFunction(() => document.querySelectorAll('.comment-card').length === 3 && document.querySelector('#report-content').getAttribute('aria-busy') === 'false');
  const cards = report.locator('.comment-card');
  const first = cards.nth(0);
  for (let index = 0; index < texts.length; index++) {
    assert.equal(await cards.nth(index).locator('.observation h3').textContent(), 'Current');
    assert.equal(await cards.nth(index).locator('.requested-change h3').textContent(), 'Change to');
    assert.equal(await cards.nth(index).locator('.observation p').textContent(), texts[index].current);
    assert.equal(await cards.nth(index).locator('.requested-change p').textContent(), texts[index].change);
  }
  pass('Three hand-authored copy issues remain separate; Current and Change to preserve each saved string exactly.');
  const firstCrop = first.locator('.selected-evidence .evidence-image img');
  await firstCrop.scrollIntoViewIfNeeded();
  await firstCrop.evaluate(image => image.decode());
  assert.equal(await first.locator('.selected-evidence .evidence-image').count(), 1);
  assert.match(await first.locator('.selected-evidence figcaption').textContent(), /^Production/);
  assert.match(await first.locator('.evidence-limit-note').textContent(), /prototype close-up was not recorded/);
  const derived = await firstCrop.evaluate(image => ({src: image.src, width: image.naturalWidth, height: image.naturalHeight, visibleWidth: image.getBoundingClientRect().width}));
  assert.equal(derived.width, frames.production.details.heading.crop.width);
  assert.equal(derived.height, frames.production.details.heading.crop.height);
  assert.ok(derived.visibleWidth >= derived.width * 1.8 && derived.visibleWidth <= derived.width * 2.01, 'Legacy detail is enlarged for reading without stretching a narrow heading across the entire card');
  assert.ok(derived.width < frames.production.width / 2);
  pass('A legacy selection produces a large focused production crop using recorded geometry; no prototype crop is invented.');
  for (const index of [1, 2]) {
    assert.equal(await cards.nth(index).locator('.selected-evidence .evidence-image').count(), 2);
    assert.deepEqual(await cards.nth(index).locator('.selected-evidence figcaption').allTextContents(), ['Production · focused detail', 'Prototype · focused detail']);
    const key = texts[index].key;
    assert.deepEqual(await cards.nth(index).locator('.selected-evidence img').evaluateAll(images => images.map(image => image.src)), [frames.production.details[key].cropDataUrl, frames.prototype.details[key].cropDataUrl]);
  }
  assert.notDeepEqual(frames.production.details.action.crop, frames.prototype.details.action.crop);
  pass('Explicit production and prototype crops are shown together with their independently recorded dimensions.');
  assert.equal(await report.locator('.full-evidence[open]').count(), 0);
  assert.equal(await first.locator('.full-evidence img').first().isVisible(), false);
  pass('Full screenshots start collapsed while focused evidence is visible.');
  await first.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 28));
  await report.screenshot({path: join(artifacts, 'review-legacy.png')});
  await cards.nth(1).evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 28));
  await report.screenshot({path: join(artifacts, 'review-desktop.png')});

  await firstCrop.focus();
  await report.keyboard.press('Enter');
  const dialog = report.locator('dialog.image-preview');
  await dialog.waitFor({state: 'visible'});
  assert.equal(await dialog.locator('output').textContent(), 'Fit to window');
  const imageWidth = () => dialog.locator('img').evaluate(image => image.getBoundingClientRect().width);
  await dialog.locator('img').evaluate(image => image.decode());
  const cappedFit = await imageWidth();
  assert.ok(cappedFit <= derived.width * 4, 'Fit shares the maximum zoom scale');
  await dialog.getByRole('button', {name: 'Zoom in', exact: true}).click();
  assert.ok(await imageWidth() >= cappedFit, 'Zoom in from a capped Fit must never shrink');
  await report.setViewportSize({width:900,height:1080});
  await dialog.getByRole('button', {name: 'Fit', exact: true}).click();
  const smallerFit = await imageWidth();
  assert.ok(smallerFit < derived.width * 4);
  await dialog.getByRole('button', {name: 'Zoom in', exact: true}).click();
  assert.ok(await imageWidth() > smallerFit, 'Zoom in from an uncapped Fit must enlarge');
  await dialog.getByRole('button', {name: 'Fit', exact: true}).click();
  await dialog.getByRole('button', {name: 'Zoom out', exact: true}).click();
  assert.ok(await imageWidth() < smallerFit, 'Zoom out from Fit must shrink');
  await report.setViewportSize({width:1440,height:1080});
  pass('Zoom steps use the actual fitted crop size; capped Fit never shrinks on +, and uncapped Fit changes in the expected direction.');
  await dialog.getByRole('button', {name: '100%', exact: true}).focus(); await report.keyboard.press('Enter');
  assert.equal(await dialog.locator('output').textContent(), '100%');
  await dialog.getByRole('button', {name: 'Zoom in', exact: true}).focus(); await report.keyboard.press('Enter');
  assert.equal(await dialog.locator('output').textContent(), '125%');
  await dialog.getByRole('button', {name: 'Zoom out', exact: true}).focus(); await report.keyboard.press('Enter');
  assert.equal(await dialog.locator('output').textContent(), '100%');
  await dialog.getByRole('button', {name: 'Fit', exact: true}).focus(); await report.keyboard.press('Enter');
  assert.equal(await dialog.locator('output').textContent(), 'Fit to window');
  await dialog.getByRole('button', {name: '100%', exact: true}).focus(); await report.keyboard.press('Enter');
  await dialog.getByRole('button', {name: 'Zoom in', exact: true}).focus();
  for (let index = 0; index < 4; index++) await report.keyboard.press('Enter');
  assert.equal(await dialog.locator('output').textContent(), '200%');
  assert.equal(await dialog.locator('img').evaluate(image => image.getBoundingClientRect().width), derived.width * 2);
  await report.screenshot({path: join(artifacts, 'review-zoom.png')});
  await report.keyboard.press('Escape');
  await dialog.waitFor({state: 'detached'});
  assert.equal(await firstCrop.evaluate(image => document.activeElement === image), true);
  pass('Keyboard Enter opens enlargement; Fit, 100%, zoom in/out work; Escape closes and returns focus to the initiating image.');
  const enlargeButton = first.locator('.selected-evidence').getByRole('button', {name: 'Enlarge', exact: true});
  await enlargeButton.focus(); await report.keyboard.press('Enter');
  await report.locator('dialog.image-preview').waitFor({state: 'visible'});
  await report.keyboard.press('Escape');
  await report.locator('dialog.image-preview').waitFor({state: 'detached'});
  assert.equal(await enlargeButton.evaluate(button => document.activeElement === button), true);
  pass('The separate Enlarge button also opens by keyboard and restores its own focus on close.');

  await report.setViewportSize({width:320,height:844});
  await first.locator('.full-evidence summary').click();
  const fullImage = first.locator('.full-evidence img').first();
  await fullImage.focus();await report.keyboard.press('Enter');
  const fullDialog = report.locator('dialog.image-preview');
  await fullDialog.waitFor({state:'visible'});
  await fullDialog.locator('img').evaluate(image=>image.decode());
  const fullFit = await fullDialog.locator('img').evaluate(image=>({width:image.getBoundingClientRect().width,naturalWidth:image.naturalWidth}));
  assert.ok(fullFit.width / fullFit.naturalWidth < .25, 'Fixture must exercise a fit below25%');
  await fullDialog.getByRole('button',{name:'Zoom out',exact:true}).click();
  assert.ok(await fullDialog.locator('img').evaluate(image=>image.getBoundingClientRect().width) < fullFit.width, 'Zoom out below25% must shrink, never jump up to25%');
  await report.keyboard.press('Escape');await fullDialog.waitFor({state:'detached'});
  await first.locator('.full-evidence summary').click();
  pass('Zoom out directly from a full screenshot fitted below25% decreases its displayed size.');

  await report.setViewportSize({width: 390, height: 844});
  assert.equal(await report.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await firstCrop.scrollIntoViewIfNeeded();
  assert.ok((await firstCrop.boundingBox()).width >= 250);
  await first.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 14));
  await report.screenshot({path: join(artifacts, 'review-mobile.png')});
  await firstCrop.focus(); await report.keyboard.press('Enter');
  await report.locator('dialog.image-preview').waitFor({state: 'visible'});
  assert.equal(await report.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await report.keyboard.press('Escape');
  pass('The review and image dialog reflow at 390px without horizontal page overflow.');

  const storedAfter = await report.evaluate(async id => (await import(chrome.runtime.getURL('review-store.mjs'))).getReview(id), review.id);
  assert.deepEqual(storedAfter, storedBefore, 'Viewing and enlarging evidence must not alter saved content or add crops to storage');
  pass('Viewing, crop derivation and enlargement leave saved review fields and media unchanged.');
  await report.setViewportSize({width: 1440, height: 1080});
  const downloadPromise = report.waitForEvent('download');
  await report.locator('#download-html').click();
  const download = await downloadPromise;
  const exportPath = join(artifacts, 'illustrative-review-fixture.html');
  await download.saveAs(exportPath);
  const exported = await readFile(exportPath, 'utf8');
  assert.equal(/<script\b/i.test(exported), false);
  assert.equal(/\son[a-z]+\s*=/i.test(exported), false);
  assert.match(exported, /Illustrative review fixture — no AI request/);
  assert.ok(exported.includes(derived.src));
  const single = {...storedBefore, comments: [{...storedBefore.comments[0], evidence: {...storedBefore.comments[0].evidence, production: {...storedBefore.comments[0].evidence.production, crop: frames.production.details.heading.crop, cropDataUrl: derived.src}}}]};
  const singlePath = join(artifacts, 'illustrative-single-issue.html');
  await writeFile(singlePath, formatStandaloneHtml(single));
  const exportedPage = await context.newPage();
  for (const [path, expectedCount] of [[exportPath, 3], [singlePath, 1]]) {
    await exportedPage.goto(pathToFileURL(path).href);
    assert.equal(await exportedPage.locator('script').count(), 0);
    assert.equal(await exportedPage.locator('.comment-card').count(), expectedCount);
    assert.equal(await exportedPage.locator('.full-evidence[open]').count(), 0);
    await exportedPage.locator('.full-evidence').evaluateAll(details => details.forEach(detail => {detail.open = true;}));
    const imageResults = await exportedPage.locator('img').evaluateAll(async images => Promise.all(images.map(async image => {
      image.loading = 'eager'; await image.decode(); return {loaded: image.complete && image.naturalWidth > 0, embedded: image.src.startsWith('data:image/')};
    })));
    assert.ok(imageResults.length >= 3 && imageResults.every(image => image.loaded && image.embedded));
  }
  assert.deepEqual(externalRequests, [], 'No provider, remote images or remote page requests may occur');
  assert.deepEqual(errors, []);
  pass('Actual HTML download and formatter-generated single-issue example are script-free, self-contained and load every embedded image with no external requests.');
  await rm(join(artifacts, 'failure.png'), {force: true});
  await writeFile(join(artifacts, 'verification.json'), JSON.stringify({fixture: title, provenance: 'Hand-authored fictional screenshots and review text. No AI request, no API key, no existing user review.', browser: 'Fresh disposable Chromium extension profile; mock keychain and basic password store.', savedReviewUnchanged: true, externalRequestCount: externalRequests.length, pageErrors: errors, passed: results, artifacts: ['review-desktop.png', 'review-legacy.png', 'review-zoom.png', 'review-mobile.png', 'illustrative-review-fixture.html', 'illustrative-single-issue.html', 'fixture-production.png', 'fixture-prototype.png'], derivedLegacyCrop: {width: derived.width, height: derived.height, visibleWidth: derived.visibleWidth}, explicitPairedCrop: {production: frames.production.details.action.crop, prototype: frames.prototype.details.action.crop}}, null, 2));
} catch (error) {
  if (report && !report.isClosed()) await report.screenshot({path: join(artifacts, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  await context?.close();
  await rm(temp, {recursive: true, force: true});
}
