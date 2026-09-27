// Exercise real key release, pointer clicks and capture in a disposable Chrome profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(join(tmpdir(),'diffuse-shortcut-')),extension=join(temporary,'extension'),artifacts=join(project,'artifacts/comment-shortcut');
await cp(process.env.SHORTCUT_EXTENSION||join(project,'extension'),extension,{recursive:true});await mkdir(artifacts,{recursive:true});
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const workerPath=join(extension,'background.js');await writeFile(workerPath,(await readFile(workerPath,'utf8')).replace("import * as reviews from './review-store.mjs';","import * as reviews from './review-store.mjs';globalThis.__shortcutReviews=reviews;"));
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><title>Shortcut fixture</title><style>body{margin:40px;font:18px system-ui;min-height:1000px}button,a,input{display:block;margin:20px 0;padding:18px}#action,#link{width:280px}#region{width:500px;height:250px;margin-top:30px;background:#e5f0ff}</style><h1>Comment shortcut</h1><button id="action">Perform action</button><a id="link" href="/navigated">Navigate away</a><input id="typing" placeholder="Typing here must stay normal"><div id="region">Area capture</div><script>window.actionCount=0;window.pointerCount=0;document.getElementById('action').onclick=()=>actionCount++;document.getElementById('action').onpointerdown=()=>pointerCount++;document.addEventListener('contextmenu',event=>event.preventDefault())</script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),results=[],pending=new Map();let context,worker,cdp,page,nativeSession,sequence=0;
const pass=message=>{results.push(message);console.log('PASS '+message);};
async function until(check,label){const stop=Date.now()+15000;while(Date.now()<stop){if(await check())return;await pause(80);}throw new Error('Timed out: '+label);}
const nativeSend=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native timeout '+method));},8000);pending.set(id,{resolve,reject,timer});cdp.send('Target.sendMessageToTarget',{sessionId:nativeSession,message:JSON.stringify({id,method,params})}).catch(reject);});
async function nativeEvaluate(expression){const result=await nativeSend('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
const currentSession=()=>worker.evaluate(async()=>(await chrome.storage.session.get('comparison')).comparison);
const state=()=>worker.evaluate(async()=>{const s=(await chrome.storage.session.get('comparison')).comparison;return(await chrome.tabs.sendMessage(s.targetTabId,{namespace:'diffuse',type:'PANEL_STATE',sessionId:s.id})).state;});
const command=async(action,payload={})=>{const result=await worker.evaluate(async({action,payload})=>{const s=(await chrome.storage.session.get('comparison')).comparison;return chrome.tabs.sendMessage(s.targetTabId,{namespace:'diffuse',type:'PANEL_COMMAND',sessionId:s.id,action,...payload});},{action,payload});assert.equal(result.ok,true,result.error);};
const draft=()=>worker.evaluate(async()=>__shortcutReviews.getDraft((await chrome.storage.session.get('comparison')).comparison.pendingDraftId));
async function cancel(){await command('cancelComment');await until(async()=>!(await currentSession()).pendingDraftId,'draft discarded');await page.evaluate(()=>document.activeElement?.blur());}
async function tapC(){await page.keyboard.down('c');await page.keyboard.up('c');assert.equal((await state()).picking,true,'C stays armed after release');}
async function captureAt(selector){await page.locator(selector).click();await until(async()=>Boolean((await state()).comment),'comment composer opens after the first click');const captured=await draft();assert(captured.evidence.production.dataUrl.length>1000);return captured;}
try{
 context=await chromium.launchPersistentContext(join(temporary,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:null,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1440,1000','--use-mock-keychain','--password-store=basic']});
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 page=context.pages()[0];await page.goto(origin+'/review');cdp=await context.browser().newBrowserCDPSession();
 cdp.on('Target.receivedMessageFromTarget',event=>{const result=JSON.parse(event.message),wait=pending.get(result.id);if(!wait)return;pending.delete(result.id);clearTimeout(wait.timer);result.error?wait.reject(new Error(result.error.message)):wait.resolve(result.result);});
 const target=(await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]})).targetInfos.find(item=>item.url===page.url());
 await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});let popup;
 await until(async()=>{popup=(await cdp.send('Target.getTargets',{filter:[{exclude:false}]})).targetInfos.find(item=>item.url===`chrome-extension://${id}/popup.html`);return popup;},'native popup');
 nativeSession=(await cdp.send('Target.attachToTarget',{targetId:popup.targetId,flatten:false})).sessionId;
 await until(()=>nativeEvaluate(`document.getElementById('popup')?.getAttribute('aria-busy')==='false'`),'popup ready');
 const box=await nativeEvaluate(`(()=>{const b=document.getElementById('start-comparison').getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
 await nativeSend('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await nativeSend('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
 await until(async()=>(await currentSession())?.status==='live','review live');await page.bringToFront();await page.evaluate(()=>document.activeElement?.blur());
 let previousSize='',stableSize=0;await until(async()=>{const size=await page.evaluate(()=>`${innerWidth}x${innerHeight}`);stableSize=size===previousSize?stableSize+1:0;previousSize=size;return stableSize>=6;},'native sidebar resize settled');
 const overlay=page.locator('diffuse-live-overlay');
 await tapC();let captured=await captureAt('#action');assert.equal(captured.selection.selector,'#action');assert.equal(await page.evaluate(()=>actionCount),0);assert.equal(await page.evaluate(()=>pointerCount),0);
 await command('setCommentFields',{fields:{comment:'Selected with a released C key',category:'ux-issue',severity:'minor'}});await command('saveComment');await until(async()=>(await currentSession()).commentCount===1,'first comment saved');
 pass('Tap and release C, then one primary click captures the clicked button without its pointer/click action');
 await overlay.locator('.comment-pin').click();await overlay.locator('#close-saved-comment').click();assert.equal(await overlay.locator('.comment-pin').evaluate(node=>node.getRootNode().activeElement===node),true);
 await tapC();captured=await captureAt('#link');assert.equal(captured.selection.selector,'#link');assert.equal(page.url(),origin+'/review');await cancel();
 pass('C remains armed with focus left on a Diffuse pin; the next click captures a link without navigation');
 await page.locator('#typing').click();await page.keyboard.press('c');assert.equal(await page.locator('#typing').inputValue(),'c');assert.equal((await state()).picking,false);await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.press('Control+c');assert.equal((await state()).picking,false);await page.keyboard.press('Shift+c');assert.equal((await state()).picking,false);
 pass('Editable typing and modified shortcuts do not start selection');
 await tapC();await page.locator('#action').click({button:'right'});await page.locator('#action').click({button:'middle'});assert.equal((await state()).picking,true);assert.equal((await state()).comment,null);
 await page.keyboard.press('Escape');assert.equal((await state()).picking,false);await page.locator('#action').click();assert.equal(await page.evaluate(()=>actionCount),1);
 pass('Right and middle clicks keep the picker armed; Escape cancels and normal page clicks resume');
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.down('c');await page.keyboard.down('c');assert.equal((await state()).picking,true);await page.keyboard.up('c');captured=await captureAt('#action');assert.equal(captured.selection.selector,'#action');await cancel();
 pass('Key repeat does not reset the armed picker or require an extra click');
 const region=await page.locator('#region').boundingBox(),point={x:region.x+35,y:region.y+35};await page.keyboard.down('c');await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+180,point.y+100,{steps:6});await page.keyboard.up('c');await page.mouse.up();await until(async()=>Boolean((await state()).comment),'area composer');captured=await draft();assert.equal(captured.selection.kind,'region');assert.equal(captured.selection.rect.viewport.width,180);assert.equal(captured.selection.rect.viewport.height,100);await cancel();
 pass('C plus drag still captures an area, including releasing C before releasing the mouse');
 await page.keyboard.down('c');await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+20,point.y+20);await page.keyboard.press('Escape');await page.mouse.up();await page.keyboard.up('c');assert.equal((await state()).picking,false);assert.equal((await state()).comment,null);
 await tapC();captured=await captureAt('#action');assert.equal(captured.selection.selector,'#action');await cancel();
 pass('Cancelling a drag leaves no stale suppression or capture state for the next tap-and-click');
 await writeFile(join(artifacts,'results.json'),JSON.stringify({localOnly:true,results},null,2));
}catch(error){console.log('SHORTCUT STATE',await state().catch(()=>null));console.log('SHORTCUT SESSION',await currentSession().catch(()=>null));await page?.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});throw error;}finally{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('Fixture ended'));}pending.clear();await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
