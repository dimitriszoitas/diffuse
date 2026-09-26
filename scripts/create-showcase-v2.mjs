// Records real extension workflows in a disposable profile, then composes a
// captioned launch film. Every app/person/key/provider response here is fictional.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, cp, readFile, writeFile, mkdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const project = resolve(import.meta.dirname, '..');
const output = join(project, 'artifacts', 'presentation');
const footage = join(output, 'footage-v2');
const encoder = process.env.SHOWCASE_FFMPEG || '/private/tmp/diffuse-showcase-encoding/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
await mkdir(footage, {recursive:true});
const temp = await mkdtemp(join(tmpdir(), 'diffuse-showcase-'));
const extension = join(temp, 'extension');
const requests = [];
// V2: real continuous browser footage; no marketing stage or replacement stills.
const demoFiles = new Map([['/showcase-production.html','text/html'],['/showcase-prototype.html','text/html'],['/showcase.css','text/css'],['/showcase.js','text/javascript']]);
const providerResult = {
  summary:'Two candidate observations in the visible studio overview.',
  limitations:['Only this captured state was reviewed. These are heuristic suggestions, not verified interaction tests.'],
  suggestions:[
    {category:'ux-issue',title:'Give the main action clearer emphasis',comment:'New project has a muted treatment similar to secondary controls.',expected:'Consider stronger emphasis for the primary creation action.',state:'Studio overview · default',component:'New project action',severity:'major',mismatchScore:74,confidence:.88,region:{x:.845,y:.17,width:.13,height:.085}},
    {category:'copy-change',title:'Clarify what is ready for review',comment:'The metric label does not identify whether it counts projects or individual items.',expected:'Consider “Items ready for review” to clarify the number.',state:'Studio overview · default',component:'Review metric',severity:'minor',mismatchScore:24,confidence:.79,region:{x:.47,y:.28,width:.23,height:.20}},
  ],
};
const server = http.createServer(async (req,res) => {
  try {
    const path = new URL(req.url,'http://localhost').pathname;
    if(path==='/simulated-ai' && req.method==='POST') {
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);requests.push({images:request.messages[0].content.filter(block=>block.type==='image').length});
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: {"type":"message_start"}\n\n');
      await pause(900);
      const text=JSON.stringify(providerResult);
      for(const event of [{type:'content_block_start',content_block:{type:'text',text:''}},{type:'content_block_delta',delta:{type:'text_delta',text}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}])res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();return;
    }
    if(demoFiles.has(path)) {
      res.writeHead(200,{'Content-Type':demoFiles.get(path),'Cache-Control':'no-store','Content-Security-Policy':"frame-ancestors 'none'"});
      res.end(await readFile(join(project,'demo',path.slice(1))));return;
    }
    // The composition serves only generated presentation assets, never workspace files.
    const relative=decodeURIComponent(path.slice(1));
    if(relative.includes('..')||relative.includes('\\')||!relative||!(/^(?:footage\/)?[a-zA-Z0-9._-]+$/.test(relative))){res.writeHead(404);res.end();return;}
    const file=join(output,relative);const info=await stat(file);
    const mime=relative.endsWith('.html')?'text/html':relative.endsWith('.webm')?'video/webm':relative.endsWith('.mp4')?'video/mp4':relative.endsWith('.png')?'image/png':relative.endsWith('.vtt')?'text/vtt':'application/octet-stream';
    const bytes=await readFile(file);const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),info.size-1):info.size-1;res.writeHead(206,{'Content-Type':mime,'Content-Range':`bytes ${start}-${end}/${info.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));}
    else {res.writeHead(200,{'Content-Type':mime,'Accept-Ranges':'bytes','Content-Length':info.size});res.end(bytes);}
  }catch{res.writeHead(404);res.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
const scenes=[];
let currentScene=null;
async function until(check,label,timeout=25000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(100);}throw new Error(`Timed out: ${label}`);}
const ease=t=>t*t*(3-2*t);
const seconds=track=>(Date.now()-track.started)/1000;
async function move(track,x,y,duration=650){
  const from=track.cursor||{x:980,y:550};const dx=x-from.x,dy=y-from.y;
  const bend=Math.min(75,Math.hypot(dx,dy)*.16);const direction=(Math.round(x+y)%2)?1:-1;
  const norm=Math.hypot(dx,dy)||1;const cx=(from.x+x)/2-dy/norm*bend*direction,cy=(from.y+y)/2+dx/norm*bend*direction;
  const count=Math.max(8,Math.round(duration/32));const begun=Date.now();
  for(let i=1;i<=count;i++){const t=ease(i/count),px=(1-t)*(1-t)*from.x+2*(1-t)*t*cx+t*t*x,py=(1-t)*(1-t)*from.y+2*(1-t)*t*cy+t*t*y;await track.page.mouse.move(px,py);track.cursor={x:px,y:py};track.events.push({at:seconds(track),x:px,y:py,down:Boolean(track.down)});await pause(Math.max(0,begun+duration*i/count-Date.now()));}
}
async function button(track,down){track.down=down;track.events.push({at:seconds(track),...track.cursor,down});await track.page.mouse[down?'down':'up']();}
async function click(track,locator){await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert(b);await move(track,b.x+b.width*.52,b.y+b.height*.53,520);await pause(110);await button(track,true);await pause(75);await button(track,false);await pause(180);}
async function type(track,locator,text){await click(track,locator);for(let i=0;i<text.length;i++){await track.page.keyboard.insertText(text[i]);await pause(62+(i*17%44)+(text[i]===' '?35:0));}}
async function select(track,locator,steps=1){await click(track,locator);await pause(160);for(let i=0;i<steps;i++){await track.page.keyboard.press('ArrowDown');await pause(200);}await track.page.keyboard.press('Tab');await pause(200);}
async function camera(track,z,target,transition=.9){let x=960,y=540;if(Array.isArray(target)){[x,y]=target;}else if(target){const b=await target.boundingBox();if(b){x=b.x+b.width/2;y=b.y+b.height/2;}}const t=seconds(track)-currentScene.sourceStart;const last=currentScene.zoom.at(-1);currentScene.zoom.push({...last,t:Math.max(last.t,t)},{t:t+transition,z,x,y});}
async function film(track,title,caption,action,{simulated=false}={}){
  await track.page.bringToFront();const start=seconds(track);currentScene={title,caption,sourcePath:join(footage,`${track.name}.webm`),sourceStart:start,duration:0,zoom:[{t:0,z:1,x:960,y:540}],cursor:[],simulated};console.log(`Recording: ${title}`);
  await action();currentScene.duration=seconds(track)-start;currentScene.zoom=currentScene.zoom.map(key=>({...key,t:Math.min(key.t,currentScene.duration-.04)}));currentScene.sourceStart=Math.max(0,start-.12);currentScene.cursor=track.events.filter(p=>p.at>=start).map(({at,...rest})=>({t:at-start,...rest}));if(currentScene.cursor[0]?.t>0)currentScene.cursor.unshift({t:0,...track.cursor,down:false});scenes.push(currentScene);await writeFile(join(output,'timeline-v2-progress.json'),JSON.stringify({version:2,scenes},null,2));console.log(`  ${currentScene.duration.toFixed(1)}s`);currentScene=null;
}
async function trackedPage(name){const started=Date.now();const page=await context.newPage();return{page,name,started,events:[],cursor:{x:960,y:540}};}
async function screenshot(page,name){await page.screenshot({path:join(output,name)});}
try{
  if(!process.argv.includes('--compose-only')){
    await cp(join(project,'extension'),extension,{recursive:true});
    const manifestPath=join(extension,'manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.host_permissions=['http://127.0.0.1/*','https://api.anthropic.com/*'];await writeFile(manifestPath,JSON.stringify(manifest));
    const clientPath=join(extension,'ai-client.mjs');await writeFile(clientPath,(await readFile(clientPath,'utf8')).replace('https://api.anthropic.com/v1/messages',`${origin}/simulated-ai`));
    context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:null,recordVideo:{dir:join(output,'.v2-takes'),size:{width:1920,height:1080}},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1920,1167','--use-mock-keychain','--password-store=basic']});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;const cdp=await context.browser().newBrowserCDPSession();
    const production=await trackedPage('production');const page=production.page;await page.goto(`${origin}/showcase-production.html`);const source=await context.newPage();await source.goto(`${origin}/showcase-prototype.html`);
    assert.deepEqual(await page.evaluate(()=>[innerWidth,innerHeight]),[1920,1080]);
    const openPopup=async target=>{await target.bringToFront();const{targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(item=>item.url===target.url()).targetId});const popup=await context.newPage();await target.bringToFront();await popup.goto(`chrome-extension://${id}/popup.html`);return popup;};
    let popup=await openPopup(source);const targetId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,page.url());await popup.locator('#target-tab').selectOption(String(targetId));await popup.locator('#start-comparison').click();const overlay=page.locator('diffuse-live-overlay');
    await until(()=>overlay.locator('#status').textContent({timeout:1000}).then(t=>t==='Live').catch(()=>false),'live comparison',30000);await popup.close();popup=await openPopup(page);await popup.locator('#enable-capture').click();await popup.close();
    const reviewId=await worker.evaluate(async()=>(await chrome.storage.session.get('comparison')).comparison.reviewId);
    const settings=await context.newPage();await settings.goto(`chrome-extension://${id}/ai-settings.html`);await settings.locator('#api-key').fill('sk-ant-fictional-showcase-key-not-a-real-key');await settings.locator('#save').click();await until(()=>settings.locator('#feedback').textContent().then(t=>t.includes('Settings saved')),'demo settings');await settings.close();await page.bringToFront();await overlay.locator('#opacity').fill('100');await pause(700);
    await film(production,'Live comparison','Your prototype. On the real product.',async()=>{
      await pause(500);const b=await overlay.locator('#handle').boundingBox();await move(production,b.x+b.width/2,b.y+b.height/2,850);await button(production,true);
      await move(production,1480,b.y+30,1700);await pause(350);await camera(production,1.55,[1040,310],1.1);await move(production,580,b.y+30,1900);await pause(250);await move(production,1120,b.y+30,1300);await button(production,false);await pause(400);await camera(production,1,[960,540],.8);await pause(800);
    });
    await screenshot(page,'cover.png');await screenshot(page,'poster.png');
    await film(production,'Opacity','Fade the overlay. Spot the difference.',async()=>{
      const control=overlay.locator('#opacity');const b=await control.boundingBox();await camera(production,1.7,[b.x+b.width/2,b.y+10],.8);await move(production,b.x+b.width*.55,b.y+b.height/2,650);await button(production,true);await move(production,b.x+b.width*.12,b.y+b.height/2,850);await pause(380);await move(production,b.x+b.width*.92,b.y+b.height/2,1000);await pause(350);await move(production,b.x+b.width*.58,b.y+b.height/2,700);await button(production,false);await pause(350);
    });
    await film(production,'Select an area','Hold C. Drag around what needs attention.',async()=>{
      await click(production,page.locator('h1'));const b=await page.locator('.metrics .metric').first().boundingBox();await camera(production,1.6,[b.x+b.width/2,b.y+b.height/2],.75);await move(production,b.x-6,b.y-6,500);await page.keyboard.down('c');await button(production,true);await move(production,b.x+b.width+7,b.y+b.height+7,1400);await screenshot(page,'area-selection.png');await pause(250);await button(production,false);await page.keyboard.up('c');await until(()=>overlay.locator('#comment-form').isVisible(),'area composer');await pause(350);
    });
    await film(production,'Write the observation','Clear feedback. The evidence is already attached.',async()=>{
      await camera(production,1.65,overlay.locator('#comment-actual'),.9);await type(production,overlay.locator('#comment-actual'),'Match the card spacing and rounded corners.');await pause(300);
      // Return to the design category with visible native keyboard selection.
      await camera(production,1.6,[1659,880],.8);await click(production,overlay.locator('#comment-category'));await page.keyboard.press('Home');await page.keyboard.press('Tab');await pause(300);await click(production,overlay.locator('#save-comment'));await until(()=>overlay.locator('.comment-pin').count().then(n=>n===1),'first pin');
    });
    await film(production,'Open the pin','Every observation stays anchored to its context.',async()=>{
      await camera(production,1.65,overlay.locator('.comment-pin'),.85);await click(production,overlay.locator('.comment-pin'));await camera(production,1.65,overlay.locator('#saved-comment-bubble'),.75);await pause(1900);await screenshot(page,'comment-pin.png');await click(production,overlay.locator('#close-saved-comment'));
    });
    await film(production,'Choose a recording','Some details need more than a screenshot.',async()=>{
      await click(production,overlay.locator('#comment'));await click(production,page.locator('#showcase-open-project'));await until(()=>overlay.locator('#comment-form').isVisible(),'recording composer');await camera(production,1.7,overlay.locator('#comment-actual'),.8);await type(production,overlay.locator('#comment-actual'),'Keep the primary action easy to find.');await click(production,overlay.locator('#evidence-recording'));await pause(400);
    });
    await film(production,'Record the interaction','Record the interaction as it happens.',async()=>{
      await camera(production,1.55,overlay.locator('#comment-record'),.65);await click(production,overlay.locator('#comment-record'));await until(()=>overlay.locator('#record').textContent().then(t=>t.includes('Stop recording')),'recording started');await click(production,overlay.locator('#hide'));await camera(production,1,[960,540],.75);await click(production,page.locator('#showcase-open-project'));await camera(production,1.75,[1690,260],.85);await type(production,page.locator('#showcase-project-name'),'New horizon');await type(production,page.locator('#showcase-project-description'),'A fresh digital direction.');await select(production,page.locator('#showcase-project-type'),1);await pause(600);await click(production,page.locator('#showcase-close-drawer'));await camera(production,1,[960,540],.7);await click(production,overlay.locator('#record'));await until(()=>overlay.locator('#recording-preview').isVisible(),'recording preview');
    });
    await film(production,'Preview the evidence','Play it back. Keep the clip with the comment.',async()=>{
      const video=overlay.locator('#recording-preview');await video.scrollIntoViewIfNeeded();await camera(production,1.75,video,.85);await click(production,video);await video.evaluate(v=>v.play());await pause(2200);await screenshot(page,'recording-evidence.png');await camera(production,1.6,[1659,890],.85);await click(production,overlay.locator('#save-comment'));await until(()=>overlay.locator('.comment-pin').count().then(n=>n===2),'second pin');
    });
    await click(production,overlay.locator('#stop'));await until(()=>overlay.count().then(n=>n===0),'stop comparison');popup=await openPopup(page);await popup.locator('#mode-audit').click();await popup.locator('#start-comparison').click();await popup.close();await until(()=>overlay.locator('#status').textContent({timeout:1000}).then(t=>t==='Audit ready').catch(()=>false),'audit ready');
    await film(production,'Audit any page','No prototype? Start with the page in front of you.',async()=>{
      await camera(production,1.55,overlay.locator('#status'),.8);await pause(600);await click(production,overlay.locator('#ai-review'));await until(()=>overlay.locator('#ai-run').isEnabled(),'AI ready');await camera(production,1.65,overlay.locator('#ai-instructions'),.8);await type(production,overlay.locator('#ai-instructions'),'Review hierarchy and clarity.');
      await overlay.locator('#ai-threshold').fill('90');
    },{simulated:true});
    await film(production,'Review the suggestions','AI offers suggestions. You decide what becomes feedback.',async()=>{
      await camera(production,1.65,overlay.locator('#ai-run'),.75);await click(production,overlay.locator('#ai-run'));await until(()=>overlay.locator('#ai-show-all').isVisible(),'AI results');await overlay.locator('#ai-show-all').scrollIntoViewIfNeeded();await camera(production,1.6,overlay.locator('#ai-results-status'),.7);await pause(1400);await click(production,overlay.locator('#ai-show-all'));await move(production,1800,825,450);await page.mouse.wheel(0,430);await pause(700);await camera(production,1.65,overlay.locator('.ai-suggestion').first(),.85);await pause(3300);await move(production,1710,740,600);await page.mouse.wheel(0,210);await pause(1200);
    },{simulated:true});
    await film(production,'Accept the useful findings','Accept all shown. Turn findings into evidence-backed pins.',async()=>{
      await overlay.locator('#ai-accept-all').scrollIntoViewIfNeeded();await camera(production,1.6,overlay.locator('#ai-accept-all'),.65);await click(production,overlay.locator('#ai-accept-all'));await until(()=>overlay.locator('.comment-pin').count().then(n=>n===2),'accepted AI pins');await click(production,overlay.locator('#close-ai'));await camera(production,1,[960,540],.9);await move(production,1120,420,700);await pause(550);
    },{simulated:true});
    assert.equal(requests.length,1);assert.equal(requests[0].images,1);
    const report=await trackedPage('report');const reportPage=report.page;await reportPage.goto(`chrome-extension://${id}/report.html?review=${encodeURIComponent(reviewId)}`);await until(()=>reportPage.locator('.comment-card').count().then(n=>n===2),'comparison report');
    await film(report,'A readable handoff','Real screenshots. Recorded behavior. Engineering context.',async()=>{
      await move(report,1230,510,400);await reportPage.mouse.wheel(0,490);await pause(900);await camera(report,1.55,[1020,390],.8);await pause(700);await move(report,1430,660,480);await reportPage.mouse.wheel(0,310);await pause(1300);await move(report,1310,720,500);await reportPage.mouse.wheel(0,310);await pause(1000);const detail=reportPage.locator('.engineering-context').first().locator('summary');await detail.scrollIntoViewIfNeeded();await camera(report,1.6,detail,.8);await click(report,detail);await reportPage.mouse.wheel(0,240);await pause(1800);
    });
    await film(report,'Ready to share','Copy the report. Export the evidence. Keep moving.',async()=>{
      await reportPage.evaluate(()=>window.scrollTo({top:0,behavior:'smooth'}));await pause(700);await camera(report,1.55,reportPage.locator('#copy-report'),.75);await click(report,reportPage.locator('#copy-report'));await pause(650);const download=reportPage.waitForEvent('download');await click(report,reportPage.locator('#download-html'));await(await download).saveAs(join(output,'example-review.html'));await camera(report,1,[960,540],.9);await pause(650);
    });
    scenes[0].captionY=870;scenes[1].captionY=780;scenes[8].captionY=850;const timeline={version:2,width:1920,height:1080,fps:25,transition:.2,durationScale:(92.5+.2*(scenes.length-1))/scenes.reduce((sum,s)=>sum+s.duration,0),scenes:scenes.map(scene=>({...scene,sourcePath:`footage-v2/${scene.sourcePath.split('/').at(-1)}`})),disclosure:'Actual Diffuse extension workflows in a fictional Forma app. AI suggestions are simulated locally. No real API keys, paid requests, or user data.',providerRequests:requests.length};await writeFile(join(output,'timeline.json'),JSON.stringify(timeline,null,2));
    const rawProduction=await page.video().path(),rawReport=await reportPage.video().path();await context.close();context=null;await cp(rawProduction,join(footage,'production.webm'));await cp(rawReport,join(footage,'report.webm'));await rm(join(output,'.v2-takes'),{recursive:true,force:true});
    console.log(`Capture complete: ${scenes.reduce((s,v)=>s+v.duration,0).toFixed(1)} seconds.`);
  }
  if(!process.argv.includes('--capture-only')){const timeline=JSON.parse(await readFile(join(output,'timeline.json'),'utf8'));const{renderShowcase}=await import('./showcase-render-v2.mjs');const renderTimeline={...timeline,scenes:timeline.scenes.map(scene=>({...scene,sourcePath:resolve(output,scene.sourcePath)}))};const result=await renderShowcase({output,encoder,timeline:renderTimeline});await finishArtifacts(timeline,result);}
}catch(error){if(context){const page=context.pages().find(p=>p.url().includes('showcase-production'));await page?.screenshot({path:join(output,'capture-v2-failure.png')}).catch(()=>{});}throw error;}finally{await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}

