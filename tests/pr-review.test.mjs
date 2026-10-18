import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPortableKey,cleanPRContext,ensurePortableIdentities,projectReviewToPreview,mapPreviewUrl,createVerification,cleanVerification,cleanVerificationHistory,findingStatus,mergePRReview,cleanPRRemoteBinding,validatePRAttachmentLocation,upsertPRAttachment} from '../extension/pr-review.mjs';
const old='2026-10-18T10:00:00.000Z', now='2026-10-18T11:00:00.000Z', sha='a'.repeat(40), next='b'.repeat(40), png='data:image/png;base64,aW1hZ2U=';
const context=()=>({owner:'dimitriszoitas',repo:'diffuse',number:12,url:'https://github.com/dimitriszoitas/diffuse/pull/12',headSha:sha,previewUrl:'https://preview-new.example.test/',sourcePreviewUrl:'https://preview-old.example.test/',association:'manual'});
const finding=()=>({id:'local-1',findingKey:'portable-finding-1',createdAt:old,fields:{comment:'Make the action readable.'},context:{production:{url:'https://preview-old.example.test/releases/2?tab=activity#note',viewport:{width:390,height:844},scroll:{x:0,y:200}},prototype:{url:'https://design.example.test/release'}},selection:{kind:'element',selector:'#action',context:{url:'https://preview-old.example.test/releases/2?tab=activity#note'}},pinSelection:{kind:'element',selector:'#replacement',context:{url:'https://preview-old.example.test/releases/2?tab=activity#note'}},evidence:{production:{dataUrl:png,capturedAt:old}}});
const fresh=()=>({dataUrl:png,width:1280,height:800,capturedAt:now,pageUrl:'https://preview-new.example.test/releases/2?tab=activity#note'});
const verification=(status='verified')=>({status,reviewer:{login:'reviewer-1',name:'Designer'},note:'Checked the current preview.',evidence:fresh()});

test('persistent review and finding keys are distinct from local IDs and remain stable on repeated use',()=>{
 const source={id:'local-review',comments:[{id:'local-comment'},{id:'local-comment-2'}]},before=structuredClone(source);let n=0;
 const result=ensurePortableIdentities(source,{uuid:()=>`portable-${++n}`});
 assert.deepEqual(result,{...source,reviewKey:'portable-1',comments:[{id:'local-comment',findingKey:'portable-2'},{id:'local-comment-2',findingKey:'portable-3'}]});
 assert.deepEqual(ensurePortableIdentities(result,{uuid:()=>assert.fail('Existing identities must be reused')}),result);
 assert.deepEqual(source,before);
 assert.throws(()=>ensurePortableIdentities({...result,comments:[result.comments[0],result.comments[0]]}),/duplicate/);
 for(const key of ['',{},'x','a'.repeat(129),'../unsafe-key','<script>'])assert.throws(()=>cleanPortableKey(key),/identifier/);
});

test('PR bindings use exact GitHub PR URLs and full commit IDs, with explicitly manual preview provenance',()=>{
 const value=cleanPRContext({...context(),token:'secret',accountId:'secret',headSha:sha.toUpperCase(),previewUrl:'https://preview-new.example.test/?tab=1&access_token=secret#details'});
 assert.equal(value.headSha,sha);assert.equal(value.association,'manual');assert.equal(value.token,undefined);assert.equal(value.accountId,undefined);
 assert.equal(value.previewUrl,'https://preview-new.example.test/?tab=1#details');
 for(const override of [{owner:'../other'},{repo:'../other'},{number:'12'},{number:0},{headSha:'abc123'},{headSha:'HEAD'},{url:'https://github.com/another/repo/pull/12'},{association:'automatic'},{previewUrl:'javascript:alert(1)'},{previewUrl:'https://user:pass@example.test'},{sourcePreviewUrl:'file:///tmp/index.html'}]) assert.throws(()=>cleanPRContext({...context(),...override}));
 assert.equal(cleanPRContext({...context(),headSha:'c'.repeat(64)}).headSha.length,64);
});

