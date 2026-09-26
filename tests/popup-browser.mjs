// Tests the actual Chrome action popup, not popup.html opened as a normal tab.
// CDP exposes this view as an unattached page target; Playwright's pages() omits it.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const{chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const artifacts=join(project,'artifacts','popup-native');
const temp=await mkdtemp(join(tmpdir(),'diffuse-popup-regression-'));
const extension=join(temp,'extension');
await mkdir(artifacts,{recursive:true});
await cp(process.env.POPUP_EXTENSION||join(project,'extension'),extension,{recursive:true});
// Grant only this disposable fixture's localhost origin so the real Start
// review click can run without an unattended browser permission prompt.
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=[...new Set([...(manifest.host_permissions||[]),'http://127.0.0.1/*'])];
await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><title>${req.url.includes('prototype')?'Forma prototype — Studio overview':'Forma production — Studio overview'}</title><h1>Fictional local popup fixture</h1>`);});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];const pass=message=>{results.push(message);console.log(`PASS ${message}`);};
let context,cdp,sessionId;
const pending=new Map();let sequence=0;
async function until(check,label,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(80);}throw new Error(`Timed out: ${label}`);}
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Popup CDP timeout: ${method}`));},8000);pending.set(id,{resolve,reject,timer});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error);});});}
async function evaluate(expression){const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.text);return response.result?.value;}
async function screenshot(name){const{data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(artifacts,`${name}.png`),Buffer.from(data,'base64'));}
async function click(id){const box=await evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});el.scrollIntoView({block:'nearest'});const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await pause(120);}
async function measure(){return evaluate(`(()=>{const rect=id=>{const el=document.getElementById(id),b=el.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,hidden:!el.checkVisibility(),disabled:el.disabled}};return{innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height},bodyWidth:document.body.getBoundingClientRect().width,bodyScrollWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,rootWidth:document.documentElement.getBoundingClientRect().width,isNativePopup:chrome.extension.getViews({type:'popup'}).includes(window),bodyFontSize:getComputedStyle(document.body).fontSize,source:document.getElementById('source-title').textContent,sourceUrl:document.getElementById('source-url').textContent,startLabel:document.getElementById('start-comparison').textContent.trim(),modeChoices:document.querySelectorAll('#mode-comparison,#mode-audit,#target-tab,.mode-switch').length,controls:Object.fromEntries(['open-side-panel','start-comparison','review-reports','ai-settings'].map(id=>[id,rect(id)]))}})()`);}
try{
  context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:process.env.POPUP_HEADED!=='1',viewport:null,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1440,1000','--use-mock-keychain','--password-store=basic']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:12000});
  const id=new URL(worker.url()).host;
  const production=context.pages()[0];await production.goto(`${origin}/production`);const prototype=await context.newPage();await prototype.goto(`${origin}/prototype`);await production.bringToFront();
  cdp=await context.browser().newBrowserCDPSession();
  const{targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===production.url()).targetId});
  let popupTarget;
  await until(async()=>{popupTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/popup.html`);return popupTarget;},'native action popup target');
  ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false}));
  cdp.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const response=JSON.parse(event.message),request=pending.get(response.id);if(!request)return;clearTimeout(request.timer);pending.delete(response.id);response.error?request.reject(new Error(response.error.message)):request.resolve(response.result);});
  await until(()=>evaluate(`document.getElementById('setup')?.hidden===false&&document.getElementById('popup').getAttribute('aria-busy')==='false'`),'loaded popup');
  await pause(350);const native=await measure();
  await screenshot(process.env.POPUP_BASELINE?'baseline':'setup-100');
  console.log('NATIVE',JSON.stringify(native));
  if(process.env.POPUP_BASELINE){await writeFile(join(artifacts,'baseline.json'),JSON.stringify({chromeVersion:context.browser().version(),native},null,2));}
  else{
    assert.equal(native.isNativePopup,true);assert(!context.pages().some(page=>page.url().endsWith('/popup.html')));pass('The tested document is the real Chrome action popup, not a normal browser tab');
    assert(native.innerWidth>=400&&native.innerWidth<=450,`Unexpected intrinsic popup width: ${native.innerWidth}`);
    assert(native.bodyWidth>=399&&native.bodyWidth<=421);assert(native.bodyScrollWidth<=native.bodyWidth+1);assert.equal(native.bodyFontSize,'16px');
    assert.equal(native.modeChoices,0);assert.match(native.source,/Forma production/);assert.match(native.sourceUrl,/\/production$/);assert.match(native.startLabel,/^Start review/);pass('Native popup keeps its intended width and shows the current page without compare or audit setup choices');
    for(const control of Object.values(native.controls)){if(!control.hidden){assert(control.height>=43.5);assert(control.x>=0&&control.x+control.width<=native.innerWidth+1);}}
    assert(native.controls['start-comparison'].bottom<=600,`Primary action falls below Chrome's 600px maximum: ${native.controls['start-comparison'].bottom}`);pass('Primary action fits Chrome’s popup limit and all controls retain 44px targets');
    assert.equal(native.controls['start-comparison'].disabled,false);assert.equal(native.controls['open-side-panel'].hidden,false);assert.equal(native.controls['open-side-panel'].disabled,false);pass('Start review and the native drawer action are available immediately on the current website');
    for(const id of ['open-side-panel','start-comparison','review-reports','ai-settings']){await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.focus();e.scrollIntoView({block:'center'})})()`);const b=await evaluate(`(()=>{const b=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:b.x,right:b.right,top:b.top,bottom:b.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`);assert(b.x>=-.5&&b.right<=b.viewportWidth+.5,`${id} clips in native popup`);assert(b.top>=-.5&&b.bottom<=b.viewportHeight+.5,`${id} cannot be brought into view in native popup`);}
    await screenshot('footer-100');pass('Primary and secondary actions remain reachable by focus and scrolling within the native popup');
    await click('start-comparison');
    await until(async()=>{const review=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);return review?.status==='live';},'review starts on the current page');
    const review=await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison);
    assert.equal(review.target.url,production.url());assert.equal(Number.isInteger(review.sourceTabId),false);
    await until(async()=> (await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`),'native sidebar opens with review');
    const sidebarTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`);
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:sidebarTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('panel-controls')?.checkVisibility()&&!document.getElementById('panel-diff').disabled`),'native sidebar connected with review controls');
    assert.equal(await evaluate(`document.getElementById('panel-comment').disabled`),false);
    await screenshot('started-review-sidebar');
    assert.equal(await production.locator('diffuse-live-overlay').locator('#toolbar').isVisible(),false);
    pass('The real Start review gesture opens the native sidebar and starts this page without a floating toolbar');
    await worker.evaluate(async()=>{const s=(await chrome.storage.session.get('comparison')).comparison;const tab=await chrome.tabs.get(s.targetTabId);await chrome.sidePanel.close({windowId:tab.windowId});});
    assert.equal(await production.locator('diffuse-live-overlay').locator('#toolbar').isVisible(),false);
    await production.bringToFront();
    const activeTarget=(await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]})).targetInfos.find(t=>t.url===production.url());
    await cdp.send('Extensions.triggerAction',{id,targetId:activeTarget.targetId});
    await until(async()=>{popupTarget=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${id}/popup.html`);return popupTarget;},'reopen native popup');
    ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:popupTarget.targetId,flatten:false}));
    await until(()=>evaluate(`document.getElementById('session-panel')?.hidden===false&&document.getElementById('popup').getAttribute('aria-busy')==='false'`),'ongoing review launch');
    assert.equal(await evaluate(`document.getElementById('return-to-comparison').checkVisibility()`),true);
    assert.match(await evaluate(`document.getElementById('return-to-comparison').textContent`),/Open review sidebar/);
    await screenshot('ongoing-review');
    await click('return-to-comparison');
    await until(async()=> (await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.some(t=>t.type==='page'&&t.url===`chrome-extension://${id}/sidepanel.html`),'reopened sidebar');
    assert.equal((await worker.evaluate(async()=> (await chrome.storage.session.get('comparison')).comparison)).id,review.id);
    pass('Closing and reopening the sidebar keeps the same review and shows an explicit Open review sidebar action');
    // Chrome disables browser zoom for extension pages and rejects CDP device
    // metrics override on this native action target. Do not substitute a normal
    // browser tab and claim it exercises native popup zoom.
    await writeFile(join(artifacts,'measurements.json'),JSON.stringify({chromeVersion:context.browser().version(),native,zoomMethod:'Native extension-page zoom and action-view CDP device metrics override are disabled by Chrome. This test validates the real native popup at default zoom; it does not claim200% popup zoom support.',results},null,2));
  }
}finally{
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Popup test ended'));}pending.clear();
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}
