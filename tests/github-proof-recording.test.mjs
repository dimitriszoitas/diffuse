import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {cleanPreviewUrl,mapPreviewUrl,projectReviewToPreview} from '../extension/pr-review.mjs';

const background=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const section=(text,from,to)=>{const start=text.indexOf(from),end=text.indexOf(to,start);assert(start>=0&&end>start);return text.slice(start,end);};
const proofFunctions=section(background,'async function assertPRProofContext(','async function capturePRVerification(');
const pageFunction=section(background,'function savedPageUrl(','function savedCommentUrl(');
const viewportFunction=section(background,'function savedCommentViewport(','async function waitForReviewPage(');
const clone=value=>structuredClone(value),head='a'.repeat(40);
function harness(){
  const context={owner:'team',repo:'prototype',number:1,url:'https://github.com/team/prototype/pull/1',headSha:head,previewUrl:'https://new.test/',sourcePreviewUrl:'https://old.test/',association:'manual'};
  const page={url:'https://old.test/releases?state=ready#primary',viewport:{width:1280,height:720,dpr:1},viewportProfile:{key:'desktop',mode:'window'},scroll:{x:0,y:0}};
  const comment={id:'finding-local',findingKey:'finding-portable',context:{production:page},fields:{comment:'Action is unclear'},evidence:{production:{dataUrl:'data:image/png;base64,b2xk'}}};
  const review={id:'review-local',reviewKey:'review-portable',productionUrl:page.url,prContext:context,comments:[comment]};
  const mapped=mapPreviewUrl(page.url,context.sourcePreviewUrl,context.previewUrl),state={calls:[],page:{...clone(page),url:mapped},tab:{id:7,windowId:3,url:mapped},tick:null,afterStart:null,beforeStop:null,video:null};
  const sandbox={session:{id:'live-session',reviewId:review.id,targetTabId:7,status:'live',mode:'audit',prContext:clone(context)},prProofRecording:null,recordingStart:null,transitioning:false,evidenceBusy:false,aiJob:null,acceptingSuggestions:new Set(),
    URL,Date,structuredClone,crypto:{randomUUID},cleanPreviewUrl,mapPreviewUrl,projectReviewToPreview,isReviewableUrl:value=>/^https?:\/\//.test(value),
    assertReferenceReady(){if(sandbox.recordingStart||sandbox.session?.recording)throw new Error('Capture already busy');},async assertPageAccess(){},captureError:error=>error,
    chrome:{tabs:{async get(){return clone(state.tab);}},tabCapture:{async getMediaStreamId(){state.calls.push('stream');return 'trusted-tab-stream';}}},
    async tabMessage(){return {context:clone(state.page)};},async focusTab(){},async requireActiveProduction(){return clone(state.tab);},async publish(){state.calls.push('publish');},
    setInterval(fn){state.tick=fn;return 1;},clearInterval(){state.tick=null;},
    async mediaMessage(type,data){state.calls.push({type,data:clone(data)});if(type==='START_RECORDING'){state.video={dataUrl:'data:video/webm;codecs=vp9;base64,dmlkZW8=',mimeType:'video/webm;codecs=vp9',durationMs:4000,width:1280,height:720,startedAt:new Date().toISOString(),stoppedAt:new Date().toISOString()};await state.afterStart?.();return {ok:true,recording:{id:data.recordingId,startedAt:state.video.startedAt}};}if(type==='STOP_RECORDING'){await state.beforeStop?.();return {ok:true,video:state.video};}return {ok:true};}
  };
  vm.createContext(sandbox);vm.runInContext(`${pageFunction}\n${viewportFunction}\n${proofFunctions}`,sandbox);
  const invoke=input=>sandbox.capturePRProofRecording({review,comment,context,...input});
  return {state,sandbox,review,comment,context,invoke};
}

test('proof Start/Stop returns trusted tab media without creating or modifying original comment evidence',async()=>{
  const h=harness(),original=clone(h.review),started=await h.invoke({action:'start'});
  assert.equal(started.maxDurationMs,30000);assert.equal(h.sandbox.session.recording.kind,'pr-proof');
  const start=h.state.calls.find(v=>v.type==='START_RECORDING');assert.equal(start.data.proof,true);assert.equal(start.data.streamId,'trusted-tab-stream');
  const proof=await h.invoke({action:'stop',recordingToken:started.recordingToken,evidence:{dataUrl:'caller-video'}});
  assert.equal(proof.dataUrl,h.state.video.dataUrl);assert.equal(proof.pageUrl,h.state.tab.url);assert.equal(proof.width,1280);assert.equal(proof.durationMs,4000);
  assert.equal(h.sandbox.session.recording,null);assert.equal(h.sandbox.prProofRecording,null);assert.deepEqual(h.review,original);
  assert(h.state.calls.some(v=>v.type==='DISCARD_RECORDING'));
});

test('proof start refuses wrong build, route, viewport or concurrent comment before opening a stream',async()=>{
  for(const change of [h=>{h.sandbox.session.prContext.headSha='b'.repeat(40);},h=>{h.state.tab.url='https://new.test/other';},h=>{h.state.page.viewport.width=1270;},h=>{h.sandbox.session.pendingDraftId='draft';}]){
    const h=harness();change(h);await assert.rejects(h.invoke({action:'start'}));assert(!h.state.calls.includes('stream'));
  }
});

test('proof stop discards media when the build changes during capture and rejects arbitrary tokens',async()=>{
  const h=harness(),started=await h.invoke({action:'start'});
  await assert.rejects(h.invoke({action:'stop',recordingToken:randomUUID()}),/no longer available/);
  h.state.beforeStop=()=>{h.sandbox.session.prContext.headSha='b'.repeat(40);};
  await assert.rejects(h.invoke({action:'stop',recordingToken:started.recordingToken}),/build changed/);
  assert.equal(h.sandbox.session.recording,null);assert.equal(h.sandbox.prProofRecording,null);
});

