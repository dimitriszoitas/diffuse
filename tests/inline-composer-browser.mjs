// In-page authoring regression. Real keyboard/pointer/browser layout with a
// disposable runtime double; no user profile, API key, or external service.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = resolve(project, 'artifacts/inline-composer');
await mkdir(artifacts, {recursive:true});
const browser = await chromium.launch({headless:true, args:['--use-mock-keychain', '--password-store=basic']});
const results = [], errors = [];
let page;
const pass = label => { results.push(label); console.log(`PASS ${label}`); };

try {
  page = await browser.newPage({viewport:{width:1440, height:1000}});
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head><title>Atlas · Inline comment fixture</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#21334b;font:15px/1.5 system-ui}header{height:72px;padding:0 42px;background:white;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e0e6ef}header b{font-size:25px;letter-spacing:-1px}header span{color:#78869b}main{max-width:1270px;padding:58px 50px;margin:auto}h1{font-size:35px;margin:0 0 8px;letter-spacing:-1.2px}.intro{margin:0 0 38px;color:#708096}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.metric{background:white;border:1px solid #dde5f0;border-radius:12px;padding:26px}.metric h2{font-size:14px;font-weight:500;color:#6e809b;margin:0 0 18px}.metric strong{font-size:40px;color:#1d304a}.metric p{font-size:13px;color:#8190a4;margin-top:15px}.metric:nth-child(3){background:#edf2ff}.section-heading{display:flex;align-items:center;justify-content:space-between;margin:34px 0 20px}.section-heading h2{font-size:20px;margin:0}button{font:inherit;cursor:pointer}#action{padding:12px 18px;background:#335fe7;border:0;border-radius:7px;color:white;box-shadow:0 3px 8px #335fe721}#region{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;height:240px}.release{border:1px solid #dee5ef;background:white;border-radius:12px;overflow:hidden}.art{height:145px;background:#dae5ff;position:relative;overflow:hidden}.art:after{content:'';position:absolute;width:130px;height:130px;border:24px solid #6d91e0;border-radius:50%;left:32%;top:30px}.release:nth-child(2) .art{background:#f7dfcf}.release:nth-child(2) .art:after{border-color:#cd876d}.release:nth-child(3) .art{background:#e6e0f1}.release:nth-child(3) .art:after{border-color:#a794c7}.release p{padding:0 20px;font-weight:600}.typing{margin-top:36px;padding:12px;border:1px solid #d3deeb;border-radius:6px;width:270px}#edge-target{position:fixed;right:10px;bottom:10px;padding:9px;background:#fff;border:1px solid #cdd8e9;border-radius:6px;color:#334a69}#page-footer{height:300px}@media(max-width:650px){header{padding:0 22px}header span{display:none}main{padding:28px 20px}.metrics{grid-template-columns:1fr}.metric:not(:first-child){display:none}h1{font-size:28px}#region{grid-template-columns:1fr}.release:not(:first-child){display:none}.section-heading{gap:14px}}
    </style></head><body><header><b>atlas.</b><span>Workspace &nbsp; / &nbsp; Overview</span></header><main><h1>Good morning, Alex.</h1><p class="intro">Good ideas deserve a thoughtful release.</p><section class="metrics"><article class="metric"><h2>Active releases</h2><strong>6</strong><p>2 new this month</p></article><article class="metric"><h2>Ready for review</h2><strong>2</strong><p>Fresh eyes make better work.</p></article><article class="metric"><h2>Next milestone</h2><strong>4 days</strong><p>Aurora · Team preview</p></article></section><div class="section-heading"><h2>In the spotlight</h2><button id="action" data-component="CreateReleaseButton">New item</button></div><section id="region"><article class="release"><div class="art"></div><p>Aurora onboarding</p></article><article class="release"><div class="art"></div><p>Search, reimagined</p></article><article class="release"><div class="art"></div><p>Studio permissions</p></article></section><input id="typing" class="typing" placeholder="Page input stays editable"><div id="page-footer"></div></main><button id="edge-target">Corner target</button></body></html>`);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 150;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#edf2fa'; ctx.fillRect(0,0,240,150);ctx.fillStyle='#335fe7';ctx.fillRect(150,90,70,20);ctx.fillStyle='#172f4f';ctx.font='bold 16px sans-serif';ctx.fillText('Atlas overview',16,30);
    const dataUrl = canvas.toDataURL();
    const listeners = [];
    window.calls = []; window.draft = null; window.saved = []; window.actionCount = 0; window.pointerCount = 0;
    document.getElementById('action').onclick = () => window.actionCount++;
    document.getElementById('action').onpointerdown = () => window.pointerCount++;
    window.chrome = {runtime:{id:'inline-fixture', onMessage:{addListener(fn){listeners.push(fn);}}, async sendMessage(message){
      window.calls.push(message);
      if(message.type==='GET_APPEARANCE') return {ok:true, preference:'light'};
      if(message.type==='GET_AI_CONFIG') return {ok:true, config:{hasKey:false, model:'fixture', threshold:35}};
      if(message.type==='GET_AI_SUGGESTIONS') return {ok:true, batch:null};
      if(message.type==='CAPTURE_COMMENT') {
        if(window.holdCapture) await new Promise(resolve => {window.releaseCapture=resolve;});
        if(window.rejectNextCapture) {
          window.rejectNextCapture=false;
          return {ok:false,error:'The screenshot could not be attached. Try again.'};
        }
        window.draft = {id:`draft-${window.calls.length}`, selection:message.selection, evidence:{production:{dataUrl},prototype:{dataUrl}}};
        return {ok:true, draft:window.draft};
      }
      if(message.type==='ADD_COMMENT') {
        window.saved.push(message);
        const comment = {id:`comment-${window.saved.length}`, createdAt:new Date().toISOString(), fields:message.fields, selection:window.draft.selection, context:{production:{url:location.href,viewport:{width:innerWidth,height:innerHeight}}}};
        return {ok:true, review:{id:'review', count:window.saved.length}, comment};
      }
      if(message.type==='START_RECORDING') return {ok:true, recording:{id:'recording-inline', startedAt:Date.now(), draftId:message.draftId}};
      return {ok:true};
    }}};
    window.deliver = message => new Promise(resolve => {
      for(const listener of listeners) listener({namespace:'diffuse', sessionId:'review', ...message},{id:'inline-fixture'},resolve);
    });
  });
  for(const file of ['theme.js','theme-content.js','select-controls.js','inspector.js','content.js']) {
    await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  }
  const deliver = message => page.evaluate(message => window.deliver(message), message);
  const command = (action, payload={}) => deliver({type:'PANEL_COMMAND', action, ...payload});
  const state = async () => (await deliver({type:'PANEL_STATE'})).state;
  const overlay = page.locator('diffuse-live-overlay');
  const panel = overlay.locator('#comment-panel');
  const comment = overlay.locator('#comment-actual');
  const reviewSession = {id:'review', mode:'audit', status:'live', settings:{opacity:.55,reveal:50,linked:false,offsetX:0,offsetY:0}, comments:[]};
  await deliver({type:'INITIALIZE', role:'target', session:reviewSession});
  await deliver({type:'DOCK_STATE', docked:true});
  const tapC = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('c'); await page.keyboard.up('c');
    assert.equal((await state()).picking,true,'C remains armed after key release');
  };
  const openAt = async selector => {
    await tapC(); await page.locator(selector).click();
    await comment.waitFor({state:'visible'});
    assert.equal(await comment.evaluate(node => node.getRootNode().activeElement===node),true,'Typing starts in the page comment');
    assert.equal(await overlay.locator('#comment-draft-pin').isVisible(),true,'A draft pin identifies the selected point');
  };
  const cancel = async () => {
    await overlay.locator('#cancel-comment').click();
    await panel.waitFor({state:'hidden'});
    assert.equal(await overlay.locator('#comment-draft-pin').isVisible(),false);
  };
  const selectControl = id => overlay.locator(`[data-diffuse-select-for="${id}"] .df-select-trigger`);
  const choose = async (id, value, label) => {
    if(await selectControl(id).count()) {
      await selectControl(id).click();
      await overlay.getByRole('option',{name:label,exact:true}).click();
    } else {
      assert.equal(await overlay.locator(`#${id}`).isVisible(),true);
      await overlay.locator(`#${id}`).selectOption(value);
    }
    assert.equal(await overlay.locator(`#${id}`).inputValue(),value);
  };
  const inViewport = async label => {
    const bounds = await panel.boundingBox(), viewport = page.viewportSize();
    assert.ok(bounds, `${label} composer has bounds`);
    assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=viewport.width+1 && bounds.y+bounds.height<=viewport.height+1, `${label} composer stays visible: ${JSON.stringify(bounds)}`);
    const save = await overlay.locator('#save-comment').boundingBox();
    assert.ok(save.y>=bounds.y && save.y+save.height<=viewport.height+1, `${label} save remains reachable`);
  };

  await openAt('#action');
  assert.equal(await page.evaluate(() => actionCount),0);
  assert.equal(await page.evaluate(() => pointerCount),0);
  assert.equal(await page.evaluate(() => window.draft.selection.selector),'#action');
  assert.equal(await overlay.locator('#panel-backdrop').isVisible(),false,'A comment bubble does not dim or cover the whole page');
  assert.equal(await panel.getAttribute('aria-modal'),'false');
  await page.keyboard.type('Rename this action to Create release so the next step is clear.');
  assert.match(await comment.inputValue(),/^Rename this action/);
  for(const id of ['comment-title','comment-component','comment-state']) assert.equal(await overlay.locator(`#${id}`).isVisible(),false,`${id} is not an authoring field`);
  assert.equal(await overlay.locator('#comment-details').evaluate(node => node.open),false);
  assert.equal(await overlay.locator('#comment-steps').isVisible(),false);
  assert.equal(await overlay.locator('.df-severity-options').isVisible(),false,'Severity is a compact dropdown, not a radio group');
  const panelBounds = await panel.boundingBox();
  for(const id of ['comment-category','comment-severity']) {
    const control = await selectControl(id).count() ? selectControl(id) : overlay.locator(`#${id}`);
    const bounds = await control.boundingBox();
    assert.ok(bounds.height<=38,`${id} badge is compact`);
    assert.ok(bounds.y>=panelBounds.y && bounds.y+ bounds.height<=panelBounds.y+105,`${id} stays in the header`);
    assert.ok(bounds.x>=panelBounds.x+panelBounds.width*.3,`${id} badge is right-aligned`);
  }
  await inViewport('desktop');
  await page.screenshot({path:resolve(artifacts,'light-inline-comment.png')});
  pass('Tap C and click opens a focused page bubble and pin while docked, suppresses the page action, and keeps a compact header');

  const pageBackground = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  const light = await panel.evaluate(node => getComputedStyle(node).backgroundColor);
  await deliver({type:'APPEARANCE_CHANGED',preference:'dark'});
  const dark = await panel.evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(dark,light);
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor),pageBackground);
  await page.screenshot({path:resolve(artifacts,'dark-inline-comment.png')});
  await deliver({type:'APPEARANCE_CHANGED',preference:'light'});
  pass('Dark and light appearance change the comment bubble without changing the reviewed site');

  await choose('comment-category','copy-change','Copy change');
  await choose('comment-severity','major','Major');
  await overlay.locator('#comment-expected').fill('Use the same action label on desktop and mobile.');
  await overlay.locator('#comment-details > summary').click();
  await overlay.locator('#comment-steps').fill('Open the overview.\nFind the action beside In the spotlight.');
  const typed = await comment.inputValue();
  await deliver({type:'DOCK_STATE',docked:false});
  assert.equal(await panel.isVisible(),true);
  await deliver({type:'DOCK_STATE',docked:true});
  assert.equal(await comment.inputValue(),typed);
  await overlay.locator('#save-comment').click();
  await panel.waitFor({state:'hidden'});
  const saved = await page.evaluate(() => window.saved.at(-1));
  assert.equal(saved.fields.comment,typed);
  assert.equal(saved.fields.expected,'Use the same action label on desktop and mobile.');
  assert.equal(saved.fields.category,'copy-change'); assert.equal(saved.fields.severity,'major');
  assert.equal(saved.fields.steps,'Open the overview.\nFind the action beside In the spotlight.');
  assert.equal(saved.evidenceChoice,'screenshot');
  assert.ok(!saved.fields.title,'No title is required to save a comment');
  assert.equal(await overlay.locator('#comment-draft-pin').isVisible(),false);
  assert.equal(await overlay.locator('#comment-pins .comment-pin').count(),1);
  pass('Comment, expected result, badge selections, and optional steps save as one screenshot-backed comment without a title/state form');

  // Releasing C during the drag must still finish the area selection.
  await page.evaluate(() => document.activeElement?.blur());
  const region = await page.locator('#region').boundingBox();
  const point = {x:region.x+28,y:region.y+32};
  await page.keyboard.down('c'); await page.mouse.move(point.x,point.y); await page.mouse.down();
  await page.mouse.move(point.x+170,point.y+95,{steps:8}); await page.keyboard.up('c'); await page.mouse.up();
  await comment.waitFor({state:'visible'});
  const area = await page.evaluate(() => window.draft.selection);
  assert.equal(area.kind,'region'); assert.equal(area.rect.viewport.width,170); assert.equal(area.rect.viewport.height,95);
  assert.equal(await overlay.locator('#comment-details').evaluate(node => node.open),false,'A fresh area starts with optional details closed');
  await comment.fill('The visual needs more breathing room.');
  await page.screenshot({path:resolve(artifacts,'area-inline-comment.png')});
  await cancel();
  pass('C plus drag opens the same inline authoring bubble for an area and cancellation removes its draft pin');

  await openAt('#edge-target'); await inViewport('bottom-right');
  await page.screenshot({path:resolve(artifacts,'corner-inline-comment.png')});
  await cancel();
  await page.setViewportSize({width:390,height:844});
  await openAt('#edge-target'); await inViewport('phone');
  await comment.fill('Keep this control clear of the mobile navigation.');
  await page.screenshot({path:resolve(artifacts,'phone-inline-comment.png')});
  await cancel();
  await page.setViewportSize({width:1440,height:1000});
  pass('Corner and phone selections keep the whole bubble and Save action inside the viewport');

  await page.evaluate(() => {window.holdCapture=true;});
  await openAt('#action');
  assert.equal((await state()).captureBusy,true);
  assert.equal(await overlay.locator('#save-comment').isDisabled(),true);
  await page.keyboard.type('I can write ');
  await deliver({type:'PREPARE_EVIDENCE'});
  assert.equal(await comment.evaluate(node => node.getRootNode().activeElement===node),true,'Hiding overlay pixels for screenshot capture must not blur the textarea');
  assert.equal(await overlay.evaluate(node => getComputedStyle(node).opacity),'0');
  await page.keyboard.type('while the screenshot is being attached.');
  await page.screenshot({path:resolve(artifacts,'page-during-evidence-capture.png')});
  await deliver({type:'RESTORE_EVIDENCE'});
  assert.equal(await comment.evaluate(node => node.getRootNode().activeElement===node),true);
  assert.equal(await comment.inputValue(),'I can write while the screenshot is being attached.');
  await choose('comment-category','copy-change','Copy change');
  await choose('comment-severity','major','Major');
  await page.evaluate(() => {window.holdCapture=false; window.releaseCapture();});
  await page.waitForFunction(() => document.querySelector('diffuse-live-overlay').shadowRoot.getElementById('save-comment').disabled===false);
  assert.equal(await comment.inputValue(),'I can write while the screenshot is being attached.');
  assert.equal(await overlay.locator('#comment-category').inputValue(),'copy-change');
  assert.equal(await overlay.locator('#comment-severity').inputValue(),'major');
  await cancel();
  pass('The bubble preserves typing and focus while real evidence preparation hides its pixels, then retains edits when capture finishes');

  await page.evaluate(() => {window.holdCapture=true;window.rejectNextCapture=true;});
  await openAt('#action');
  const retryText='Keep this comment even if the screenshot cannot be attached.';
  await comment.fill(retryText);
  await overlay.locator('#comment-expected').fill('The action clearly explains its destination.');
  await choose('comment-category','copy-change','Copy change');
  await choose('comment-severity','major','Major');
  await overlay.locator('#comment-details > summary').click();
  await overlay.locator('#comment-steps').fill('Open the overview and inspect the main action.');
  await page.evaluate(() => {window.holdCapture=false;window.releaseCapture();});
  await overlay.locator('#retry-capture').waitFor({state:'visible'});
  const failedState=await state();
  assert.equal(failedState.captureBusy,false);
  assert.equal(failedState.comment,null,'No stored draft exists before screenshot capture succeeds');
  assert.equal(failedState.commentOpen,true,'Unsaved text is still an active composer');
  assert.equal(await comment.inputValue(),retryText);
  await page.locator('#action').focus();await page.keyboard.press('c');
  assert.equal((await state()).picking,false,'C cannot discard a failed-capture comment');
  const callsBefore=await page.evaluate(() => window.calls.length);
  for(const action of ['selectElement','selectArea','openAi','runAi','record']) await command(action);
  assert.equal((await command('openDiff')).ok,false);
  await overlay.locator('#viewport-controls button[data-preset="phone"]').evaluate(node => node.click());
  const blockedCalls=await page.evaluate(start => window.calls.slice(start).filter(call => ['CAPTURE_COMMENT','RUN_AI_REVIEW','START_RECORDING','OPEN_DIFF','VIEWPORT_PRESET'].includes(call.type)).map(call=>call.type),callsBefore);
  assert.deepEqual(blockedCalls,[],'Failed-capture text blocks operations that could replace its context');
  assert.equal((await state()).picking,false);assert.equal((await state()).areaArmed,false);
  assert.equal(await panel.isVisible(),true);assert.equal(await overlay.locator('#ai-panel').isVisible(),false);
  assert.equal(await comment.inputValue(),retryText);
  await overlay.locator('#retry-capture').click();
  await page.waitForFunction(() => document.querySelector('diffuse-live-overlay').shadowRoot.getElementById('save-comment').disabled===false);
  assert.equal(await comment.inputValue(),retryText);
  assert.equal(await overlay.locator('#comment-expected').inputValue(),'The action clearly explains its destination.');
  assert.equal(await overlay.locator('#comment-category').inputValue(),'copy-change');
  assert.equal(await overlay.locator('#comment-severity').inputValue(),'major');
  assert.equal(await overlay.locator('#comment-steps').inputValue(),'Open the overview and inspect the main action.');
  await overlay.locator('#save-comment').click();await panel.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => window.saved.at(-1).fields.comment),retryText);
  pass('Failed screenshot capture retains all typed fields, blocks competing tools, and retries into a saved comment');

  await openAt('#action');
  await comment.fill('The transition jumps before the detail screen appears.');
  await overlay.locator('#comment-expected').fill('Keep the transition continuous.');
  await choose('comment-severity','critical','Critical');
  await overlay.locator('#comment-details > summary').click();
  await overlay.locator('#comment-steps').fill('Open the release and watch the panel.');
  await overlay.locator('#comment-evidence > summary').click();
  await overlay.locator('#evidence-recording').click();
  await overlay.locator('#comment-record').click();
  await panel.waitFor({state:'hidden'});
  const recordingState = await state();
  assert.equal(recordingState.recording.id,'recording-inline');
  assert.equal(recordingState.comment.fields.comment,'The transition jumps before the detail screen appears.');
  const previousKey = recordingState.comment.evidenceKey;
  await page.evaluate(async () => {
    window.draft.evidence.video = {dataUrl:'data:video/webm;base64,AA==',recordingId:'recording-inline'};
    await window.deliver({type:'RECORDING_STOPPED',draft:window.draft});
  });
  await comment.waitFor({state:'visible'});
  assert.equal(await comment.inputValue(),'The transition jumps before the detail screen appears.');
  assert.equal(await overlay.locator('#comment-expected').inputValue(),'Keep the transition continuous.');
  assert.equal(await overlay.locator('#comment-severity').inputValue(),'critical');
  assert.equal(await overlay.locator('#comment-steps').inputValue(),'Open the release and watch the panel.');
  assert.notEqual((await state()).comment.evidenceKey,previousKey);
  await overlay.locator('#save-comment').click();
  await panel.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(() => window.saved.at(-1).evidenceChoice),'video');
  pass('Short recording temporarily clears the bubble, restores the same text and metadata, and saves video evidence');

  await page.locator('#typing').click(); await page.keyboard.press('c');
  assert.equal(await page.locator('#typing').inputValue(),'c');
  assert.equal((await state()).picking,false);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+c'); assert.equal((await state()).picking,false);
  await openAt('#action');
  await page.keyboard.type('c');
  assert.equal(await comment.inputValue(),'c');
  await page.keyboard.press('Escape'); await panel.waitFor({state:'hidden'});
  assert.equal(await overlay.locator('#comment-draft-pin').isVisible(),false);
  await page.locator('#action').click(); assert.equal(await page.evaluate(() => actionCount),1);
  assert.deepEqual(errors,[]);
  pass('Typing C in the page or composer stays ordinary text, modified shortcuts stay untouched, and Escape restores page interaction');

  // Losing extension context before a stored draft exists must still leave the
  // locally typed text visible for copying, without replaying a pending save.
  await page.evaluate(() => {window.holdCapture=true;window.rejectNextCapture=true;});
  await openAt('#action');
  const unsavedText='Unsaved text remains available to copy after an extension reload.';
  await comment.fill(unsavedText);
  await page.evaluate(() => {window.holdCapture=false;window.releaseCapture();});
  await overlay.locator('#retry-capture').waitFor({state:'visible'});
  const savedCount=await page.evaluate(() => window.saved.length);
  await page.evaluate(() => {window.chrome.runtime.id=undefined;});
  await overlay.locator('#context-reload-notice').waitFor({state:'visible'});
  assert.equal(await panel.isVisible(),true);
  assert.equal(await comment.inputValue(),unsavedText);
  assert.equal(await comment.evaluate(node => node.readOnly),true);
  assert.equal(await overlay.locator('#save-comment').isDisabled(),true);
  assert.equal(await page.evaluate(() => window.saved.length),savedCount);
  pass('Extension invalidation before draft creation keeps unsaved text visible and read-only without saving or discarding it');
  await writeFile(resolve(artifacts,'results.json'),JSON.stringify({localOnly:true,checks:results.length,results,screenshots:['light-inline-comment.png','dark-inline-comment.png','area-inline-comment.png','corner-inline-comment.png','phone-inline-comment.png','page-during-evidence-capture.png']},null,2));
  console.log(`${results.length} inline composer checks passed.`);
} catch(error) {
  if(page) {
    await page.screenshot({path:resolve(artifacts,'failure.png')}).catch(()=>{});
    const diagnostic = await page.evaluate(() => ({calls:window.calls?.map(call=>call.type),errors:window.errors})).catch(()=>null);
    console.error('Inline composer diagnostic:',diagnostic);
  }
  throw error;
} finally {
  await browser.close();
}
