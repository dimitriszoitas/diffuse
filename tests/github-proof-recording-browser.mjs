// Real tab capture in a disposable Chromium profile and a local synthetic page.
// No GitHub connection, provider token, paid service or production page is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'diffuse-proof-native-')),extension=join(temp,'extension'),artifacts=join(project,'artifacts/github-proof-recording');
await cp(join(project,'extension'),extension,{recursive:true});await mkdir(artifacts,{recursive:true});
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const diagnostic=`
let proofSmoke;
globalThis.__proofSmoke={
 async initialize(url){const target=(await chrome.tabs.query({url}))[0];await startAudit({targetTabId:target.id});const draft=await captureDraft(null,{pending:false});const saved=await reviews.addComment(draft.id,{comment:'Synthetic action should update the counter.',state:'Counter page',category:'ux-issue',severity:'minor'});const context={owner:'local',repo:'synthetic',number:1,url:'https://github.com/local/synthetic/pull/1',headSha:'a'.repeat(40),previewUrl:new URL(url).origin+'/',sourcePreviewUrl:new URL(url).origin+'/',association:'manual'};await reviews.setPRReviewContext(session.reviewId,context);session.prContext=context;await refreshComments();await publish();const review=await reviews.getReview(session.reviewId);proofSmoke={review,comment:review.comments.find(v=>v.id===saved.comment.id),context};return {reviewId:review.id,commentId:saved.comment.id};},
 async start(){return capturePRProofRecording({...proofSmoke,action:'start'});},
 async stop(token){return capturePRProofRecording({...proofSmoke,action:'stop',recordingToken:token});},
 async status(){return {active:session?.recording?.kind==='pr-proof',complete:!!prProofRecording?.evidence,error:prProofRecording?.error||null,pendingDraftId:session?.pendingDraftId||null};},
 async original(){const review=await reviews.getReview(proofSmoke.review.id),comment=review.comments.find(v=>v.id===proofSmoke.comment.id);return {hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(comment.evidence))))).join(','),count:review.comments.length};},
 async end(){await stopSession();}
};
`;
await writeFile(join(extension,'background.js'),await readFile(join(extension,'background.js'),'utf8')+diagnostic);
const html=`<!doctype html><title>Diffuse synthetic proof recording</title><style>body{margin:0;background:#eef3f8;color:#16304a;font:20px system-ui}main{padding:64px}button{font:inherit;padding:18px;background:#2863db;color:white;border:0;border-radius:6px}canvas{display:block;margin-top:32px;background:white;border:1px solid #d5dfec}</style><main><h1>Proof recording smoke test</h1><p>This page contains only synthetic test content.</p><button id="action">Update counter: <span>0</span></button><canvas id="canvas" width="800" height="380"></canvas></main><script>let count=0;document.querySelector('#action').onclick=()=>document.querySelector('span').textContent=++count;const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');function draw(t){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,800,380);ctx.fillStyle=count%2?'#ed9164':'#437be6';ctx.fillRect(30+(Math.sin(t/700)+1)*310,130,100,100);ctx.fillStyle='#16304a';ctx.font='24px system-ui';ctx.fillText('Live interaction '+count,30,50);requestAnimationFrame(draw);}requestAnimationFrame(draw);</script>`;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;let browser,worker,page;const results=[];
const until=async(check,label,timeout=15000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,200));}throw Error('Timed out: '+label);};
async function verifyPlayable(evidence,name){
  assert(evidence.dataUrl.length<=2*1024*1024);assert(evidence.durationMs>500&&evidence.durationMs<=30000);
  await writeFile(join(artifacts,`${name}.webm`),Buffer.from(evidence.dataUrl.split(',')[1],'base64'));
  const playback=await browser.newPage();await playback.goto(origin+'/playback');
  const result=await playback.evaluate(async dataUrl=>{const video=document.createElement('video');video.muted=true;video.controls=true;document.body.replaceChildren(video);video.src=dataUrl;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('Video decode failed'));});await video.play();await new Promise(resolve=>setTimeout(resolve,600));const result={width:video.videoWidth,height:video.videoHeight,readyState:video.readyState,played:video.currentTime};video.pause();return result;},evidence.dataUrl);
  assert(result.width>0&&result.height>0&&result.readyState>=2&&result.played>0);assert.equal(result.width,evidence.width);assert.equal(result.height,evidence.height);await playback.close();return result;
}
try{
  browser=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),headless:true,viewport:null,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1280,900','--use-mock-keychain','--password-store=basic']});
  worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');const id=new URL(worker.url()).host,cdp=await browser.browser().newBrowserCDPSession();
  page=browser.pages()[0];await page.goto(origin+'/counter');await page.bringToFront();
  const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(v=>v.url===page.url()).targetId});
  await worker.evaluate(url=>globalThis.__proofSmoke.initialize(url),page.url());const original=await worker.evaluate(()=>globalThis.__proofSmoke.original());
  await page.screenshot({path:join(artifacts,'synthetic-page.png')});
  const short=await worker.evaluate(()=>globalThis.__proofSmoke.start());await page.locator('#action').click();await page.waitForTimeout(1400);await page.locator('#action').click();await page.waitForTimeout(1400);
  const shortEvidence=await worker.evaluate(token=>globalThis.__proofSmoke.stop(token),short.recordingToken);const shortDecode=await verifyPlayable(shortEvidence,'manual-stop');
  assert.deepEqual(await worker.evaluate(()=>globalThis.__proofSmoke.original()),original);results.push({manualStop:true,durationMs:shortEvidence.durationMs,dataUrlBytes:shortEvidence.dataUrl.length,decode:shortDecode});console.log('PASS real tab capture, interactions, playable manual-stop WebM, original evidence unchanged');
  await page.bringToFront();const auto=await worker.evaluate(()=>globalThis.__proofSmoke.start());await page.locator('#action').click();
  await until(async()=>{const status=await worker.evaluate(()=>globalThis.__proofSmoke.status());if(status.error)throw Error(status.error);return status.complete;},'29-second proof auto-stop',33000);
  const status=await worker.evaluate(()=>globalThis.__proofSmoke.status());assert.equal(status.active,false);assert.equal(status.pendingDraftId,null);
  const autoEvidence=await worker.evaluate(token=>globalThis.__proofSmoke.stop(token),auto.recordingToken);assert(autoEvidence.durationMs>=28500&&autoEvidence.durationMs<=30000);const autoDecode=await verifyPlayable(autoEvidence,'automatic-stop');
  assert.deepEqual(await worker.evaluate(()=>globalThis.__proofSmoke.original()),original);results.push({automaticStop:true,durationMs:autoEvidence.durationMs,dataUrlBytes:autoEvidence.dataUrl.length,decode:autoDecode,normalComposerOpened:false,originalUnchanged:true});
  await worker.evaluate(()=>globalThis.__proofSmoke.end());await writeFile(join(artifacts,'verification.json'),JSON.stringify({passed:true,browser:'Disposable Chromium with native chrome.tabCapture and MediaRecorder',productionAuth:false,results},null,2));
  console.log('PASS native auto-stop before30seconds, playable WebM under2MiB, no comment composer, original evidence unchanged');
}catch(error){if(worker)console.error('Proof state:',await worker.evaluate(()=>globalThis.__proofSmoke?.status()).catch(()=>null));throw error;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
