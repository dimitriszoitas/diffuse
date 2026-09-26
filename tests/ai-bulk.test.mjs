import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const listener = {addListener() {}};
const sender = {tab: {id: 2}, url: 'https://example.test/page'};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function harness() {
  const current = {id:'session',reviewId:'review',mode:'comparison',status:'live',targetTabId:2,sourceTabId:1,target:{},settings:{},aiBatchId:'batch',recording:null};
  const batch = {
    id:'batch',reviewId:'review',mode:'comparison',createdAt:'2026-09-25T00:00:00Z',
    context:{production:{url:sender.url,viewport:{width:1000,height:800},scroll:{x:0,y:200}}},
    evidence:{production:{dataUrl:'data:image/png;base64,cGFnZQ==',capturedAt:'2026-09-25T00:00:00Z'},prototype:{dataUrl:'data:image/png;base64,cmVmZXJlbmNl'}},
    aiBatch:{model:'fixture-model',summary:'Three findings',limitations:[],suggestions:[85,60,12].map((score,index)=>({id:`finding-${index+1}`,title:`Finding ${index+1}`,comment:`Observation ${index+1}`,expected:'Expected result',category:'design-mismatch',severity:'minor',component:'Card',state:'Current state',region:{x:0.1,y:0.2,width:0.3,height:0.1},mismatchScore:score,score,confidence:0.8,status:'pending'}))},
  };
  const state = {drafts:new Map([['batch',structuredClone(batch)]]),comments:[],providerCalls:0,captures:0,annotations:0,annotationGate:null,failAnnotationAt:0,failBatchWrite:false,messages:[],annotationMessages:[]};
  const reviews = {
    getDraft:async id=>{if(id==='batch' && state.batchReadGate)await state.batchReadGate.promise;return structuredClone(state.drafts.get(id));},
    putDraft:async draft=>{
      if(draft.id==='batch' && state.failBatchWrite){state.failBatchWrite=false;throw new Error('Batch write failed');}
      state.drafts.set(draft.id,structuredClone(draft));
    },
    discardDraft:async id=>state.drafts.delete(id),
    getReview:async id=>({id,count:state.comments.filter(comment=>comment.reviewId===id).length,comments:structuredClone(state.comments.filter(comment=>comment.reviewId===id))}),
    addComment:async (id,fields)=>{
      const draft=state.drafts.get(id);assert.ok(draft);
      const comment={...structuredClone(draft),id:`comment-${state.comments.length+1}`,fields:structuredClone(fields)};
      state.comments.push(comment);state.drafts.delete(id);
      return {comment,review:{id:draft.reviewId,count:state.comments.length}};
    },
  };
  const chrome = {
    runtime:{onMessage:listener,onInstalled:listener,getURL:path=>`chrome-extension://test/${path}`,sendMessage:async message=>{
      assert.equal(message.type,'ANNOTATE_EVIDENCE','acceptance must only annotate retained evidence');
      state.annotations++;state.annotationMessages.push(structuredClone(message));
      if(state.annotationGate)await state.annotationGate.promise;
      if(state.failAnnotationAt===state.annotations)throw new Error('Annotation failed');
      return {ok:true,production:{dataUrl:message.dataUrl,annotatedDataUrl:'data:image/png;base64,YW5ub3RhdGVk'}};
    }},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{onUpdated:listener,onRemoved:listener,sendMessage:async(id,message)=>{state.messages.push(structuredClone(message));return {ok:true};},captureVisibleTab:async()=>{state.captures++;throw new Error('Unexpected screenshot');}},
    permissions:{contains:async()=>true},
  };
  const context=vm.createContext({chrome,reviews,crypto:webcrypto,protectAIStorage:async()=>{},viewportWarning:()=>'',DEFAULT_SETTINGS:{},AbortController,
    readAISettings:async()=>({hasKey:true,apiKey:'fixture-key',model:'fixture-model'}),reviewScreens:async()=>{state.providerCalls++;throw new Error('Unexpected provider request');},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  });
  vm.runInContext(source.replace(/^import .*\n/gm,'')+`
    globalThis.api={ready,handle,runAIReview,setSession(value){session=value;},getSession(){return session;},setEvidenceBusy(value){evidenceBusy=value;},setAIJob(value){aiJob=value;},lockCount(){return acceptingSuggestions.size;}};
  `,context,{filename:'background.js'});
  await context.api.ready;context.api.setSession(current);
  return {...context.api,current,state,batch,send:(type,fields={})=>context.api.handle({type,sessionId:'session',...fields},sender)};
}

const bulk=(worker,ids=['finding-1','finding-2'])=>worker.send('ACCEPT_AI_SUGGESTIONS',{batchId:'batch',suggestionIds:ids});

