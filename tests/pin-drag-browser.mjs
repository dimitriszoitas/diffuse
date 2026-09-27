// Exercise real pointer geometry in an isolated browser. No user profile or network.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({headless:true, args:['--use-mock-keychain', '--password-store=basic']});
let count = 0;
const pass = label => { count++; console.log(`PASS ${label}`); };
const near = (actual, expected, label = 'Coordinate') => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} should be within 2px of ${expected}`);

try {
  const page = await browser.newPage({viewport:{width:1280, height:900}});
  await page.setContent(`<!doctype html><title>Movable comment fixture</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:2000px;background:#eef3f8;font:16px system-ui}
    main{margin:120px 10%;width:80%}#target{display:block;width:100%;height:150px;padding:24px;border:1px solid #bac9da;background:white;text-align:left;font:inherit}
    #nested{height:290px;width:460px;overflow:auto;margin-top:50px;border:2px solid #bac9da}
    #rows{padding:20px}.row{height:100px;margin-bottom:20px;padding:20px;background:white;border:1px solid #bac9da}
    @media(max-width:1050px){main{margin-left:5%;width:90%}#target{height:180px}}
  </style><main><button id="target">The comment must keep referring to this button.</button>
  <div id="nested"><div id="rows"><div class="row" id="row1">First row</div><div class="row" id="row2">Second row</div><div class="row" id="row3">Third row</div><div class="row" id="row4">Fourth row</div><div class="row" id="row5">Fifth row</div></div></div></main>`);
  await page.evaluate(() => {
    window.hostClicks = 0;
    document.addEventListener('click', event => { if (!event.composedPath().some(node => node.tagName === 'DIFFUSE-LIVE-OVERLAY')) window.hostClicks++; });
    document.getElementById('target').addEventListener('click', () => window.targetActivations = (window.targetActivations || 0) + 1);
    window.pinWrites = [];
    window.chrome = {runtime:{id:'fixture', onMessage:{addListener(fn){window.receiver = fn;}}, async sendMessage(message){
      if (!['REMAP_COMMENT','UPDATE_COMMENT_PIN'].includes(message.type)) return {ok:true};
      window.pinWrites.push(structuredClone(message));
      if (window.holdPinSave) await new Promise(resolve => {window.releasePinSave=resolve;});
      if (window.failNextPinSave) {window.failNextPinSave=false; return {ok:false,error:'Fixture could not save the new attachment.'};}
      const comment=window.storedSession.comments.find(comment => comment.id===message.commentId);
      if (message.type==='UPDATE_COMMENT_PIN') {
        comment.pinOffset=structuredClone(message.offset);
        return {ok:true,pinOffset:structuredClone(message.offset)};
      }
      const target=DiffuseInspector.resolveSelector(message.selector);
      if(!target) return {ok:false,error:'The replacement component is no longer available.'};
      comment.pinSelection=structuredClone(DiffuseInspector.inspect(target));
      const rect=target.getBoundingClientRect();
      comment.pinPoint={x:(message.position.x-rect.x)/rect.width,y:(message.position.y-rect.y)/rect.height};
      comment.pinOffset={x:0,y:0};
      return {ok:true,pinSelection:structuredClone(comment.pinSelection),pinPoint:structuredClone(comment.pinPoint),pinOffset:{x:0,y:0}};
    }}};
    window.deliver = message => new Promise(resolve => window.receiver({namespace:'diffuse', sessionId:'review', ...message}, {id:'fixture'}, resolve));
  });
  for (const file of ['inspector.js', 'content.js']) await page.addScriptTag({content:await readFile(resolve(project, 'extension', file), 'utf8')});
  const capture = id => page.evaluate(id => DiffuseInspector.inspect(document.getElementById(id)), id);
  const targetSelection = await capture('target');
  const nestedSelection = await capture('row2');
  const makeComment = (id, selection) => ({id, selection, context:{production:{...selection.context, viewportProfile:{key:'desktop'}}}, fields:{comment:'Preserve the selected element and its evidence.', category:'ux-issue', severity:'minor'}, evidence:{screenshot:'fixture-evidence'}});
  const session = {id:'review', viewportPreset:'desktop', mode:'audit', status:'live', settings:{opacity:.55, reveal:50, linked:false, offsetX:0, offsetY:0}, comments:[makeComment('target-comment', targetSelection), makeComment('nested-comment', nestedSelection)]};
  await page.evaluate(session => {window.storedSession = structuredClone(session);}, session);
  await page.evaluate(session => window.deliver({type:'INITIALIZE', role:'target', session}), session);
  const overlay = page.locator('diffuse-live-overlay');
  const pin = id => overlay.locator(`.comment-pin[data-comment-id="${id}"]`);
  const position = id => pin(id).evaluate(node => ({x:parseFloat(node.style.left), y:parseFloat(node.style.top), hidden:node.hidden}));
  const targetPin = pin('target-comment');
  const bubble = overlay.locator('#saved-comment-bubble');
  const tick = () => page.waitForTimeout(160);
  const lastWrite = () => page.evaluate(() => window.pinWrites.at(-1));
  const writeCount = () => page.evaluate(() => window.pinWrites.length);
  const sessionUpdate = () => page.evaluate(() => window.deliver({type:'SESSION_UPDATE', session:structuredClone(window.storedSession)}));
  const drag = async (id, dx, dy, release = true) => {
    const start = await position(id);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, {steps:8});
    await tick();
    if (release) { await page.mouse.up(); await tick(); }
    return start;
  };

  const origin=await position('target-comment');
  await drag('target-comment',180,78,false);
  let moved=await position('target-comment');
  near(moved.x,origin.x+180); near(moved.y,origin.y+78);
  assert.equal(await targetPin.evaluate(node=>node.hasPointerCapture(1)),true);
  assert.equal(await bubble.isVisible(),false);
  await sessionUpdate(); await tick();
  moved=await position('target-comment'); near(moved.x,origin.x+180); near(moved.y,origin.y+78);
  await page.mouse.up(); await tick();
  let write=await lastWrite();
  assert.equal(write.type,'REMAP_COMMENT'); assert.equal(write.sessionId,'review'); assert.equal(write.commentId,'target-comment'); assert.equal(write.selector,'#target');
  near(write.position.x,origin.x+180); near(write.position.y,origin.y+78);
  assert.equal(await bubble.isVisible(),false);
  assert.equal(await page.evaluate(()=>window.targetActivations||0),0);
  assert.equal(await page.evaluate(()=>window.hostClicks),0);
  pass('Direct dragging captures the pointer, survives a session update, and saves the drop location without opening a comment or activating the page');

  await sessionUpdate(); await tick();
  moved=await position('target-comment'); near(moved.x,origin.x+180); near(moved.y,origin.y+78);
  await targetPin.click();
  assert.equal(await bubble.isVisible(),true);
  assert.equal(await overlay.locator('#saved-comment-text').textContent(),session.comments[0].fields.comment);
  await overlay.locator('#close-saved-comment').click();
  let writesBefore=await writeCount(),before=await position('target-comment');
  await page.mouse.move(before.x,before.y); await page.mouse.down(); await page.mouse.move(before.x+2,before.y+1); await page.mouse.up(); await tick();
  assert.equal(await writeCount(),writesBefore); assert.equal(await bubble.isVisible(),true);
  await overlay.locator('#close-saved-comment').click();
  pass('A normal click, including slight pointer jitter, still opens the existing comment without remapping it');

  writesBefore=await writeCount(); before=await position('target-comment');
  await drag('target-comment',60,30,false);
  await page.keyboard.press('Escape'); await page.mouse.up(); await tick();
  moved=await position('target-comment'); near(moved.x,before.x); near(moved.y,before.y);
  assert.equal(await writeCount(),writesBefore); assert.equal(await bubble.isVisible(),false);
  assert.equal(await page.evaluate(()=>window.hostClicks),0);
  await drag('target-comment',-40,35,false);
  await targetPin.dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',bubbles:true,composed:true});
  await page.mouse.up(); await tick();
  moved=await position('target-comment'); near(moved.x,before.x); near(moved.y,before.y);
  assert.equal(await writeCount(),writesBefore); assert.equal(await page.evaluate(()=>window.hostClicks),0);
  pass('Escape and pointer cancellation restore the previous attachment and consume the trailing release/click');

  await page.evaluate(()=>{window.holdPinSave=true;});
  before=await drag('target-comment',42,-26);
  await sessionUpdate(); await tick();
  moved=await position('target-comment'); near(moved.x,before.x+42); near(moved.y,before.y-26);
  await page.evaluate(()=>{window.holdPinSave=false;window.releasePinSave();}); await tick();
  await sessionUpdate(); await tick();
  moved=await position('target-comment'); near(moved.x,before.x+42); near(moved.y,before.y-26);
  pass('An older session update cannot move the dropped pin back while its new attachment is saving');

  await page.evaluate(()=>{window.failNextPinSave=true;});
  before=await drag('target-comment',-75,20);
  moved=await position('target-comment'); near(moved.x,before.x); near(moved.y,before.y);
  assert.match(await overlay.evaluate(node=>node.shadowRoot.textContent),/could not|unable|couldn.t/i);
  pass('A failed attachment save restores the previous saved position and reports the failure');

  await targetPin.click();
  const row=await page.locator('#row1').boundingBox();
  before=await position('target-comment');
  const drop={x:row.x+row.width*.72,y:row.y+row.height*.5};
  await drag('target-comment',drop.x-before.x,drop.y-before.y,false);
  assert.equal(await bubble.isVisible(),false);
  await page.mouse.up(); await tick();
  assert.equal(await bubble.isVisible(),true);
  assert.equal((await lastWrite()).selector,'#row1');
  const highlight=await overlay.locator('#saved-comment-highlight').boundingBox();
  near(highlight.x,row.x); near(highlight.y,row.y); near(highlight.width,row.width);
  await overlay.locator('#close-saved-comment').click();
  pass('Dragging an open comment directly to a different component restores its details with the new component highlighted');

  const atRow=await position('target-comment');
  await page.locator('#nested').evaluate(node=>{node.scrollTop=22;}); await tick();
  moved=await position('target-comment'); near(moved.y,atRow.y-22); assert.equal(moved.hidden,false);
  await page.locator('#nested').evaluate(node=>{node.scrollTop=150;}); await tick();
  assert.equal((await position('target-comment')).hidden,true);
  await page.locator('#nested').evaluate(node=>{node.scrollTop=22;}); await tick();
  assert.equal((await position('target-comment')).hidden,false);
  pass('The dropped pin follows the replacement inside a scrolling container and hides when its chosen point leaves view');

  // Reviews from 0.9.2 retain their saved offset until the user moves them.
  await page.evaluate(()=>{
    const legacy=window.storedSession.comments.find(comment=>comment.id==='nested-comment');
    legacy.pinOffset={x:80,y:30};
  });
  await sessionUpdate(); await tick();
  const legacyRect=await page.locator('#row2').boundingBox();
  const legacy=await position('nested-comment');
  near(legacy.x,legacyRect.x+12+80); near(legacy.y,legacyRect.y+12+30);
  await pin('nested-comment').click(); await overlay.locator('#reset-pin-position').click(); await tick();
  const reset=await position('nested-comment'); near(reset.x,legacyRect.x+12); near(reset.y,legacyRect.y+12);
  assert.equal((await lastWrite()).type,'UPDATE_COMMENT_PIN');
  await overlay.locator('#close-saved-comment').click();
  pass('Legacy saved offsets still load correctly and can be reset without changing their original capture');

  const stored=await page.evaluate(()=>window.storedSession.comments);
  for(let index=0;index<stored.length;index++)for(const key of ['selection','context','fields','evidence'])assert.deepEqual(stored[index][key],session.comments[index][key]);
  assert.equal(stored[0].pinSelection.selector,'#row1'); assert.deepEqual(stored[0].pinOffset,{x:0,y:0});
  assert.equal(await page.evaluate(()=>window.hostClicks),0); assert.equal(await page.evaluate(()=>window.targetActivations||0),0);
  await page.evaluate(()=>window.deliver({type:'STOP'}));
  await page.evaluate(()=>window.deliver({type:'INITIALIZE',role:'target',session:structuredClone(window.storedSession)}));
  await tick();
  const restoredRect=await page.locator('#row1').boundingBox();
  moved=await position('target-comment'); near(moved.x,restoredRect.x+restoredRect.width*stored[0].pinPoint.x); near(moved.y,restoredRect.y+restoredRect.height*stored[0].pinPoint.y);
  pass('The original report content is preserved and starting the saved review restores the new attachment');
  const artifacts=resolve(project,'artifacts/pin-drag'); await mkdir(artifacts,{recursive:true});
  await page.screenshot({path:resolve(artifacts,'relocated-pins.png')});
  console.log(`${count} pin drag browser checks passed.`);
} finally {await browser.close();}
