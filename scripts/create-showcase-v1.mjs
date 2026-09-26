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
const footage = join(output, 'footage');
const encoder = process.env.SHOWCASE_FFMPEG || '/private/tmp/diffuse-showcase-encoding/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
await mkdir(footage, {recursive:true});
const temp = await mkdtemp(join(tmpdir(), 'diffuse-showcase-'));
const extension = join(temp, 'extension');
const requests = [];
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
const tracks={};
async function until(check,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(100);}throw new Error(`Timed out: ${label}`);}
async function point(track,x,y,click=false){tracks[track.name].cursor.push({at:(Date.now()-track.started)/1000,x,y,click});await track.page.mouse.move(x,y);}
async function click(track,locator){await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();if(box)await point(track,box.x+box.width/2,box.y+box.height/2);await pause(160);if(box)await point(track,box.x+box.width/2,box.y+box.height/2,true);await locator.click();await pause(240);}
async function type(track,locator,text){await click(track,locator);await locator.fill('');await locator.pressSequentially(text,{delay:18});}
async function film(track,{chapter,title,caption,duration,focus=[1,1.015,50,50],simulated=false},action=async()=>{}){
  await track.page.bringToFront();const start=(Date.now()-track.started)/1000;console.log(`Recording: ${chapter} — ${title}`);
  await action();await pause(Math.max(0,duration*1000-((Date.now()-track.started)-start*1000)));
  const sourceDuration=(Date.now()-track.started)/1000-start;
  scenes.push({kind:'video',media:`footage/${track.name}.webm`,sourceStart:Math.max(0,start-.12),sourceDuration,duration,chapter,title,caption,focus,simulated,track:track.name});
}
async function trackedPage(name){const started=Date.now();const page=await context.newPage();tracks[name]={cursor:[],width:1280,height:720};return {page,name,started};}
async function command(args){return new Promise((resolve,reject)=>{const child=spawn(encoder,args,{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-9000);});child.on('error',reject);child.on('close',code=>code===0?resolve(stderr):reject(new Error(`Video encoder exited ${code}: ${stderr}`)));});}

