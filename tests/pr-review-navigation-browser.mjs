// Real extension worker, independent original/preview origins and imported portable review.
// Disposable browser and fictional evidence only; no GitHub/AI/Jira requests.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-pr-navigation-')),extension=join(temp,'extension');
await cp(join(project,'extension'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];manifest.background.service_worker='pr-navigation-worker.js';
await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
await writeFile(join(extension,'pr-navigation-worker.js'),(await readFile(join(extension,'background.js'),'utf8'))+"\nimport {createReviewBundle as __bundle} from './review-transfer.mjs';globalThis.__prTest={handle,reviews,bundle:__bundle,getSession:()=>session};");
let originalHits=0;
const html=url=>`<!doctype html><title>Preview ${url}</title><style>body{font:16px system-ui;margin:24px;min-height:1600px}#scroller{height:200px;overflow:auto;border:1px solid;padding:12px}button{padding:16px;margin:12px;display:block}</style><h1>Current preview</h1><div id="scroller"><div style="height:600px"></div><button id="saved-anchor">Original position</button><button id="moved-anchor">New component</button><div style="height:400px"></div></div>`;
const original=http.createServer((req,res)=>{originalHits++;res.setHeader('content-type','text/html');res.end(html(req.url));});
const preview=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html(req.url));});
await Promise.all([new Promise(r=>original.listen(0,'127.0.0.1',r)),new Promise(r=>preview.listen(0,'127.0.0.1',r))]);
const source=`http://127.0.0.1:${original.address().port}`,target=`http://127.0.0.1:${preview.address().port}`,profile=join(temp,'profile');
const child=spawn(process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),['--headless=new','--no-first-run','--no-default-browser-check','--use-mock-keychain','--password-store=basic','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--window-size=1440,1000','about:blank'],{stdio:'ignore'});
let socket,sequence=0;const pending=new Map(),pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{const end=Date.now()+20000;while(Date.now()<end){const found=await fn();if(found)return found;await pause(80);}throw new Error(`Timed out: ${label}`);};
try{
 const [port,path]=await until(async()=>{try{return(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');}catch{return null;}},'browser');
 socket=new WebSocket(`ws://127.0.0.1:${port}${path}`);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const response=JSON.parse(event.data),wait=pending.get(response.id);if(wait){pending.delete(response.id);clearTimeout(wait.timer);response.error?wait.reject(new Error(response.error.message)):wait.resolve(response.result);}};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},25000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const worker=await until(async()=>(await send('Target.getTargets')).targetInfos.find(item=>item.type==='service_worker'&&item.url.endsWith('/pr-navigation-worker.js')),'worker');
 const workerId=(await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).sessionId;
 const run=async(expression)=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},workerId);if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;};
 await until(()=>run('Boolean(globalThis.__prTest)'),'worker ready');
 const seed=await run(`(async()=>{
  const createReviewBundle=__prTest.bundle;
  const source=${JSON.stringify(source)},target=${JSON.stringify(target)},date='2026-01-01T00:00:00.000Z';
  const review={title:'Received mobile and desktop feedback',reviewKey:'portable-review-native',productionUrl:source+'/one',mode:'audit',createdAt:date,updatedAt:date,comments:[]};
  for(const [index,path,width,height,key]of [[0,'/one',390,844,'phone'],[1,'/two?tab=details#feedback',1280,900,'laptop']]){
   const context={url:source+path,viewport:{width,height,dpr:1},viewportProfile:{key,mode:'preset'},scroll:{x:0,y:0},nestedScroll:[{selector:'#scroller',x:0,y:570}]};
   review.comments.push({findingKey:'portable-finding-native-'+index,createdAt:date,updatedAt:date,mode:'audit',fields:{comment:'Feedback for '+path,state:'Visible',severity:'minor',category:'ux-issue'},context:{production:context},selection:{schemaVersion:1,kind:'element',tagName:'button',selector:'#saved-anchor',selectorFormat:'css',anchor:{version:1,kind:'element',selector:'#saved-anchor',identity:{tag:'button',attributes:{id:'saved-anchor'}}},rect:{viewport:{x:48,y:80,width:200,height:50},document:{x:48,y:650,width:200,height:50}},context},evidence:{production:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sG8sAAAAASUVORK5CYII=',width:1,height:1,capturedAt:date}}});
  }
  const imported=await __prTest.reviews.importReview(createReviewBundle(review));
  const bound=await __prTest.reviews.setPRReviewContext(imported.review.id,{owner:'dimitriszoitas',repo:'diffuse',number:12,headSha:'a'.repeat(40),previewUrl:target+'/one'});
  const tab=await chrome.tabs.create({url:target+'/one',active:true});
  return {review:bound,tabId:tab.id};
 })()`);
 const reportRequest=message=>run(`__prTest.handle(${JSON.stringify(message)},{id:chrome.runtime.id,url:chrome.runtime.getURL('report.html'),frameId:0})`);
 const open=await reportRequest({type:'OPEN_REVIEW',reviewId:seed.review.id,targetTabId:seed.tabId});assert.equal(open.ok,true);assert.equal(open.reusedTab,true);
 const current=()=>run('__prTest.getSession()');
 const pageRun=expression=>run(`chrome.scripting.executeScript({target:{tabId:${open.tabId}},world:'MAIN',func:()=>(${expression})}).then(items=>items[0].result)`);
 const contentRequest=message=>run(`(async()=>{const tab=await chrome.tabs.get(${open.tabId});return __prTest.handle({...${JSON.stringify(message)},sessionId:__prTest.getSession().id},{id:chrome.runtime.id,url:tab.url,tab,frameId:0});})()`);
 assert.equal(await pageRun('location.href'),target+'/one');assert.equal(await pageRun('innerWidth'),390);assert.equal((await current()).prContext.headSha,'a'.repeat(40));
 assert.equal(await pageRun("document.querySelector('diffuse-live-overlay').shadowRoot.querySelectorAll('.comment-pin').length"),1);
 assert.ok(await pageRun("document.getElementById('scroller').scrollTop")>500);
 console.log('PASS Received portable review reuses open chosen preview with mobile pin and nested scroll');
 await contentRequest({type:'SHOW_COMMENT',commentId:seed.review.comments[1].id});
 assert.equal(await pageRun('location.href'),target+'/two?tab=details#feedback');assert.equal(await pageRun('innerWidth'),1280);
 await contentRequest({type:'SHOW_COMMENT',commentId:seed.review.comments[0].id});assert.equal(await pageRun('location.href'),target+'/one');assert.equal(await pageRun('innerWidth'),390);
 console.log('PASS Recheck navigation preserves route/query/hash and restores each finding viewport');
 await pageRun("document.getElementById('moved-anchor').scrollIntoView({block:'center'})");
 const position=await pageRun("(()=>{const r=document.getElementById('moved-anchor').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
 const remapped=await contentRequest({type:'REMAP_COMMENT',commentId:seed.review.comments[0].id,selector:'#moved-anchor',position});
 assert.equal(remapped.ok,true);assert.equal(remapped.pinSelection.selector,'#moved-anchor');
 const stored=await run(`__prTest.reviews.getReview(${JSON.stringify(seed.review.id)})`);
 const item=stored.comments[0];assert.equal(item.selection.selector,'#saved-anchor');assert.equal(item.pinSelection,undefined);assert.equal(item.context.production.url,source+'/one');assert.deepEqual(item.evidence,seed.review.comments[0].evidence);assert.equal(item.prAttachments[0].selection.selector,'#moved-anchor');
 const live=await contentRequest({type:'GET_COMMENT',commentId:item.id});assert.equal(live.comment.pinSelection.selector,'#moved-anchor');assert.equal(live.comment.context.production.url,target+'/one');
 assert.equal(originalHits,0,'Opening and rechecking must not visit the original build');
 console.log('PASS Real worker remaps on new build while original route, selector and screenshot remain unchanged');
}finally{
 for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('Fixture ended'));}pending.clear();socket?.close();child.kill('SIGTERM');
 await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();});
 await Promise.all([new Promise(r=>original.close(r)),new Promise(r=>preview.close(r))]);await rm(temp,{recursive:true,force:true});
}