test('new preview projection preserves path, query, hash and viewport without rewriting original evidence or cross-origin findings',()=>{
 const source={reviewKey:'portable-review',productionUrl:'https://preview-old.example.test/releases?sort=date',prototypeUrl:'https://design.example.test/',comments:[finding(),{...finding(),findingKey:'portable-finding-2',context:{production:{url:'https://external.example.test/unrelated'}}}]};
 const before=structuredClone(source),projected=projectReviewToPreview(source,context());
 assert.equal(projected.productionUrl,'https://preview-new.example.test/releases?sort=date');
 const item=projected.comments[0];
 assert.equal(item.context.production.url,fresh().pageUrl);assert.equal(item.selection.context.url,fresh().pageUrl);assert.equal(item.pinSelection.context.url,fresh().pageUrl);
 assert.deepEqual(item.context.production.viewport,source.comments[0].context.production.viewport);assert.deepEqual(item.context.production.scroll,{x:0,y:200});
 assert.deepEqual(item.evidence,source.comments[0].evidence);assert.equal(item.context.prototype.url,'https://design.example.test/release');
 assert.equal(projected.comments[1].context.production.url,'https://external.example.test/unrelated');
 assert.deepEqual(source,before);assert.equal(projected.prototypeUrl,source.prototypeUrl);
 assert.equal(mapPreviewUrl('https://old.test/page?view=1#end','https://old.test/start','https://new.test/other'),'https://new.test/page?view=1#end','Mapping swaps the selected origin, not an inferred application base path');
 assert.equal(mapPreviewUrl('https://old.test.evil/page','https://old.test','https://new.test'),'https://old.test.evil/page');
});

test('recipient and reviewer statuses require fresh proof without turning a reported fix into verification',()=>{
 const comment=finding(),input=verification();
 const record=createVerification(input,{comment,context:context(),now,uuid:()=> 'verification-1'});
 assert.equal(record.buildSha,sha);assert.equal(record.status,'verified');assert.equal(record.checkedAt,now);assert.equal(record.reviewer.login,'reviewer-1');
 assert.equal(comment.verifications,undefined);assert.equal(input.id,undefined);
 const ready=createVerification({status:'ready-for-recheck',reviewer:{login:'recipient'},note:'Changed the primary action.',evidence:fresh()},{comment,context:context(),now,uuid:()=> 'verification-2'});
 assert.deepEqual(ready.evidence,fresh());assert.equal(findingStatus({...comment,verifications:[ready]},context()),'ready-for-recheck');
 assert.throws(()=>createVerification({status:'verified',reviewer:{login:'recipient'}},{comment,context:context(),now}),/fresh screenshot/);
});

test('new ready and still-present claims require proof while legacy note-only history remains readable',()=>{
 for(const status of ['ready-for-recheck','still-present','verified'])assert.throws(()=>createVerification({status,reviewer:{login:'recipient'}},{comment:finding(),context:context(),now}),/fresh screenshot/);
 for(const status of ['ready-for-recheck','still-present'])assert.equal(cleanVerification({id:'legacy-event-1',buildSha:sha,previewUrl:context().previewUrl,status,reviewer:{login:'recipient'},checkedAt:old}).evidence,undefined);
 assert.equal(createVerification({status:'needs-remap',reviewer:{login:'recipient'}},{comment:finding(),context:context(),now}).status,'needs-remap');
});
test('a short recording can prove a reported fix or reviewer verdict, with route and capture time preserved',()=>{
 const clip={...fresh(),dataUrl:'data:video/webm;codecs=vp9;base64,dmlkZW8=',mimeType:'video/webm;codecs=vp9',durationMs:30000};
 for(const status of ['ready-for-recheck','verified','still-present']) {
   const record=createVerification({...verification(status),evidence:clip},{comment:finding(),context:context(),now});
   assert.equal(record.evidence.kind,'recording');assert.equal(record.evidence.durationMs,30000);assert.equal(record.evidence.mimeType,clip.mimeType);
   assert.equal(record.evidence.pageUrl,fresh().pageUrl);assert.equal(record.status,status);
   assert.deepEqual(cleanVerification({...record,evidence:{...record.evidence,accessToken:'secret'}}),record);
 }
 for(const change of [{durationMs:30001},{durationMs:0},{durationMs:1.5},{durationMs:undefined},{mimeType:'video/mp4'},{kind:'screenshot'},{dataUrl:'data:video/avi;base64,dmlkZW8='},{capturedAt:old},{pageUrl:'https://preview-new.example.test/other'}])assert.throws(()=>createVerification({...verification(),evidence:{...clip,...change}},{comment:finding(),context:context(),now}));
 const mp4=createVerification({...verification(),evidence:{...clip,dataUrl:'data:video/mp4;base64,dmlkZW8=',mimeType:'video/mp4',durationMs:1000}},{comment:finding(),context:context(),now});assert.equal(mp4.evidence.mimeType,'video/mp4');
 assert.throws(()=>createVerification({...verification(),evidence:{...fresh(),durationMs:1000}},{comment:finding(),context:context(),now}));
});