try {
  if(!process.argv.includes('--compose-only')) {
    await cp(join(project,'extension'),extension,{recursive:true});
    const manifestPath=join(extension,'manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.host_permissions=['http://127.0.0.1/*','https://api.anthropic.com/*'];
    await writeFile(manifestPath,JSON.stringify(manifest));
    const clientPath=join(extension,'ai-client.mjs');await writeFile(clientPath,(await readFile(clientPath,'utf8')).replace('https://api.anthropic.com/v1/messages',`${origin}/simulated-ai`));
    context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:chromium.executablePath(),headless:true,viewport:null,recordVideo:{dir:join(output,'.takes'),size:{width:1280,height:720}},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--enable-unsafe-extension-debugging','--window-size=1280,807','--use-mock-keychain','--password-store=basic']});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
    const cdp=await context.browser().newBrowserCDPSession();
    const production=await trackedPage('production');const page=production.page;await page.goto(`${origin}/showcase-production.html`);
    const source=await context.newPage();await source.goto(`${origin}/showcase-prototype.html`);
    await page.screenshot({path:join(output,'demo-production.png')});await source.screenshot({path:join(output,'demo-prototype.png')});
    const openPopup=async target=>{await target.bringToFront();const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(item=>item.url===target.url()).targetId});const popup=await context.newPage();await target.bringToFront();await popup.goto(`chrome-extension://${id}/popup.html`);return popup;};
    let popup=await openPopup(source);
    const targetId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,page.url());
    await popup.locator('#target-tab').selectOption(String(targetId));await popup.locator('#start-comparison').click();
    let overlay=page.locator('diffuse-live-overlay');
    await until(()=>overlay.locator('#status').textContent({timeout:1000}).then(text=>text==='Live').catch(()=>false),'live comparison',30000);
    await popup.close();popup=await openPopup(page);await popup.locator('#enable-capture').click();await popup.close();
    const reviewId=await worker.evaluate(async()=>(await chrome.storage.session.get('comparison')).comparison.reviewId);
    const settings=await context.newPage();await settings.goto(`chrome-extension://${id}/ai-settings.html`);
    await settings.locator('#api-key').fill('sk-ant-fictional-showcase-key-not-a-real-key');await settings.locator('#save').click();await until(()=>settings.locator('#feedback').textContent().then(text=>text.includes('Settings saved')),'simulated AI settings');await settings.close();
    await page.bringToFront();await pause(800);
    scenes.push({kind:'title',duration:7,chapter:'INTRODUCING DIFFUSE',title:'The details.\nFinally in focus.',caption:'A clear path from your design intent to the shipped experience.'});
    await film(production,{chapter:'01 / LIVE COMPARISON',title:'Bring intent into view.',caption:'Layer your live prototype over production. Reveal differences as you drag.',duration:11,focus:[1,1.045,50,35]},async()=>{
      const handle=overlay.locator('#handle');const box=await handle.boundingBox();await point(production,box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      for(const x of [950,360,700]){await page.mouse.move(x,box.y+box.height/2,{steps:38});await point(production,x,box.y+box.height/2);await pause(850);}await page.mouse.up();
      await click(production,overlay.locator('#opacity'));await overlay.locator('#opacity').fill('25');await pause(900);await overlay.locator('#opacity').fill('75');await pause(900);await overlay.locator('#opacity').fill('55');
    });
    await page.screenshot({path:join(output,'live-comparison.png')});
    await film(production,{chapter:'02 / PRECISE FEEDBACK',title:'Point to what matters.',caption:'Hold C and drag an area. Paired screenshots preserve the exact context.',duration:13,focus:[1,1.06,84,20]},async()=>{
      await click(production,page.locator('h1'));
      await page.keyboard.down('c');await point(production,240,224);await page.mouse.down();
      for(let step=1;step<=28;step++){const x=240+(710-240)*step/28,y=224+(342-224)*step/28;await page.mouse.move(x,y);await point(production,x,y);await pause(24);}await pause(700);await page.mouse.up();await page.keyboard.up('c');
      await until(()=>overlay.locator('#comment-form').isVisible(),'area composer');
      await type(production,overlay.locator('#comment-actual'),'Restore the prototype’s card spacing and rounded corners.');
      await click(production,overlay.locator('#comment-category'));await overlay.locator('#comment-category').selectOption('design-mismatch');
      await type(production,overlay.locator('#comment-component'),'StudioMetrics');await type(production,overlay.locator('#comment-state'),'Overview · default');
    });
    await film(production,{chapter:'02 / PRECISE FEEDBACK',title:'Keep the context. Skip the busywork.',caption:'Categorize the issue. Titles and expected results are optional. Save a pin on the page.',duration:6,focus:[1.02,1,65,45]},async()=>{
      await click(production,overlay.locator('#save-comment'));await until(()=>overlay.locator('.comment-pin').count().then(count=>count===1),'saved comment pin');
      await click(production,overlay.locator('.comment-pin'));await pause(1800);await click(production,overlay.locator('#close-saved-comment'));
    });
    await film(production,{chapter:'03 / EVIDENCE THAT EXPLAINS',title:'A still. Or the whole interaction.',caption:'Choose a screenshot or add a short recording to the same comment.',duration:7,focus:[1.08,1.26,100,0]},async()=>{
      await click(production,overlay.locator('#comment'));await click(production,page.locator('#showcase-open-project'));
      await until(()=>overlay.locator('#comment-form').isVisible(),'interaction comment');
      await type(production,overlay.locator('#comment-actual'),'Keep the creation action prominent in the project drawer.');
      await overlay.locator('#comment-category').selectOption('ux-issue');
      await click(production,overlay.locator('#evidence-recording'));await pause(1000);await page.screenshot({path:join(output,'comment-evidence.png')});
    });
    await film(production,{chapter:'03 / EVIDENCE THAT EXPLAINS',title:'Show how it behaves.',caption:'Record the real interaction. Your selected area and written feedback stay attached.',duration:11,focus:[1,1.025,90,40]},async()=>{
      await click(production,overlay.locator('#comment-record'));await until(()=>overlay.locator('#record').textContent().then(text=>text.includes('Stop recording')),'recording running');
      await click(production,overlay.locator('#hide'));await click(production,page.locator('#showcase-open-project'));await type(production,page.locator('#showcase-project-name'),'New horizon');
      await click(production,page.locator('#showcase-project-type'));await page.locator('#showcase-project-type').selectOption('Digital experience');await pause(1200);
      await click(production,page.locator('#showcase-close-drawer'));await click(production,overlay.locator('#record'));
      await until(()=>overlay.locator('#recording-preview').isVisible(),'recording preview');
    });
    await film(production,{chapter:'03 / EVIDENCE THAT EXPLAINS',title:'Review before you hand it over.',caption:'Preview the clip, keep the original screenshots, and save everything together.',duration:6,focus:[1.08,1.22,100,0]},async()=>{
      await overlay.locator('#recording-preview').scrollIntoViewIfNeeded();await overlay.locator('#recording-preview').evaluate(video=>video.play());await pause(2400);await click(production,overlay.locator('#save-comment'));
      await until(()=>overlay.locator('.comment-pin').count().then(count=>count===2),'recording comment saved');
    });
    await click(production,overlay.locator('#stop'));await until(()=>overlay.count().then(count=>count===0),'end comparison');
    popup=await openPopup(page);await popup.locator('#mode-audit').click();await popup.locator('#start-comparison').click();await popup.close();
    await until(()=>overlay.locator('#status').textContent({timeout:1000}).then(text=>text==='Audit ready').catch(()=>false),'standalone audit');
    await film(production,{chapter:'04 / STANDALONE AUDITS',title:'One page is enough.',caption:'No prototype? Audit any supported page and collect the same actionable evidence.',duration:5,focus:[1,1.025,50,50]},async()=>{await point(production,650,370);await pause(1600);await click(production,overlay.locator('#ai-review'));});
    await until(()=>overlay.locator('#ai-run').isEnabled(),'AI available');
    await film(production,{chapter:'05 / A SECOND PERSPECTIVE',title:'Your judgment. A little assistance.',caption:'Simulated AI suggestions · Review the visible screen. Hidden states are not tested.',duration:9,focus:[1,1.08,100,20],simulated:true},async()=>{
      await type(production,overlay.locator('#ai-instructions'),'Focus on visual hierarchy and clarity.');await overlay.locator('#ai-threshold').fill('90');await click(production,overlay.locator('#ai-run'));
      await until(()=>overlay.locator('#ai-show-all').isVisible(),'filtered AI results');await overlay.locator('#ai-show-all').scrollIntoViewIfNeeded();await pause(1400);
    });
    await film(production,{chapter:'05 / A SECOND PERSPECTIVE',title:'See the findings. Keep control.',caption:'Simulated AI suggestions · Show hidden findings, then accept all shown with one click.',duration:8,focus:[1.08,1.25,100,48],simulated:true},async()=>{
      await click(production,overlay.locator('#ai-show-all'));await overlay.locator('#ai-accept-all').scrollIntoViewIfNeeded();await pause(2000);await page.screenshot({path:join(output,'ai-review.png')});await click(production,overlay.locator('#ai-accept-all'));
      await until(()=>overlay.locator('.comment-pin').count().then(count=>count===2),'accepted AI pins');await pause(1600);
    });
    assert.equal(requests.length,1);assert.equal(requests[0].images,1);
    await click(production,overlay.locator('#close-ai'));
    const reportPromise=context.waitForEvent('page');await click(production,overlay.locator('#review'));const reportPage=await reportPromise;const report={page:reportPage,name:'report',started:Date.now()};tracks.report={cursor:[],width:1280,height:720};
    await reportPage.waitForLoadState();await reportPage.goto(`chrome-extension://${id}/report.html?review=${encodeURIComponent(reviewId)}`);
    await until(()=>reportPage.locator('.comment-card').count().then(count=>count===2),'comparison report');
    await reportPage.screenshot({path:join(output,'report.png')});
    await film(report,{chapter:'06 / A COMPLETE HANDOFF',title:'Make the next step obvious.',caption:'Copy a readable report or export HTML with screenshots, clips, and engineering context.',duration:11,focus:[1,1.055,63,23]},async()=>{
      await pause(1300);await click(report,reportPage.locator('#copy-report'));await pause(1400);
      const downloaded=reportPage.waitForEvent('download');await click(report,reportPage.locator('#download-html'));const file=await downloaded;await file.saveAs(join(output,'example-review.html'));
      await reportPage.evaluate(()=>window.scrollTo({top:520,behavior:'smooth'}));await pause(2500);
    });
    scenes.push({kind:'roadmap',duration:6,chapter:'COMING SOON / PLANNED INTEGRATIONS',title:'Next, your team’s tools.\nPlanned integrations.',caption:'Coming soon: Jira, Asana, and ClickUp. Today, share with copy and export.'});
    scenes.push({kind:'closing',duration:7,chapter:'FROM PROTOTYPE TO PRODUCTION',title:'Keep the vision.\nShip the details.',caption:'Diffuse · Live comparison. Clear evidence. A considered handoff.'});
    await page.screenshot({path:join(output,'workflow-final.png')});await reportPage.screenshot({path:join(output,'report-preview.png')});
    const data={scenes,tracks,disclosure:'Fictional Forma demo. All AI suggestions are simulated locally. No real API keys, user data, or paid API requests.',providerRequests:requests.length};
    await writeFile(join(output,'timeline.json'),JSON.stringify(data,null,2));
    const productionPath=await page.video().path();const reportPath=await reportPage.video().path();
    await context.close();context=null;
    await cp(productionPath,join(footage,'production.webm'));await cp(reportPath,join(footage,'report.webm'));
    await rm(join(output,'.takes'),{recursive:true,force:true});
  }
  // Composition is reusable without rerunning the extension workflows.
  const data=JSON.parse(await readFile(join(output,'timeline.json'),'utf8'));
  await createPresentation(data);
  if(!process.argv.includes('--capture-only'))await recordPresentation(data);
} catch(error) {
  if(context)for(const page of context.pages())if(page.url().includes('showcase-production')||page.url().includes('presentation-stage')){
    await page.screenshot({path:join(output,'capture-failure.png')}).catch(()=>{});
    console.error('Capture state:',await page.locator('diffuse-live-overlay').evaluate(host=>({status:host.shadowRoot.querySelector('#status')?.textContent,error:host.shadowRoot.querySelector('#comment-error')?.textContent,retry:host.shadowRoot.querySelector('#capture-retry-description')?.textContent})).catch(()=>null));
  }
  throw error;
} finally {
  await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}

