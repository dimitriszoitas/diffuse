import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import {createGitHubWorker,canonicalPullUrl,isGitHubRequest} from '../extension/github-worker.mjs';
import {formatGitHubSummary} from '../extension/github-format.mjs';
import {createReviewBundle,parseReviewBundle} from '../extension/review-transfer.mjs';
import {cleanPRContext,mergePRReview} from '../extension/pr-review.mjs';
const clone=value=>structuredClone(value),sha='a'.repeat(40),next='b'.repeat(40),date='2026-10-18T12:00:00.000Z',old='2026-10-17T12:00:00.000Z';
const reviewId='11111111-1111-4111-8111-111111111111',reviewKey='22222222-2222-4222-8222-222222222222',remoteId='33333333-3333-4333-8333-333333333333',connectionId='44444444-4444-4444-8444-444444444444';
const findingKeys=['55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'];
const png='data:image/png;base64,aW1hZ2U=',url='https://github.com/Team/Prototype/pull/42',previewUrl='https://preview.example.test/';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
 const comments=findingKeys.map((findingKey,index)=>({id:`local-${index}`,reviewId,findingKey,createdAt:old,updatedAt:old,mode:'audit',fields:{comment:`Saved feedback ${index}`,expected:'Keep the action visible.',state:'Current state',severity:'major',category:'ux-issue'},context:{production:{url:`${previewUrl}page-${index}`,viewport:{width:390,height:844},viewportProfile:{key:'phone',mode:'preset'},scroll:{x:0,y:0}}},selection:null,evidence:{production:{dataUrl:png,width:390,height:844,capturedAt:old}}}));
 return {id:reviewId,reviewKey,title:'Shared prototype feedback',productionUrl:previewUrl,createdAt:old,updatedAt:old,mode:'audit',count:comments.length,comments};
}
function harness() {
 let clock=Date.parse(date),local=fixture(),remoteBundle=null,revision=0,prepare=null,events=new Map();
 const saved={},drafts=new Map(),calls=[],writes=[],opened=[],captures=[];
 const server={pull:{owner:'Team',repo:'Prototype',number:42,url,headSha:sha,private:false,canWrite:true},login:'publisher',author:'publisher',assets:0,uploaded:0,waiting:false,unknownPublish:false,unknownEvent:false,summaryUpdated:true,chunkOverride:null,metadataOverride:null,chunkError:false};
 const chunks=new Map(),metadata=()=>({id:remoteId,reviewKey,revision,pullUrl:url,author:{login:server.author,name:'Publisher'},title:local.title,commentUrl:revision?url+'#issuecomment-123':null});
 const storage={async get(key){return key===null?clone(saved):{[key]:clone(saved[key])};},async set(values){Object.assign(saved,clone(values));},async remove(key){delete saved[key];}};
 const store={
  async getReview(id){assert.equal(id,reviewId);return clone(local);},async ensureReviewIdentities(id){return this.getReview(id);},
  async setPRReviewContext(id,context){assert.equal(id,reviewId);local.prContext=cleanPRContext({...context,sourcePreviewUrl:local.prContext?.sourcePreviewUrl||local.productionUrl});return clone(local);},
  async setPRRemoteBinding(id,binding){assert.equal(id,reviewId);local.prRemote=clone(binding);return clone(local);},
  async mergePRReviewBundle(bundle,options){writes.push({bundle:clone(bundle),options:clone(options)});local=mergePRReview(local,parseReviewBundle(bundle).review,{now:date});return clone(local);},
  async putDraft(draft){drafts.set(draft.id,clone(draft));},async getDraft(id){return clone(drafts.get(id));},async discardDraft(id){drafts.delete(id);}
 };
 const client={async refresh(id){assert.equal(id,connectionId);return {id,login:server.login,displayName:'Publisher'};},async request(id,path,options={}){
  assert.equal(id,connectionId);const body=options.body;calls.push({path,body:clone(body),method:options.method||'GET'});
  if(path.startsWith('/github/v1/pull?'))return {pull:clone(server.pull)};
  if(path.startsWith('/github/v1/reviews?'))return {pull:clone(server.pull),reviews:revision?[metadata()]:[]};
  if(path==='/github/v1/reviews/prepare'){
   assert.equal(body.expectedRevision,revision);prepare=clone(body);chunks.clear();return {id:remoteId,revision,chunkSize:512*1024,received:[]};
  }
  if(path===`/github/v1/reviews/${remoteId}/chunks`){
   const value=Buffer.from(body.dataBase64,'base64');chunks.set(body.index,value);
   if(server.chunkError){server.chunkError=false;throw new Error('Lost chunk response');}return {received:body.index};
  }
  if(path===`/github/v1/reviews/${remoteId}/publish`){
   if(server.waiting)return {done:false,waiting:true,review:metadata()};
   if(server.uploaded<server.assets){server.uploaded++;return {done:false,uploadedAssets:server.uploaded,totalAssets:server.assets,review:metadata()};}
   if(prepare){const bytes=Buffer.concat([...chunks.entries()].sort((a,b)=>a[0]-b[0]).map(([,bytes])=>bytes));assert.equal(bytes.length,prepare.byteLength);assert.equal(digest(bytes),prepare.sha256);remoteBundle=JSON.parse(bytes);revision++;prepare=null;}
   if(server.unknownPublish){server.unknownPublish=false;throw new Error('Connection ended after publication');}
   return {done:true,review:metadata()};
  }
  if(path===`/github/v1/reviews/${remoteId}/events`){
   let event=events.get(body.id);
   if(!event){event={id:body.id,buildSha:body.buildSha,previewUrl:body.previewUrl,status:body.status,reviewer:{login:server.login},checkedAt:new Date(clock).toISOString(),note:body.note,...(body.evidence?{evidence:clone(body.evidence)}:{})};events.set(body.id,event);revision++;const item=remoteBundle.review.comments.find(item=>item.findingKey===body.findingKey);item.verifications=[...(item.verifications||[]),clone(event)];}
   if(server.unknownEvent){server.unknownEvent=false;throw new Error('Connection ended after status save');}
   return {event:clone(event),review:metadata(),summaryUpdated:server.summaryUpdated};
  }
  if(path===`/github/v1/reviews/${remoteId}`){
   const bytes=Buffer.from(JSON.stringify(remoteBundle)),result={review:metadata(),byteLength:bytes.length,chunkCount:Math.ceil(bytes.length/(512*1024)),chunkSize:512*1024,sha256:digest(bytes)};return server.metadataOverride?server.metadataOverride(result):result;
  }
  const chunk=path.match(new RegExp(`/reviews/${remoteId}/chunks/(\\d+)$`));
  if(chunk){const index=Number(chunk[1]),bytes=Buffer.from(JSON.stringify(remoteBundle)),part={revision,index,dataBase64:bytes.subarray(index*512*1024,(index+1)*512*1024).toString('base64')};return server.chunkOverride?server.chunkOverride(part):part;}
  throw new Error(`Unexpected request: ${path}`);
 }};
 const worker=(options={})=>createGitHubWorker({client,store,storage,formatSummary:formatGitHubSummary,openReview:async message=>{opened.push(clone(message));return {ok:true,tabId:8};},captureVerification:async input=>{captures.push(clone(input));return {dataUrl:png,width:390,height:844,capturedAt:new Date(clock).toISOString(),pageUrl:input.comment.context.production.url};},cryptoApi:webcrypto,now:()=>clock,...options});
 const message={connectionId,reviewId,commentIds:['local-0'],prUrl:url,previewUrl};
 const approve=async instance=>{const response=await instance.handle({type:'GITHUB_PREVIEW',...message});return {...message,type:'GITHUB_PUBLISH',expectedHeadSha:response.preview.pull.headSha,expectedRevision:response.preview.expectedRevision,previewToken:response.previewToken,previewDigest:response.previewDigest};};
 const proof=async message=>({...message,proofToken:(await worker().handle({...message,type:'GITHUB_CAPTURE_PROOF'})).proofToken});
 const seedRemote=()=>{local.prContext=cleanPRContext({...server.pull,previewUrl,sourcePreviewUrl:previewUrl});revision=1;remoteBundle=createReviewBundle(local,{now:date});local.prRemote={remoteReviewId:remoteId,remoteRevision:1,connectionId,commentUrl:metadata().commentUrl};};
 return {worker,approve,proof,message,client,storage,store,server,calls,writes,opened,captures,saved,drafts,chunks,seedRemote,metadata,get local(){return local;},get remoteBundle(){return remoteBundle;},get events(){return events;},setClock(value){clock=value;},advance(ms){clock+=ms;}};
}

