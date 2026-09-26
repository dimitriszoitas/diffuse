import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const backgroundSource = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const offscreenSource = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
const video = {dataUrl: 'data:video/webm;base64,dmlkZW8=', mimeType: 'video/webm', bytes: 5};
const listener = {addListener() {}};

// Execute the shipping lifecycle code, replacing only Chrome and storage APIs.
// Timers are inert so the 30-second recording and 60-second cache cleanup do not
// hold tests open; event ordering is controlled explicitly by each regression.
async function backgroundHarness(options = {}) {
  const drafts = new Map();
  const comments = [];
  const messages = [];
  const mediaMessages = [];
  const saves = [];
  let screenshots = 0;
  let rejectDelivery = false;
  const reviews = {
    getReview: async id => ({id, comments: structuredClone(comments), count: comments.length}),
    getDraft: async id => structuredClone(drafts.get(id)),
    putDraft: async draft => { drafts.set(draft.id, structuredClone(draft)); },
    discardDraft: async id => {drafts.delete(id);},
    addComment: async (id, fields, saveOptions) => {
      const draft = drafts.get(id);
      if (!draft) throw new Error('This evidence draft is no longer available.');
      drafts.delete(id);
      saves.push({id,fields:structuredClone(fields),options:structuredClone(saveOptions)});
      comments.push({...structuredClone(draft), fields});
      return {review: {id: draft.reviewId, count: comments.length}};
    },
  };
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: listener, onInstalled: listener,
      getContexts: async () => [],
      sendMessage: async message => {
        mediaMessages.push(structuredClone(message));
        if (message.type === 'START_RECORDING') {
          if (options.mediaStart) return options.mediaStart(message);
          return {ok:true,recording:{id:message.recordingId,startedAt:new Date().toISOString()}};
        }
        if (message.type === 'STOP_RECORDING') return {ok:true,video};
        if (message.type === 'SNAPSHOT_EVIDENCE') return {ok:true,evidence:{production:{dataUrl:message.dataUrl},prototype:{dataUrl:'data:image/png;base64,cHJvdG90eXBl'}}};
        return {ok:true};
      },
    },
    storage: {session: {get: async () => ({}), set: async () => {}}},
    tabs: {
      onUpdated: listener, onRemoved: listener,
      get: async id => ({id, windowId:1, url: 'https://example.test/app', title: 'Example'}),
      query: async () => [{id:2,windowId:1}],
      captureVisibleTab: async () => {screenshots++;return 'data:image/png;base64,c2NyZWVuc2hvdA==';},
      sendMessage: async (tabId, message) => {
        if (message.type === 'RECORDING_STOPPED' && rejectDelivery) throw new Error('Page is navigating.');
        messages.push(structuredClone(message));
        return {ok: true, viewport: {width: 1280, height: 900, dpr: 1},context:{url:'https://example.test/app',viewport:{width:1280,height:900,dpr:1,visualScale:1},scroll:{x:0,y:0}}};
      },
    },
    permissions: {contains: async () => true},
    scripting: {executeScript: async () => {}},
    tabCapture: {getMediaStreamId: async input => options.streamId ? options.streamId(input) : 'target-stream'},
  };
  const context = vm.createContext({
    chrome, reviews, crypto: webcrypto, protectAIStorage: async () => {},
    DEFAULT_SETTINGS: {}, sitePattern: () => 'https://example.test/*', viewportWarning: () => null,
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(backgroundSource.replace(/^import .*\n/gm, '') + `
    globalThis.api = {
      ready, beginRecording, finishRecording, initializeTab, stopSession, handle,
      setSession(value) { session = value; }, getSession() { return session; },
      setEvidenceBusy(value) {evidenceBusy=value;}, setAIJob(value) {aiJob=value;}
    };
  `, context, {filename: 'background.js'});
  await context.api.ready;
  const session = {
    id: 'comparison', reviewId: 'review', sourceTabId: 1, targetTabId: 2,
    source: {}, target: {}, settings: {},status:'live',targetViewport:{width:1280,height:900,dpr:1},
    recording: {id: 'recording', draftId: 'draft'},
  };
  drafts.set('draft', {id: 'draft', reviewId: 'review', recordingId: 'recording', evidence: {}});
  context.api.setSession(session);
  return {
    ...context.api, session, drafts, comments, messages, mediaMessages, saves,
    screenshots() {return screenshots;},
    rejectDelivery(value) { rejectDelivery = value; },
  };
}

test('Stop during video encoding waits for the same finished recording', {timeout: 1000}, async () => {
  let recorder;
  let reader;
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { recorder = this; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({data: new Blob(['video'])});
      this.onstop();
    }
  }
  const track = {stop() {}};
  const media = {active: true, getTracks: () => [track], getVideoTracks: () => [track]};
  const context = vm.createContext({
    Blob, MediaRecorder,
    FileReader: class { readAsDataURL() { reader = this; } },
    navigator: {mediaDevices: {getUserMedia: async () => media}},
    chrome: {runtime: {onMessage: listener, sendMessage: async () => ({ok: true})}},
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(offscreenSource + `
    currentSessionId = 'comparison'; stream = {active: true};
    globalThis.receiveMessage = receive;
  `, context, {filename: 'offscreen.js'});
  await context.receiveMessage({type: 'START_RECORDING', sessionId: 'comparison', recordingId: 'recording', streamId: 'stream', viewport: {width: 1280, height: 900, dpr: 1}});
  recorder.stop();
  let outcome;
  const stopping = context.receiveMessage({type: 'STOP_RECORDING', sessionId: 'comparison', recordingId: 'recording'});
  stopping.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  await new Promise(setImmediate);
  assert.equal(outcome, undefined, 'Stop must stay pending while FileReader is encoding');
  reader.result = video.dataUrl;
  reader.onload();
  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.video.dataUrl, video.dataUrl);
  assert.equal(result.video.bytes, 5);
});

test('a concurrent automatic finish and tab closure preserve exactly one comment', async () => {
  const harness = await backgroundHarness();
  await Promise.all([
    harness.finishRecording('recording', video, {notify: true}),
    harness.finishRecording('recording', video, {interrupted: true}),
  ]);
  assert.equal(harness.comments.length, 1);
  assert.equal(harness.comments[0].evidence.video.dataUrl, video.dataUrl);
  assert.equal(harness.session.pendingDraftId, null);
  assert.equal(harness.session.recording, null);
  await harness.finishRecording('recording', video, {interrupted: true});
  assert.equal(harness.comments.length, 1, 'A repeated closure cannot duplicate preserved evidence');
});

test('a late error for an old recording cannot clear the current recording', async () => {
  const harness = await backgroundHarness();
  await harness.handle({type: 'RECORDING_ERROR', sessionId: 'comparison', recordingId: 'older-recording', error: 'Late encoder failure'}, {url: 'chrome-extension://test/offscreen.html'});
  assert.equal(harness.session.recording.id, 'recording');
  assert.equal(harness.messages.length, 0);
});

test('target initialization recovers a finished draft whose notification was lost during reload', async () => {
  const harness = await backgroundHarness();
  harness.rejectDelivery(true);
  await harness.finishRecording('recording', video, {notify: true});
  assert.equal(harness.session.pendingDraftId, 'draft');
  assert.equal(harness.session.recording, null);
  assert.equal(harness.messages.some(message => message.type === 'RECORDING_STOPPED'), false);
  harness.rejectDelivery(false);
  await harness.initializeTab('target');
  const delivered = harness.messages.filter(message => message.type === 'RECORDING_STOPPED');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].draft.evidence.video.dataUrl, video.dataUrl);
  assert.equal(harness.comments.length, 0, 'Recovered draft remains editable before submission');
});