async function encode(args){return new Promise((resolve,reject)=>{const child=spawn(encoder,args,{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>error=(error+chunk).slice(-3000));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));});}
async function finishArtifacts(timeline,result){
  const stamp=(seconds,separator='.')=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;};
  const chapters=result.scenes.map((scene,index)=>({...scene,title:timeline.scenes[index].title}));
  await writeFile(join(output,'diffuse-showcase.vtt'),'WEBVTT\n\n'+chapters.map(s=>`${stamp(s.start)} --> ${stamp(s.end)}\n${s.caption}${s.simulated?' · Simulated AI suggestions':''}\n`).join('\n'));
  await writeFile(join(output,'diffuse-showcase.srt'),chapters.map((s,i)=>`${i+1}\n${stamp(s.start,',')} --> ${stamp(s.end,',')}\n${s.caption}${s.simulated?' · Simulated AI suggestions':''}\n`).join('\n'));
  await writeFile(join(output,'transcript.md'),'# Diffuse — See it. Explain it. Share it.\n\n'+timeline.disclosure+'\n\n'+chapters.map(s=>`**${stamp(s.start).slice(3,8)} — ${s.title}**\n\n${s.caption}\n`).join('\n'));
  for(const [name,index,duration] of [['reveal-loop',0,12],['comment-loop',2,12],['recording-loop',6,18]])await encode(['-y','-ss',String(chapters[index].start),'-i',result.videoPath,'-t',String(duration),'-an','-vf','scale=1280:720','-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart',join(output,`${name}.mp4`)]);
  const info={version:2,durationSeconds:result.duration,width:1920,height:1080,fps:25,format:'H.264 MP4',bytes:(await stat(result.videoPath)).size,captioned:true,audio:false,chapters,disclosure:timeline.disclosure,providerRequests:timeline.providerRequests,sourceScripts:['scripts/create-showcase-v2.mjs','scripts/showcase-render-v2.mjs'],capture:'Continuous real browser workflows with a tracked pointer. Camera crops and short dissolves only; no replacement stills or presentation stage.'};
  await writeFile(join(output,'presentation-info.json'),JSON.stringify(info,null,2));
  await writeFile(join(output,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diffuse — See it. Explain it. Share it.</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f4fc;color:#211a35;font:17px/1.65 -apple-system,BlinkMacSystemFont,Arial,sans-serif}main{max-width:1320px;margin:auto;padding:38px 28px 80px}strong{color:#6941c6}h1{font-size:42px;letter-spacing:-1.5px;line-height:1.15;margin:16px 0}p{max-width:900px;color:#625870}video{width:100%;display:block;background:#211a35;border-radius:12px;margin:28px 0}.links{display:flex;gap:24px;flex-wrap:wrap}a{color:#6941c6;font-weight:600}a:focus-visible,video:focus-visible,summary:focus-visible{outline:3px solid #6941c6;outline-offset:5px}.note{font-size:14px}details{margin-top:32px}summary{font-size:20px;font-weight:600;cursor:pointer}article{display:flex;gap:25px;border-bottom:1px solid #ded5e8;padding:16px 0}time{color:#6d5c80;min-width:55px}h2{font-size:17px;margin:0}article p{font-size:16px;margin:6px 0}@media(max-width:650px){h1{font-size:32px}main{padding:24px 16px}}</style><main><strong>Diffuse · Product walkthrough</strong><h1>See it. Explain it. Share it.</h1><p>Real browser workflows: compare the shipped page with your prototype, capture feedback, record behavior, review suggestions, and share the evidence.</p><video controls playsinline preload="metadata" poster="poster.png"><source src="diffuse-showcase.mp4" type="video/mp4"><track kind="captions" src="diffuse-showcase.vtt" srclang="en" label="English"></video><div class="links"><a href="diffuse-showcase.mp4" download>Download video</a><a href="diffuse-showcase.srt" download>Download captions</a><a href="example-review.html">Open the example report</a></div><p class="note">${escapeHTML(timeline.disclosure)} This silent film includes burned-in captions and a separate caption track.</p><details><summary>Read the transcript</summary>${chapters.map(s=>`<article><time>${stamp(s.start).slice(3,8)}</time><div><h2>${escapeHTML(s.title)}</h2><p>${escapeHTML(s.caption)}</p></div></article>`).join('')}</details></main></html>`);
  console.log(`Finished V2: ${result.duration.toFixed(1)} seconds at ${result.videoPath}`);
}