test('bulk acceptance saves only explicit visible IDs with paired evidence, regions and AI provenance',async()=>{
  const worker=await harness();
  const result=await bulk(worker);
  assert.equal(result.acceptedCount,2);assert.equal(result.review.count,2);assert.equal(result.skippedCount,0);assert.equal(result.partial,false);
  assert.deepEqual(Array.from(result.batch.suggestions,item=>item.id),['finding-3']);
  for(const comment of worker.state.comments){
    assert.equal(comment.ai.runId,'batch');assert.equal(comment.ai.model,'fixture-model');assert.equal(comment.ai.provider,'anthropic');
    assert.equal(comment.selection.rect.viewport.x,100);assert.equal(comment.selection.rect.document.y,360);
    assert.equal(comment.evidence.prototype.dataUrl,worker.batch.evidence.prototype.dataUrl);
    assert.ok(comment.evidence.production.annotatedDataUrl);assert.equal(comment.fields.comment,comment.ai.suggestionId==='finding-1'?'Observation 1':'Observation 2');
  }
  assert.equal(worker.state.providerCalls,0);assert.equal(worker.state.captures,0);assert.equal(worker.lockCount(),0);
});

test('bulk payload validation rejects duplicates, unknown IDs and oversized selection before saves',async()=>{
  for(const ids of [[],['finding-1','finding-1'],['finding-1','foreign'],Array.from({length:13},(_,i)=>`finding-${i}`)]){
    const worker=await harness();await assert.rejects(bulk(worker,ids),/Choose 1–12|do not belong/);
    assert.equal(worker.state.comments.length,0);assert.equal(worker.state.annotations,0);assert.equal(worker.lockCount(),0);
  }
});

test('duplicate and concurrent bulk requests are serialized and safely skip already accepted items',async()=>{
  const worker=await harness();
  const [first,second]=await Promise.all([bulk(worker),bulk(worker)]);
  assert.equal(first.acceptedCount,2);assert.equal(second.acceptedCount,0);assert.equal(second.skippedCount,2);
  assert.equal(worker.state.comments.length,2);assert.equal(worker.state.annotations,2);assert.equal(worker.lockCount(),0);
});

test('a partial failure keeps remaining suggestions pending and retries without duplicating saved comments',async()=>{
  const worker=await harness();worker.state.failAnnotationAt=2;
  const partial=await bulk(worker,['finding-1','finding-2','finding-3']);
  assert.equal(partial.acceptedCount,1);assert.equal(partial.review.count,1);assert.equal(partial.partial,true);
  assert.equal(partial.failures[0].suggestionId,'finding-2');assert.match(partial.failures[0].error,/Annotation failed/);
  assert.deepEqual(Array.from(partial.batch.suggestions,item=>item.id),['finding-2','finding-3']);
  worker.state.failAnnotationAt=0;
  const retried=await bulk(worker,['finding-1','finding-2','finding-3']);
  assert.equal(retried.acceptedCount,2);assert.equal(retried.skippedCount,1);assert.equal(retried.review.count,3);
  assert.equal(new Set(worker.state.comments.map(item=>item.ai.suggestionId)).size,3);
});

test('failure after atomic comment save reports the committed comment and a retry repairs status only',async()=>{
  const worker=await harness();worker.state.failBatchWrite=true;
  const partial=await bulk(worker);
  assert.equal(partial.acceptedCount,1);assert.equal(partial.review.count,1);assert.equal(partial.partial,true);
  assert.equal(partial.batch.suggestions.length,3);
  const retried=await bulk(worker);
  assert.equal(retried.acceptedCount,1);assert.equal(retried.review.count,2);assert.equal(worker.state.annotations,2);
  assert.equal(worker.state.comments.length,2);assert.equal(retried.batch.suggestions[0].id,'finding-3');
});

test('bulk acceptance shares the queue with individual acceptance and dismissal',async()=>{
  const worker=await harness();worker.state.annotationGate=deferred();
  const accepting=bulk(worker,['finding-1']);
  await new Promise(setImmediate);
  const individual=worker.send('ACCEPT_AI_SUGGESTION',{batchId:'batch',suggestionId:'finding-2'});
  const dismissing=worker.send('DISMISS_AI_SUGGESTION',{batchId:'batch',suggestionId:'finding-3'});
  assert.equal(worker.state.annotations,1);
  worker.state.annotationGate.resolve();
  await Promise.all([accepting,individual,dismissing]);
  assert.equal(worker.state.comments.length,2);
  assert.deepEqual(worker.state.drafts.get('batch').aiBatch.suggestions.map(item=>item.status),['accepted','accepted','dismissed']);
  const result=await bulk(worker,['finding-1','finding-2','finding-3']);
  assert.equal(result.acceptedCount,0);assert.equal(result.skippedCount,3);
});

test('a replaced session cannot receive an old batch or saved suggestion after annotation',async()=>{
  const worker=await harness();worker.state.annotationGate=deferred();
  const accepting=bulk(worker);
  await new Promise(setImmediate);
  worker.setSession({...worker.current,id:'replacement',reviewId:'other-review',aiBatchId:'other-batch'});
  worker.state.annotationGate.resolve();
  const result=await accepting;
  assert.equal(result.partial,true);assert.equal(result.batch,null);assert.equal(result.review.id,'review');assert.equal(result.acceptedCount,0);
  assert.equal(worker.state.comments.length,0);assert.equal(worker.lockCount(),0);
});