test('verification cannot reuse old evidence, verify another page, trust a short SHA or accept a stale build',()=>{
 for(const override of [{capturedAt:old},{capturedAt:'2026-10-18T10:54:00Z'},{capturedAt:'2026-10-18T11:01:00Z'},{pageUrl:'https://preview-new.example.test/wrong-page'},{pageUrl:'https://external.example.test/releases/2'},{dataUrl:'https://images.example.test/screenshot.png'},{dataUrl:'data:image/svg+xml;base64,aW1hZ2U='},{width:0},{height:Infinity}]) {
   assert.throws(()=>createVerification({...verification(),evidence:{...fresh(),...override}},{comment:finding(),context:context(),now}));
 }
 assert.throws(()=>createVerification({...verification(),buildSha:next},{comment:finding(),context:context(),now}),/selected build/);
 assert.throws(()=>createVerification({...verification(),reviewer:{login:'<script>'}},{comment:finding(),context:context(),now}),/who checked/);
 assert.throws(()=>createVerification({...verification(),status:'fixed'},{comment:finding(),context:context(),now}),/status/);
});

test('history retains each actor and build while new commits or preview addresses require a recheck',()=>{
 const first=createVerification(verification(),{comment:finding(),context:context(),now,uuid:()=> 'verification-1'});
 const comment={...finding(),verifications:[first]};
 assert.equal(findingStatus(comment,context()),'verified');
 assert.equal(findingStatus(comment,{...context(),headSha:next}),'needs-recheck');
 assert.equal(findingStatus(comment,{...context(),previewUrl:'https://third.example.test'}),'needs-recheck');
 const second=createVerification({status:'still-present',reviewer:{login:'reviewer-2'},note:'Still clipped.',evidence:fresh()},{comment,context:{...context(),headSha:next},now,uuid:()=> 'verification-2'});
 const updated={...comment,verifications:[...comment.verifications,second]};
 assert.equal(findingStatus(updated,{...context(),headSha:next}),'still-present');assert.equal(comment.verifications.length,1);assert.deepEqual(updated.verifications[0],first);
 assert.throws(()=>cleanVerificationHistory([first,first]),/duplicate/);
 assert.throws(()=>cleanVerificationHistory(Array.from({length:101},()=>first)),/too many/);
 assert.throws(()=>createVerification({status:'needs-remap',reviewer:{login:'reviewer'}},{comment,context:context(),now,uuid:()=> 'verification-1'}),/unique/);
});

test('portable verification strips tokens and delivery handles and validates imported verified evidence',()=>{
 const record=createVerification(verification(),{comment:finding(),context:context(),now,uuid:()=> 'verification-1'});
 const clean=cleanVerification({...record,accessToken:'secret',reviewer:{...record.reviewer,token:'secret'},evidence:{...record.evidence,apiKey:'secret'}});
 assert.deepEqual(clean,record);assert.equal(JSON.stringify(clean).includes('secret'),false);
 const missing={...record};delete missing.evidence;assert.throws(()=>cleanVerification(missing),/fresh screenshot/);
});