test('ending a comparison preserves a pending recording instead of stranding its draft', async () => {
  const harness = await backgroundHarness();
  await harness.finishRecording('recording', video);
  await harness.stopSession();
  assert.equal(harness.getSession(), null);
  assert.equal(harness.comments.length, 1);
  assert.equal(harness.comments[0].evidence.video.dataUrl, video.dataUrl);
  assert.equal(harness.drafts.has('draft'), false);
});

test('ending an active recording through the toolbar saves its finished evidence', async () => {
  const harness = await backgroundHarness();
  await harness.handle({type:'STOP_SESSION',sessionId:'comparison'}, {tab:{id:2},url:'https://example.test/app'});
  assert.equal(harness.getSession(),null);
  assert.equal(harness.comments.length,1);
  assert.equal(harness.comments[0].evidence.video.dataUrl,video.dataUrl);
  assert.equal(harness.mediaMessages.filter(message=>message.type==='STOP_RECORDING').length,1);
});

const composerDraft = () => ({
  id:'draft',reviewId:'review',mode:'audit',createdAt:'2026-09-25T00:00:00Z',
  selection:{kind:'region',component:{name:'Selected area',source:'region'},rect:{viewport:{x:50,y:80,width:140,height:90},document:{x:50,y:280,width:140,height:90}}},
  context:{production:{url:'https://example.test/app',scroll:{x:0,y:200}}},
  evidence:{production:{dataUrl:'data:image/png;base64,b3JpZ2luYWw='}},evidenceChoice:'screenshot',
});

