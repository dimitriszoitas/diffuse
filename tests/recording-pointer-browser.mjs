// Real tabCapture/MediaRecorder frames, with the shipped isolated pointer helper.
// The disposable worker replaces only orchestration around those production files.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const artifacts = join(project, 'artifacts', 'journey');
const temporary = await mkdtemp(join(tmpdir(), 'diffuse-pointer-browser-'));
const extension = join(temporary, 'extension');
await mkdir(extension); await mkdir(artifacts, {recursive: true});
for (const file of ['recording-pointer.js', 'journey-page.js', 'journey-executor.mjs', 'offscreen.js', 'offscreen.html']) {
  await cp(join(project, 'extension', file), join(extension, file));
}
await writeFile(join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Recording pointer fixture', version: '1.0',
  permissions: ['tabs', 'activeTab', 'scripting', 'debugger', 'tabCapture', 'offscreen'],
  host_permissions: ['http://127.0.0.1/*'], action: {default_title: 'Record fixture', default_popup: 'popup.html'},
  background: {service_worker: 'worker.js', type: 'module'},
}));
await writeFile(join(extension, 'popup.html'), '<!doctype html><title>Record fixture</title><p>Recording fixture</p>');
await writeFile(join(extension, 'worker.js'), `
import {createJourneyExecutor} from './journey-executor.mjs';
let tabId;
const media = async (type, fields={}) => {
  const reply = await chrome.runtime.sendMessage({namespace:'diffuse',target:'offscreen',type,sessionId:'pointer-fixture',...fields});
  if (!reply?.ok) throw new Error(reply?.error || 'Recording unavailable'); return reply;
};
globalThis.pointer = (type, fields={}) => chrome.tabs.sendMessage(tabId,{namespace:'diffuse-recording-pointer',type,...fields},{frameId:0});
globalThis.evidence = type => chrome.tabs.sendMessage(tabId,{namespace:'diffuse',type},{frameId:0}).catch(()=>{});
globalThis.beginJourney = async () => {
  const tab=await chrome.tabs.get(tabId);
  globalThis.journey=createJourneyExecutor({chromeApi:chrome,tabId,startUrl:tab.url,assertPageAccess:async()=>{},
    captureScreenshot:async observation=>({dataUrl:'data:image/png;base64,'+(await chrome.debugger.sendCommand({tabId},'Page.captureScreenshot',{format:'png'})).data,width:observation.context.viewport.width,height:observation.context.viewport.height})});
};
globalThis.finishRecording=async()=>{await pointer('STOP').catch(()=>{});return (await media('STOP_RECORDING',{recordingId:'pointer-recording'})).video;};
globalThis.beginRecording=async url=>{
  tabId=(await chrome.tabs.query({})).find(tab=>tab.url===url).id;
    await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'Verify pointer feedback in local fixture video.'});
    await media('START_AUDIT');
    const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tabId});
    await media('START_RECORDING',{recordingId:'pointer-recording',streamId,viewport:{width:1100,height:800,dpr:1},journey:true});
    await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:['recording-pointer.js']});
    await pointer('START');
    return true;
};
`);
const pageHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Pointer recording fixture</title><style>body{margin:0;background:white;font:20px system-ui;color:#223344}main{padding:80px}a,button{font:inherit;padding:20px;margin:20px;border:1px solid #9aabba;background:white;color:#234455;display:inline-block}#blank{height:240px}</style></head><body><main><h1>Recording feedback</h1><button id="ordinary">Inspect item</button><a href="/next">Open next page</a><div id="blank"></div><button id="move">Inspect moving target</button><p id="status"></p></main><script>document.querySelector("#ordinary").onclick=()=>document.querySelector("#status").textContent="Item inspected";document.querySelector("#move").onclick=()=>window.movedTargetClicked=true;</script></body></html>';
const server = http.createServer((req, res) => {res.setHeader('content-type', 'text/html');res.end(req.url === '/next' ? '<!doctype html><title>Next page</title><h1>Arrived</h1>' : pageHtml);});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(30);}throw new Error(`Timed out: ${label}`);}
let context;
try {
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: chromium.executablePath(), headless: true, viewport: {width: 1100, height: 800},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1100,900', '--use-mock-keychain', '--password-store=basic'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); await page.goto(origin); await page.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const target = targets.targetInfos.find(item => item.url === page.url());
  await cdp.send('Extensions.triggerAction', {id: new URL(worker.url()).host, targetId: target.targetId});
  await worker.evaluate(url => beginRecording(url), page.url());
  await page.bringToFront();
  const marker = () => page.evaluate(() => Boolean(document.querySelector('diffuse-recording-pointer')));
  const point = await page.locator('#ordinary').evaluate(el => {const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
  await pause(250);
  await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y);
  await until(marker, 'trusted click halo');
  const rendered = await page.evaluate(p => {
    const host=document.querySelector('diffuse-recording-pointer'),halo=host.shadowRoot.querySelector('#halo'),ring=host.shadowRoot.querySelector('#ring');
    return {x:parseFloat(halo.style.left),y:parseFloat(halo.style.top),pointerEvents:getComputedStyle(host).pointerEvents,hit:document.elementFromPoint(p.x,p.y).id,ring:!ring.hidden};
  }, point);
  assert.ok(Math.abs(rendered.x-point.x)<.01 && Math.abs(rendered.y-point.y)<.01);
  assert.equal(rendered.pointerEvents,'none'); assert.equal(rendered.hit,'ordinary'); assert.equal(rendered.ring,true);
  assert.equal(await page.locator('#status').textContent(), 'Item inspected');
  await page.screenshot({path:join(artifacts,'recording-pointer-click.png')});
  await pause(300);
  await worker.evaluate(() => pointer('CLEAR'));
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:500,clientY:500,button:0})));
  assert.equal(await marker(), false, 'Synthetic website events must not show a recorded click');
  await worker.evaluate(() => pointer('PAUSE'));
  await page.mouse.move(700,450); await page.mouse.click(700,450);
  assert.equal(await marker(), false, 'Pause removes and suppresses the marker');
  await worker.evaluate(() => pointer('RESUME'));
  await page.mouse.move(720,460); assert.equal(await marker(), true);
  await worker.evaluate(() => evidence('PREPARE_EVIDENCE'));
  await page.mouse.move(740,480); assert.equal(await marker(), false, 'Screenshot preparation hides and suppresses the pointer');
  await worker.evaluate(() => evidence('RESTORE_EVIDENCE'));
  await page.mouse.move(760,500); assert.equal(await marker(), true);
  await worker.evaluate(() => pointer('STOP'));
  await page.mouse.move(780,520); assert.equal(await marker(), false, 'Stop removes the marker and its listeners');
  console.log('PASS trusted click/move marker, unobstructed controls, synthetic-event exclusion, pause/resume, screenshot suspension and stop cleanup');

  await worker.evaluate(async () => {await beginJourney();globalThis.observation=await journey.observe();});
  assert.equal(await marker(), false, 'Journey observations must have clean screenshot evidence');
  const cancelled = await worker.evaluate(async () => {
    const controller=new AbortController(),control=observation.controls.find(item=>item.label==='Inspect moving target');
    setTimeout(()=>controller.abort(),60);
    try {await journey.execute({type:'click',targetId:control.id},observation,{signal:controller.signal});return null;}
    catch(error){return error.code;}
  });
  assert.equal(cancelled,'JOURNEY_CANCELLED'); assert.equal(await page.evaluate(()=>window.movedTargetClicked),undefined);
  assert.equal(await marker(),false,'Cancellation clears the lead-in marker');
  await worker.evaluate(async()=>{globalThis.observation=await journey.observe();});
  const moving = worker.evaluate(async () => {
    const control=observation.controls.find(item=>item.label==='Inspect moving target');
    try{await journey.execute({type:'click',targetId:control.id},observation);return null;}catch(error){return error.code;}
  });
  await until(marker,'moving target lead-in');
  await page.locator('#move').evaluate(el=>{el.style.transform='translateX(80px)';});
  assert.equal(await moving,'JOURNEY_STALE'); assert.equal(await page.evaluate(()=>window.movedTargetClicked),undefined);
  assert.equal(await marker(),false,'A changed click location clears its marker without clicking');
  await page.locator('#move').evaluate(el=>{el.style.transform='';});
  await worker.evaluate(async()=>{globalThis.observation=await journey.observe();});
  console.log('PASS cancellation and a moving target during the visible lead-in cause no click and remove the marker');
  const navPoint = await page.locator('a').evaluate(el => {const b=el.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};});
  const nav = worker.evaluate(async () => {
    const control=observation.controls.find(item=>item.label==='Open next page');
    return journey.execute({type:'click',targetId:control.id},observation);
  });
  await until(marker, 'journey click lead-in');
  assert.equal(page.url(), `${origin}/`, 'Marker is drawn before navigation starts');
  await nav; assert.equal(page.url(), `${origin}/next`);
  assert.equal(await marker(), false, 'The marker does not persist into a replacement document');
  await pause(250);
  const video = await worker.evaluate(() => finishRecording());
  assert.ok(video.dataUrl.startsWith('data:video/')); assert.ok(video.bytes>1000);
  await writeFile(join(artifacts,'recording-pointer-fixture.webm'),Buffer.from(video.dataUrl.split(',')[1],'base64'));
  await worker.evaluate(() => journey.cleanup());

  const frames = await page.evaluate(async ({dataUrl,durationMs,points}) => {
    const video=document.createElement('video');video.muted=true;video.src=dataUrl;document.body.append(video);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Video decode failed'));});
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),found=points.map(()=>null),peaks=points.map(()=>({goldPixels:0}));let navigationFrame=null;
    for(let time=.08;time<durationMs/1000;time+=.08){
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Video seek timed out')),2000);video.onseeked=()=>{clearTimeout(timer);resolve();};video.currentTime=time;});
      ctx.drawImage(video,0,0);
      // Chromium can letterbox tabCapture when the debugger warning changes
      // the browser's content height. The fixture background is pure white.
      const edge=ctx.getImageData(2,0,1,canvas.height).data;let topInset=0;
      while(topInset<canvas.height&&edge[topInset*4]+edge[topInset*4+1]+edge[topInset*4+2]<30)topInset++;
      if(topInset===canvas.height)continue;
      for(let j=0;j<points.length;j++){
        if(found[j])continue; const p=points[j],scaleX=canvas.width/1100;
        const bytes=ctx.getImageData(Math.max(0,Math.round(p.x*scaleX-25)),Math.max(0,Math.round(p.y*scaleX+topInset-25)),50,50).data;
        let gold=0; for(let i=0;i<bytes.length;i+=4){if(bytes[i]>170&&bytes[i]-bytes[i+2]>28&&bytes[i+1]-bytes[i+2]>15&&bytes[i]>=bytes[i+1])gold++;}
        if(gold>peaks[j].goldPixels)peaks[j]={time:Math.round(time*1000),goldPixels:gold};
        if(gold>80){found[j]={time:Math.round(time*1000),goldPixels:gold,topInset};if(j===1)navigationFrame=canvas.toDataURL('image/png');}
      }
      if(found.every(Boolean))break;
    }
    video.remove();return{width:canvas.width,height:canvas.height,found,peaks,navigationFrame};
  },{dataUrl:video.dataUrl,durationMs:video.durationMs,points:[point,navPoint]});
  if(frames.navigationFrame)await writeFile(join(artifacts,'recording-pointer-navigation.png'),Buffer.from(frames.navigationFrame.split(',')[1],'base64'));
  delete frames.navigationFrame;
  console.log('Video frame analysis',JSON.stringify({durationMs:video.durationMs,point,navPoint,...frames}));
  assert.ok(frames.found[0], 'Recorded frames must show the yellow marker at the actual user click');
  assert.ok(frames.found[1], 'Recorded frames must show the yellow marker at the journey click before navigation');
  await writeFile(join(artifacts,'recording-pointer-verification.json'),JSON.stringify({bytes:video.bytes,durationMs:video.durationMs,...frames},null,2));
  console.log('PASS real tabCapture video contains yellow click feedback at both the manual and AI navigation click coordinates',JSON.stringify(frames));
} finally {
  await context?.close(); await new Promise(resolve=>server.close(resolve));
  await rm(temporary,{recursive:true,force:true});
}
