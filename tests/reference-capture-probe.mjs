// Isolated native proof: no toolbar invocation on the reference, no helper tab,
// no desktopCapture permission, and identity checked before accepting a stream.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import http from 'node:http';
const require=createRequire(import.meta.url);
const{chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const temporary=await mkdtemp(join(tmpdir(),'diffuse-reference-proof-'));
const referenceTitle='Diffuse isolated capture reference';
const manifest={manifest_version:3,name:'Diffuse reference capture proof',version:'1.0',permissions:['offscreen','tabs','scripting','tabCapture','activeTab'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'worker.js'},action:{default_title:'Unused test action'}};
await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest));
await writeFile(join(temporary,'worker.js'),'globalThis.referenceProbe=true;');
await writeFile(join(temporary,'offscreen.html'),'<!DOCTYPE html><script src="offscreen.js"></script>');
await writeFile(join(temporary,'offscreen.js'),`
let stream,video;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type==='CAPTURE'){
    (async()=>{
      const candidate=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',width:{max:message.width},height:{max:message.height},frameRate:{max:30}},audio:false,preferCurrentTab:false,systemAudio:'exclude',surfaceSwitching:'exclude'});
      const track=candidate.getVideoTracks()[0],handle=track.getCaptureHandle?.();
      if(track.getSettings().displaySurface!=='browser'||handle?.handle!==message.expectedHandle){candidate.getTracks().forEach(t=>t.stop());throw new Error('Selected tab does not match the reference');}
      stream=candidate;video=document.createElement('video');video.srcObject=stream;video.muted=true;video.playsInline=true;document.body.append(video);await video.play();
      const settings=track.getSettings();return{ok:true,handle,width:video.videoWidth,height:video.videoHeight,displaySurface:settings.displaySurface};
    })().then(reply,error=>reply({ok:false,error:error.name+': '+error.message}));return true;
  }
  if(message.type==='FRAME'){
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext('2d');context.drawImage(video,0,0);reply({pixel:[...context.getImageData(5,5,1,1).data],handle:stream.getVideoTracks()[0].getCaptureHandle?.()});
  }
});`);
const server=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});response.end(`<!DOCTYPE html><title>${request.url==='/reference'?referenceTitle:'Diffuse isolated production'}</title><style>body{margin:0;background:rgb(255,0,0)}</style><h1>Fictional capture fixture</h1>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let context;
async function until(check,label){const started=Date.now();while(Date.now()-started<8000){if(await check())return;await pause(100);}throw new Error(`Timed out: ${label}`);}
try{
  context=await chromium.launchPersistentContext(join(temporary,'profile'),{executablePath:chromium.executablePath(),headless:process.env.REFERENCE_HEADLESS==='1',viewport:null,args:[`--disable-extensions-except=${temporary}`,`--load-extension=${temporary}`,'--window-size=1200,900','--use-mock-keychain','--password-store=basic',`--auto-select-tab-capture-source-by-title=${referenceTitle}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
  const reference=context.pages()[0];await reference.goto(`${origin}/reference`);
  const production=await context.newPage();await production.goto(`${origin}/production`);
  const extensionId=new URL(worker.url()).host;
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,reference.url());
  const tabCaptureError=await worker.evaluate(async tabId=>{try{await chrome.tabCapture.getMediaStreamId({targetTabId:tabId});return null;}catch(error){return error.message;}},tabId);
  assert.match(tabCaptureError,/not been invoked|activeTab/i);
  const expectedHandle=`diffuse-reference-${crypto.randomUUID()}`;
  await worker.evaluate(async({tabId,expectedHandle,extensionId})=>chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:(handle,origin)=>navigator.mediaDevices.setCaptureHandleConfig({exposeOrigin:false,handle,permittedOrigins:[origin]}),args:[expectedHandle,`chrome-extension://${extensionId}`]}),{tabId,expectedHandle,extensionId});
  const pixels=await reference.evaluate(()=>({width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio)}));
  await worker.evaluate(()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons:['DISPLAY_MEDIA'],justification:'Validate user-selected local reference tab capture.'}));
  const capture=await Promise.race([worker.evaluate(args=>chrome.runtime.sendMessage({type:'CAPTURE',...args}),{...pixels,expectedHandle}),pause(12000).then(()=>{throw new Error('Native capture picker timed out');})]);
  assert.equal(capture.ok,true,capture.error);assert.equal(capture.handle.handle,expectedHandle);assert.equal(capture.displaySurface,'browser');assert.equal(capture.width,pixels.width);assert.equal(capture.height,pixels.height);
  console.log('PASS Offscreen display capture verifies the selected reference without action invocation or a helper tab');
  await until(async()=>{const frame=await worker.evaluate(()=>chrome.runtime.sendMessage({type:'FRAME'}));return frame.pixel[0]>240&&frame.pixel[2]<10;},'red source pixels');
  // Continuous frame progression is checked through Diffuse's real WebRTC
  // receiver in sidepanel-browser.mjs; this probe covers API permission/identity.
  assert.equal(context.pages().length,2);console.log('PASS Capture decodes at viewport × DPR resolution with no helper tab');
  await reference.reload();await until(async()=>{const frame=await worker.evaluate(()=>chrome.runtime.sendMessage({type:'FRAME'}));return frame.handle===null;},'identity reset after reference navigation');console.log('PASS Reference reload clears Capture Handle, requiring explicit identity recovery');
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
