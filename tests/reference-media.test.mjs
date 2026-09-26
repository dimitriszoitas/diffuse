import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../extension/offscreen.js',import.meta.url),'utf8');
const viewport={width:1280,height:800,dpr:1};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);

function media(name,{handle=name,surface='browser',play}={}) {
  const track={name,handle,surface,stopped:false,stopCalls:0,
    stop(){this.stopped=true;this.stopCalls++;},
    getSettings(){return{displaySurface:this.surface,width:1280,height:800};},
    getCaptureHandle(){return{handle:this.handle};},
  };
  return{name,track,play,get active(){return !track.stopped;},getTracks:()=>[track],getVideoTracks:()=>[track]};
}

async function harness() {
  const old=media('old-reference'),displays=[],users=[old],videos=[],reports=[],timers=new Map(),displayCalls=[];
  let timerId=0;
  const chrome={runtime:{id:'fixture',onMessage:{addListener(){}},sendMessage:async message=>{reports.push(message);return{ok:true};}}};
  const document={body:{append(video){video.appended=true;}},createElement(tag){
    assert.equal(tag,'video');
    const video={removed:false,srcObject:null,play(){return this.srcObject.play||Promise.resolve();},remove(){this.removed=true;}};
    videos.push(video);return video;
  }};
  const navigator={mediaDevices:{
    getUserMedia:async()=>{assert(users.length,'Unexpected user-media request');return users.shift();},
    getDisplayMedia:async options=>{
      displayCalls.push(options);assert(displays.length,'Unexpected display-media request');
      const next=displays.shift();if(next instanceof Error)throw next;return next;
    },
  }};
  const context=vm.createContext({chrome,document,navigator,
    setTimeout(callback,milliseconds){const id=++timerId;timers.set(id,{callback,milliseconds});return id;},
    clearTimeout(id){timers.delete(id);},
  });
  vm.runInContext(source+`\nglobalThis.api={receive,state:()=>({stream,sourceVideo,currentSessionId,stagedReference,displayRequest})};`,context,{filename:'offscreen.js'});
  const receive=message=>context.api.receive(message);
  await receive({type:'START_CAPTURE',sessionId:'old-session',streamId:'old-stream',viewport});
  const originalVideo=context.api.state().sourceVideo;
  const choose=(candidate,changes={})=>{displays.push(candidate);return receive({type:'CHOOSE_REFERENCE',sessionId:'old-session',requestId:'request-1',expectedHandle:'selected-reference',viewport,...changes});};
  const commit=changes=>receive({type:'COMMIT_REFERENCE',sessionId:'old-session',requestId:'request-1',newSessionId:'new-session',...changes});
  const assertOriginal=()=>{const state=context.api.state();assert.equal(state.stream,old);assert.equal(state.currentSessionId,'old-session');assert.equal(state.sourceVideo,originalVideo);assert.equal(old.track.stopCalls,0);assert.equal(originalVideo.removed,false);};
  return{old,displays,users,videos,reports,timers,displayCalls,receive,choose,commit,state:context.api.state,assertOriginal};
}

test('canceling Chrome sharing keeps the working stream and session unchanged',async()=>{
  const h=await harness(),cancel=new Error('User canceled');cancel.name='NotAllowedError';
  const result=await h.choose(cancel);
  assert.equal(result.cancelled,true);h.assertOriginal();assert.equal(h.state().stagedReference,null);assert.equal(h.state().displayRequest,null);
  assert.equal(h.displayCalls[0].audio,false);assert.equal(h.displayCalls[0].surfaceSwitching,'exclude');
});

test('a wrong tab, window, or screen is rejected and its media stopped without replacing the reference',async()=>{
  for(const options of [{handle:'wrong-tab'},{handle:'selected-reference',surface:'window'},{handle:'selected-reference',surface:'monitor'}]){
    const h=await harness(),candidate=media('candidate',options);
    await assert.rejects(h.choose(candidate),/does not match/);
    h.assertOriginal();assert.equal(candidate.track.stopCalls,1);assert.equal(h.state().stagedReference,null);assert.equal(h.videos.length,1);
  }
});

test('commit requires the staged nonce and original session, then swaps exactly once into the requested session',async()=>{
  const h=await harness(),candidate=media('selected-reference');await h.choose(candidate);
  h.assertOriginal();assert.equal(h.state().stagedReference.media,candidate);assert.equal(candidate.track.stopCalls,0);
  await assert.rejects(h.commit({requestId:'stale-request'}),/no longer available/);
  await assert.rejects(h.commit({sessionId:'stale-session'}),/no longer available/);
  h.assertOriginal();assert.equal(h.state().stagedReference.media,candidate);
  const result=await h.commit();assert.equal(result.ok,true);
  assert.equal(h.old.track.stopCalls,1);assert.equal(h.state().stream,candidate);assert.equal(h.state().currentSessionId,'new-session');assert.equal(h.state().sourceVideo.srcObject,candidate);
  assert.equal(h.state().stagedReference,null);assert.equal(h.timers.size,0);assert.equal(candidate.track.stopCalls,0);
  await assert.rejects(h.commit(),/no longer available/);assert.equal(candidate.track.stopCalls,0);
});