async function createPresentation(data) {
  // Filled below: generated files remain standalone alongside the original footage.
  const total=data.scenes.reduce((sum,scene)=>sum+scene.duration,0);
  let at=0;
  for(const scene of data.scenes){scene.start=at;at+=scene.duration;scene.end=at;}
  const stamp=(seconds,separator='.')=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;};
  await writeFile(join(output,'diffuse-showcase.vtt'),'WEBVTT\n\n'+data.scenes.map(scene=>`${stamp(scene.start)} --> ${stamp(scene.end)}\n${scene.caption}\n`).join('\n'));
  await writeFile(join(output,'diffuse-showcase.srt'),data.scenes.map((scene,index)=>`${index+1}\n${stamp(scene.start,',')} --> ${stamp(scene.end,',')}\n${scene.caption}\n`).join('\n'));
  await writeFile(join(output,'transcript.md'),`# Diffuse — The details, finally in focus\n\n${data.disclosure}\n\n`+data.scenes.map(scene=>`**${stamp(scene.start).slice(3,8)} — ${scene.title.replaceAll('\n',' ')}**\n\n${scene.caption}\n`).join('\n'));
  await writeFile(join(output,'presentation-stage.html'),stageHTML(data,total));
  await writeFile(join(output,'index.html'),playerHTML(data,total));
  console.log(`Composition ready: ${total.toFixed(1)} seconds, ${data.scenes.length} scenes.`);
}

