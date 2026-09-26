// Controller-only regression fixture. Uses a fresh Chromium process and a local
// runtime stub; no installed extension, user profile, API key, or network call.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):await import('playwright');
const project=resolve(import.meta.dirname,'..');
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
let checks=0;
const pass=label=>{checks++;console.log(`PASS ${label}`);};
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent('<!doctype html><title>Local drawer fixture</title><style>body{font:20px system-ui;margin:80px}button{padding:24px}</style><h1>Review fixture</h1><button id="target" data-component="Primary action">Create release</button>');
  await page.evaluate(()=>{
    const image=document.createElement('canvas');image.width=32;image.height=32;
    const dataUrl=image.toDataURL();
    window.calls=[];window.failCapture=false;window.draft=null;
    window.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){window.receiver=fn;}},async sendMessage(message){
      window.calls.push(message);
      if(message.type==='GET_AI_CONFIG')return{ok:true,config:{hasKey:true,model:'fixture',threshold:35,apiKey:'must-not-leak'}};
      if(message.type==='GET_AI_SUGGESTIONS')return{ok:true,batch:null};
      if(message.type==='CAPTURE_COMMENT'){
        if(window.failCapture)return{ok:false,code:'NEEDS_CAPTURE_ACCESS',error:'Allow capture'};
        window.draft={id:`draft-${window.calls.length}`,selection:message.selection,evidence:{production:{dataUrl},prototype:{dataUrl}}};
        return{ok:true,draft:window.draft};
      }
      if(message.type==='START_RECORDING')return{ok:true,recording:{id:'recording-1',startedAt:Date.now(),draftId:message.draftId}};
      if(message.type==='ADD_COMMENT')return{ok:true,review:{id:'review',count:1}};
      return{ok:true};
    }}};
    window.deliver=message=>new Promise(resolve=>window.receiver({namespace:'diffuse',sessionId:'review',...message},{id:'fixture'},resolve));
  });
  for(const file of ['inspector.js','content.js'])await page.addScriptTag({content:await readFile(resolve(project,'extension',file),'utf8')});
  const deliver=message=>page.evaluate(message=>window.deliver(message),message);
  const command=(action,payload={})=>deliver({type:'PANEL_COMMAND',action,...payload});
  const state=async payload=>(await deliver({type:'PANEL_STATE',...payload})).state;
  const overlay=page.locator('diffuse-live-overlay');
  const reviewSession={id:'review',mode:'audit',status:'live',settings:{opacity:.55,reveal:50,linked:false,offsetX:0,offsetY:0},comments:[]};
  await deliver({type:'INITIALIZE',role:'target',session:reviewSession});
  assert.equal(await overlay.locator('#status').textContent(),'Review ready');
  assert.equal(await overlay.locator('#diff').isVisible(),true);
  assert.equal(await overlay.locator('#diff').isEnabled(),true);
  assert.equal(await overlay.locator('#divider').isVisible(),false);
  assert.equal(await overlay.locator('#hide').isVisible(),false);
  await overlay.locator('#diff').click();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).type),'OPEN_DIFF');
  await command('openDiff');
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.type==='OPEN_DIFF').length),2);
  await deliver({type:'SESSION_UPDATE',session:{...reviewSession,mode:'comparison',sourceTabId:1}});
  assert.equal(await overlay.locator('#divider').isVisible(),true);
  assert.equal(await overlay.locator('#hide').isVisible(),true);
  assert.equal(await overlay.locator('#reference').count(),1);
  pass('Review starts without a reference; Diff opens its picker and an attached reference appears without resetting the controller');
  await deliver({type:'DOCK_STATE',docked:true});
  assert.equal(await overlay.locator('#toolbar').isVisible(),false);
  assert.equal(await overlay.locator('#divider').isVisible(),true);
  assert.equal(await overlay.locator('#toolbar').evaluate(node=>node.inert),false);
  pass('Docking hides floating controls while preserving the live reveal and page interaction');

  await command('selectElement');await page.locator('#target').click();
  await page.waitForFunction(()=>window.calls.some(item=>item.type==='CAPTURE_COMMENT'));
  let snapshot=await state();assert.equal(snapshot.view,'comment');assert.ok(snapshot.comment.evidence.production.dataUrl);
  assert.equal(await overlay.locator('#diff').isEnabled(),false);assert.match(snapshot.diffDisabledReason,/Save or cancel/);
  assert.equal((await command('openDiff')).ok,false);
  assert.equal(await page.evaluate(()=>window.calls.filter(item=>item.type==='OPEN_DIFF').length),2);
  assert.equal(await overlay.locator('#comment-panel').isVisible(),false);
  assert.equal(await overlay.locator('#panel-backdrop').isVisible(),false);
  const known={knownDraftId:snapshot.comment.id,knownEvidenceKey:snapshot.comment.evidenceKey};
  assert.equal((await state(known)).comment.evidenceIncluded,false);assert.equal((await state(known)).comment.evidence,undefined);
  pass('Docked selection opens a draft in state, with media sent once per evidence revision');

  const fields={title:'',comment:'  Keep the drafted detail\n',expected:'Match the reference',component:'Primary action',state:'Current state',steps:'Open releases',severity:'major',category:'copy-change'};
  await command('setCommentFields',{fields});
  assert.equal((await state()).comment.fields.comment,fields.comment);
  await command('setCommentFields',{editorId:'panel-editor',fieldRevision:2,fields:{comment:'Newer fields survive reordered delivery'}});
  await command('setCommentFields',{editorId:'panel-editor',fieldRevision:1,fields:{comment:'Older request arriving last'}});
  assert.equal((await state()).comment.fields.comment,'Newer fields survive reordered delivery');
  assert.equal((await state()).comment.fieldRevisions['panel-editor'],2);
  await command('setCommentFields',{editorId:'panel-editor',fieldRevision:3,fields});
  assert.equal((await command('setCommentFields',{draftId:'stale-draft',fields:{comment:'Stale input'}})).ok,false);
  assert.equal((await state()).comment.fields.comment,fields.comment);
  await deliver({type:'DOCK_STATE',docked:false});
  assert.equal(await overlay.locator('#comment-panel').isVisible(),true);
  assert.equal(await overlay.locator('#comment-actual').inputValue(),fields.comment);
  assert.equal(await overlay.locator('#comment-panel').getAttribute('aria-modal'),'true');
  await deliver({type:'DOCK_STATE',docked:true});
  assert.equal(await overlay.locator('#comment-panel').getAttribute('aria-modal'),'false');
  await command('setCommentFields',{editorId:'panel-editor',fieldRevision:4,fields:{...fields,comment:'Latest keystroke reaches Save'}});
  await command('saveComment',{editorId:'panel-editor',fieldRevision:3,fields:{...fields,comment:'Stale save payload'}});
  assert.equal((await state()).view,'controls');
  assert.equal(await page.evaluate(()=>window.calls.findLast(item=>item.type==='ADD_COMMENT').fields.comment),'Latest keystroke reaches Save');
  pass('Edits retain whitespace through drawer close; reordered updates and stale save payload cannot overwrite newer fields');

  await command('selectArea');assert.equal((await state()).areaArmed,true);
  await page.setViewportSize({width:1000,height:900});await page.waitForTimeout(80);
  assert.equal((await state()).areaArmed,false);assert.match((await state()).warning,/resized/);
  pass('Resizing cancels an armed area instead of capturing stale coordinates');

  await page.evaluate(()=>window.failCapture=true);
  await command('selectElement');await page.locator('#target').click();
  await page.waitForTimeout(60);snapshot=await state();
  assert.equal(snapshot.view,'comment');assert.equal(snapshot.comment,null);assert.equal(snapshot.captureNeedsAccess,true);assert.match(snapshot.captureDescription,/extension icon/);
  await page.evaluate(()=>window.failCapture=false);await command('retryCapture');
  snapshot=await state();assert.ok(snapshot.comment);
  await command('saveComment',{fields:{comment:'',state:''}});assert.match((await state()).comment.error,/comment and a state/);
  pass('Permission failures and required-field errors remain visible in docked state');

  await command('evidence',{choice:'recording'});
  await command('recordComment',{fields:{...fields,comment:'Recording keeps the draft'}});
  snapshot=await state();assert.equal(snapshot.view,'controls');assert.equal(snapshot.recording.id,'recording-1');assert.equal(snapshot.comment.fields.comment,'Recording keeps the draft');
  const previousKey=snapshot.comment.evidenceKey;
  await page.evaluate(async()=>{window.draft.evidence.video={dataUrl:'data:video/webm;base64,AA==',recordingId:'recording-1'};await window.deliver({type:'RECORDING_STOPPED',draft:window.draft});});
  snapshot=await state({knownDraftId:snapshot.comment.id,knownEvidenceKey:previousKey});
  assert.equal(snapshot.view,'comment');assert.equal(snapshot.comment.evidenceIncluded,true);assert.ok(snapshot.comment.evidence.video);
  assert.equal(snapshot.comment.fields.comment,'Recording keeps the draft');
  await command('cancelComment');
  pass('Recording preserves draft fields and refreshes media when the same draft gains a clip');

  await command('openAi');await command('setAiFields',{instructions:'Check copy only',threshold:18});
  snapshot=await state();assert.equal(snapshot.view,'ai');assert.equal(snapshot.ai.instructions,'Check copy only');assert.equal(snapshot.ai.threshold,18);assert.equal(snapshot.ai.config.apiKey,undefined);
  await command('runAi',{instructions:'Use the latest input',threshold:21});
  assert.deepEqual(await page.evaluate(()=>{const call=window.calls.findLast(item=>item.type==='RUN_AI_REVIEW');return{instructions:call.instructions,threshold:call.threshold};}),{instructions:'Use the latest input',threshold:21});
  await deliver({type:'DOCK_STATE',docked:false});assert.equal(await overlay.locator('#ai-instructions').inputValue(),'Use the latest input');
  assert.equal((await command('unknown')).ok,false);
  pass('AI fields survive docking and the snapshot never exposes secret config fields');
  await deliver({type:'STOP'});
  console.log(`${checks} focused controller checks passed.`);
} finally {await browser.close();}