test('guard monitoring cancels proof on navigation and cancel remains available without review/session inputs',async()=>{
  const h=harness(),started=await h.invoke({action:'start'});h.state.tab.url='https://new.test/other';await h.state.tick();
  assert.equal(h.sandbox.session.recording,null);assert(h.sandbox.prProofRecording.error);
  h.sandbox.session=null;
  const result=await h.sandbox.capturePRProofRecording({action:'cancel',recordingToken:started.recordingToken});assert.equal(result.cancelled,true);assert.equal(h.sandbox.prProofRecording,null);
  assert.equal((await h.sandbox.capturePRProofRecording({action:'cancel',recordingToken:started.recordingToken})).cancelled,true);
});

test('auto-stopped proof is retained for explicit Stop without opening a normal comment composer',async()=>{
  const h=harness(),started=await h.invoke({action:'start'});await h.sandbox.finishPRProof(h.sandbox.prProofRecording,h.state.video);
  assert.equal(h.sandbox.session.recording,null);assert(h.sandbox.prProofRecording.evidence);
  const result=await h.invoke({action:'stop',recordingToken:started.recordingToken});assert.equal(result.dataUrl,h.state.video.dataUrl);assert(!h.state.calls.some(v=>v.type==='STOP_RECORDING'));
  assert.match(background,/if\(prProofRecording\?\.id===message\.recordingId\)\{await finishPRProof/);
});

test('proof evidence is capped before it can leave the trusted capture boundary',async()=>{
  for(const mutate of [video=>{video.dataUrl='data:video/webm;base64,'+'A'.repeat(2*1024*1024);},video=>{video.durationMs=30001;},video=>{video.startedAt='2020-01-01';}]){
    const h=harness(),started=await h.invoke({action:'start'});mutate(h.state.video);await assert.rejects(h.invoke({action:'stop',recordingToken:started.recordingToken}),/could not be saved/);assert.equal(h.sandbox.prProofRecording,null);
  }
});

const offscreen=await readFile(new URL('../extension/offscreen.js',import.meta.url),'utf8');
const startRecorder=section(offscreen,'async function startRecording(','function gathered(');
function recorderHarness(){
  const state={options:null,trackStopped:false,report:[],timer:null};
  const track={getSettings:()=>({width:1280,height:720}),stop(){state.trackStopped=true;}};
  class Recorder{static isTypeSupported(){return true;}constructor(media,options){state.options=options;state.recorder=this;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}}
  const sandbox={recording:null,recordingRequest:null,lastRecording:null,currentSessionId:'session',navigator:{mediaDevices:{async getUserMedia(constraints){state.constraints=constraints;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}}},MediaRecorder:Recorder,Blob,Date,
    captureSize:viewport=>({width:viewport.width,height:viewport.height}),dataURL:async blob=>`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
    report:async(type,data)=>state.report.push({type,data}),setTimeout:(fn,delay)=>{state.timer=fn;state.timerDelay=delay;return 1;},clearTimeout(){}};
  vm.createContext(sandbox);vm.runInContext(startRecorder,sandbox);return {state,sandbox};
}

test('offscreen proof recorder uses bounded bitrate and real video-track dimensions',async()=>{
  const h=recorderHarness();await h.sandbox.startRecording({recordingId:randomUUID(),streamId:'trusted',viewport:{width:3840,height:2160},proof:true});
  assert.equal(h.state.options.videoBitsPerSecond,300000);assert.equal(h.state.timerDelay,29000);assert.equal(h.state.constraints.video.mandatory.maxWidth,1920);assert.equal(h.state.constraints.video.mandatory.maxHeight,1080);
  const item=h.sandbox.recording;h.state.recorder.ondataavailable({data:new Blob(['real-video-bytes'])});h.state.recorder.stop();const video=await item.finished;
  assert.equal(video.kind,'pr-proof');assert.equal(video.width,1280);assert.equal(video.height,720);assert(h.state.trackStopped);assert.equal(h.state.report.length,0);
});

test('offscreen proof rejects oversize media and discard resolves without retaining a recording',async()=>{
  const h=recorderHarness();await h.sandbox.startRecording({recordingId:randomUUID(),streamId:'trusted',viewport:{width:1280,height:720},proof:true});const item=h.sandbox.recording;
  h.state.recorder.ondataavailable({data:new Blob([new Uint8Array(1600*1024)])});await assert.rejects(item.finished,/too large/);assert.equal(h.sandbox.lastRecording,null);
  const other=recorderHarness();await other.sandbox.startRecording({recordingId:randomUUID(),streamId:'trusted',viewport:{width:1280,height:720},proof:true});const discarded=other.sandbox.recording;discarded.discarded=true;other.state.recorder.ondataavailable({data:new Blob(['video'])});other.state.recorder.stop();assert.equal(await discarded.finished,null);assert.equal(other.sandbox.lastRecording,null);
});

test('offscreen proof rejects elapsed duration beyond30seconds without trimming its timestamp',async()=>{
  const h=recorderHarness();await h.sandbox.startRecording({recordingId:randomUUID(),streamId:'trusted',viewport:{width:1280,height:720},proof:true});const item=h.sandbox.recording;
  item.startedAt=new Date(Date.now()-30001).toISOString();h.state.recorder.ondataavailable({data:new Blob(['video'])});h.state.recorder.stop();
  await assert.rejects(item.finished,/exceeded 30 seconds/);assert.equal(h.sandbox.lastRecording,null);
});