function useComposer(harness, draft = composerDraft()) {
  harness.session.recording=null;harness.session.pendingDraftId=draft.id;
  harness.drafts.set(draft.id,structuredClone(draft));
  return draft;
}

const targetSender = {tab:{id:2},url:'https://example.test/app'};

test('toolbar recording keeps composer defaults available after recording finishes', async () => {
  const harness=await backgroundHarness();
  harness.session.recording=null;
  harness.drafts.clear();
  const recording=await harness.beginRecording();
  assert.equal(harness.screenshots(),1);
  const started=harness.drafts.get(recording.draftId);
  assert.equal(Object.hasOwn(started,'composerFields'),false,'toolbar recording must not replace default state/component with blank values');
  const finished=await harness.finishRecording(recording.id,video);
  assert.equal(Object.hasOwn(finished,'composerFields'),false);
  assert.equal(finished.evidence.video.dataUrl,video.dataUrl);
});

test('composer recording reuses its screenshot and selected area while preserving partial fields', async () => {
  const harness=await backgroundHarness();
  const original=useComposer(harness);
  const recording=await harness.beginRecording({draftId:'draft',fields:{title:'',comment:'',component:'Pricing copy',state:'',expected:'Expected copy',category:'copy-change',steps:'x'.repeat(9000),unexpected:'omit'}});
  assert.equal(recording.draftId,'draft');
  assert.equal(harness.screenshots(),0,'adding a clip must not recapture or replace selected screenshot');
  assert.equal(harness.drafts.size,1);
  const started=harness.drafts.get('draft');
  assert.deepEqual(started.selection,original.selection);
  assert.deepEqual(started.context,original.context);
  assert.deepEqual(started.evidence,original.evidence);
  assert.equal(started.composerFields.title,'');
  assert.equal(started.composerFields.comment,'','unfinished text is allowed when starting a clip');
  assert.equal(started.composerFields.component,'Pricing copy');
  assert.equal(started.composerFields.steps.length,8000);
  assert.equal(started.composerFields.unexpected,undefined);
  const result=await harness.finishRecording(recording.id,video);
  assert.equal(result.id,'draft');
  assert.deepEqual(result.selection,original.selection);
  assert.equal(result.composerFields.category,'copy-change');
  assert.equal(result.evidenceChoice,'video');
  await harness.initializeTab('target');
  const recovered=harness.messages.filter(message=>message.type==='RECORDING_STOPPED').at(-1).draft;
  assert.equal(recovered.composerFields.component,'Pricing copy');
  assert.equal(recovered.selection.kind,'region');
});

test('capture permission failure retains the composer draft, text, previous clip, and evidence choice', async () => {
  const harness=await backgroundHarness({streamId:async()=>{throw new Error('Extension has not been invoked for this tab');}});
  const original=composerDraft();original.evidence.video=video;original.recordingId='previous';
  useComposer(harness,original);
  await assert.rejects(harness.beginRecording({draftId:'draft',fields:{comment:'Keep this typed feedback',title:'',category:'ux-issue'}}),error=>error.code==='NEEDS_CAPTURE_ACCESS');
  const retained=harness.drafts.get('draft');
  assert.equal(retained.composerFields.comment,'Keep this typed feedback');
  assert.deepEqual(retained.selection,original.selection);
  assert.deepEqual(retained.evidence,original.evidence);
  assert.equal(retained.recordingId,'previous');
  assert.equal(retained.evidenceChoice,'screenshot');
  assert.equal(harness.session.pendingDraftId,'draft');
  assert.equal(harness.session.recording,null);
  assert.equal(harness.session.captureReady,false);
});