test('canonical GitHub responses accept owner/repo case changes and reject unrelated repositories',async()=>{
 const h=harness(),worker=h.worker();
 const result=await worker.handle({type:'GITHUB_GET_PR',connectionId,url:'https://github.com/team/prototype/pull/42'});assert.equal(result.pull.url,url);
 h.server.pull={...h.server.pull,repo:'Other',url:'https://github.com/Team/Other/pull/42'};
 await assert.rejects(worker.handle({type:'GITHUB_GET_PR',connectionId,url}),/unexpected/);
 for(const bad of ['https://evil.test/Team/Prototype/pull/42','https://github.com/Team/Prototype/pull/42?token=bad','https://github.com/Team/Prototype/pull/42#comment'])assert.throws(()=>canonicalPullUrl(bad));
 assert.equal(isGitHubRequest('GITHUB_PUBLICATION_STATUS'),true);assert.equal(isGitHubRequest('GITHUB_SYNC_SUMMARY'),true);
});

test('publication uses only selected trusted saved findings and preview displays authenticated author',async()=>{
 const h=harness(),worker=h.worker(),payload=await h.approve(worker);
 const preview=await worker.handle({type:'GITHUB_PREVIEW',...h.message});assert.match(preview.preview.markdown,/Shared by publisher/);assert.equal(preview.preview.author.login,'publisher');assert.equal(preview.preview.canPublish,true);
 const result=await worker.handle({...payload,body:'untrusted comment',bundle:{review:{comments:[]}},evidence:{dataUrl:'bad'},actor:'imposter',commentIds:['local-0','local-1']});
 assert.equal(result.pending,false);assert.equal(h.remoteBundle.review.comments.length,1);assert.equal(h.remoteBundle.review.comments[0].fields.comment,'Saved feedback 0');assert.equal(h.remoteBundle.review.comments[0].findingKey,findingKeys[0]);
 assert.ok(!JSON.stringify(h.remoteBundle).includes('imposter'));assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,1);
 assert.ok(!JSON.stringify(h.saved).includes(png),'Chrome metadata storage must never contain screenshots or bundles');
});