async function recordPresentation(data) {
  const total=data.scenes.reduce((sum,scene)=>sum+scene.duration,0);
  context=await chromium.launchPersistentContext(join(temp,'presentation-profile'),{executablePath:chromium.executablePath(),headless:true,viewport:{width:1920,height:1080},recordVideo:{dir:join(temp,'presentation-recording'),size:{width:1920,height:1080}},args:['--window-size=1920,1167','--use-mock-keychain','--password-store=basic','--autoplay-policy=no-user-gesture-required']});
  const page=await context.newPage();const pageStarted=Date.now();
  await page.goto(`${origin}/presentation-stage.html`);await page.waitForFunction(()=>window.presentationReady);
  await page.screenshot({path:join(output,'poster.png')});
  await cp(join(output,'poster.png'),join(output,'cover.png'));
  const begin=(Date.now()-pageStarted)/1000;await page.evaluate(()=>window.startPresentation());
  console.log('Rendering the composed 1080p presentation…');
  await page.waitForFunction(()=>window.presentationComplete,{},{timeout:(total+35)*1000});
  const recordingPath=await page.video().path();await context.close();context=null;await cp(recordingPath,join(footage,'composed.webm'));
  await command(['-y','-ss',String(Math.max(0,begin-.12)),'-i',join(footage,'composed.webm'),'-t',String(total),'-an','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',join(output,'diffuse-showcase.mp4')]);
  for(const [name,index,duration] of [['reveal-loop',1,10],['comment-loop',2,12]])await command(['-y','-ss',String(data.scenes[index].start),'-i',join(output,'diffuse-showcase.mp4'),'-t',String(duration),'-an','-vf','scale=1280:720','-c:v','libx264','-preset','medium','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',join(output,`${name}.mp4`)]);
  const encoded=await stat(join(output,'diffuse-showcase.mp4'));
  await writeFile(join(output,'presentation-info.json'),JSON.stringify({durationSeconds:total,width:1920,height:1080,format:'H.264 MP4',bytes:encoded.size,captioned:true,audio:false,chapters:data.scenes.map(({chapter,title,start,end})=>({chapter,title,start,end})),disclosure:data.disclosure,providerRequests:data.providerRequests},null,2));
  console.log(`Created ${join(output,'diffuse-showcase.mp4')} (${(encoded.size/1048576).toFixed(1)} MiB).`);
}