test('refresh matches findings by portable key, preserves local feedback and selected preview, and syncs shared statuses',()=>{
 const existing={id:'local-review',reviewKey:'portable-review',title:'Local title',prContext:{...context(),headSha:next,previewUrl:'https://newest.test'},prRemote:{remoteReviewId:'review-1'},comments:[finding(),{...finding(),id:'local-2',findingKey:'unsent-local-finding'}]};
 existing.comments[0].fields.comment='Locally refined description';
 const event=createVerification(verification(),{comment:finding(),context:context(),now,uuid:()=> 'verification-1'});
 const incoming={reviewKey:'portable-review',title:'Published title',prContext:context(),comments:[{...finding(),id:'other-device-id',fields:{comment:'Old shared description'},verifications:[event]},{...finding(),findingKey:'new-remote-finding',id:'remote-id'}]};
 const before=structuredClone(existing),merged=mergePRReview(existing,incoming,{uuid:()=> 'new-local-id',now});
 assert.equal(merged.id,'local-review');assert.equal(merged.title,'Local title');assert.deepEqual(merged.prContext,cleanPRContext(existing.prContext));
 assert.equal(merged.comments.length,3);assert.equal(merged.comments[0].id,'local-1');assert.equal(merged.comments[0].fields.comment,'Locally refined description');assert.deepEqual(merged.comments[0].verifications,[event]);
 assert.equal(merged.comments[1].findingKey,'unsent-local-finding');assert.equal(merged.comments[2].id,'new-local-id');assert.equal(merged.comments[2].reviewId,'local-review');
 assert.deepEqual(merged.comments[0].evidence,existing.comments[0].evidence);assert.deepEqual(existing,before);
 assert.throws(()=>mergePRReview(existing,{...incoming,reviewKey:'another-review'}),/does not match/);
 assert.throws(()=>mergePRReview(existing,incoming,{uuid:()=> 'local-1'}),/unique/);
});

test('profile-only PR links accept no tokens, arbitrary URLs or unbounded revisions',()=>{
 const binding={remoteReviewId:'review-1234',remoteRevision:4,connectionId:'connection-1234',commentUrl:'https://github.com/dimitriszoitas/diffuse/pull/12#issuecomment-123'};
 assert.deepEqual(cleanPRRemoteBinding({...binding,token:'secret'}),binding);
 for(const changes of [{remoteRevision:0},{remoteRevision:Infinity},{remoteRevision:'4'},{connectionId:'../secret'},{remoteReviewId:'<script>'},{commentUrl:'https://evil.test/callback'},{commentUrl:'javascript:alert(1)'}])assert.throws(()=>cleanPRRemoteBinding({...binding,...changes}));
});

test('received review refresh adopts remote corrections while preserving separately edited local fields',()=>{
 const baseline={comment:'Original feedback',severity:'minor',expected:'Original expectation'},local={id:'local-review',reviewKey:'portable-review',title:'Original title',prRemoteTitle:'Original title',prContext:context(),comments:[{...finding(),fields:{...baseline},prRemoteFields:{...baseline}}]};
 const incoming={...local,title:'Corrected title',comments:[{...finding(),fields:{comment:'Corrected feedback',severity:'major',expected:'Corrected expectation'}}]};
 const untouched=mergePRReview(local,incoming,{now});assert.deepEqual(untouched.comments[0].fields,incoming.comments[0].fields);assert.equal(untouched.title,'Corrected title');assert.deepEqual(untouched.comments[0].evidence,local.comments[0].evidence);
 local.comments[0].fields.comment='Unsent local feedback';local.title='My local title';
 const edited=mergePRReview(local,incoming,{now});assert.equal(edited.comments[0].fields.comment,'Unsent local feedback');assert.equal(edited.comments[0].fields.severity,'major');assert.equal(edited.comments[0].fields.expected,'Corrected expectation');assert.equal(edited.title,'My local title');
 assert.deepEqual(edited.comments[0].prRemoteFields,incoming.comments[0].fields);assert.equal(edited.prRemoteTitle,'Corrected title');
 const changedAgain={...incoming,comments:[{...incoming.comments[0],fields:{...incoming.comments[0].fields,severity:'critical'}}]};
 const refreshed=mergePRReview(edited,changedAgain,{now});assert.equal(refreshed.comments[0].fields.comment,'Unsent local feedback');assert.equal(refreshed.comments[0].fields.severity,'critical');
 assert.throws(()=>mergePRReview(local,{...incoming,prContext:{...context(),number:99,url:'https://github.com/dimitriszoitas/diffuse/pull/99'}},{now}),/different pull/);
});