test('expired approval, changed findings, changed PR head and wrong digest prevent all publication writes',async()=>{
 for(const mutate of [async(h)=>h.advance(11*60*1000),async(h)=>{h.local.comments[0].fields.comment='Changed after preview';},async(h)=>{h.server.pull.headSha=next;},async(h,payload)=>{payload.previewDigest='0'.repeat(64);}]){
  const h=harness(),worker=h.worker(),payload=await h.approve(worker);await mutate(h,payload);
  await assert.rejects(worker.handle(payload),/preview|changed|publishing/i);assert.equal(h.calls.filter(c=>c.method==='POST').length,0);
 }
});

test('recipient and read-only accounts can preview but cannot overwrite the original publisher summary',async()=>{
 for(const change of ['recipient','readonly']){
  const h=harness();h.seedRemote();if(change==='recipient')h.server.login='recipient';else h.server.pull.canWrite=false;
  const worker=h.worker(),preview=await worker.handle({type:'GITHUB_PREVIEW',...h.message});assert.equal(preview.preview.canPublish,false);assert.equal(preview.preview.author.login,'publisher');
  await assert.rejects(worker.handle({...h.message,type:'GITHUB_PUBLISH',expectedHeadSha:sha,expectedRevision:1,previewToken:preview.previewToken,previewDigest:preview.previewDigest}),/original publisher/);assert.equal(h.calls.filter(c=>c.method==='POST').length,0);
 }
});

test('durable transfer receipt survives uncertain publication and worker restart without preparing or creating again',async()=>{
 const h=harness(),first=h.worker(),payload=await h.approve(first);h.server.unknownPublish=true;
 await assert.rejects(first.handle(payload),/Connection ended/);
 const receipt=Object.values(h.saved).find(value=>value.id===remoteId);assert.equal(receipt.phase,'publish');assert.equal(receipt.exportedAt,date);assert.equal(h.metadata().revision,1);
 h.server.pull.headSha=next;h.advance(20*60*1000);
 const restarted=h.worker(),status=await restarted.handle({type:'GITHUB_PUBLICATION_STATUS',reviewId,connectionId});assert.equal(status.pending,true);assert.deepEqual(status.resume,payload);
 const result=await restarted.handle(status.resume);assert.equal(result.pending,false);assert.equal(h.metadata().revision,1);
 assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/publish')).length,2);
 assert.equal((await restarted.handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).pending,false);
});