test('media-start failure retains a composer draft, while a failed toolbar recording removes only its new draft', async () => {
  const options={mediaStart:async()=>({ok:false,error:'Recorder unavailable'})};
  const composer=await backgroundHarness(options);const original=useComposer(composer);
  await assert.rejects(composer.beginRecording({draftId:'draft',fields:{comment:'Keep me'}}),/Recorder unavailable/);
  assert.equal(composer.drafts.get('draft').composerFields.comment,'Keep me');
  assert.deepEqual(composer.drafts.get('draft').selection,original.selection);
  assert.equal(composer.drafts.get('draft').recordingId,undefined);
  assert.equal(composer.drafts.get('draft').evidenceChoice,'screenshot');
  const toolbar=await backgroundHarness(options);toolbar.session.recording=null;toolbar.session.pendingDraftId=null;toolbar.drafts.clear();
  await assert.rejects(toolbar.beginRecording(),/Recorder unavailable/);
  assert.equal(toolbar.screenshots(),1,'toolbar path still captures new evidence');
  assert.equal(toolbar.drafts.size,0);
  assert.equal(toolbar.session.pendingDraftId,null);
});

test('a recording start locks draft save, discard, capture and duplicate starts until media is ready', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const harness=await backgroundHarness({streamId:()=>gate});useComposer(harness);
  const starting=harness.beginRecording({draftId:'draft',fields:{comment:'In progress'}});
  await new Promise(setImmediate);
  await assert.rejects(harness.beginRecording({draftId:'draft'}),/already running or starting/);
  await assert.rejects(harness.handle({type:'ADD_COMMENT',sessionId:'comparison',draftId:'draft',fields:{comment:'Save'}},targetSender),/Stop the recording/);
  await assert.rejects(harness.handle({type:'DISCARD_DRAFT',sessionId:'comparison',draftId:'draft'},targetSender),/Stop the recording/);
  await assert.rejects(harness.handle({type:'CAPTURE_COMMENT',sessionId:'comparison',selection:null},targetSender),/recording to start/);
  await assert.rejects(harness.handle({type:'RUN_AI_REVIEW',sessionId:'comparison'},targetSender),/capture or recording/);
  assert(harness.drafts.has('draft'));
  release('stream');await starting;
  await assert.rejects(harness.handle({type:'DISCARD_DRAFT',sessionId:'comparison',draftId:'draft'},targetSender),/Stop the recording/);
});

test('existing-draft recording respects evidence and AI locks and rejects unrelated drafts', async () => {
  const harness=await backgroundHarness();useComposer(harness);
  harness.setEvidenceBusy(true);await assert.rejects(harness.beginRecording({draftId:'draft'}),/screenshot capture/);
  harness.setEvidenceBusy(false);harness.setAIJob({});await assert.rejects(harness.beginRecording({draftId:'draft'}),/AI review/);
  harness.setAIJob(null);await assert.rejects(harness.beginRecording({draftId:'missing'}),/draft is no longer/);
  await assert.rejects(harness.beginRecording(),/Finish the open comment/);
  assert.equal(harness.drafts.size,1);
});

test('recording finalization keeps typed feedback when the session ends before submission', async () => {
  const harness=await backgroundHarness();useComposer(harness);
  const recording=await harness.beginRecording({draftId:'draft',fields:{title:'',comment:'The hover state jumps.',component:'Action button',state:'Hover',category:'design-mismatch',severity:'major'}});
  await harness.finishRecording(recording.id,video,{interrupted:true});
  assert.equal(harness.comments.length,1);
  assert.equal(harness.comments[0].fields.comment,'The hover state jumps.');
  assert.equal(harness.comments[0].fields.component,'Action button');
  assert.equal(harness.comments[0].fields.state,'Hover');
  assert.equal(harness.comments[0].fields.title,'');
  assert.equal(harness.saves[0].options.evidenceChoice,'video');
});

test('saving passes screenshot-only choice to the transaction and rejects video choice without a clip', async () => {
  const harness=await backgroundHarness();useComposer(harness);
  const fields={title:'',comment:'Observation',state:'Current state',category:'ux-issue'};
  await assert.rejects(harness.handle({type:'ADD_COMMENT',sessionId:'comparison',draftId:'draft',fields,evidenceChoice:'video'},targetSender),/Record a clip first/);
  assert(harness.drafts.has('draft'),'a failed evidence choice must not consume the draft');
  const original=harness.drafts.get('draft');original.evidence.video=video;harness.drafts.set('draft',original);
  await harness.handle({type:'ADD_COMMENT',sessionId:'comparison',draftId:'draft',fields,evidenceChoice:'screenshot'},targetSender);
  assert.equal(harness.saves.length,1);
  assert.equal(harness.saves[0].options.evidenceChoice,'screenshot');
  assert.equal(harness.saves[0].fields.title,'');
});