function stageHTML(data,total) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diffuse · Presentation stage</title><style>
  *{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#f7f4fc;color:#211a35;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.ambient{position:absolute;inset:0;background:radial-gradient(ellipse at 17% 75%,#e6d9fc 0,transparent 53%),radial-gradient(ellipse at 87% 9%,#fbe4dc 0,transparent 49%),#f7f4fc}.ambient:after{content:'';position:absolute;width:700px;height:700px;border:1px solid #6941c61c;border-radius:50%;right:-270px;top:-200px;box-shadow:0 0 0 75px #6941c607,0 0 0 150px #6941c605}.topline{position:absolute;top:27px;left:75px;right:75px;display:flex;align-items:center;justify-content:space-between}.brand{display:flex;align-items:center;gap:17px;font-size:31px;font-weight:760;letter-spacing:-.8px}.mark{position:relative;width:39px;height:41px;display:inline-block}.mark i{position:absolute;width:23px;height:34px;border-radius:7px;border:2px solid #211a35;transform:rotate(-12deg);left:0;top:0;background:#ef785c}.mark i+i{left:13px;top:7px;background:#b89aef}.chapter{font-size:16px;letter-spacing:2px;font-weight:650;color:#746083}.browser{position:absolute;left:210px;top:93px;width:1500px;border-radius:18px;box-shadow:0 25px 65px #38204b25,0 2px 5px #211a3510;overflow:hidden;border:1px solid #ded2eb;background:#fff;transition:opacity .42s,transform .7s cubic-bezier(.2,.8,.2,1);opacity:0;transform:translateY(22px) scale(.975)}.browser.active{opacity:1;transform:translateY(0) scale(1)}.chrome{height:32px;display:flex;align-items:center;background:#fcfaff;gap:7px;padding:0 14px;border-bottom:1px solid #e5ddec}.chrome i{width:7px;height:7px;border-radius:50%;background:#dbcee7}.chrome i:first-child{background:#ef785c}.chrome span{margin:auto;color:#776885;font-size:11px;letter-spacing:.3px;padding-right:25px}.screen{position:relative;width:1500px;height:843.75px;overflow:hidden;background:#f7f4fc}.media{position:absolute;inset:0;will-change:transform}.media video{display:block;width:100%;height:100%;object-fit:fill}.cursor{position:absolute;width:27px;height:32px;pointer-events:none;filter:drop-shadow(0 2px 2px #211a3533);transform:translate(-4px,-2px);z-index:3}.cursor:after{content:'';position:absolute;width:74px;height:74px;border:3px solid #ef785c;background:#ef785c16;border-radius:50%;left:-27px;top:-25px;transform:scale(.3);opacity:0}.cursor.click:after{animation:pulse .55s ease-out}.caption{position:absolute;left:120px;right:120px;bottom:24px;text-align:center;font-size:27px;line-height:1.45;font-weight:550;letter-spacing:-.25px;transition:opacity .22s,transform .4s;opacity:0;transform:translateY(8px)}.caption.active{opacity:1;transform:translateY(0)}.chapter-tab{position:absolute;left:82px;top:447px;writing-mode:vertical-rl;transform:rotate(180deg);text-transform:uppercase;letter-spacing:2px;color:#8b769f;font-size:13px;font-weight:600}.simulated{position:absolute;top:108px;right:223px;z-index:8;background:#211a35;color:#f2eafa;border:1px solid #a387bb;border-radius:8px;padding:8px 13px;font-size:13px;letter-spacing:.3px}.hero{position:absolute;inset:0;background:#211a35;color:#f7f4fc;z-index:10;display:flex;align-items:center;justify-content:center;text-align:center;opacity:0;pointer-events:none;transition:opacity .5s}.hero.active{opacity:1}.hero:before,.hero:after{content:'';position:absolute;border-radius:50%;border:1px solid #b393d02d;width:730px;height:730px;left:-220px;top:-350px;box-shadow:0 0 0 110px #6941c614,0 0 0 220px #6941c60b}.hero:after{left:auto;top:auto;right:-200px;bottom:-390px;border-color:#ef785c3d;box-shadow:0 0 0 110px #ef785c07,0 0 0 220px #ef785c04}.hero-content{position:relative;z-index:2}.hero .brand{justify-content:center;font-size:38px;margin-bottom:55px}.hero .mark{transform:scale(1.15);margin-right:8px}.eyebrow{font-size:17px;letter-spacing:3px;font-weight:550;color:#c6a8e8;margin-bottom:28px}.hero h1{font-size:100px;letter-spacing:-5px;line-height:1.13;font-weight:670;margin:0 0 36px;white-space:pre-line;transform:translateY(25px);opacity:0;transition:transform 1.2s cubic-bezier(.2,.7,.2,1),opacity 1s}.hero.active h1{transform:translateY(0);opacity:1}.hero h1 em{font-style:normal;color:#ef997e}.hero p{font-size:25px;line-height:1.55;color:#cfc2dc;margin:0 auto;max-width:1000px}.hero .tags{display:flex;gap:12px;justify-content:center;margin-top:39px}.hero .tags span{font-size:15px;letter-spacing:.2px;border:1px solid #756086;border-radius:100px;padding:11px 19px;color:#e4d8ee}.hero small{display:block;font-size:15px;letter-spacing:.2px;color:#b8a9c9;margin-top:44px}.wipe{position:absolute;inset:0;background:#6941c6;z-index:20;pointer-events:none;transform:translateX(-103%)}.wipe.run{animation:wipe .65s cubic-bezier(.7,0,.3,1)}.progress{position:absolute;left:0;bottom:0;height:4px;background:linear-gradient(90deg,#6941c6,#ef785c);transform-origin:left;z-index:30;width:100%;transform:scaleX(0)}@keyframes wipe{0%{transform:translateX(-103%)}50%{transform:translateX(0)}100%{transform:translateX(103%)}}@keyframes pulse{0%{transform:scale(.25);opacity:.9}100%{transform:scale(1);opacity:0}}
  </style></head><body><div class="ambient"></div><div class="topline"><div class="brand"><span class="mark"><i></i><i></i></span>Diffuse</div><div class="chapter" id="chapter"></div></div><div class="chapter-tab" id="title"></div><div class="browser" id="browser"><div class="chrome"><i></i><i></i><i></i><span id="location">Forma · Fictional studio workspace</span></div><div class="screen"><div class="media" id="media"><video id="clip" muted playsinline preload="auto"></video><span class="cursor" id="cursor"><svg viewBox="0 0 28 34" width="28" height="34"><path d="M3 2v26l7-7 6 11 5-3-6-10h10Z" fill="white" stroke="#211a35" stroke-width="1.8" stroke-linejoin="round"/></svg></span></div></div></div><div class="simulated" id="simulated" hidden>Simulated AI suggestions · local demo</div><div class="caption" id="caption"></div><section class="hero active" id="hero"><div class="hero-content"><div class="brand"><span class="mark"><i></i><i></i></span>Diffuse</div><div class="eyebrow" id="hero-eyebrow">INTRODUCING DIFFUSE</div><h1 id="hero-title">The details.<br><em>Finally in focus.</em></h1><p id="hero-copy">A clear path from your design intent to the shipped experience.</p><div class="tags" id="hero-tags"><span>Live comparison</span><span>Evidence-rich feedback</span><span>Optional AI review</span></div><small id="hero-small">A product walkthrough · Fictional app and simulated AI</small></div></section><div class="wipe" id="wipe"></div><div class="progress" id="progress"></div><script>
  const data=${JSON.stringify(data).replaceAll('<','\\u003c')};const total=${total};
  const el=id=>document.getElementById(id);const video=el('clip');let started=null,lastScene=-1,lastClick=-1,activeScene=null;
  const cursor=el('cursor');
  const reportStill=document.createElement('img');reportStill.src='report-detail.png';Object.assign(reportStill.style,{position:'absolute',inset:'0',width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top',opacity:'0',transition:'opacity .45s',pointerEvents:'none'});el('media').append(reportStill);
  async function showScene(index){const scene=data.scenes[index];activeScene=scene;el('caption').classList.remove('active');
    if(scene.kind!=='video'){const labels=scene.kind==='roadmap'?['Jira','Asana','ClickUp']:['Live comparison','Evidence-rich feedback','Optional AI review'];el('hero-tags').replaceChildren(...labels.map(text=>{const tag=document.createElement('span');tag.textContent=text;return tag;}));}
    if(scene.kind!=='video'){video.pause();el('browser').classList.remove('active');el('hero-eyebrow').textContent=scene.chapter;const lines=scene.title.split('\\n');el('hero-title').replaceChildren();el('hero-title').append(document.createTextNode(lines[0]),document.createElement('br'));const em=document.createElement('em');em.textContent=lines[1]||'';el('hero-title').append(em);el('hero-copy').textContent=scene.caption;el('hero-small').textContent=scene.kind==='closing'?'Fictional demo · Simulated AI suggestions · No real API requests':'A product walkthrough · Actual Diffuse extension workflows';el('hero').classList.add('active');el('simulated').hidden=true;return;}
    el('hero').classList.remove('active');el('chapter').textContent=scene.chapter;el('title').textContent=scene.title;el('location').textContent=scene.track==='report'?'Diffuse · Review notebook':'Forma · Fictional studio workspace';el('caption').textContent=scene.caption;el('simulated').hidden=!scene.simulated;
    const url=new URL(scene.media,location.href).href;if(video.src!==url){video.src=url;await new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true}));}
    video.currentTime=scene.sourceStart;video.playbackRate=Math.max(.6,Math.min(2,scene.sourceDuration/scene.duration));await video.play();el('browser').classList.add('active');setTimeout(()=>el('caption').classList.add('active'),280);
  }
  function frame(now){if(started===null)return;const time=Math.min(total,(now-started)/1000);const index=data.scenes.findIndex(scene=>time>=scene.start&&time<scene.end);if(index!==lastScene&&index>=0){const previous=lastScene;lastScene=index;if(previous>=0&&data.scenes[index].chapter!==data.scenes[previous].chapter){el('wipe').classList.remove('run');void el('wipe').offsetWidth;el('wipe').classList.add('run');}showScene(index);}
    if(activeScene?.kind==='video'){const progress=Math.max(0,Math.min(1,(time-activeScene.start)/activeScene.duration));const ease=progress*progress*(3-2*progress);const [from,to,x,y]=activeScene.focus;el('media').style.transformOrigin=x+'% '+y+'%';el('media').style.transform='scale('+(from+(to-from)*ease)+')';const events=data.tracks[activeScene.track].cursor;const stamp=video.currentTime;let current=null,next=null;for(let i=0;i<events.length;i++){if(events[i].at<=stamp){current=events[i];next=events[i+1]||null;}else break;}if(current){const part=next?Math.max(0,Math.min(1,(stamp-current.at)/(next.at-current.at||1))):0;const px=next?current.x+(next.x-current.x)*part:current.x;const py=next?current.y+(next.y-current.y)*part:current.y;cursor.style.left=(px/1280*1500)+'px';cursor.style.top=(py/720*843.75)+'px';if(current.click&&current.at!==lastClick){lastClick=current.at;cursor.classList.remove('click');void cursor.offsetWidth;cursor.classList.add('click');}}}
    const showDetail=activeScene?.track==='report'&&(time-activeScene.start)>activeScene.duration*.55;reportStill.style.opacity=showDetail?'1':'0';cursor.style.visibility=showDetail?'hidden':'visible';
    el('progress').style.transform='scaleX('+(time/total)+')';if(time>=total){video.pause();window.presentationComplete=true;return;}requestAnimationFrame(frame);}
  window.startPresentation=()=>{started=performance.now();requestAnimationFrame(frame);};window.presentationReady=true;
  </script></body></html>`;
}

function playerHTML(data,total){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diffuse · The details, finally in focus</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f4fc;color:#211a35;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:48px 28px 80px}.brand{font-size:25px;font-weight:750;color:#6941c6;letter-spacing:-.7px}.eyebrow{font-size:14px;text-transform:uppercase;letter-spacing:2px;color:#7c628e;margin:35px 0 12px}h1{font-size:44px;line-height:1.15;letter-spacing:-1.8px;margin:0 0 15px}p{color:#655674}.lead{font-size:18px;max-width:740px;margin-bottom:28px}video{display:block;width:100%;border-radius:18px;background:#211a35;box-shadow:0 18px 65px #33204621}a{color:#6941c6;font-weight:600}a:focus-visible,video:focus-visible,summary:focus-visible{outline:3px solid #6941c6;outline-offset:5px}.links{display:flex;gap:22px;flex-wrap:wrap;margin:24px 0}details{margin-top:34px;padding-top:22px;border-top:1px solid #ddd0e9}summary{cursor:pointer;font-size:20px;font-weight:650}.scene{display:grid;grid-template-columns:80px 1fr;gap:20px;padding:18px 0;border-bottom:1px solid #e7deee}.scene time{color:#8a7899}.scene h2{font-size:16px;margin:0}.scene p{margin:6px 0 0;font-size:15px}.note{font-size:14px;margin-top:25px}@media(max-width:650px){h1{font-size:34px}.scene{grid-template-columns:55px 1fr;gap:12px}}</style></head><body><main><div class="brand">Diffuse</div><p class="eyebrow">FROM PROTOTYPE TO PRODUCTION · ${Math.round(total)} SECONDS</p><h1>The details. Finally in focus.</h1><p class="lead">A captioned walkthrough of live comparison, precise feedback, captured interactions, optional AI review, and a complete handoff.</p><video controls playsinline preload="metadata" poster="poster.png"><source src="diffuse-showcase.mp4" type="video/mp4"><track kind="captions" src="diffuse-showcase.vtt" srclang="en" label="English captions"></video><div class="links"><a href="diffuse-showcase.mp4" download>Download MP4</a><a href="diffuse-showcase.srt" download>Download captions</a><a href="example-review.html">Open the example report</a></div><p class="note">${escapeHTML(data.disclosure)} Captions are burned into the video; a separate caption track is also available. This presentation has no audio.</p><details><summary>Read the transcript</summary>${data.scenes.map(scene=>`<article class="scene"><time>${String(Math.floor(scene.start/60)).padStart(2,'0')}:${String(Math.floor(scene.start%60)).padStart(2,'0')}</time><div><h2>${escapeHTML(scene.title.replaceAll('\n',' '))}</h2><p>${escapeHTML(scene.caption)}</p></div></article>`).join('')}</details></main></body></html>`;}