test('receipt is stored before chunk writes and chunk retry reconstructs identical exportedAt bytes after restart',async()=>{
 const h=harness();h.local.comments[0].evidence.production.dataUrl='data:image/png;base64,'+Buffer.alloc(500000,1).toString('base64');
 const worker=h.worker({maxOperations:1}),payload=await h.approve(worker),first=await worker.handle(payload);assert.equal(first.pending,true);assert.equal(h.chunks.size,0);
 const receipt=Object.values(h.saved).find(item=>item.id===remoteId);assert.equal(receipt.phase,'upload');assert.equal(receipt.exportedAt,date);
 h.advance(20000);h.server.chunkError=true;
 await assert.rejects(h.worker().handle(payload),/Lost chunk/);assert.equal(h.chunks.size,1);
 const result=await h.worker().handle(payload);assert.equal(result.pending,false);assert.equal(h.remoteBundle.exportedAt,date);assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,1);
 assert.ok(!JSON.stringify(h.saved).includes('data:image'));
});

test('waiting yields immediately and 250 evidence assets complete across bounded resumed runs',async()=>{
 const h=harness(),worker=h.worker({maxOperations:300}),payload=await h.approve(worker);h.server.waiting=true;
 const waiting=await worker.handle(payload);assert.equal(waiting.pending,true);assert.equal(waiting.progress.waiting,true);assert.equal(h.calls.filter(c=>c.path.endsWith('/publish')).length,1);
 h.server.waiting=false;h.server.assets=250;let result,runs=0;
 do{const before=h.calls.filter(c=>c.method==='POST').length;result=await h.worker({maxOperations:12}).handle(payload);const after=h.calls.filter(c=>c.method==='POST').length;assert.ok(after-before<=12);runs++;assert.ok(runs<30);}while(result.pending);
 assert.equal(h.server.uploaded,250);assert.equal(h.metadata().revision,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,1);
});

test('wrong-PR loads and corrupt or mixed-revision chunks never mutate local reviews or open a page',async()=>{
 for(const damage of ['wrong-pr','revision','index','hash','length']){
  const h=harness();h.seedRemote();
  if(damage==='wrong-pr')h.server.metadataOverride=result=>({...result,review:{...result.review,pullUrl:'https://github.com/Other/Repo/pull/42'}});
  if(damage==='revision')h.server.chunkOverride=part=>({...part,revision:part.revision+1});
  if(damage==='index')h.server.chunkOverride=part=>({...part,index:part.index+1});
  if(damage==='hash')h.server.metadataOverride=result=>({...result,sha256:'0'.repeat(64)});
  if(damage==='length')h.server.chunkOverride=part=>({...part,dataBase64:Buffer.from('wrong').toString('base64')});
  await assert.rejects(h.worker().handle({type:'GITHUB_LOAD',connectionId,prUrl:url,remoteReviewId:remoteId,previewUrl,expectedHeadSha:sha}),/different|changed|invalid/);
  assert.equal(h.writes.length,0);assert.equal(h.opened.length,0);
 }
});

test('a valid received review is authenticated, integrity checked and opened on the chosen preview',async()=>{
 const h=harness();h.seedRemote();const result=await h.worker().handle({type:'GITHUB_LOAD',connectionId,prUrl:'https://github.com/team/prototype/pull/42',remoteReviewId:remoteId,previewUrl:'https://next.example.test',expectedHeadSha:sha});
 assert.equal(result.reviewId,reviewId);assert.equal(h.writes.length,1);assert.equal(h.local.prContext.previewUrl,'https://next.example.test/');assert.deepEqual(h.opened,[{reviewId}]);
});

test('uncertain verification reuses its event id and exact captured evidence after worker restart',async()=>{
 const h=harness();h.seedRemote();h.server.unknownEvent=true;
 const message=await h.proof({type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'verified',note:'Checked phone layout.',previewUrl,expectedHeadSha:sha,expectedRevision:1,evidence:{dataUrl:'untrusted'},reviewer:{login:'imposter'}});
 await assert.rejects(h.worker().handle(message),/Connection ended/);assert.equal(h.captures.length,1);assert.equal(h.events.size,1);assert.equal(h.drafts.size,1);
 const first=h.calls.find(c=>c.path.endsWith('/events')).body;assert.equal(first.evidence.dataUrl,png);assert.equal(first.reviewer,undefined);assert.ok(!JSON.stringify(h.saved).includes(png));
 h.advance(60000);h.server.pull.headSha=next;
 const result=await h.worker().handle(message);assert.equal(result.summaryUpdated,true);assert.equal(h.captures.length,1);assert.equal(h.events.size,1);assert.equal(h.drafts.size,0);
 const posts=h.calls.filter(c=>c.path.endsWith('/events'));assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(h.local.comments[0].verifications[0].reviewer.login,'publisher');
});