test('each preview build can remap its live anchor without changing the original capture or another build',()=>{
 const comment=finding(),attachment={buildSha:sha,previewUrl:context().previewUrl,updatedAt:now,selection:{...comment.selection,selector:'#new-action',context:{...comment.context.production,url:fresh().pageUrl}},pinPoint:{x:.25,y:.75}};
 comment.prAttachments=[attachment];comment.pinOffset={x:100,y:200};
 const source={productionUrl:'https://preview-old.example.test/',prContext:context(),comments:[comment]},before=structuredClone(source);
 const mapped=projectReviewToPreview(source);
 assert.equal(mapped.comments[0].pinSelection.selector,'#new-action');assert.deepEqual(mapped.comments[0].pinPoint,{x:.25,y:.75});assert.deepEqual(mapped.comments[0].pinOffset,{x:0,y:0});
 const other=projectReviewToPreview(source,{...context(),headSha:next});assert.equal(other.comments[0].pinSelection.selector,'#replacement');assert.deepEqual(other.comments[0].pinOffset,{x:100,y:200});
 assert.deepEqual(source,before);assert.deepEqual(mapped.comments[0].evidence,comment.evidence);
 const revised={...attachment,pinPoint:{x:.5,y:.5}};assert.deepEqual(upsertPRAttachment([attachment],revised),[revised]);
 assert.equal(upsertPRAttachment([attachment],{...revised,buildSha:next}).length,2);
 const presetComment={...comment,context:{production:{...comment.context.production,viewportProfile:{key:'phone',mode:'preset'}}}};
 const preset={...attachment,selection:{...attachment.selection,context:{...attachment.selection.context,viewportProfile:{key:'phone',mode:'preset'}}}};
 assert.equal(validatePRAttachmentLocation(preset,presetComment,context().sourcePreviewUrl),preset);
 for(const change of [{url:'https://preview-new.example.test/wrong'},{viewportProfile:{key:'desktop',mode:'window'}},{viewport:{width:1440,height:800}}])assert.throws(()=>validatePRAttachmentLocation({...preset,selection:{...preset.selection,context:{...preset.selection.context,...change}}},presetComment,context().sourcePreviewUrl),/page|viewport/);
});

test('findings first captured on a later preview move to the next build while their evidence stays on the captured build',()=>{
 const newComment=finding();newComment.prSourcePreviewUrl=context().previewUrl;
 newComment.context.production.url=fresh().pageUrl;newComment.selection.context.url=fresh().pageUrl;newComment.pinSelection.context.url=fresh().pageUrl;
 const review={productionUrl:context().sourcePreviewUrl,comments:[newComment]},before=structuredClone(review),third={...context(),headSha:next,previewUrl:'https://third.example.test/'};
 const projected=projectReviewToPreview(review,third);
 assert.equal(projected.comments[0].context.production.url,'https://third.example.test/releases/2?tab=activity#note');
 assert.equal(projected.comments[0].selection.context.url,projected.comments[0].context.production.url);assert.deepEqual(review,before);
 assert.deepEqual(projected.comments[0].evidence,newComment.evidence);
 const record=createVerification({...verification(),evidence:{...fresh(),pageUrl:projected.comments[0].context.production.url}},{comment:newComment,context:third,now});
 assert.equal(record.buildSha,next);assert.equal(record.evidence.pageUrl,projected.comments[0].context.production.url);
 const unrelated={...newComment};delete unrelated.prSourcePreviewUrl;
 assert.equal(projectReviewToPreview({...review,comments:[unrelated]},third).comments[0].context.production.url,fresh().pageUrl,'Unassociated cross-origin findings must remain untouched');
});
