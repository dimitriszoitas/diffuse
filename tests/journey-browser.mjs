// Full native-sidebar integration. Only the AI decision provider is replaced in
// a disposable extension; actions, screenshots, storage and UI use real code.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {DEFAULT_JOURNEY_PERSONA} from '../extension/journey-persona.mjs';
import {DEFAULT_JOURNEY_SETTINGS} from '../extension/journey-settings.mjs';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = join(project, 'artifacts', 'journey');
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-journey-native-'));
const extension = join(temporary, 'extension');
await mkdir(artifacts, {recursive: true});
await cp(join(project, 'extension'), extension, {recursive: true});
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.anthropic.com/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const servicePath = join(extension, 'journey-service.mjs');
const service = await readFile(servicePath, 'utf8');
assert.ok(service.includes('decide = requestJourneyDecision'), 'Journey decision injection point is missing');
await writeFile(servicePath, service.replace('decide = requestJourneyDecision', 'decide = globalThis.__journeyDecide || requestJourneyDecision').replace('followUp = requestJourneyFollowUp', 'followUp = globalThis.__journeyFollowUp || requestJourneyFollowUp'));
const workerPath = join(extension, 'background.js');
await writeFile(workerPath, (await readFile(workerPath, 'utf8'))
  .replace("import * as reviews from './review-store.mjs';", "import * as reviews from './review-store.mjs';\nglobalThis.__journeyReviews = reviews;")
  .concat("\nimport * as journeyStore from './journey-store.mjs';\nglobalThis.__journeyStore = journeyStore;\n"));