test('queued acceptance blocks screenshot capture, recording and AI start without provider requests',async()=>{
  const worker=await harness();worker.state.annotationGate=deferred();
  const accepting=bulk(worker);
  await new Promise(setImmediate);
  await assert.rejects(worker.send('CAPTURE_COMMENT'),/suggestions to finish saving/);
  await assert.rejects(worker.send('START_RECORDING'),/AI review action to finish/);
  await assert.rejects(worker.runAIReview({}),/AI review action to finish/);
  await assert.rejects(worker.handle({type:'DELETE_REVIEW',reviewId:'review'},{url:'chrome-extension://test/report.html'}),/AI review action before deleting/);
  worker.state.annotationGate.resolve();await accepting;
  assert.equal(worker.state.captures,0);assert.equal(worker.state.providerCalls,0);assert.equal(worker.lockCount(),0);
});

test('bulk acceptance rejects an in-progress capture or provider request',async()=>{
  const worker=await harness();worker.setEvidenceBusy(true);
  await assert.rejects(bulk(worker),/capture or recording to finish/);
  worker.setEvidenceBusy(false);worker.setAIJob({});
  await assert.rejects(bulk(worker),/current AI review to finish/);
  assert.equal(worker.state.comments.length,0);assert.equal(worker.lockCount(),0);
});

test('a dismissal whose batch read overlaps session replacement cannot update the old batch',async()=>{
  const worker=await harness();worker.state.batchReadGate=deferred();
  const dismissing=worker.send('DISMISS_AI_SUGGESTION',{batchId:'batch',suggestionId:'finding-1'});
  await new Promise(setImmediate);
  worker.setSession({...worker.current,id:'replacement',reviewId:'other-review',aiBatchId:'other-batch'});
  worker.state.batchReadGate.resolve();
  await assert.rejects(dismissing,/replaced or its review has ended/);
  assert.equal(worker.state.drafts.get('batch').aiBatch.suggestions[0].status,'pending');
  assert.equal(worker.lockCount(),0);
});


test('acceptance crops an explicit prototype region using its own viewport, never production coordinates', async()=>{
  const worker=await harness();
  const batch=worker.state.drafts.get('batch');
  batch.context.prototype={url:'http://localhost/prototype',viewport:{width:800,height:600},scroll:{x:0,y:30}};
  batch.aiBatch.suggestions[0].prototypeRegion={x:0.5,y:0.1,width:0.2,height:0.25};
  await bulk(worker,['finding-1']);
  assert.equal(worker.state.annotations,2);
  const [current,reference]=worker.state.annotationMessages;
  assert.equal(current.selection.rect.viewport.x,100);
  assert.equal(reference.selection.rect.viewport.x,400);
  assert.equal(reference.selection.rect.viewport.y,60);
  assert.equal(reference.selection.rect.viewport.width,160);
  assert.equal(reference.selection.rect.viewport.height,150);
  assert.equal(reference.dataUrl,batch.evidence.prototype.dataUrl);
  assert.equal(worker.state.comments[0].evidence.prototype.annotatedDataUrl,'data:image/png;base64,YW5ub3RhdGVk');
  assert.equal(worker.state.providerCalls,0);assert.equal(worker.state.captures,0);
});

test('unknown reference bounds preserve the whole prototype without a fabricated crop', async()=>{
  for(const value of [undefined,null]){
    const worker=await harness();const batch=worker.state.drafts.get('batch');
    batch.context.prototype={viewport:{width:800,height:600},scroll:{x:0,y:0}};
    if(value!==undefined)batch.aiBatch.suggestions[0].prototypeRegion=value;
    await bulk(worker,['finding-1']);
    assert.equal(worker.state.annotations,1);
    assert.deepEqual(worker.state.comments[0].evidence.prototype,batch.evidence.prototype);
    assert.equal(worker.state.comments[0].evidence.prototype.cropDataUrl,undefined);
  }
});

test('reference annotation failure leaves the suggestion pending without a half-saved comment', async()=>{
  const worker=await harness();const batch=worker.state.drafts.get('batch');
  batch.context.prototype={viewport:{width:800,height:600},scroll:{x:0,y:0}};
  batch.aiBatch.suggestions[0].prototypeRegion={x:0.2,y:0.1,width:0.3,height:0.2};
  worker.state.failAnnotationAt=2;
  const result=await bulk(worker,['finding-1']);
  assert.equal(result.acceptedCount,0);assert.equal(result.partial,true);
  assert.equal(worker.state.comments.length,0);
  assert.equal(worker.state.drafts.get('batch').aiBatch.suggestions[0].status,'pending');
  worker.state.failAnnotationAt=0;
  const retry=await bulk(worker,['finding-1']);
  assert.equal(retry.acceptedCount,1);assert.equal(worker.state.comments.length,1);
});
