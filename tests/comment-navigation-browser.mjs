// Real extension and disposable browser; only local pages and local review data.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(join(tmpdir(),'diffuse-navigation-')),extension=join(temporary,'extension');
await cp(join(project,'extension'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];manifest.background.service_worker='navigation-worker.js';await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Navigation ${req.url}</title><style>body{margin:24px;font:18px system-ui;min-height:1600px}#scroller{height:240px;overflow:auto;border:1px solid;padding:10px}#space{height:700px}button{padding:16px}input{padding:12px}</style><h1>Review route ${req.url}</h1><input id="typing" placeholder="Page field"><div id="scroller"><div id="space"></div><button id="saved-anchor">Saved target on ${req.url}</button><div style="height:500px"></div></div><script>window.route=(url)=>history.pushState({},'',url)</script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,profile=join(temporary,'profile');
await writeFile(join(extension,'navigation-worker.js'),(await readFile(join(extension,'background.js'),'utf8'))+'\nglobalThis.__navigationTest={handle,reviews,getSession:()=>session};');
const child=spawn(process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),['--headless=new','--no-first-run','--no-default-browser-check','--use-mock-keychain','--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--window-size=1440,1000','about:blank'],{stdio:'ignore'});
const results=[],pending=new Map();let socket,sequence=0;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=label=>{results.push(label);console.log('PASS '+label);};
async function until(check,label){const stop=Date.now()+20000;while(Date.now()<stop){const value=await check();if(value)return value;await pause(100);}throw new Error('Timed out: '+label);}
try{
 const [port,path]=await until(async()=>{try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');}catch{return null;}},'browser');
 socket=new WebSocket(`ws://127.0.0.1:${port}${path}`);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const result=JSON.parse(event.data);if(result.method==='Runtime.exceptionThrown')console.log('Browser error',JSON.stringify(result.params));const wait=pending.get(result.id);if(wait){pending.delete(result.id);clearTimeout(wait.timer);result.error?wait.reject(new Error(result.error.message)):wait.resolve(result.result);}};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},25000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const attach=async targetId=>(await send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 const evaluate=async(sessionId,expression)=>{const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);return response.result?.value;};
 const worker=await until(async()=>(await send('Target.getTargets')).targetInfos.find(target=>target.type==='service_worker'&&target.url.endsWith('/navigation-worker.js')),'worker'),workerId=await attach(worker.targetId),id=worker.url.split('/')[2];
 await send('Runtime.enable',{},workerId);await send('Runtime.runIfWaitingForDebugger',{},workerId);
 const run=expression=>evaluate(workerId,expression);await until(()=>run('Boolean(globalThis.__navigationTest)'),'worker ready');
 const seedFn=async function(origin){const store=__navigationTest.reviews;
    const review={id:'navigation-review',title:'Shared review',productionUrl:`${origin}/one`,mode:'audit',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const result=[];
    for(const [index,path]of ['/one','/two?tab=details#saved','/two?tab=details#other'].entries()){
      const production={url:`${origin}${path}`,viewport:{width:390,height:844,dpr:1},viewportProfile:{key:'phone',mode:'preset'},scroll:{x:0,y:0},nestedScroll:[{selector:'#scroller',x:0,y:650}]};
      const draft={id:`draft-${index}`,reviewId:review.id,createdAt:new Date(Date.now()+index).toISOString(),mode:'audit',context:{production},selection:{selector:'#saved-anchor',context:production,rect:{document:{x:30,y:780,width:200,height:50}}},evidence:{production:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sG8sAAAAASUVORK5CYII='}}};
      await store.putDraft(draft,review);result.push((await store.addComment(draft.id,{comment:`Comment for ${path}`,state:'Visible target',severity:'minor',category:'ux-issue'})).comment.id);
    }

    const production={url:`${origin}/legacy`,viewport:{width:1542,height:1107,dpr:1},viewportProfile:{key:'desktop',mode:'window'},scroll:{x:0,y:400}};
    const region={id:'legacy-area',reviewId:review.id,createdAt:new Date(Date.now()+10).toISOString(),mode:'audit',context:{production},selection:{kind:'region',context:production,rect:{viewport:{x:100,y:120,width:140,height:70},document:{x:100,y:520,width:140,height:70}}},evidence:{production:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sG8sAAAAASUVORK5CYII='}}};
    await store.putDraft(region,review);result.push((await store.addComment(region.id,{comment:'Legacy AI region',state:'Original viewport',severity:'minor',category:'ux-issue'})).comment.id);
 return result;};
 const seed=await run(`(${seedFn.toString()})(${JSON.stringify(origin)})`);
 const request=message=>run(`__navigationTest.handle(${JSON.stringify(message)},{id:chrome.runtime.id,url:chrome.runtime.getURL('report.html')})`);
 const opened=await request({type:'OPEN_REVIEW',reviewId:'navigation-review'});assert.equal(opened.ok,true,opened.error);
 const session=()=>run('__navigationTest.getSession()');
 const pageRun=expression=>run(`chrome.scripting.executeScript({target:{tabId:${opened.tabId}},world:'MAIN',func:()=>(${expression})}).then(results=>results[0].result)`);
 const state=()=>run(`chrome.tabs.sendMessage(${opened.tabId},{namespace:'diffuse',sessionId:__navigationTest.getSession().id,type:'PANEL_STATE'})`);
 let current=await session();assert.equal(current.reviewId,'navigation-review');assert.equal(current.commentCount,4);assert.equal(current.viewportPreset,'phone');
 assert.equal(await pageRun('innerWidth'),390);assert.equal(await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.querySelectorAll('.comment-pin').length`),1);assert.ok(await pageRun(`document.getElementById('scroller').scrollTop`)>500);
 pass('Opening stored review restores identity, comments, saved phone size from desktop window and nested scroll');
 const panelTab=await run(`chrome.tabs.create({url:chrome.runtime.getURL('sidepanel.html'),active:false})`);const target=await until(async()=>(await send('Target.getTargets')).targetInfos.find(target=>target.url===`chrome-extension://${id}/sidepanel.html`),'sidebar fixture');const panelId=await attach(target.targetId);
 await evaluate(panelId,`window.testPort=chrome.runtime.connect({name:'diffuse-sidepanel'});window.testPort.onMessage.addListener(()=>{});window.testPort.postMessage({type:'ATTACH',windowId:${panelTab.windowId}});`);await pause(150);
 const show=async commentId=>evaluate(panelId,`chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type:'PANEL_COMMAND',windowId:${panelTab.windowId},sessionId:${JSON.stringify((await session()).id)},action:'showPin',id:${JSON.stringify(commentId)}})`);
 let result=await show(seed[1]);assert.equal(result.ok,true,result.error);assert.equal(await pageRun('location.href'),`${origin}/two?tab=details#saved`);assert.equal((await session()).reviewId,'navigation-review');assert.equal((await session()).commentCount,4);assert.equal((await session()).viewportPreset,'phone');
 assert.equal(await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.querySelectorAll('.comment-pin').length`),1);assert.match(await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.getElementById('saved-comment-text').textContent`),/two\?tab=details#saved/);assert.ok(await pageRun(`document.getElementById('scroller').scrollTop`)>500);
 pass('Sidebar command navigates exact path/query/hash, reconnects and reveals correct nested anchor');
 result=await show(seed[2]);assert.equal(result.ok,true,result.error);assert.equal(await pageRun('location.hash'),'#other');
 await pageRun(`window.route('/one')`);await pause(500);assert.equal(await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.querySelectorAll('.comment-pin').length`),1);assert.equal((await state()).state.openPinId,null);
 result=await show(seed[1]);assert.equal(result.ok,true,result.error);assert.equal(await pageRun('location.href'),`${origin}/two?tab=details#saved`);
 pass('Hash-only and SPA path changes retain URL-scoped pins and navigate back to recorded path');
 const key=async(type,key,code,windowsVirtualKeyCode)=>run(`chrome.debugger.sendCommand({tabId:${opened.tabId}},'Input.dispatchKeyEvent',${JSON.stringify({type,key,code,windowsVirtualKeyCode})})`);
 await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.getElementById('close-saved-comment').click()`);await pageRun(`document.activeElement?.blur()`);
 await key('keyDown','c','KeyC',67);await key('keyUp','c','KeyC',67);assert.equal((await state()).state.picking,true);
 await key('keyDown','Escape','Escape',27);await key('keyUp','Escape','Escape',27);await pageRun(`document.getElementById('typing').focus()`);
 await key('keyDown','c','KeyC',67);await key('keyUp','c','KeyC',67);assert.equal((await state()).state.picking,false);
 pass('Physical C key arms element commenting and leaves editable fields alone');
 await pageRun(`document.activeElement?.blur()`);
 result=await show(seed[3]);assert.equal(result.ok,true,result.error);assert.equal(await pageRun('innerWidth'),1542);assert.equal(await pageRun('innerHeight'),1107);
 assert.deepEqual((await session()).viewportReplay,{width:1542,height:1107});assert.equal((await state()).state.openPinId,seed[3]);
 assert.equal(await pageRun(`document.querySelector('diffuse-live-overlay').shadowRoot.querySelectorAll('.comment-pin:not([hidden])').length`),1);
 pass('Legacy area with no DOM anchor replays the exact1542×1107 saved size and shows its correct pin');
 await run(`__navigationTest.getSession().pendingDraftId='unsaved'`);
 await assert.rejects(request({type:'OPEN_REVIEW',reviewId:'navigation-review',commentId:seed[0]}),/Save or cancel/);
 pass('Pending draft blocks review replacement before navigation');
 const artifacts=join(project,'artifacts/comment-navigation');await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'results.json'),JSON.stringify({results,localOnly:true},null,2));
}finally{
 for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('Fixture ended'));}pending.clear();socket?.close();child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();});await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}