test('saved status with stale GitHub summary is surfaced and same-id summary retry does not append another event',async()=>{
 const h=harness();h.seedRemote();h.server.summaryUpdated=false;
 const message=await h.proof({type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'ready-for-recheck',note:'Adjusted spacing.',previewUrl,expectedHeadSha:sha,expectedRevision:1});
 const result=await h.worker().handle(message);assert.equal(result.summaryUpdated,false);assert.equal(h.events.size,1);assert.equal(h.captures.length,1);
 assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).summaryPending,true);
 h.server.summaryUpdated=true;h.server.pull.headSha=next;
 const retry=await h.worker().handle({type:'GITHUB_SYNC_SUMMARY',reviewId,connectionId});assert.equal(retry.summaryUpdated,true);assert.equal(h.events.size,1);assert.equal(h.drafts.size,0);
 assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).summaryPending,false);
 const ids=h.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.body.id);assert.equal(new Set(ids).size,1);
});

test('pending publication bypasses mutable previews and requires its original account',async()=>{
 const h=harness(),payload=await h.approve(h.worker());h.server.unknownPublish=true;
 await assert.rejects(h.worker().handle(payload),/Connection ended/);
 h.local.comments[0].fields.comment='Edited locally after publication';h.server.pull.headSha=next;
 const before=h.calls.length,response=await h.worker().handle({type:'GITHUB_PREVIEW',...h.message});
 assert.equal(response.requiresResume,true);assert.equal(response.pending,true);assert.deepEqual(response.resume,payload);assert.equal(h.calls.length,before);
 await assert.rejects(h.worker().handle({type:'GITHUB_PREVIEW',...h.message,connectionId:randomUUID()}),/original publishing account/);
});

test('opening a finding updates its commit association and rejects a stale displayed build',async()=>{
 const h=harness();h.seedRemote();h.server.pull.headSha=next;
 await assert.rejects(h.worker().handle({type:'GITHUB_OPEN_FINDING',reviewId,connectionId,commentId:'local-0',expectedHeadSha:sha,previewUrl:'https://new.example.test/'}),/changed/);
 assert.equal(h.opened.length,0);assert.equal(h.local.prContext.headSha,sha);
 await h.worker().handle({type:'GITHUB_OPEN_FINDING',reviewId,connectionId,commentId:'local-0',expectedHeadSha:next,previewUrl:'https://new.example.test/'});
 assert.equal(h.local.prContext.headSha,next);assert.equal(h.local.prContext.previewUrl,'https://new.example.test/');assert.deepEqual(h.opened,[{reviewId,commentId:'local-0'}]);
});

test('unfinished checks remain explicitly recoverable without resetting a newer chosen preview',async()=>{
 const h=harness();h.seedRemote();h.server.unknownEvent=true;
 await assert.rejects(h.worker().handle(await h.proof({type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'ready-for-recheck',previewUrl,expectedHeadSha:sha})),/Connection ended/);
 const status=await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId,connectionId});assert.equal(status.summaryPending,true);assert.equal(status.eventState,'sending');assert.match(status.eventMessage,/needs confirmation/);
 h.local.prContext={...h.local.prContext,headSha:next,previewUrl:'https://new.example.test/'};
 await h.worker().handle({type:'GITHUB_SYNC_SUMMARY',reviewId,connectionId});assert.equal(h.local.prContext.headSha,next);assert.equal(h.local.prContext.previewUrl,'https://new.example.test/');
});

test('definitively rejected stale staging can be replaced, while unknown publication keeps its receipt',async()=>{
 const h=harness(),payload=await h.approve(h.worker());await h.worker({maxOperations:1}).handle(payload);h.server.pull.headSha=next;
 await assert.rejects(h.worker().handle(payload),/changed/);assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).pending,false);
 const nextPayload=await h.approve(h.worker()),request=h.client.request.bind(h.client);
 h.client.request=async(id,path,options)=>{if(path.endsWith('/publish'))throw Object.assign(new Error('Changed before send'),{code:'preview_changed'});return request(id,path,options);};
 await assert.rejects(h.worker().handle(nextPayload),/Changed before send/);assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).pending,false);
});