const shell = content => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ingredient workspace</title><style>
body{font:17px system-ui;color:#19324a;background:#f1f5f8;margin:0;padding:48px}
main{background:white;padding:32px;max-width:750px;border:1px solid #d5e0e8;border-radius:10px}
a,button{display:inline-block;color:#2361bd;padding:12px 16px;border:1px solid #c5d5e8;border-radius:6px;background:white;font:inherit;margin:8px 0}
input,select{display:block;margin:8px 0 24px;padding:12px;border:1px solid #a8bdce;border-radius:5px;font:inherit}
label{display:block}h1{margin-top:0}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:18px;border-bottom:1px solid #dbe4ed}
</style></head><body><main>${content}</main></body></html>`;
const pages = {
  '/': shell('<p>Workspace</p><h1>Dashboard</h1><p>Manage the materials used in your products.</p><a href="/ingredients">Ingredients</a><br><a href="/wizard">Setup wizard</a>'),
  '/wizard': shell('<p>Setup</p><h1>Add your first ingredient</h1><p>Step 1 of 1</p><a href="/new">Add ingredient</a>'),
  '/ingredients': shell('<p>Inventory</p><h1>Ingredients</h1><a href="/new">New</a><table><thead><tr><th>Name</th><th>Unit</th></tr></thead><tbody id="items"></tbody></table><script>const entries=JSON.parse(localStorage.getItem("ingredients")||"[]");for(const entry of entries){const row=document.createElement("tr");for(const v of [entry.name,entry.unit]){const cell=document.createElement("td");cell.textContent=v;row.append(cell)}document.querySelector("#items").append(row)}</script>'),
  '/new': shell('<p>Inventory / Ingredients</p><h1>New ingredient</h1><form><label>Name<input name="name" required></label><label>Unit<select name="unit"><option value="g">g</option><option value="ml">ml</option></select></label><button>Save ingredient</button></form><script>document.querySelector("form").addEventListener("submit",event=>{event.preventDefault();const data=new FormData(event.currentTarget);const entries=JSON.parse(localStorage.getItem("ingredients")||"[]");entries.push({name:data.get("name"),unit:data.get("unit")});localStorage.setItem("ingredients",JSON.stringify(entries));location.href="/ingredients"})</script>'),
};
const server = http.createServer((request, response) => {
  response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  response.end(pages[new URL(request.url, 'http://localhost').pathname] || pages['/']);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(120); }
  throw new Error(`Timed out: ${label}`);
}
let context, worker, cdp, extensionId, panel;
const pending = new Map();
let sequence = 0;
function nativeSend(sessionId, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native view timeout: ${method}`)); }, 8000);
    pending.set(id, {resolve, reject, timer});
    cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(reject);
  });
}
async function nativeView(path) {
  let target;
  await until(async () => {
    target = (await cdp.send('Target.getTargets', {filter: [{exclude: false}]})).targetInfos.find(item => item.type === 'page' && item.url === `chrome-extension://${extensionId}/${path}`);
    return target;
  }, path);
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  const send = (method, params) => nativeSend(sessionId, method, params);
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Runtime.enable');
  return {
    evaluate,
    reload: () => send('Page.reload'),
    visible: selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`),
    text: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`),
    fill: (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`),
    enter: async selector => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
    },
    click: async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||!e.checkVisibility()||e.disabled)throw new Error('Unavailable control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
    },
    screenshot: async name => {
      const {data} = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      await writeFile(join(artifacts, `${name}.png`), Buffer.from(data, 'base64'));
    },
  };
}
async function checkNarrowChat({assistance = false} = {}) {
  // Freeze the actual rendered native panel, then inspect its shipped styles
  // in a separate browser. Resizing Chrome's native sidebar through CDP is not
  // supported, so this is a responsive layout check rather than a second flow.
  let html = await panel.evaluate(`(()=>{const root=document.documentElement.cloneNode(true);for(const script of root.querySelectorAll('script'))script.remove();for(const video of root.querySelectorAll('video')){video.removeAttribute('src');video.replaceChildren()}return root.outerHTML})()`);
  for (const match of [...html.matchAll(/<link\b[^>]*href="([^\"]+)"[^>]*>/g)]) {
    if (!/rel="stylesheet"/.test(match[0])) continue;
    const css = await readFile(join(extension, match[1]), 'utf8');
    html = html.replace(match[0], `<style>${css}</style>`);
  }
  const browser = await chromium.launch({headless: true});
  try {
    const preview = await browser.newPage({viewport: {width: 320, height: 740}});
    await preview.setContent(html);
    for (const theme of ['light', 'dark']) {
      await preview.evaluate(value => {document.documentElement.dataset.theme=value;document.querySelector('#journey-conversation').scrollTop=99999;}, theme);
      assert(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Chat must fit a 320px sidebar');
      for (const selector of ['#journey-chat-back', '#journey-question', '#journey-ask', ...(assistance ? ['#journey-help-stop'] : [])]) {
        const bounds = await preview.locator(selector).boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321 && bounds.y >= 0 && bounds.y + bounds.height <= 741, `Narrow chat control clipped: ${selector} ${JSON.stringify(bounds)}`);
      }
      await preview.screenshot({path: join(artifacts, `${assistance ? 'journey-help' : 'journey-chat'}-320-${theme}.png`)});
    }
    console.log(`PASS actual ${assistance ? 'blocked help' : 'conversation'} layout keeps navigation and response controls visible at 320px in light and dark`);
  } finally { await browser.close(); }
}
try {
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000', '--use-mock-keychain', '--password-store=basic'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  cdp = await context.browser().newBrowserCDPSession();
  cdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message), request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
  });
  await worker.evaluate(async () => {
    await chrome.storage.session.set({anthropicApiKey: 'sk-ant-fixture-not-a-real-key'});
    globalThis.__journeyDecisionCalls = 0;
    globalThis.__journeyProfiles = [];
    globalThis.__journeyFollowUpRequests = [];
    globalThis.__journeyDecide = async ({goal, observation, history, routePreferences, persona, exploration, allowRecordMoves, extraInstructions, focusChecks, continuation, priorJourney}) => {
      globalThis.__journeyDecisionCalls++;
      globalThis.__journeyProfiles.push({persona, exploration, allowRecordMoves, extraInstructions, focusChecks, continuation, assistance: priorJourney?.assistance});
      const ingredient = ['Rice milk', 'Soy milk', 'Almond milk', 'Hazelnut milk'].find(name => goal.includes(name)) || 'Oat milk';
      const controls = observation.controls;
      const byLabel = label => controls.find(item => item.label === label);
      const click = label => ({action: {type: 'click', targetId: byLabel(label).id}, reason: `Follow the visible ${label} control.`});
      const path = new URL(observation.url).pathname;
      await new Promise(resolve => setTimeout(resolve, history.length ? 200 : 1000));
      if (path === '/') return click(routePreferences ? 'Setup wizard' : 'Ingredients');
      if (path === '/wizard') return click('Add ingredient');
      if (path === '/ingredients' && !observation.text.includes(ingredient)) return click('New');
      if (path === '/new') {
        if (byLabel('Name').value !== ingredient) return {action: {type: 'type', targetId: byLabel('Name').id, text: ingredient}, reason: 'Enter the supplied test ingredient.'};
        if (byLabel('Unit').value !== 'ml') return {action: {type: 'select', targetId: byLabel('Unit').id, value: 'ml'}, reason: 'Choose the specified unit.'};
        return click('Save ingredient');
      }
      const dimensions = ['discoverability', 'clarity', 'effort', 'feedback', 'recovery'];
      const untestedScores = dimensions.map(dimension => ({dimension, score: null, reason: 'This fixture has not assessed this dimension.', evidenceSteps: [], confidence: 0}));
      if (['Almond milk', 'Hazelnut milk'].includes(ingredient) && !continuation) return {
        reason: `${ingredient} was saved. I cannot tell whether this table is enough to verify the requested outcome.`,
        action: {type: 'finish', outcome: 'blocked', summary: 'The ingredient was saved, but the verification needs reviewer guidance.',
          helpQuestion: `${ingredient} is now in the table. Should I verify the row here, or open a detail page?`, findings: [], scores: untestedScores}
      };
      return {reason: `The resulting table contains ${ingredient} and its ml unit.`, action: {
        type: 'finish', outcome: 'completed', summary: `${ingredient} was created and appears in the ingredients table with unit ml.`,
        findings: history.length ? [{title: 'Name the creation action', comment: 'The Ingredients page labels its creation action only “New”. The destination is clearer after opening the form.', expected: 'Label the action “Add ingredient” so the object being created is explicit.', category: 'copy-change', severity: 'minor', stepIndex: 2, confidence: .9}] : [],
        scores: history.length ? dimensions.map(dimension => ({dimension, score: dimension === 'recovery' ? null : dimension === 'clarity' ? 3 : 4,
          reason: dimension === 'recovery' ? 'No error recovery was needed.' : 'Evidence from the observed task path.',
          evidenceSteps: dimension === 'recovery' ? [] : [2], confidence: dimension === 'recovery' ? 0 : .8})) : untestedScores,
      }};
    };
    globalThis.__journeyFollowUp = async ({stepIndex, question, run}) => {
      globalThis.__journeyFollowUpRequests.push({stepIndex, question, previousAnswers: run.followUps?.length || 0, persona: run.persona});
      await new Promise(resolve => setTimeout(resolve, 900));
      if (globalThis.__journeyFollowUpFailOnce) { globalThis.__journeyFollowUpFailOnce = false; throw new Error('Temporary test connection failure. Please try again.'); }
      return {answer: 'The recorded step used New on Ingredients. The starting page also offered Setup wizard; that route was not tested in this attempt.', evidenceSteps: [1, 2], routeSuggestion: question.includes('wizard') ? {label: 'Try the setup wizard', instructions: 'Start with Setup wizard, then Add ingredient. Use Rice milk as a separate test entry.'} : null};
    };
  });
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.bringToFront();
  const targets = await cdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const target = targets.targetInfos.find(item => item.url === page.url());
  await cdp.send('Extensions.triggerAction', {id: extensionId, targetId: target.targetId});
  const popup = await nativeView('popup.html');
  await until(() => popup.evaluate(`document.getElementById('popup')?.getAttribute('aria-busy')==='false'`), 'popup ready');
  await popup.click('#start-comparison');
  panel = await nativeView('sidepanel.html');
  await until(() => panel.evaluate(`document.getElementById('popup')?.getAttribute('aria-busy')==='false'`), 'native panel ready');
  await until(() => panel.visible('#panel-journey'), 'journey entry');
  await panel.click('#panel-journey');
  // Let the initial state response settle with no saved journey. A comparison
  // of two absent IDs must not try to read timestamps from a null run.
  await until(() => panel.evaluate(`!document.querySelector('#journey-start').disabled`), 'AI settings loaded for empty journey');
  await pause(1600);
  assert.equal(await panel.text('#journey-error'), '', 'Opening a journey with no previous run must not show an error');
  assert.equal(await panel.visible('#journey-form'), true);
  assert.equal(await panel.visible('#journey-run'), false);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyPersona.read()'), DEFAULT_JOURNEY_PERSONA);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyOptions.read()'), DEFAULT_JOURNEY_SETTINGS);
  console.log('PASS empty journey setup settles without a null-state error');
  const persona = {description: 'A new inventory teammate who already knows ingredient catalogues.', technicalConfidence: 2, productFamiliarity: 1, taskFamiliarity: 4, persistence: 3};
  const settings = {exploration: 'thorough', allowRecordMoves: true, extraInstructions: 'Keep existing entries intact. Use only the ingredient supplied for this task.', focusChecks: ['completion', 'discoverability', 'feedback', 'interaction']};
  await panel.fill('#journey-persona-description', persona.description);
  for (const key of ['technicalConfidence', 'productFamiliarity', 'taskFamiliarity', 'persistence']) await panel.fill(`#journey-persona-${key}`, String(persona[key]));
  await panel.click('#journey-focus-checks summary');
  await panel.click('#journey-check-interaction');
  await panel.click('#journey-exploration-options summary');
  await panel.fill('#journey-exploration', settings.exploration);
  await panel.click('#journey-allow-record-moves');
  await panel.fill('#journey-extra-instructions', settings.extraInstructions);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyPersona.read()'), persona);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyOptions.read()'), settings);
  await panel.fill('#journey-goal', 'Add Oat milk to the Ingredients table, with ml as its unit. Find the path yourself and confirm the saved row.');
  await until(() => panel.evaluate(`!document.querySelector('#journey-start').disabled`), 'AI settings loaded for journey');
  await panel.screenshot('journey-setup');
  await panel.click('#journey-start');
  const currentRun = () => worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    return session?.journey?.id ? __journeyStore.getJourney(session.journey.id) : null;
  });
  await until(() => worker.evaluate(() => __journeyDecisionCalls > 0), 'first model decision pending');
  await panel.click('#journey-pause');
  await until(async () => (await currentRun())?.status === 'paused', 'journey paused');
  const pausedRun = await currentRun();
  assert.equal(pausedRun.recording.status, 'paused');
  const pausedUrl = page.url(), pausedActions = pausedRun.metrics.actions;
  await pause(1300); // The pending decision returns while paused.
  assert.equal(page.url(), pausedUrl, 'A late decision must not navigate the paused browser');
  assert.equal((await currentRun()).metrics.actions, pausedActions, 'No actions run during pause');
  await panel.screenshot('journey-paused');
  await panel.click('#journey-resume');
  await until(async () => (await currentRun())?.status === 'running', 'journey resumed');
  assert.equal((await currentRun()).recording.status, 'recording');
  console.log('PASS Pause aborts a pending decision, prevents late actions and pauses recording; Resume continues the task');
  await until(async () => {
    const error = await panel.text('#journey-error');
    if (error) throw new Error(error);
    const run = await currentRun();
    return run && !['running', 'paused'].includes(run.status) && run.recording?.status !== 'processing';
  }, 'journey completed', 60000);
  const run = await currentRun();
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(run.persona, persona);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(run[key], value, `Saved ${key}`);
  const decisionProfiles = await worker.evaluate(() => __journeyProfiles);
  assert.ok(decisionProfiles.length > 3);
  for (const profile of decisionProfiles) {
    assert.deepEqual(profile.persona, persona);
    for (const [key, value] of Object.entries(settings)) assert.deepEqual(profile[key], value, `Decision ${key}`);
  }
  assert.equal(page.url(), `${origin}/ingredients`);
  assert.match(await page.locator('tbody').textContent(), /Oat milk.*ml/);
  assert.equal(new Set(run.steps.map(step => new URL(step.observation.url).pathname)).size, 3);
  assert.ok(run.steps.every(step => step.observation.screenshot?.dataUrl?.startsWith('data:image/')));
  assert.equal(run.findings.length, 1);
  assert.equal(run.scores.find(score => score.dimension === 'recovery').score, null);
  assert.equal(run.recording?.status, 'saved', run.recordingError);
  assert.ok(run.video?.dataUrl?.startsWith('data:video/'), 'The whole journey must include a recording');
  assert.ok(run.video.bytes > 1000);
  assert.ok(run.video.durationMs > 1000);
  assert.ok(run.steps.every(step => Number.isFinite(step.videoOffsetMs)));
  await until(() => panel.text('#journey-status').then(value => value.includes('completed')), 'completed status rendered');
  await panel.screenshot('journey-completed');
  await page.screenshot({path: join(artifacts, 'journey-result-page.png')});
  console.log('PASS real native sidebar starts a multi-page run, enters test data, saves the record, and persists screenshot evidence and scores');
  await until(() => panel.visible('#journey-video'), 'journey video visible');
  await until(() => panel.evaluate(`document.querySelector('#journey-video').readyState>=2`), 'video decoded');
  await panel.evaluate(`document.querySelector('#journey-video').play()`);
  await until(() => panel.evaluate(`document.querySelector('#journey-video').currentTime>.3`), 'recording playback');
  await panel.evaluate(`document.querySelector('#journey-video').pause()`);
  const seekStep = run.steps.find(step => step.videoOffsetMs > 1000);
  assert.ok(seekStep, 'A later journey step must have a recording offset');
  await panel.click(`#journey-timeline li[data-step="${seekStep.index}"] summary`);
  await panel.click(`#journey-timeline li[data-step="${seekStep.index}"] .journey-watch-step`);
  await until(() => panel.evaluate(`Math.abs(document.querySelector('#journey-video').currentTime-${seekStep.videoOffsetMs / 1000})<1`), 'timeline seeks the recording');
  await panel.evaluate(`document.querySelector('#journey-video').pause()`);
  await writeFile(join(artifacts, 'journey-fixture.webm'), Buffer.from(run.video.dataUrl.split(',')[1], 'base64'));
  console.log('PASS full journey recording is saved, decodes, plays and seeks from a timeline step in the native sidebar');
  await until(() => panel.visible('#journey-findings button'), 'accept finding');
  await panel.click('#journey-findings button');
  await until(async () => (await currentRun())?.findings[0].acceptedCommentId, 'finding accepted');
  const comment = await worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    return (await __journeyReviews.getReview(session.reviewId)).comments[0];
  });
  assert.ok(comment.evidence.production.dataUrl.startsWith('data:image/'));
  assert.match(comment.fields.steps, /Goal:.*Oat milk/s);
  assert.match(comment.fields.steps, /Click Ingredients/);
  assert.equal(comment.context.production.url, `${origin}/ingredients`);
  console.log('PASS accepted finding becomes a review comment with the correct page screenshot and reproduction path');
  await panel.click('#journey-back');
  await panel.click('#panel-journey');
  await until(() => panel.visible('#journey-history'), 'saved history');
  assert.match(await panel.text('#journey-history'), /Oat milk/);
  await panel.screenshot('journey-history');
  console.log('PASS journey history remains available after closing and reopening the sidebar view');

  if (!await panel.evaluate(`document.querySelector('#journey-timeline li[data-step="2"] details').open`)) await panel.click('#journey-timeline li[data-step="2"] summary');
  await panel.click('#journey-timeline li[data-step="2"] .journey-ask-step');
  await panel.fill('#journey-question', 'Why did you choose New instead of the setup wizard?');
  await panel.click('#journey-ask');
  await until(() => panel.visible('.journey-pending-exchange'), 'immediate pending user message');
  assert.equal(await panel.visible('.journey-chat-typing'), true);
  assert.equal(await panel.evaluate('document.querySelector("#journey-question").value'), '');
  await until(() => panel.text('#journey-conversation').then(value => value.includes('that route was not tested')), 'grounded follow-up answer');
  assert.equal((await currentRun()).followUps.length, 1);
  assert.equal((await currentRun()).followUps[0].stepIndex, 2);
  assert.equal(page.url(), `${origin}/ingredients`, 'Asking a question must not operate the app');
  await panel.fill('#journey-question', 'How would a new teammate interpret that action?');
  await panel.enter('#journey-question');
  await until(async () => (await currentRun()).followUps?.length === 2, 'second answer submitted with Enter');
  assert.equal((await worker.evaluate(() => __journeyFollowUpRequests))[1].previousAnswers, 1, 'Follow-up request includes the preceding exchange');
  await worker.evaluate(() => { globalThis.__journeyFollowUpFailOnce = true; });
  const retryQuestion = 'What label would make the next step clearer?';
  await panel.fill('#journey-question', retryQuestion);
  await panel.enter('#journey-question');
  await until(() => panel.visible('#journey-question-error'), 'failed answer shows a retryable error');
  assert.equal(await panel.evaluate('document.querySelector("#journey-question").value'), retryQuestion, 'A failed request restores the question');
  assert.equal(await panel.visible('.journey-pending-exchange'), false);
  assert.equal((await currentRun()).followUps.length, 2, 'Failed follow-ups do not duplicate the transcript');
  await panel.enter('#journey-question');
  await until(async () => (await currentRun()).followUps?.length === 3, 'retry answer persisted');
  await until(() => panel.evaluate('!document.querySelector("#journey-ask").disabled'), 'chat request finished');
  const answered = await currentRun();
  assert.equal(answered.followUps[2].question, retryQuestion);
  assert.equal(page.url(), `${origin}/ingredients`, 'Multi-turn discussion must not operate the app');
  await panel.screenshot('journey-follow-up');
  const chatViewport = await panel.evaluate(`(()=>{const selectors=['#journey-chat-back','#journey-question','#journey-ask'];return selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return{selector,visible:el.checkVisibility(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})})()`);
  for (const control of chatViewport) assert.ok(control.visible && control.left >= 0 && control.right <= control.width + 1 && control.top >= 0 && control.bottom <= control.height + 1, `Chat control clipped: ${JSON.stringify(control)}`);
  await checkNarrowChat();
  console.log('PASS dedicated chat shows pending messages, keeps multi-turn context, submits with Enter and safely retries a failed answer');
  await panel.click('.journey-fork-proposal');
  assert.match(await panel.text('#journey-fork-description'), /Existing app data is not reset/);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyPersona.read()'), persona);
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyOptions.read()'), settings);
  await panel.fill('#journey-goal', 'Add Rice milk to Ingredients using ml. Use the setup wizard and verify the saved row.');
  assert.equal(await panel.evaluate('document.querySelector("#journey-route").value'), answered.followUps[0].routeSuggestion.instructions);
  await panel.screenshot('journey-fork-setup');
  await panel.click('#journey-start');
  await until(async () => (await currentRun())?.id !== run.id && (await currentRun())?.status === 'completed' && (await currentRun())?.recording?.status === 'saved', 'fork completed', 60000);
  const forked = await currentRun();
  assert.deepEqual(forked.persona, persona);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(forked[key], value, `Fork inherited ${key}`);
  assert.equal(forked.fork.parentRunId, run.id);
  assert.equal(forked.fork.stepIndex, 2);
  assert.equal(forked.startUrl, `${origin}/`);
  assert.equal(forked.steps[0].observation.url, `${origin}/`);
  assert.ok(forked.steps.some(step => step.observation.url === `${origin}/wizard`));
  assert.match(await page.locator('tbody').textContent(), /Oat milk.*Rice milk/s);
  const retained = await worker.evaluate(id => __journeyStore.getJourney(id), run.id);
  assert.equal(retained.followUps.length, 3);
  assert.equal(retained.video.dataUrl, run.video.dataUrl, 'Fork keeps the original recording intact');
  await until(() => panel.text('#journey-lineage').then(value => value.includes('Alternative route')), 'fork lineage');
  await panel.screenshot('journey-fork-completed');
  console.log('PASS step follow-up persists an answer without actions, proposes an editable alternative, reruns from the original start through the wizard, and preserves original evidence and existing app data');
  await until(() => panel.text('#journey-history-list').then(value => value.includes('Rice milk')), 'fork history refreshed');
  await panel.click('#journey-history summary');
  const originalHistoryIndex = await panel.evaluate(`Array.from(document.querySelectorAll('#journey-history-list button')).findIndex(button => button.textContent.includes('Add Oat milk')) + 1`);
  await panel.click(`#journey-history-list button:nth-child(${originalHistoryIndex})`);
  await until(() => panel.text('#journey-run-goal').then(value => value.includes('Oat milk')), 'original journey restored');
  await panel.click('#journey-chat-open');
  assert.match(await panel.text('#journey-conversation'), /setup wizard/);
  assert.match(await panel.text('#journey-conversation'), /new teammate/);
  assert.match(await panel.text('#journey-conversation'), /next step clearer/);
  await panel.click('.journey-fork-proposal');
  await until(() => panel.visible('#journey-fork-fields'), 'older journey fork form');
  await panel.fill('#journey-route', 'Try the wizard with another test ingredient.');
  await pause(7600); // A normal finished-run poll must not replace an older parent form.
  assert.equal(await panel.visible('#journey-fork-fields'), true);
  assert.equal(await panel.evaluate('document.querySelector("#journey-route").value'), 'Try the wizard with another test ingredient.');
  await panel.click('#journey-fork-cancel');
  assert.match(await panel.text('#journey-run-goal'), /Oat milk/);
  console.log('PASS saved conversation reloads with its original journey and an older fork draft survives polling');
  await panel.click('#journey-new');
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyPersona.read()'), DEFAULT_JOURNEY_PERSONA, 'A new journey starts with the default persona');
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyOptions.read()'), DEFAULT_JOURNEY_SETTINGS, 'A new journey resets exploration and checks');
  await panel.fill('#journey-goal', 'Add Soy milk to Ingredients using ml. Confirm that exactly one matching record exists.');
  const callsBeforeStop = await worker.evaluate(() => __journeyDecisionCalls);
  const continuationStartUrl = page.url();
  await panel.click('#journey-start');
  await until(() => worker.evaluate(previous => __journeyDecisionCalls > previous, callsBeforeStop), 'new journey awaiting its first decision');
  await until(() => panel.evaluate('document.querySelector("#journey-stop").checkVisibility() && !document.querySelector("#journey-stop").disabled'), 'Stop ready after journey creation');
  await panel.click('#journey-stop');
  await until(async () => (await currentRun())?.status === 'stopped' && (await currentRun())?.recording?.status === 'saved', 'stopped journey and recording saved');
  const stopped = await currentRun();
  assert.equal(page.url(), continuationStartUrl, 'Stop cancels the outstanding decision before navigation');
  assert.equal(await page.locator('tbody').textContent().then(value => value.includes('Soy milk')), false);
  await until(() => panel.visible('#journey-continue'), 'continue a stopped journey');
  await panel.click('#journey-continue');
  assert.deepEqual(await panel.evaluate('window.diffuseJourneyPersona.read()'), stopped.persona);
  assert.equal(await panel.evaluate('document.querySelector("#journey-goal").value'), stopped.goal);
  await panel.fill('#journey-route', 'Continue from Ingredients and create Soy milk only if it is absent.');
  await panel.click('#journey-start');
  await until(async () => {const current = await currentRun(); return current?.id !== stopped.id && current?.status === 'completed' && current?.recording?.status === 'saved';}, 'continued journey completed', 60000);
  const continued = await currentRun();
  assert.equal(continued.continuation.parentRunId, stopped.id);
  assert.equal(continued.startUrl, continuationStartUrl, 'Continuation keeps the current page instead of returning to the original journey start');
  assert.equal(continued.steps[0].observation.url, continuationStartUrl);
  assert.deepEqual(continued.persona, stopped.persona);
  for (const key of Object.keys(DEFAULT_JOURNEY_SETTINGS)) assert.deepEqual(continued[key], stopped[key], `Continuation inherited ${key}`);
  const savedEntries = await page.evaluate(() => JSON.parse(localStorage.getItem('ingredients')));
  assert.equal(savedEntries.filter(entry => entry.name === 'Soy milk').length, 1);
  assert.equal((await worker.evaluate(id => __journeyStore.getJourney(id), stopped.id)).video.dataUrl, stopped.video.dataUrl, 'Continue preserves the previous recording');
  await panel.screenshot('journey-continued');
  console.log('PASS stopped journey continues as a linked recording from the current page, inherits its profile and checks, and preserves the original evidence');

  // An AI blocker is an unanswered question, not proof that the product failed.
  // This fixture creates a record before asking for guidance, so continuing
  // must retain the existing app state and must not repeat the creation.
  await until(() => panel.evaluate('document.querySelector("#journey-new").checkVisibility() && !document.querySelector("#journey-new").disabled'), 'finished journey actions ready');
  await panel.click('#journey-new');
  await panel.fill('#journey-goal', 'Add Almond milk to Ingredients using ml and verify the saved record.');
  await panel.click('#journey-start');
  await until(async () => {const current = await currentRun(); return current?.goal.includes('Almond milk') && current.status === 'blocked' && current.recording?.status === 'saved';}, 'blocked journey asks for help', 60000);
  const blocked = await currentRun();
  assert.match(blocked.assistance.question, /Almond milk.*verify the row/);
  assert.equal(blocked.findings.length, 0, 'Uncertainty must not automatically become a UX defect');
  await until(() => panel.visible('#journey-help-question'), 'blocker automatically opens conversational help');
  assert.match(await panel.text('#journey-help-question'), /Almond milk/);
  assert.equal(await panel.visible('#journey-question'), true);
  assert.equal(await panel.visible('#journey-help-stop'), true);
  assert.match(await panel.text('#journey-ask'), /Continue/);
  assert.equal(await panel.evaluate('document.querySelector("#journey-help-classification").value'), 'unsure');
  await panel.screenshot('journey-blocked-help');
  await checkNarrowChat({assistance: true});
  const blockedUrl = page.url();
  await panel.click('#journey-chat-back');
  await pause(7600);
  assert.equal(await panel.visible('#journey-help-question'), false, 'Polling must respect a manually closed help conversation');
  assert.equal(page.url(), blockedUrl, 'Waiting for reviewer guidance must not operate the app');
  await panel.evaluate('document.documentElement.dataset.nativeTestReload="pending"');
  await panel.reload();
  await until(async () => {
    try { return await panel.evaluate('!document.documentElement.dataset.nativeTestReload && document.querySelector("#popup")?.getAttribute("aria-busy")==="false"'); }
    catch { return false; } // The old execution context briefly disappears.
  }, 'sidebar reloaded');
  await until(() => panel.visible('#panel-journey'), 'journey entry after reload');
  await panel.click('#panel-journey');
  await until(async () => await panel.visible('#journey-help-question') || await panel.visible('#journey-help-open'), 'saved blocker offers help after reload');
  if (!await panel.visible('#journey-help-question')) await panel.click('#journey-help-open');
  await until(() => panel.visible('#journey-help-question'), 'saved blocker help restored');
  assert.equal(await panel.text('#journey-help-question p'), blocked.assistance.question);
  const guidance = 'The existing table row confirms success. Verify Almond milk with ml here and finish. Do not create it again.';
  await panel.fill('#journey-help-classification', 'ai_missed');
  await panel.fill('#journey-question', guidance);
  await panel.click('#journey-ask');
  await until(async () => {const current = await currentRun(); return current?.continuation?.parentRunId === blocked.id && current.status === 'completed' && current.recording?.status === 'saved';}, 'classified help continues the blocked journey', 60000);
  const assisted = await currentRun();
  const answeredBlocker = await worker.evaluate(id => __journeyStore.getJourney(id), blocked.id);
  assert.equal(answeredBlocker.assistance.response.text, guidance);
  assert.equal(answeredBlocker.assistance.response.classification, 'ai_missed');
  assert.equal(answeredBlocker.assistance.response.decision, 'continue');
  assert.equal(assisted.startUrl, blockedUrl);
  assert.equal(assisted.steps[0].observation.url, blockedUrl);
  assert.equal(assisted.metrics.actions, 0, 'Guided verification should not recreate an already saved record');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ingredients')).filter(item => item.name === 'Almond milk').length), 1);
  const assistedProfiles = await worker.evaluate(parent => __journeyProfiles.filter(item => item.continuation?.parentRunId === parent), blocked.id);
  assert.ok(assistedProfiles.length > 0);
  for (const profile of assistedProfiles) assert.equal(profile.assistance.response.classification, 'ai_missed');
  assert.equal(answeredBlocker.video.dataUrl, blocked.video.dataUrl, 'Assistance preserves the blocked recording');
  await panel.screenshot('journey-assisted-completed');
  console.log('PASS blocked journey automatically asks for help, respects manual close, restores the saved question after reload and continues from the existing record using classified reviewer guidance');

  await until(() => panel.evaluate('document.querySelector("#journey-new").checkVisibility() && !document.querySelector("#journey-new").disabled'), 'assisted journey actions ready');
  await panel.click('#journey-new');
  await panel.fill('#journey-goal', 'Add Hazelnut milk to Ingredients using ml and verify the saved record.');
  await panel.click('#journey-start');
  await until(async () => {const current = await currentRun(); return current?.goal.includes('Hazelnut milk') && current.status === 'blocked' && current.recording?.status === 'saved';}, 'second blocker ready', 60000);
  const stopBlocker = await currentRun();
  await until(() => panel.visible('#journey-help-question'), 'second blocker help opens');
  await panel.fill('#journey-help-classification', 'experience_issue');
  await panel.fill('#journey-question', 'Stop here. The confirmation does not make it clear that the ingredient was saved.');
  const callsBeforeHelpStop = await worker.evaluate(() => __journeyDecisionCalls);
  await panel.click('#journey-help-stop');
  await until(async () => (await currentRun())?.assistance?.response?.decision === 'stop', 'stop decision saved with reviewer context');
  await until(() => panel.visible('#journey-help-response'), 'saved stop response shown in the conversation');
  assert.match(await panel.text('#journey-help-response'), /confirmation does not make it clear/);
  assert.match(await panel.text('#journey-status'), /Stopped by you/);
  assert.equal(await panel.visible('#journey-help-stop'), false, 'An answered blocker no longer asks the reviewer to choose again');
  const stoppedBlocker = await currentRun();
  assert.equal(stoppedBlocker.id, stopBlocker.id, 'Stop does not create a continuation');
  assert.equal(stoppedBlocker.assistance.response.classification, 'experience_issue');
  assert.deepEqual(stoppedBlocker.scores, stopBlocker.scores, 'Reviewer classification does not rewrite AI scores');
  assert.deepEqual(stoppedBlocker.findings, stopBlocker.findings, 'Reviewer classification does not create findings automatically');
  assert.equal(await worker.evaluate(() => __journeyDecisionCalls), callsBeforeHelpStop);
  assert.equal(stoppedBlocker.video.dataUrl, stopBlocker.video.dataUrl);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ingredients')).filter(item => item.name === 'Hazelnut milk').length), 1);
  await panel.screenshot('journey-help-stopped');
  console.log('PASS Stop journey saves the classified reviewer explanation without launching a new run or changing the existing app record');
  await writeFile(join(artifacts, 'journey-browser-verification.json'), JSON.stringify({
    status: run.status, pages: [...new Set(run.steps.map(step => step.observation.url))],
    steps: run.steps.length, findings: run.findings.length, metrics: run.metrics,
    acceptedCommentId: comment.id, screenshots: run.steps.filter(step => step.observation.screenshot).length,
    video: {bytes: run.video.bytes, durationMs: run.video.durationMs, width: run.video.width, height: run.video.height},
  }, null, 2));
} catch (error) {
  if (panel) await panel.screenshot('journey-failure').catch(() => {});
  if (worker) console.error('Journey state at failure:', await worker.evaluate(async () => {
    const session = (await chrome.storage.session.get('comparison')).comparison;
    const run = session?.journey?.id ? await __journeyStore.getJourney(session.journey.id) : null;
    return run ? {status: run.status, goal: run.goal, summary: run.summary, recording: run.recording, recordingError: run.recordingError, assistance: run.assistance, steps: run.steps.map(step => ({index: step.index, url: step.observation.url, action: step.action, reason: step.reason}))} : null;
  }).catch(() => null));
  throw error;
} finally {
  await context?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, {recursive: true, force: true});
}
