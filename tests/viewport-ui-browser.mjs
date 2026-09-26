// Disposable controller UI fixture. Native metrics/capture are tested separately.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.setContent('<!doctype html><style>body{margin:60px;font:16px system-ui}#target{width:200px;height:60px;margin-top:50px}</style><h1>Viewport fixture</h1><button id="target">Review this</button>');
  await page.evaluate(()=>{
    window.messages=[];
    window.chrome={runtime:{id:'fixture',onMessage:{addListener(callback){window.receiver=callback;}},async sendMessage(message){window.messages.push(message);return window.rejectViewport&&message.type==='VIEWPORT_PRESET'?{ok:false,error:'Close DevTools before switching viewports.'}:{ok:true};}}};
    window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
  });
  for(const file of ['inspector.js','content.js'])await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const profiles=[['desktop',1440,900],['laptop',1280,800],['tablet',1024,768],['phone',390,844]];
  const comments=profiles.map(([key,width,height])=>({id:key,fields:{comment:`${key} finding`,category:'ux-issue'},selection:{selector:'#target'},context:{production:{url:'about:blank',viewportProfile:{key},viewport:{width,height}}}}));
  const session={id:'review',mode:'audit',status:'live',settings:{hidden:true},comments};
  const deliver=message=>page.evaluate(message=>window.deliver(message),message);
  await deliver({type:'INITIALIZE',role:'target',session});
  const overlay=page.locator('diffuse-live-overlay');
  assert.equal(await overlay.locator('.comment-pin').count(),1);
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'desktop');
  assert.equal((await deliver({type:'GET_CONTEXT'})).context.viewportProfile.key,'desktop');
  assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  for(const [preset,width,height] of profiles.slice(1,3)){
    // The drawer changes the browser viewport, then publishes the new session.
    await page.setViewportSize({width,height});
    await deliver({type:'SESSION_UPDATE',session:{...session,viewportPreset:preset}});
    assert.equal(await overlay.locator('.comment-pin').count(),1);
    assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),preset);
    assert.equal((await deliver({type:'GET_CONTEXT'})).context.viewportProfile.key,preset);
  }
  await page.setViewportSize({width:390,height:844});
  await deliver({type:'SESSION_UPDATE',session:{...session,viewportPreset:'phone'}});
  assert.equal(await overlay.locator('.comment-pin').count(),1);
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'phone');
  assert.equal((await deliver({type:'GET_CONTEXT'})).context.viewportProfile.key,'phone');
  assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  await deliver({type:'SESSION_UPDATE',session:{...session,viewportPreset:'desktop'}});
  assert.equal(await overlay.locator('.comment-pin').getAttribute('data-comment-id'),'desktop');
  await deliver({type:'PREPARE_EVIDENCE'});assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  await deliver({type:'RESTORE_EVIDENCE'});assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  await mkdir(resolve(project,'artifacts/viewport-ui'),{recursive:true});
  await page.screenshot({path:resolve(project,'artifacts/viewport-ui/phone-controls.png')});
  console.log('PASS drawer viewport session updates retain captured profiles and isolated comments without revealing page controls');

  // Exercise the drawer's separate classic controller, including historical
  // profile labels that must not be reclassified by their captured width.
  const drawer=await browser.newPage({viewport:{width:380,height:900}});
  await drawer.setContent((await readFile(resolve(project,'extension/sidepanel.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,''));
  for(const file of ['popup.css','sidepanel.css'])await drawer.addStyleTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const fixtureComments=[...comments,...[
    ['Legacy desktop','desktop'],['Legacy tablet','tablet'],['Unspecified 1280',null],['Invalid profile 1280','invalid'],['Unknown width',null]
  ].map(([title,key])=>({id:title,fields:{title},context:{production:{viewportProfile:key?{key}:undefined,viewport:title==='Unknown width'?{}:{width:1280,height:800}}}}))];
  await drawer.evaluate(({comments})=>{
    if(!crypto.randomUUID)crypto.randomUUID=()=> 'viewport-fixture';
    window.session={id:'session',mode:'audit',target:{title:'Viewport fixture'},settings:{},targetViewport:{width:1440,height:900},comments};
    window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
    const event=()=>({addListener(){}});
    window.chrome={runtime:{connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(){return{ok:true,session:window.session,state:{view:'controls',active:true,available:true}};}},tabs:{onActivated:event(),onUpdated:event()},windows:{getCurrent:async()=>({id:1})}};
  },{comments:fixtureComments});
  await drawer.addScriptTag({content:await readFile(resolve(project,'extension/sidepanel.js'),'utf8')});
  const expected={desktop:['desktop finding','Legacy desktop','Unknown width'],laptop:['laptop finding','Unspecified 1280','Invalid profile 1280','Unknown width'],tablet:['tablet finding','Legacy tablet','Unknown width'],phone:['phone finding','Unknown width']};
  for(const [preset,width,height] of profiles){
    await drawer.evaluate(({preset,width,height})=>{session.viewportPreset=preset;session.targetViewport={width,height};window.dispatchEvent(new Event('diffuse-refresh'));},{preset,width,height});
    await drawer.waitForFunction(({preset,count})=>document.querySelector('#panel-comments h2')?.textContent===`${preset[0].toUpperCase()+preset.slice(1)} comments · ${count}`,{preset,count:expected[preset].length});
    const entries=await drawer.locator('#panel-comments .saved-item').allTextContents();
    assert.equal(entries.length,expected[preset].length);
    for(const label of expected[preset])assert(entries.some(entry=>entry.includes(label)),`${preset} includes ${label}`);
  }
  await drawer.evaluate(()=>{session.viewportPreset=null;session.targetViewport={width:1280,height:800};window.dispatchEvent(new Event('diffuse-refresh'));});
  await drawer.waitForFunction(()=>document.querySelector('#panel-comments h2')?.textContent==='Laptop comments · 4');
  await drawer.screenshot({path:resolve(project,'artifacts/viewport-ui/laptop-drawer-comments.png')});
  console.log('PASS drawer groups all four profiles, native Laptop width, unknown captures and explicit legacy identities');
}finally{await browser.close();}