test('approved previews stay bounded without deleting an in-progress publication approval',async()=>{
 const h=harness(),payload=await h.approve(h.worker());await h.worker({maxOperations:1}).handle(payload);
 for(let i=0;i<25;i++)h.saved[`diffuseGitHubApprovalV1:${randomUUID()}`]={expiresAt:Date.parse(date)+i,payload:{}};
 // A new local review's approval is independent of the existing in-progress one.
 const pendingKey=`diffuseGitHubPublishV1:${reviewId}`,receipt=h.saved[pendingKey];delete h.saved[pendingKey];h.saved['diffuseGitHubPublishV1:another-review']=receipt;
 await h.worker().handle({type:'GITHUB_PREVIEW',...h.message});
 assert.ok(h.saved[`diffuseGitHubApprovalV1:${payload.previewToken}`]);assert.ok(Object.keys(h.saved).filter(key=>key.startsWith('diffuseGitHubApprovalV1:')).length<=21);
});

test('confirmed publication survives a failed local binding save without posting again',async()=>{
 const h=harness(),payload=await h.approve(h.worker()),save=h.store.setPRRemoteBinding;
 h.store.setPRRemoteBinding=async()=>{throw new Error('Local storage temporarily unavailable');};
 await assert.rejects(h.worker().handle(payload),/Local storage/);assert.equal(h.metadata().revision,1);
 const status=await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId,connectionId});assert.equal(status.pending,true);
 h.store.setPRRemoteBinding=save;
 const result=await h.worker().handle(status.resume);assert.equal(result.pending,false);assert.equal(h.local.prRemote.remoteRevision,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/publish')).length,1);assert.equal(h.calls.filter(c=>c.path.endsWith('/prepare')).length,1);
});

test('late publication confirmation preserves a newer preview selected while waiting',async()=>{
 const h=harness();h.seedRemote();const payload=await h.approve(h.worker());h.server.unknownPublish=true;
 await assert.rejects(h.worker().handle(payload),/Connection ended/);
 h.local.prContext={...h.local.prContext,headSha:next,previewUrl:'https://newer.example.test/'};
 const result=await h.worker().handle(payload);assert.equal(result.pending,false);assert.equal(h.local.prContext.headSha,next);assert.equal(h.local.prContext.previewUrl,'https://newer.example.test/');assert.equal(h.local.prRemote.remoteRevision,2);
});

test('definitively stale publication can be approved again while ambiguous conflicts keep the original receipt',async()=>{
 for(const code of ['review_changed','conflict']){
  const h=harness(),payload=await h.approve(h.worker()),request=h.client.request.bind(h.client);
  h.client.request=async(id,path,options)=>{if(path.endsWith('/publish'))throw Object.assign(new Error('Concurrent review change'),{code});return request(id,path,options);};
  await assert.rejects(h.worker().handle(payload),error=>error.code===code);
  const status=await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId,connectionId});assert.equal(status.pending,code==='conflict');
  if(code==='review_changed'){
   h.client.request=request;const fresh=await h.approve(h.worker());assert.notEqual(fresh.previewToken,payload.previewToken);const result=await h.worker().handle(fresh);assert.equal(result.pending,false);
  }else assert.equal(status.resume.previewToken,payload.previewToken);
 }
});

test('definitively rejected stale check releases its receipt for a fresh explicit check without reusing evidence',async()=>{
 const h=harness();h.seedRemote();const request=h.client.request.bind(h.client);
 h.client.request=async(id,path,options)=>{if(path.endsWith('/events'))throw Object.assign(new Error('Shared review changed'),{code:'review_changed'});return request(id,path,options);};
 const message=await h.proof({type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'verified',previewUrl,expectedHeadSha:sha,expectedRevision:1});
 await assert.rejects(h.worker().handle(message),error=>error.code==='review_changed');assert.equal(h.drafts.size,0);assert.equal(h.captures.length,1);assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId})).summaryPending,false);
 h.client.request=request;h.advance(1000);await h.worker().handle(await h.proof({...message,note:'Checked again after refreshing.'}));assert.equal(h.captures.length,2);assert.equal(h.events.size,1);
});

test('updated proof is inspectable without posting and is required for every proof status',async()=>{
 for(const status of ['ready-for-recheck','verified','still-present']){
  const h=harness();h.seedRemote();const base={type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status,previewUrl,expectedHeadSha:sha};
  await assert.rejects(h.worker().handle({...base,evidence:{dataUrl:png}}),/Capture and preview/);assert.equal(h.captures.length,0);assert.equal(h.events.size,0);
  const proof=await h.worker().handle({...base,type:'GITHUB_CAPTURE_PROOF'});
  assert.equal(proof.evidence.dataUrl,png);assert.ok(proof.proofToken);assert.equal(h.events.size,0);assert.ok(!JSON.stringify(h.saved).includes(png));
  await h.worker().handle({...base,proofToken:proof.proofToken});assert.equal(h.events.size,1);assert.equal(h.drafts.size,0);
 }
});