test('malformed destination sessions cannot stop a working reference or consume its staged replacement',async()=>{
  const h=await harness(),candidate=media('selected-reference');await h.choose(candidate);
  for(const newSessionId of [undefined,null,'','   ',42]){
    await assert.rejects(h.commit({newSessionId}),/destination review/);
    h.assertOriginal();assert.equal(h.state().stagedReference.media,candidate);assert.equal(candidate.track.stopCalls,0);
  }
  await h.commit();assert.equal(h.state().currentSessionId,'new-session');
});

test('stale aborts cannot discard another staged candidate or an already committed reference',async()=>{
  const h=await harness(),candidate=media('selected-reference');await h.choose(candidate);
  await h.receive({type:'ABORT_REFERENCE',requestId:'older-request'});h.assertOriginal();assert.equal(h.state().stagedReference.media,candidate);
  await h.commit();
  await h.receive({type:'ABORT_REFERENCE',requestId:'request-1'});
  await h.receive({type:'ABORT_REFERENCE',requestId:'older-request'});
  assert.equal(h.state().stream,candidate);assert.equal(h.state().currentSessionId,'new-session');assert.equal(candidate.track.stopCalls,0);
  h.old.track.onended();assert.equal(candidate.track.stopCalls,0);assert.equal(h.reports.length,0,'late old-track events must not end the new reference');
});

test('a candidate that changes identity or ends before commit is cleaned up while the original keeps running',async()=>{
  for(const change of ['identity','ended']){
    const h=await harness(),candidate=media('selected-reference');await h.choose(candidate);
    if(change==='identity')candidate.track.handle='different-tab';else candidate.track.stopped=true;
    await assert.rejects(h.commit(),/changed before it could connect/);
    h.assertOriginal();assert.equal(h.state().stagedReference,null);assert.equal(candidate.track.stopCalls,1);assert.equal(h.videos[1].removed,true);
  }
});

test('an aborted request waiting for video readiness releases only its own candidate',async()=>{
  const h=await harness(),gate=deferred(),candidate=media('selected-reference',{play:gate.promise});
  const choosing=h.choose(candidate);await tick();
  assert.equal(h.videos.length,2);assert.equal(h.state().stagedReference,null);
  await h.receive({type:'ABORT_REFERENCE',requestId:'older-request'});assert.equal(h.state().displayRequest.cancelled,false);
  await h.receive({type:'ABORT_REFERENCE',requestId:'request-1'});gate.resolve();
  assert.equal((await choosing).cancelled,true);h.assertOriginal();assert.equal(candidate.track.stopCalls,1);assert.equal(h.videos[1].removed,true);assert.equal(h.state().displayRequest,null);
});

test('stop followed by a new capture cannot be overwritten by a late sharing result',async()=>{
  const h=await harness(),gate=deferred(),late=media('selected-reference');
  const choosing=h.choose(gate.promise);await tick();
  await h.receive({type:'STOP_CAPTURE'});
  const replacement=media('replacement');h.users.push(replacement);
  await h.receive({type:'START_CAPTURE',sessionId:'replacement-session',streamId:'replacement-stream',viewport});
  gate.resolve(late);assert.equal((await choosing).cancelled,true);
  assert.equal(h.state().stream,replacement);assert.equal(h.state().currentSessionId,'replacement-session');assert.equal(replacement.track.stopCalls,0);assert.equal(late.track.stopCalls,1);assert.equal(h.old.track.stopCalls,1);
});

test('concurrent pickers are rejected and staged expiry leaves the live reference untouched',async()=>{
  const h=await harness(),gate=deferred(),candidate=media('selected-reference');
  const choosing=h.choose(gate.promise);await tick();
  await assert.rejects(h.receive({type:'CHOOSE_REFERENCE',sessionId:'old-session',requestId:'request-2',expectedHandle:'other',viewport}),/tab selection first/);
  gate.resolve(candidate);await choosing;h.assertOriginal();
  const timer=[...h.timers.values()][0];assert.equal(timer.milliseconds,120000);timer.callback();
  h.assertOriginal();assert.equal(candidate.track.stopCalls,1);assert.equal(h.state().stagedReference,null);
  await assert.rejects(h.commit(),/no longer available/);
});

test('capture identity monitoring is attached to the committed stream and its new session',async()=>{
  const h=await harness(),candidate=media('selected-reference');await h.choose(candidate);await h.commit();
  candidate.track.handle='changed-reference';candidate.track.oncapturehandlechange();await tick();
  assert.equal(candidate.track.stopCalls,1);assert.equal(h.reports.length,1);assert.equal(h.reports[0].type,'STREAM_ENDED');assert.equal(h.reports[0].sessionId,'new-session');
});
