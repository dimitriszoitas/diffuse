// Real layout regression in an isolated browser. No user profile or network.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
let count=0;const pass=label=>{count++;console.log(`PASS ${label}`);};
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent(`<!doctype html><title>Pin anchoring fixture</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:2400px;font:16px system-ui;background:#faf8ff}
    main{margin:120px 10%;width:80%}.card{height:120px;padding:24px;border:1px solid #bbb;background:white;margin-bottom:16px}
    #nested{height:300px;overflow:auto;border:2px solid #6941c6;margin-top:24px}#rows{padding:20px}.row{height:100px;margin:0 0 16px;background:#eee5ff;padding:20px}
    #fixed{position:fixed;right:20px;top:28px;width:180px;height:60px;background:#ffd28a;padding:14px}
    #sticky{position:sticky;top:10px;height:48px;background:#9bd5ff;padding:10px}
    .spacer{height:140px}#reorder span{display:block;height:50px}
    @media(max-width:1050px){main{margin-left:5%;width:90%}.card{height:180px}}
  </style><div id="fixed">Fixed feedback</div><main><div id="sticky">Sticky heading</div><div id="card" class="card">Responsive card</div>
  <div id="nested"><div id="rows"><div class="row" id="row1">First row</div><div class="row" id="row2">Second row</div><div class="row" id="row3">Third row</div><div class="row" id="row4">Fourth row</div></div></div>
  <div id="reorder"><span>Original item</span><span>Different item</span></div></main>`);
  await page.evaluate(()=>{
    window.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;}},async sendMessage(){return{ok:true};}}};
    window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
  });
  for(const file of ['inspector.js','content.js'])await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const deliver=message=>page.evaluate(message=>window.deliver(message),message);
  const session={id:'review',viewportPreset:'desktop',mode:'audit',status:'live',settings:{opacity:.55,reveal:50,linked:false,offsetX:0,offsetY:0},comments:[]};
  const capture=async(id,region=false)=>page.evaluate(({id,region})=>{
    const target=document.getElementById(id),rect=target.getBoundingClientRect();
    return region?DiffuseInspector.region(rect.x+8,rect.y+8,rect.width-16,rect.height-16):DiffuseInspector.inspect(target);
  },{id,region});
  let sequence=0;
  const add=async(selection)=>{const comment={id:`comment-${++sequence}`,selection,context:{production:{...selection.context,viewportProfile:{key:'desktop'}}},fields:{comment:'Anchored feedback',category:'design-mismatch'}};session.comments.push(comment);await deliver({type:'SESSION_UPDATE',session});return comment.id;};
  await deliver({type:'INITIALIZE',role:'target',session});
  const overlay=page.locator('diffuse-live-overlay');
  const pin=id=>overlay.locator(`[data-comment-id="${id}"]`);
  const pos=id=>pin(id).evaluate(node=>({x:parseFloat(node.style.left),y:parseFloat(node.style.top),hidden:node.hidden}));
  const near=(a,b)=>assert.ok(Math.abs(a-b)<2,`${a} should be within 2px of ${b}`);
  const tick=()=>page.waitForTimeout(300);

  const selected=await capture('card',true);assert.equal(selected.anchor.selector,'#card');assert.equal(selected.anchor.space,'relative');
  const cardId=await add(selected),before=await pos(cardId);
  await page.setViewportSize({width:1000,height:900});await tick();
  const after=await pos(cardId),card=await page.locator('#card').boundingBox();assert.equal(after.hidden,false);
  near(after.x,card.x+selected.anchor.relative.x*card.width+12);near(after.y,card.y+selected.anchor.relative.y*card.height+12);
  assert.notEqual(after.x,before.x);pass('Selected areas keep their element-relative position through responsive resize');

  await page.setViewportSize({width:1280,height:900});await tick();
  const nestedId=await add(await capture('row2',true));const nestedBefore=await pos(nestedId);
  await page.locator('#nested').evaluate(node=>node.scrollTop=55);await tick();near((await pos(nestedId)).y,nestedBefore.y-55);
  await pin(nestedId).click();assert.equal(await overlay.locator('#saved-comment-bubble').isVisible(),true);
  await page.locator('#nested').evaluate(node=>node.scrollTop=240);await tick();assert.equal((await pos(nestedId)).hidden,true);assert.equal(await overlay.locator('#saved-comment-bubble').isVisible(),false);
  await page.locator('#nested').evaluate(node=>node.scrollTop=55);await tick();assert.equal((await pos(nestedId)).hidden,false);
  pass('Nested scrolling moves the region pin and hides it plus its bubble when the anchor is clipped');

  const fixedId=await add(await capture('fixed',true));const fixedBefore=await pos(fixedId);
  const stickyId=await add(await capture('sticky'));await page.evaluate(()=>scrollTo(0,250));await tick();
  near((await pos(fixedId)).y,fixedBefore.y);near((await pos(stickyId)).y,22);assert.equal((await pos(cardId)).hidden,true);
  pass('Fixed and sticky targets use their live geometry while scrolled-away pins leave the viewport');

  await page.evaluate(()=>scrollTo(0,0));await tick();
  await page.locator('#card').evaluate(node=>node.remove());await tick();assert.equal((await pos(cardId)).hidden,true);
  pass('Removing an anchored target hides its pin without inventing a replacement location');

  const positional=await page.locator('#reorder span').first().evaluate(node=>DiffuseInspector.inspect(node));
  const positionalId=await add(positional);assert.ok(positional.anchor.identity.text);
  await page.locator('#reorder').evaluate(node=>node.prepend(node.lastElementChild));await tick();assert.equal((await pos(positionalId)).hidden,true);
  pass('Reordered positional selectors cannot attach an existing comment to a different item');

  const legacySelection=await capture('row2');delete legacySelection.anchor;const legacyElementId=await add(legacySelection);
  const legacyBefore=await pos(legacyElementId);await page.locator('#nested').evaluate(node=>node.scrollTop+=20);await tick();near((await pos(legacyElementId)).y,legacyBefore.y-20);
  const legacyRegion={kind:'region',context:await page.evaluate(()=>DiffuseInspector.context()),rect:{document:{x:600,y:250,width:160,height:100}}};
  const legacyId=await add(legacyRegion);await page.setViewportSize({width:1100,height:850});await tick();assert.equal((await pos(legacyId)).hidden,false);near((await pos(legacyId)).x,612);
  pass('Legacy element captures still follow their target and legacy regions survive a window resize');

  const liveSelection=await capture('row2',true);const aiSelection={...liveSelection};delete aiSelection.anchor;
  let response=await deliver({type:'ANCHOR_SELECTION',selection:aiSelection});assert.ok(response.selection.anchor);
  response=await deliver({type:'ANCHOR_SELECTION',selection:{...aiSelection,context:{...aiSelection.context,scroll:{x:0,y:999}}}});assert.equal(response.selection.anchor,undefined);
  await page.locator('#nested').evaluate(node=>node.scrollTop+=30);
  response=await deliver({type:'ANCHOR_SELECTION',selection:aiSelection});assert.equal(response.selection.anchor,undefined);
  pass('AI region anchors require matching URL, viewport, root scroll and nested scroll positions');

  const artifacts=resolve(project,'artifacts/pin-anchoring');await mkdir(artifacts,{recursive:true});await page.screenshot({path:resolve(artifacts,'pins.png')});
  console.log(`${count} pin anchoring browser checks passed.`);
} finally {await browser.close();}