test('proof cannot be substituted across findings, actors, previews, builds or expired approval',async()=>{
 for(const mutate of [(h,m)=>{m.commentId='local-1';},(h,m)=>{h.server.login='recipient';},(h,m)=>{m.previewUrl='https://another.example.test/';},(h,m)=>{h.server.pull.headSha=next;m.expectedHeadSha=next;},(h,m)=>{h.advance(11*60*1000);},(h,m)=>{m.proofToken=randomUUID();}]){
  const h=harness();h.seedRemote();const message=await h.proof({type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'verified',previewUrl,expectedHeadSha:sha});
  mutate(h,message);await assert.rejects(h.worker().handle(message),/Capture and preview/);assert.equal(h.events.size,0);
 }
});

test('retake invalidates the old proof and cancel removes only its own evidence',async()=>{
 const h=harness();h.seedRemote();const base={connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 const first=await h.worker().handle({...base,type:'GITHUB_CAPTURE_PROOF'}),second=await h.worker().handle({...base,type:'GITHUB_CAPTURE_PROOF'});
 assert.equal(h.drafts.size,1);
 await h.worker().handle({type:'GITHUB_DISCARD_PROOF',connectionId,reviewId,proofToken:first.proofToken});assert.equal(h.drafts.size,1);
 await assert.rejects(h.worker().handle({...base,type:'GITHUB_RECHECK',status:'verified',proofToken:first.proofToken}),/Capture and preview/);
 await h.worker().handle({type:'GITHUB_DISCARD_PROOF',connectionId,reviewId,proofToken:second.proofToken});assert.equal(h.drafts.size,0);assert.equal(h.events.size,0);
});

test('new commit arriving during capture prevents an approvable screenshot',async()=>{
 const h=harness();h.seedRemote();const worker=h.worker({captureVerification:async input=>{h.server.pull.headSha=next;return {dataUrl:png,width:390,height:844,capturedAt:date,pageUrl:input.comment.context.production.url};}});
 await assert.rejects(worker.handle({type:'GITHUB_CAPTURE_PROOF',connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha}),/changed during capture/);
 assert.equal(h.drafts.size,0);assert.equal(h.events.size,0);
});

test('explicit recording restart cancels an old durable receipt after the media process was lost',async()=>{
 const h=harness();h.seedRemote();const mediaCalls=[];
 const captureProofRecording=async input=>{mediaCalls.push(clone(input));return input.action==='start'?{recordingToken:randomUUID()}:{cancelled:true};};
 const start={type:'GITHUB_START_PROOF_RECORDING',connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 const first=await h.worker({captureProofRecording}).handle(start);
 // Restarted worker has only its durable receipt; cancellation tolerates media already gone.
 const second=await h.worker({captureProofRecording}).handle(start);
 assert.notEqual(second.recordingToken,first.recordingToken);
 assert.deepEqual(mediaCalls.map(call=>call.action),['start','cancel','start']);
 assert.equal(mediaCalls[1].recordingToken,first.recordingToken);
 assert.equal(h.saved[`diffuseGitHubRecordingV1:${reviewId}`].recordingToken,second.recordingToken);
 assert.equal(h.events.size,0);
});

test('a recording is cancelled if its receipt cannot be durably saved, including partial storage success',async()=>{
 const h=harness();h.seedRemote();const calls=[],set=h.storage.set;
 const captureProofRecording=async input=>{calls.push(clone(input));return {recordingToken:'recording-fixture-1'};};
 h.storage.set=async values=>{await set(values);if(Object.keys(values).some(key=>key.startsWith('diffuseGitHubRecordingV1:')))throw new Error('Storage write failed');};
 await assert.rejects(h.worker({captureProofRecording}).handle({type:'GITHUB_START_PROOF_RECORDING',connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha}),/Storage write failed/);
 assert.deepEqual(calls.map(call=>call.action),['start','cancel']);assert.equal(calls[1].recordingToken,'recording-fixture-1');
 assert.equal(h.saved[`diffuseGitHubRecordingV1:${reviewId}`],undefined);assert.equal(h.events.size,0);
});

test('Stop clears obsolete recording state even when the PR changes before capture validation',async()=>{
 const h=harness();h.seedRemote();const calls=[];
 const captureProofRecording=async input=>{calls.push(clone(input));return {recordingToken:randomUUID()};};
 const base={connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 const first=await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'});h.server.pull.headSha=next;
 await assert.rejects(h.worker({captureProofRecording}).handle({...base,type:'GITHUB_STOP_PROOF_RECORDING',recordingToken:first.recordingToken}),/pull request changed/);
 assert.deepEqual(calls.map(call=>call.action),['start','cancel']);assert.equal(h.saved[`diffuseGitHubRecordingV1:${reviewId}`],undefined);
 await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING',expectedHeadSha:next});
 assert.equal(calls.at(-1).action,'start');assert.equal(h.events.size,0);
});

test('failed media stop can be retried with a new recording without publishing incomplete evidence',async()=>{
 const h=harness();h.seedRemote();const calls=[];
 const captureProofRecording=async input=>{calls.push(clone(input));if(input.action==='stop')throw new Error('Page changed during recording');return {recordingToken:randomUUID()};};
 const base={connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 const first=await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'});
 await assert.rejects(h.worker({captureProofRecording}).handle({...base,type:'GITHUB_STOP_PROOF_RECORDING',recordingToken:first.recordingToken}),/Page changed/);
 assert.deepEqual(calls.map(call=>call.action),['start','stop','cancel']);assert.equal(h.saved[`diffuseGitHubRecordingV1:${reviewId}`],undefined);
 assert.equal(h.drafts.size,0);assert.equal(h.events.size,0);
 await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'});assert.equal(calls.at(-1).action,'start');
});

test('recording receipts cannot be cancelled by a mismatched token or replaced under another account',async()=>{
 const h=harness();h.seedRemote();const calls=[];
 const captureProofRecording=async input=>{calls.push(clone(input));return {recordingToken:randomUUID()};};
 const base={connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'});
 await assert.rejects(h.worker({captureProofRecording}).handle({...base,type:'GITHUB_STOP_PROOF_RECORDING',recordingToken:randomUUID()}),/different finding or account/);
 h.saved[`diffuseGitHubRecordingV1:${reviewId}`].binding.connectionId='another-connection';
 await assert.rejects(h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'}),/account that started/);
 assert.equal(calls.length,1);assert.ok(h.saved[`diffuseGitHubRecordingV1:${reviewId}`]);
});

test('recorded proof is previewable locally before an explicit shared status and retains video metadata',async()=>{
 const h=harness();h.seedRemote();const captureProofRecording=async input=>input.action==='start'?{recordingToken:randomUUID()}:input.action==='stop'?{dataUrl:'data:video/webm;base64,dmlkZW8=',mimeType:'video/webm',durationMs:1000,width:390,height:844,capturedAt:date,pageUrl:input.comment.context.production.url}:{cancelled:true};
 const base={connectionId,reviewId,commentId:'local-0',previewUrl,expectedHeadSha:sha};
 const first=await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_START_PROOF_RECORDING'});
 const proof=await h.worker({captureProofRecording}).handle({...base,type:'GITHUB_STOP_PROOF_RECORDING',recordingToken:first.recordingToken});
 assert.equal(proof.evidence.durationMs,1000);assert.equal(h.events.size,0);assert.equal(h.saved[`diffuseGitHubRecordingV1:${reviewId}`],undefined);
 assert(!JSON.stringify(h.saved).includes('data:video'));
 await h.worker().handle({...base,type:'GITHUB_RECHECK',status:'ready-for-recheck',proofToken:proof.proofToken});
 assert.equal(h.events.size,1);assert.equal([...h.events.values()][0].evidence.mimeType,'video/webm');assert.equal(h.drafts.size,0);
});

test('definitively expired unsaved proof releases its retry receipt so a fresh capture can be shared',async()=>{
 const h=harness();h.seedRemote();const request=h.client.request.bind(h.client);
 h.client.request=async(id,path,options)=>{if(path.endsWith('/events'))throw Object.assign(new Error('Fresh evidence required'),{code:'needs_evidence'});return request(id,path,options);};
 const base={type:'GITHUB_RECHECK',connectionId,reviewId,commentId:'local-0',status:'verified',previewUrl,expectedHeadSha:sha};
 await assert.rejects(h.worker().handle(await h.proof(base)),error=>error.code==='needs_evidence');
 assert.equal(h.drafts.size,0);assert.equal((await h.worker().handle({type:'GITHUB_PUBLICATION_STATUS',reviewId,connectionId})).eventPending,undefined);
 h.client.request=request;h.advance(1000);await h.worker().handle(await h.proof(base));assert.equal(h.captures.length,2);assert.equal(h.events.size,1);
});
