// Disposable browser fixtures exercise the real settings controllers and drawer UI.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
const require = createRequire(import.meta.url);
const {chromium} = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : await import('playwright');
const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/settings');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
const context = await browser.newContext();
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('https://diffuse.test/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript'};
  let body = await readFile(resolve(root,'extension',name),'utf8');
  if(name === 'sidepanel.html') body = body.replace('<script src="popup.js" defer></script>','');
  await route.fulfill({status:200,contentType:types[extname(name)]||'text/plain',body});
});
await context.route('https://diffuse-jira-api.vercel.app/**', async route => {
  const url = new URL(route.request().url());
  let body = {};
  if(route.request().method() === 'GET' && url.pathname === '/v1/connection') body = {connection:{id:'10000000-0000-4000-8000-000000000001',accountId:'demo-account',displayName:'Demo Reviewer',sites:[]}};
  if(url.pathname === '/v1/sites')body={sites:[{id:'20000000-0000-4000-8000-000000000001',name:'Demo Jira',url:'https://demo.atlassian.net'}]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
});
await context.addInitScript(() => {
  if (location.origin !== 'https://diffuse.test') return;
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const event = () => ({addListener(){}});
  const stored = () => JSON.parse(localStorage.getItem('fixture-store') || '{}');
  const store = {async setAccessLevel(){},async get(key){const all=stored();return key ? {[key]:all[key]} : all;},async set(values){localStorage.setItem('fixture-store',JSON.stringify({...stored(),...values}));},async remove(key){const all=stored();delete all[key];localStorage.setItem('fixture-store',JSON.stringify(all));}};
  if(!localStorage.getItem('fixture-store'))store.set({'diffuseJiraConnection:10000000-0000-4000-8000-000000000001':{id:'10000000-0000-4000-8000-000000000001',accountId:'demo-account',displayName:'Demo Reviewer',sites:[{id:'20000000-0000-4000-8000-000000000001',name:'Demo Jira',url:'https://demo.atlassian.net'}],credential:'10000000-0000-4000-8000-000000000001.'+'a'.repeat(43)}});
  window.messages=[];window.permissionRequests=[];window.allowPermission=true;window.failAgentSetup=false;window.holdAgentSetup=false;
  window.session={id:'session',mode:'audit',target:{title:'Atlas production'},targetViewport:{width:1440,height:900},settings:{},comments:Array.from({length:18},(_,i)=>({id:String(i),fields:{title:`Review finding ${i+1}`},context:{production:{url:'https://other-review.test/releases/42?tab=details',viewportProfile:{key:'desktop'}}}}))};
  window.pageHelpersReady=Promise.resolve(); // popup.js is deliberately replaced by this fixture.
  window.sourceTab={};window.loadTabs=async()=>{};window.renderSession=()=>{document.querySelector('#loading').hidden=true;};
  window.chrome={runtime:{id,connect(){const port={postMessage(){queueMicrotask(()=>port.listener?.({type:'ATTACHED'}));},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:event()};return port;},async sendMessage(message){window.messages.push(message);const config=()=>JSON.parse(localStorage.getItem('ai-fixture')||'{"model":"claude-sonnet-5","threshold":35,"rememberKey":false,"hasKey":false}');
    if(message.type==='GET_AI_CONFIG')return{ok:true,config:config()};
    if(message.type==='JOURNEY_STATE')return{ok:true,run:window.journeyRun||null};
    if(message.type==='JOURNEY_HISTORY')return{ok:true,runs:[]};
    if(message.type==='JOURNEY_START')return{ok:false,error:'Fixture start request received.'};
    if(message.type==='JOURNEY_ASK'){
      window.journeyRun.managed.evaluatorRequestInFlight=true;
      window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
      await new Promise(resolve=>window.finishJourneyReply=resolve);
      window.journeyRun.managed.evaluatorRequestInFlight=false;
      window.journeyRun.followUps.push({question:message.question,answer:'The Add ingredient button matched the task.',evidenceSteps:[1]});
      return{ok:true,run:window.journeyRun};
    }
    if(message.type==='SAVE_AI_CONFIG'){if(message.apiKey)localStorage.removeItem('agents-ready');localStorage.setItem('ai-fixture',JSON.stringify({model:message.model,threshold:message.threshold,rememberKey:message.rememberKey,hasKey:Boolean(message.apiKey)||config().hasKey,journeyEngine:message.journeyEngine||'direct',journeyBudgetUsd:message.journeyBudgetUsd??2}));return{ok:true,config:config()};}
    if(message.type==='GET_JOURNEY_AGENTS_STATUS')return{ok:true,agents:{ready:config().hasKey&&localStorage.getItem('agents-ready')==='true'}};
    if(message.type==='SETUP_JOURNEY_AGENTS'){
      if(window.holdAgentSetup)await new Promise(resolve=>window.releaseAgentSetup=resolve);
      if(window.failAgentSetup)return{ok:false,error:'Managed Agents is not enabled for this Anthropic account. Use Direct or enable access in your Anthropic account.'};
      localStorage.setItem('agents-ready','true');localStorage.setItem('ai-fixture',JSON.stringify({...config(),journeyEngine:'managed'}));return{ok:true,agents:{ready:true}};
    }
    if(message.type==='CLEAR_AI_KEY'){localStorage.setItem('ai-fixture',JSON.stringify({...config(),hasKey:false}));return{ok:true};}
    if(message.type==='VIEWPORT_PRESET'){session.viewportPreset=message.preset;return{ok:true};}
    return{ok:true,session:window.session,state:{view:'controls',active:true,available:true}};
  }},permissions:{request:async value=>{window.permissionRequests.push(value);return window.allowPermission;}},storage:{local:store,session:store,onChanged:event()},identity:{launchWebAuthFlow:async()=>''},extension:{isAllowedFileSchemeAccess:async()=>true},tabs:{onActivated:event(),onUpdated:event(),async create(value){window.openedTab=value;}},windows:{getCurrent:async()=>({id:1})}};
});
try {
  const settings = await context.newPage();
  await settings.goto('https://diffuse.test/settings.html');
  await settings.locator('#save:not([disabled])').waitFor();
  await settings.getByRole('heading',{name:'Demo Reviewer',exact:true}).waitFor();
  assert.equal(await settings.locator('[id]').evaluateAll(nodes=>new Set(nodes.map(n=>n.id)).size===nodes.length),true);
  assert.equal(await settings.locator('#file-access-status').textContent(),'Allowed');
  await settings.locator('#api-key').fill('sk-ant-'+ 'a'.repeat(64));
  await settings.locator('#model').fill('claude-sonnet-5');
  await settings.locator('#remember-key').check();
  await settings.locator('#threshold').fill('60');
  await settings.locator('#save').click();
  await settings.locator('#ai-feedback').filter({hasText:'AI settings saved.'}).waitFor();
  assert.equal(await settings.locator('#api-key').inputValue(),'');
  assert.equal(await settings.locator('#jira-feedback').isVisible(),false);
  await settings.reload();
  await settings.locator('#key-status').filter({hasText:'Key remembered'}).waitFor();
  assert.equal(await settings.locator('#threshold').inputValue(),'60');
  await settings.locator('#ai').screenshot({path:resolve(out,'ai-settings.png')});
  assert.equal(await settings.evaluate(()=>messages.some(item=>item.type==='SETUP_JOURNEY_AGENTS')),false,'Loading settings must not create agents or start sessions');
  await settings.locator('#journey-engine-managed').check();
  await settings.locator('#journey-budget').fill('3.50');
  await settings.locator('#save').click();
  await settings.locator('#ai-feedback').filter({hasText:'Set up journey agents'}).waitFor();
  assert.equal(await settings.evaluate(()=>JSON.parse(localStorage.getItem('ai-fixture')).journeyEngine),'direct','Selecting an unconfigured engine does not enable it');
  await settings.evaluate(()=>{window.failAgentSetup=true;window.holdAgentSetup=true;});
  await settings.locator('#setup-journey-agents').click();
  await settings.waitForFunction(()=>typeof window.releaseAgentSetup==='function');
  for(const id of ['save','clear-key','setup-journey-agents','api-key','journey-engine-direct','journey-engine-managed','journey-budget']) assert.equal(await settings.locator(`#${id}`).isDisabled(),true,`${id} is disabled during setup`);
  await settings.evaluate(()=>window.releaseAgentSetup());
  await settings.locator('#ai-feedback').filter({hasText:'Managed Agents is not enabled'}).waitFor();
  assert.equal(await settings.evaluate(()=>JSON.parse(localStorage.getItem('ai-fixture')).journeyEngine),'direct','Setup failure preserves the working direct engine');
  assert.equal(await settings.locator('#api-key').inputValue(),'','Saved key never becomes visible after setup failure');
  assert.equal(await settings.locator('#journey-engine-direct').isChecked(),true,'The form reflects the saved Direct engine after setup fails');
  await settings.evaluate(()=>{window.failAgentSetup=false;window.holdAgentSetup=false;});
  await settings.locator('#journey-engine-managed').check();
  await settings.locator('#setup-journey-agents').click();
  await settings.locator('#ai-feedback').filter({hasText:'Journey agents are ready and enabled'}).waitFor();
  assert.equal(await settings.locator('#journey-engine-managed').isChecked(),true);
  assert.equal(await settings.locator('#journey-budget').inputValue(),'3.5');
  assert.equal(await settings.locator('#journey-agent-status').textContent(),'Agents ready');
  await settings.reload();
  await settings.locator('#journey-agent-status').filter({hasText:'Agents ready'}).waitFor();
  assert.equal(await settings.evaluate(()=>messages.some(item=>item.type==='SETUP_JOURNEY_AGENTS')),false,'Reload only reads readiness');
  for(const theme of ['light','dark']){
    await settings.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1440,390,320]){
      await settings.setViewportSize({width,height:900});
      assert.equal(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Journey agent settings fit ${theme} ${width}px`);
    }
    await settings.locator('[aria-labelledby="journey-agent-heading"]').screenshot({path:resolve(out,`journey-agents-${theme}.png`)});
  }
  await settings.setViewportSize({width:1280,height:900});
  await settings.locator('#api-key').fill('sk-ant-'+ 'b'.repeat(64));
  assert.equal(await settings.locator('#journey-agent-status').textContent(),'Setup needed','Replacing a key requires setup for that account');
  await settings.locator('#save').click();
  await settings.locator('#ai-feedback').filter({hasText:'Set up journey agents'}).waitFor();
  await settings.locator('#api-key').fill('');
  await settings.locator('#journey-engine-direct').check();
  await settings.locator('#save').click();
  await settings.locator('#ai-feedback').filter({hasText:'AI settings saved.'}).waitFor();
  assert.equal(await settings.evaluate(()=>JSON.parse(localStorage.getItem('ai-fixture')).journeyBudgetUsd),3.5);
  await settings.reload();await settings.locator('#save:not([disabled])').waitFor();
  console.log('PASS journey agents opt in after successful setup; failure stays direct; keys stay hidden; busy states, reload, engine changes, and mobile themes work.');

  await settings.getByRole('button',{name:'Refresh Jira sites for Demo Reviewer'}).click();
  await settings.locator('#jira-feedback').filter({hasText:'Jira sites updated'}).waitFor();
  assert.equal(await settings.locator('#ai-feedback').isVisible(),false);
  await settings.locator('#jira').screenshot({path:resolve(out,'jira-settings.png')});
  await settings.getByRole('button',{name:'Disconnect Demo Reviewer from Diffuse'}).click();
  await settings.locator('#connection-count').filter({hasText:'0 connected'}).waitFor();
  await settings.locator('#clear-key').click();
  await settings.locator('#key-status').filter({hasText:'No key connected'}).waitFor();
  await settings.locator('#browser-settings').click();
  assert.equal(await settings.evaluate(()=>window.openedTab.url),'chrome://extensions/?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  for(const width of [1440,768,390,320]){
    await settings.setViewportSize({width,height:900});
    assert.equal(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Settings overflow at ${width}`);
  }
  console.log('PASS unified AI saves/reloads/removes key; Jira refresh/disconnect remains isolated; browser access works; settings fit 320–1440px.');
  const panel=await context.newPage({viewport:{width:360,height:720}});
  await panel.goto('https://diffuse.test/sidepanel.html');
  await panel.locator('#panel-comments .saved-item').first().waitFor();
  await panel.evaluate(()=>document.getElementById('loading').hidden=true);
  assert.equal(await panel.locator('#panel-comment,#panel-area,#ai-settings,#jira-settings').count(),0);
  assert.equal(await panel.locator('#settings').count(),1);
  await panel.evaluate(()=>window.allowPermission=false);
  await panel.locator('#panel-comments .saved-item').first().click();
  await panel.locator('#feedback').filter({hasText:'Your current page has not changed'}).waitFor();
  assert.equal(await panel.evaluate(()=>window.messages.filter(m=>m.action==='showPin').length),0);
  assert.deepEqual(await panel.evaluate(()=>window.permissionRequests.at(-1)),{origins:['https://other-review.test/*']});
  await panel.waitForTimeout(1100);
  assert.equal(await panel.locator('#feedback').isVisible(),true,'permission denial survives state refresh');
  await panel.evaluate(()=>window.allowPermission=true);
  await panel.locator('#panel-comments .saved-item').first().click();
  await panel.waitForFunction(()=>window.messages.some(m=>m.action==='showPin'&&m.id==='0'));
  console.log('PASS comment click requests only its saved site; denial keeps the page and warning, grant reveals through the worker.');
  for(const preset of ['desktop','laptop','tablet','phone']){
    const control=panel.locator(`[data-preset=${preset}]`);
    assert.equal((await control.textContent()).trim(),'');
    assert((await control.getAttribute('aria-label')).startsWith(preset[0].toUpperCase()+preset.slice(1)));
    await control.click();
    await panel.waitForFunction(preset=>window.messages.some(m=>m.type==='VIEWPORT_PRESET'&&m.preset===preset),preset);
  }
  await panel.locator('.viewport-info').hover();
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),true);
  for(const width of [420,360,320]){
    await panel.setViewportSize({width,height:720});
    await panel.locator('.viewport-info').hover();
    const tip=await panel.locator('#viewport-help-text').boundingBox();
    assert.ok(tip && tip.x>=8 && tip.x+tip.width<=width-8 && tip.y>=0 && tip.y+tip.height<=720,`Viewport explanation stays inside ${width}px drawer`);
  }
  await panel.evaluate(()=>document.activeElement?.blur());
  await panel.keyboard.press('Escape');
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),false,'Escape dismisses a hover tooltip even when its button is not focused');
  await panel.mouse.move(2,2);
  await panel.locator('.viewport-info').hover();
  const infoBounds=await panel.locator('.viewport-info').boundingBox(),tipBounds=await panel.locator('#viewport-help-text').boundingBox();
  const pointerX=Math.max(tipBounds.x+5,Math.min(infoBounds.x+infoBounds.width/2,tipBounds.x+tipBounds.width-5));
  await panel.mouse.move(pointerX,infoBounds.y+infoBounds.height+3);
  await panel.waitForTimeout(50);
  await panel.mouse.move(pointerX,tipBounds.y+15);
  await panel.waitForTimeout(200);
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),true,'The hover gap is crossable and the tooltip stays visible while reading its text');
  await panel.mouse.move(2,2);await panel.waitForTimeout(200);
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),false,'Leaving the tooltip dismisses it');
  await panel.locator('.viewport-info').focus();
  await panel.keyboard.press('Escape');
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),false);
  assert.equal(await panel.locator('.viewport-info').evaluate(node=>document.activeElement===node),true,'Escape retains keyboard focus');
  await panel.locator('.viewport-info').hover();
  await panel.locator('.drawer-scroll').evaluate(node=>node.scrollTop=30);
  await panel.waitForTimeout(40);
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),false,'Scrolling the drawer hides its tooltip');
  await panel.locator('.drawer-scroll').evaluate(node=>node.scrollTop=0);
  await panel.emulateMedia({forcedColors:'active'});
  await panel.evaluate(()=>document.activeElement?.blur());await panel.locator('.viewport-info').focus();
  assert.equal(await panel.locator('#viewport-help-text').isVisible(),true);
  assert.equal(await panel.locator('#viewport-help-text').evaluate(node=>{const style=getComputedStyle(node);return style.color!==style.backgroundColor&&parseFloat(style.borderTopWidth)>0;}),true,'Tooltip text and boundary remain visible in forced colors');
  await panel.keyboard.press('Escape');await panel.emulateMedia({forcedColors:'none'});
  for(const width of [360,320]){
    await panel.setViewportSize({width,height:600});
    for(const end of [false,true]){
      await panel.locator('.drawer-scroll').evaluate((node,end)=>node.scrollTop=end?node.scrollHeight:0,end);
      const b=await panel.locator('#settings').boundingBox();
      assert(b.y>=0&&b.y+b.height<=600&&b.height>=44);
      assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
  }
  await panel.locator('.drawer-scroll').evaluate(node=>node.scrollTop=0);
  await panel.screenshot({path:resolve(out,'drawer.png')});
  await panel.evaluate(()=>localStorage.setItem('ai-fixture',JSON.stringify({model:'claude-sonnet-5',threshold:35,rememberKey:false,hasKey:true,journeyEngine:'managed',journeyBudgetUsd:4,managedAgentModel:'claude-opus-5-5'})));
  await panel.locator('#open-ai-entry').click();
  await panel.locator('#panel-journey').click();
  await panel.locator('#journey-engine-description').filter({hasText:'Claude agents · Claude Opus 5.5 · Max effort'}).waitFor();
  const managedConsent=await panel.locator('#journey-managed-consent').textContent();
  assert.match(managedConsent,/Anthropic stores.*screenshots.*page context.*your account/);
  assert.match(managedConsent,/\$4\.00 USD.*75%.*25%/);
  assert.match(managedConsent,/Keep Chrome and the reviewed tab open/);
  await panel.locator('#journey-form').screenshot({path:resolve(out,'managed-journey-setup.png')});
  assert.equal(await panel.evaluate(()=>messages.some(message=>message.type==='JOURNEY_START')),false,'Viewing disclosure never starts a journey');
  assert.equal(await panel.locator('#journey-max-steps').count(),0,'The old action-limit selector is removed');
  assert.equal(await panel.getByLabel('Action target',{exact:true}).inputValue(),'20');
  assert.match(await panel.locator('#journey-target-help-form').textContent(),/passing it does not stop/);
  await panel.locator('.journey-target').screenshot({path:resolve(out,'journey-action-target.png')});
  await panel.evaluate(()=>window.session.target.url='https://example.test/');
  await panel.locator('#journey-goal').fill('Create a test ingredient.');
  for(const invalid of ['0','501','1.5','']){
    await panel.locator('#journey-action-target').fill(invalid);
    assert.equal(await panel.locator('#journey-action-target').evaluate(input=>input.checkValidity()),false,`Target ${invalid} is rejected by the form`);
  }
  await panel.locator('#journey-action-target').fill('45');
  await panel.locator('#journey-start').click();
  await panel.locator('#journey-error').filter({hasText:'Fixture start request received.'}).waitFor();
  const startInput=await panel.evaluate(()=>messages.find(message=>message.type==='JOURNEY_START')?.input);
  assert.equal(startInput.actionTarget,45,'A target above the old 30-action limit reaches the worker');
  assert.equal(Object.hasOwn(startInput,'maxSteps'),false,'New journeys no longer submit a hard step limit');
  await panel.evaluate(()=>{
    localStorage.setItem('ai-fixture',JSON.stringify({...JSON.parse(localStorage.getItem('ai-fixture')),journeyEngine:'direct'}));window.dispatchEvent(new Event('focus'));
  });
  await panel.locator('#journey-engine-description').filter({hasText:'Direct · claude-sonnet-5'}).waitFor();
  assert.equal(await panel.locator('#journey-managed-consent').isVisible(),false);
  await panel.evaluate(()=>{
    localStorage.setItem('ai-fixture',JSON.stringify({...JSON.parse(localStorage.getItem('ai-fixture')),journeyEngine:'managed'}));window.dispatchEvent(new Event('focus'));
    window.journeyRun={id:'managed-fixture',status:'running',model:'claude-fable-5',goal:'Add a test ingredient',startUrl:'https://example.test/',updatedAt:new Date().toISOString(),metrics:{actions:1},steps:[{index:1,action:{type:'click',targetLabel:'Add ingredient'},observation:{url:'https://example.test/',title:'Ingredients'},executionStatus:'done'}],scores:[{dimension:'clarity',score:4,reason:'Recorded labels were clear.',evidenceSteps:[1]}],findings:[{title:'Fixture finding',comment:'Not yet evaluated.',severity:'minor',stepIndex:1}],followUps:[{question:'Which route did you take?',answer:'I used the Ingredients page.',evidenceSteps:[1]}],managed:{engine:'managed',model:'claude-fable-5',effort:'max',evaluatorStatus:'reviewing'}};
    window.session.journey={id:'managed-fixture'};window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-evaluator-status').filter({hasText:'Reviewing the recorded attempt'}).waitFor();
  assert.equal(await panel.locator('#journey-assessment').isVisible(),false,'Actor output is not displayed as a completed independent evaluation');
  assert.equal(await panel.locator('#journey-findings-section').isVisible(),false);
  assert.equal(await panel.locator('#journey-chat-open').isVisible(),false,'Live evaluation remains an active run rather than an available chat');
  await panel.evaluate(()=>{
    Object.assign(window.journeyRun,{actionTarget:20,metrics:{actions:35},targetAssessment:{actionTarget:20,actionCount:35,overBy:15,withinTarget:false,efficiencyScore:57,verifiedComplete:true},recording:{status:'saved'},recordingNotice:{code:'JOURNEY_RECORDING_LIMIT',message:'Recording reached its size limit. The journey continues with screenshots and notes.'}});
    window.journeyRun.updatedAt=new Date().toISOString();
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-progress').filter({hasText:'35 AI actions · target 20'}).waitFor();
  assert.equal(await panel.locator('#journey-target-comparison').textContent(),'35 action attempts · 15 over target');
  assert.equal(await panel.locator('#journey-run-controls').isVisible(),true,'Exceeding the target leaves active journey controls available');
  assert.equal(await panel.locator('#journey-target-score').textContent(),'Not scored yet','A running journey never gets a completion score');
  assert.match(await panel.locator('#journey-target-help').textContent(),/does not stop/);
  assert.equal(await panel.locator('#journey-recording-status').isVisible(),true,'An expected recording cap stays explained while the journey continues');
  assert.match(await panel.locator('#journey-recording-status').textContent(),/continues with screenshots and notes/);
  await panel.evaluate(()=>{
    window.journeyRun.status='completed';window.journeyRun.updatedAt=new Date().toISOString();
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-target-score').filter({hasText:'57/100'}).waitFor();
  assert.match(await panel.locator('#journey-target-help').textContent(),/not human effort or overall usability/);
  await panel.evaluate(()=>{
    window.journeyRun.continuation={parentRunId:'earlier-attempt',instructions:'Continue from here.'};
    window.journeyRun.targetAssessment.scope='segment';window.journeyRun.updatedAt=new Date().toISOString();
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-target-title').filter({hasText:'this part'}).waitFor();
  assert.match(await panel.locator('#journey-target-help').textContent(),/continuation only, excluding earlier attempts/);
  for(const theme of ['light','dark']){
    await panel.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await panel.setViewportSize({width:320,height:600});
    assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Action target fits a 320px ${theme} panel`);
    await panel.locator('#journey-target-assessment').screenshot({path:resolve(out,`journey-target-score-${theme}.png`)});
  }
  await panel.evaluate(()=>{
    delete window.journeyRun.actionTarget;delete window.journeyRun.targetAssessment;delete window.journeyRun.recordingNotice;delete window.journeyRun.continuation;
    window.journeyRun.maxSteps=30;window.journeyRun.metrics={actions:1};window.journeyRun.updatedAt=new Date().toISOString();
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-progress').filter({hasText:'1 AI action · target 30'}).waitFor();
  await panel.locator('#journey-use-goal').click();
  assert.equal(await panel.locator('#journey-action-target').inputValue(),'30','Reusing a legacy journey interprets its old limit as the new scoring target');
  await panel.locator('#journey-back').click();
  await panel.locator('#panel-journey').click();
  await panel.evaluate(()=>{
    window.journeyRun.status='stopped';window.journeyRun.updatedAt=new Date().toISOString();window.journeyRun.managed.evaluatorStatus='unavailable';window.journeyRun.managed.evaluatorError='Budget limit reached; diagnostic sk-ant-do-not-show';
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-evaluator-status').filter({hasText:'Evaluation unavailable'}).waitFor();
  await panel.locator('#journey-evaluator-help').filter({hasText:'spending limit'}).waitFor();
  assert.match(await panel.locator('#journey-evaluator-help').textContent(),/Continue the journey or start a new run/);
  assert.match(await panel.locator('#journey-evaluator-help').textContent(),/spending limit/);
  assert.equal((await panel.locator('#panel-journey-view').textContent()).includes('sk-ant-do-not-show'),false,'Provider diagnostics are not exposed in assessment errors');
  assert.equal(await panel.locator('#journey-assessment').isVisible(),false,'Unavailable evaluations show no fabricated scores');
  await panel.locator('#journey-evaluator').screenshot({path:resolve(out,'managed-journey-unavailable.png')});
  await panel.locator('#journey-chat-open').click();
  assert.equal(await panel.locator('#journey-ask').isDisabled(),true,'An exhausted evaluator cannot silently start a new budget');
  assert.equal(await panel.locator('#journey-question').isEnabled(),true,'An unavailable evaluator does not lock the saved draft');
  await panel.locator('#journey-question').fill('Keep this unsent question.');
  assert.match(await panel.locator('#journey-conversation').textContent(),/I used the Ingredients page/);
  await panel.locator('#journey-chat-back').click();
  await panel.evaluate(()=>{
    window.journeyRun.summary='Stopped at the old action limit before the task outcome was verified.';
    window.journeyRun.video={stopReason:'size-limit',bytes:6000000,durationMs:202000};
    window.journeyRun.updatedAt=new Date().toISOString();
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-run-notice').filter({hasText:'Stopped at the old action limit'}).waitFor();
  await panel.locator('#journey-chat-open').click();
  assert.match(await panel.locator('#journey-chat-stop-reason').textContent(),/Recorded ending.*Stopped at the old action limit/s,'Older terminal summaries remain visible in chat when no structured reason exists');
  assert.match(await panel.locator('#journey-chat-recording-ending').textContent(),/recording reached its size limit/,'Historical recording metadata is exposed without guessing the journey stop cause');
  await panel.locator('#journey-chat-back').click();
  await panel.evaluate(()=>{delete window.journeyRun.summary;delete window.journeyRun.video;});
  for(const resumable of [
    {status:'stopped',evaluatorStatus:'not-started'},
    {status:'blocked',evaluatorStatus:'reviewing'},
    {status:'stopped',evaluatorStatus:'unavailable',evaluatorReservationVersion:1,actorOutcome:{type:'finish',outcome:'blocked'}},
    {status:'inconclusive',evaluatorStatus:'unavailable',evaluatorSessionId:'sesn_existing_idle'}
  ]){
    await panel.evaluate(({status,...managed})=>{
      window.journeyRun.status=status;window.journeyRun.updatedAt=new Date().toISOString();window.journeyRun.stopReason=status==='stopped' ? 'The next action needs your guidance.' : {source:'browser',code:'target_missing',message:'The next action needs your guidance.',stepIndex:1};
      Object.assign(window.journeyRun.steps[0],{executionStatus:'error',executionError:{source:'browser',code:'target_missing',message:'The selected control is no longer on the page.'}});
      window.journeyRun.managed={engine:'managed',model:'claude-fable-5',effort:'max',...managed};
      window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
    },resumable);
    await panel.locator('#journey-evaluator-help').filter({hasText:'You can still discuss the recorded steps.'}).waitFor();
    assert.equal(await panel.locator('#journey-assessment').isVisible(),false,'Discussing evidence never promotes an incomplete assessment to scores');
    assert.match(await panel.locator('#journey-timeline [data-step="1"] .journey-step-error').textContent(),/The selected control is no longer on the page/,'A failed step retains its actual execution error');
    await panel.locator('#journey-chat-open').click();
    assert.equal(await panel.locator('#journey-ask').isEnabled(),true,'A stopped or blocked attempt can discuss evidence without completed scores');
    assert.match(await panel.locator('#journey-chat-stop-reason').textContent(),/The next action needs your guidance/);
    assert.match(await panel.locator('#journey-question-status').textContent(),/No usability evaluation was completed\. You can still discuss/);
    await panel.locator('#journey-question').fill('Why did this attempt stop?');
    await panel.evaluate(()=>window.finishJourneyReply=null);
    await panel.locator('#journey-ask').click();
    await panel.waitForFunction(()=>typeof window.finishJourneyReply==='function');
    assert.equal(await panel.locator('#journey-ask').isDisabled(),true);
    await panel.evaluate(()=>window.finishJourneyReply());
    await panel.locator('#journey-ask:not([disabled])').waitFor();
    assert.match(await panel.locator('#journey-conversation').textContent(),/The Add ingredient button matched the task/);
    await panel.locator('#journey-chat-back').click();
  }
  await panel.evaluate(()=>{
    window.journeyRun.status='blocked';window.journeyRun.updatedAt=new Date().toISOString();
    window.journeyRun.error='The journey agent could not finish its request.';
    window.journeyRun.assistance={id:'help-fixture',question:'I cannot find the next step. What should I do?',stepIndex:1};
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-help-question').waitFor();
  assert.match(await panel.locator('#journey-question').getAttribute('placeholder'),/scroll inside the list/);
  assert.match(await panel.locator('#journey-chat-stop-reason').textContent(),/could not finish its request/,'The stopping error is visible without expanding hidden context');
  await panel.evaluate(()=>{
    window.journeyRun.status='stopped';window.journeyRun.updatedAt=new Date().toISOString();
    window.journeyRun.assistance.response={text:'Stop here for now.',classification:'unsure',decision:'stop'};
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-help-response').waitFor();
  assert.equal(await panel.locator('#journey-ask').isEnabled(),true,'Stopping a blocked attempt still permits discussion');
  assert.doesNotMatch(await panel.locator('#journey-question').getAttribute('placeholder'),/scroll inside the list/,'Returning to ordinary chat clears the guidance placeholder');
  await panel.locator('#journey-question').fill('Keep this unsent question.');
  await panel.locator('#journey-chat-back').click();
  for(const incomplete of [
    {status:'completed',evaluatorStatus:'complete',evaluatorInterrupted:true,reason:'session was interrupted'},
    {status:'completed',evaluatorStatus:'complete',evaluatorRequestInFlight:true,reason:'last reply could not be confirmed'},
    {status:'stopped',evaluatorStatus:'not-started',evaluatorSessionCreationPending:true,reason:'setup did not finish'},
    {status:'blocked',evaluatorStatus:'not-started',evaluatorSessionCreationUncertain:true,reason:'creation could not be confirmed'},
    {status:'blocked',evaluatorStatus:'unavailable',evaluatorSessionId:null,actorOutcome:{type:'finish',outcome:'blocked'},reason:'creation could not be confirmed'},
    {status:'stopped',evaluatorStatus:'unavailable',evaluatorBudgetExhausted:true,reason:'spending limit'}
  ]){
    // Render a completed evaluation first, so every case must visibly leave
    // that state before its unavailable controls are asserted.
    await panel.evaluate(()=>{
      window.journeyRun.status='completed';window.journeyRun.updatedAt=new Date().toISOString();
      window.journeyRun.assistance=null;window.journeyRun.error=null;
      window.journeyRun.managed={engine:'managed',model:'claude-fable-5',effort:'max',evaluatorStatus:'complete',evaluatorSessionId:'sesn_existing_idle'};
      window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
    });
    await panel.locator('#journey-evaluator-status').filter({hasText:'Evaluation complete'}).waitFor();
    await panel.evaluate(({status,reason,...managed})=>{
      window.journeyRun.status=status;window.journeyRun.updatedAt=new Date().toISOString();Object.assign(window.journeyRun.managed,managed);
      window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
    },incomplete);
    await panel.locator('#journey-evaluator-status').filter({hasText:'Evaluation unavailable'}).waitFor();
    const explanation=await panel.locator('#journey-evaluator-help').textContent();
    assert.ok(explanation.includes(incomplete.reason),`Actionable explanation for ${JSON.stringify(incomplete)}`);
    assert.doesNotMatch(explanation,/Waiting|Reviewing|finishing/,'A terminal attempt never promises a pending evaluation');
    assert.equal(await panel.locator('#journey-assessment').isVisible(),incomplete.evaluatorStatus==='complete','A failed later request preserves a previously completed assessment');
    await panel.locator('#journey-chat-open').click();
    assert.equal(await panel.locator('#journey-ask').isDisabled(),true,JSON.stringify(incomplete));
    assert.equal(await panel.locator('#journey-question').isEnabled(),true);
    assert.equal(await panel.locator('#journey-question').inputValue(),'Keep this unsent question.');
    assert.match(await panel.locator('#journey-conversation').textContent(),/I used the Ingredients page/);
    assert.ok((await panel.locator('#journey-question-status').textContent()).includes(incomplete.reason));
    const sentBefore=await panel.evaluate(()=>messages.filter(message=>message.type==='JOURNEY_ASK').length);
    await panel.locator('#journey-question-form').evaluate(form=>form.requestSubmit());
    assert.equal(await panel.evaluate(()=>messages.filter(message=>message.type==='JOURNEY_ASK').length),sentBefore,'Form submission cannot bypass unavailable evaluator protection');
    await panel.locator('#journey-chat-back').click();
  }
  await panel.evaluate(()=>{
    window.journeyRun.status='completed';window.journeyRun.updatedAt=new Date().toISOString();window.journeyRun.managed={engine:'managed',model:'claude-fable-5',effort:'max',evaluatorStatus:'complete',evaluatorSessionId:'sesn_existing_idle'};
    window.dispatchEvent(new CustomEvent('diffuse-panel-state',{detail:{session:window.session,state:{view:'controls',active:true,available:true}}}));
  });
  await panel.locator('#journey-evaluator-status').filter({hasText:'Evaluation complete'}).waitFor();
  assert.equal(await panel.locator('#journey-assessment').isVisible(),true);
  await panel.locator('#journey-chat-open').click();
  assert.equal(await panel.locator('#journey-chat-budget').isVisible(),true);
  assert.equal(await panel.locator('#journey-ask').isDisabled(),false);
  await panel.locator('#journey-ask').click();
  await panel.waitForFunction(()=>typeof window.finishJourneyReply==='function');
  assert.equal(await panel.locator('#journey-ask').isDisabled(),true,'Live follow-up prevents concurrent Send');
  assert.equal(await panel.locator('#journey-ask').textContent(),'Replying…');
  assert.doesNotMatch(await panel.locator('#journey-question-status').textContent(),/Evaluation unavailable/,'The current panel’s live reply is not mistaken for a stale request');
  await panel.evaluate(()=>window.finishJourneyReply());
  await panel.locator('#journey-conversation').filter({hasText:'The Add ingredient button matched the task.'}).waitFor();
  await panel.locator('#journey-ask:not([disabled])').waitFor();
  await panel.screenshot({path:resolve(out,'managed-journey-chat.png')});
  assert.match(await panel.locator('#journey-chat-budget').textContent(),/remaining evaluator budget.*does not reset/);
  for(const theme of ['light','dark']){
    await panel.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Managed journey chat fits 320px in ${theme}`);
    const askBounds=await panel.locator('#journey-ask').boundingBox();assert(askBounds&&askBounds.y>=0&&askBounds.y+askBounds.height<=601,'Managed budget note preserves the chat Send control');
  }
  console.log('PASS managed journey disclosures, evidence chat without scores, explicit stop reasons, guidance-to-chat transition, uncertain/exhausted session guards, retained drafts and budget.');
  assert.deepEqual(errors,[]);
  console.log('PASS compact drawer has icon viewport controls, hover/focus info, shortcut cheatsheet, and a persistent Settings footer.');
} finally {await browser.close();}
