import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewBundle,parseReviewBundle,prepareImportedReview,portablePageUrl,withPortableJiraLinks} from '../extension/review-transfer.mjs';
const when='2026-09-27T10:30:00.000Z';
const png='data:image/png;base64,aW1hZ2U=';
const webm='data:video/webm;codecs=vp9;base64,dmlkZW8=';
function fixture() {
  const url='https://example.test/releases/42?tab=activity#details';
  const context={url,title:'Release',capturedAt:when,viewport:{width:1280,height:800,dpr:2,visualScale:1},scroll:{x:0,y:500},nestedScroll:[{selector:'#activity',x:0,y:320}],viewportProfile:{key:'laptop',mode:'preset'}};
  const selection={schemaVersion:1,kind:'region',anchor:{version:1,kind:'region',selector:'#activity',identity:{tag:'div',attributes:{id:'activity'}},space:'scroll-content',offset:{x:12,y:330,width:180,height:80}},component:{name:'Selected area',source:'region'},rect:{viewport:{x:20,y:60,width:180,height:80},document:{x:20,y:560,width:180,height:80}},context};
  return {id:'local-review-session-id',title:'Review of release',mode:'audit',productionUrl:url,createdAt:when,updatedAt:when,count:1,comments:[{id:'local-comment-id',reviewId:'local-review-session-id',createdAt:when,updatedAt:when,mode:'audit',selection,fields:{title:'Spacing',comment:'Needs more room',expected:'Use consistent spacing',state:'Expanded',component:'Activity',steps:'Open release\nExpand activity',severity:'major',category:'ux-issue'},context:{production:context,alignment:{hidden:true,linked:false,opacity:.55,reveal:50,offsetX:0,offsetY:0}},evidence:{production:{dataUrl:png,annotatedDataUrl:png,cropDataUrl:png,crop:{x:1,y:2,width:20,height:30},width:2560,height:1600,capturedAt:when},prototype:{dataUrl:png,width:2560,height:1600,capturedAt:when},captureSkewMs:0,video:{dataUrl:webm,mimeType:'video/webm;codecs=vp9',durationMs:1000,bytes:5,filename:'capture.webm',kind:'comparison-recording',startedAt:when,stoppedAt:when,stopReason:'manual'}},ai:{provider:'anthropic',model:'test-model',runId:'local-ai-draft',suggestionId:'local-suggestion',mismatchScore:74,confidence:.9,reason:'Visible spacing',acceptedAt:when,mode:'audit'}}]};
}
test('portable roundtrip keeps paths, nested scroll anchors, presets, all media and AI context',()=>{
 const source=fixture(),before=structuredClone(source),bundle=createReviewBundle(source,{now:when});
 const parsed=parseReviewBundle(JSON.stringify(bundle));
 const comment=parsed.review.comments[0];
 assert.equal(parsed.review.productionUrl,source.productionUrl);
 assert.deepEqual(comment.context,source.comments[0].context);
 assert.deepEqual(comment.selection,source.comments[0].selection);
 assert.deepEqual(comment.evidence,source.comments[0].evidence);
 assert.equal(comment.ai.reason,'Visible spacing');assert.equal(comment.ai.runId,undefined);
 assert.deepEqual(source,before,'export must not mutate saved review');
});
test('import generates new review and comment IDs and never carries local handles/settings/secrets',()=>{
 const source=fixture();Object.assign(source,{sessionId:'secret-session',apiKey:'secret-api',jira:{token:'secret'},connectionId:'secret-connection'});
 Object.assign(source.comments[0],{recordingId:'secret-recording',sessionId:'secret',composerFields:{password:'secret'}});
 source.comments[0].context.production.token='secret';source.comments[0].selection.anchor.identity.attributes.onclick='bad()';
 const bundle=createReviewBundle(source,{now:when});assert(!JSON.stringify(bundle).includes('secret'));assert(!JSON.stringify(bundle).includes('local-'));
 let index=0;const imported=prepareImportedReview(bundle,{uuid:()=>`fresh-${++index}`,now:when});
 assert.equal(imported.review.id,'fresh-1');assert.equal(imported.comments[0].id,'fresh-2');assert.equal(imported.comments[0].reviewId,'fresh-1');
 assert.equal(imported.review.comments,undefined);assert.equal(imported.review.count,1);
 const second=prepareImportedReview(bundle,{uuid:()=>`fresh-${++index}`,now:when});assert.notEqual(second.review.id,imported.review.id);
});
test('rejects unsupported versions, malformed or incomplete reviews and remote executable attachments',()=>{
 assert.throws(()=>parseReviewBundle('{'),/valid/);assert.throws(()=>parseReviewBundle({format:'other',version:1}),/not a Diffuse/);
 const bundle=createReviewBundle(fixture(),{now:when});assert.throws(()=>parseReviewBundle({...bundle,version:2}),/unsupported version/);
 for(const url of ['javascript:alert(1)','data:text/html,hello','https://name:password@example.test/','file://remote/share/a.html',' chrome://settings/'])assert.throws(()=>portablePageUrl(url));
 for(const media of ['https://example.test/screenshot.png','data:image/svg+xml;base64,YQ==','data:text/html;base64,YQ==','data:image/png;base64,%%%']){
   const copy=structuredClone(bundle);copy.review.comments[0].evidence.production.dataUrl=media;assert.throws(()=>parseReviewBundle(copy),/attachment/i);
 }
 const missing=structuredClone(bundle);delete missing.review.comments[0].context.production.url;assert.throws(()=>parseReviewBundle(missing),/original page URL/);
 const measurement=structuredClone(bundle);measurement.review.comments[0].selection.rect.viewport.x=Infinity;assert.throws(()=>parseReviewBundle(measurement),/measurement/);
});
test('page routes remain intact while authentication URL parameters never travel',()=>{
 assert.equal(portablePageUrl('https://example.test/account?tab=settings&access_token=secret&session_id=secret#details'),'https://example.test/account?tab=settings#details');
 assert.equal(portablePageUrl('https://example.test/#access_token=secret'),'https://example.test/');
 assert.equal(portablePageUrl('https://example.test/product?code=SKU123&session=workshop#details'),'https://example.test/product?code=SKU123&session=workshop#details');
 assert.equal(portablePageUrl('https://example.test/auth/callback?code=secret&state=verified'),'https://example.test/auth/callback?state=verified');
 assert.equal(portablePageUrl('https://example.test/return?code=secret&state=verified'),'https://example.test/return?state=verified');
 assert.equal(portablePageUrl('file:///Users/reviewer/My%20Page.html'),'file:///Users/reviewer/My%20Page.html');
});
test('untrusted text stays data and prototype properties cannot enter imported objects',()=>{
 const bundle=createReviewBundle(fixture(),{now:when});bundle.review.title='<img src=x onerror=alert(1)>';
 const parsed=JSON.parse(JSON.stringify(bundle).replace('"title":','"__proto__":{"polluted":true},"title":'));
 const result=parseReviewBundle(parsed);assert.equal(result.review.title,'<img src=x onerror=alert(1)>');assert.equal({}.polluted,undefined);assert.equal(Object.hasOwn(result.review,'__proto__'),false);
});
test('exports only matching Jira links, deduplicating connection receipts without account or delivery IDs',()=>{
 const source=fixture();const receipt={issue:{url:'https://team.atlassian.net/browse/DIF-8',key:'DIF-8',id:'local-jira-id'},status:'complete',token:'secret'};
 const linked=withPortableJiraLinks(source,{'diffuseJiraDeliveryV1:connection:site:project:type:local-comment-id:revision':{receipt,connectionId:'secret',accountId:'secret'},'diffuseJiraDeliveryV1:account:site:project:type:local-comment-id:revision':{receipt},'diffuseJiraDeliveryV1:connection:site:project:type:other-comment:revision':{receipt:{issue:{url:'https://team.atlassian.net/browse/DIF-9'}}}});
 assert.deepEqual(linked.comments[0].jiraIssues,[{url:'https://team.atlassian.net/browse/DIF-8',key:'DIF-8',status:'complete'}]);
 const text=JSON.stringify(createReviewBundle(linked,{now:when}));assert(!text.includes('secret'));assert(!text.includes('accountId'));assert(!text.includes('connectionId'));
});

test('portable pin positions survive fresh-ID import without changing the captured element or evidence',()=>{
 const source=fixture();source.comments[0].pinOffset={x:-142.25,y:82.5};
 const bundle=createReviewBundle(source,{now:when});
 assert.equal(bundle.version,1,'An optional display offset does not require a new file format');
 const parsed=parseReviewBundle(JSON.stringify(bundle));let index=0;
 const imported=prepareImportedReview(parsed,{uuid:()=>`fresh-${++index}`,now:when});
 for(const key of ['pinOffset','selection','context','evidence','fields']) assert.deepEqual(imported.comments[0][key],source.comments[0][key]);
 const legacy=createReviewBundle(fixture(),{now:when});
 assert.equal(Object.hasOwn(parseReviewBundle(legacy).review.comments[0],'pinOffset'),false,'Older files retain their original default placement');
});

test('portable pin positions reject incomplete, non-finite and unbounded coordinates',()=>{
 const bundle=createReviewBundle(fixture(),{now:when});
 for(const offset of [null,[],{}, {x:2}, {y:2}, {x:'2',y:0}, {x:0,y:Infinity}, {x:NaN,y:0}, {x:100001,y:0}, {x:0,y:-100001}]) {
   const copy=structuredClone(bundle);copy.review.comments[0].pinOffset=offset;
   assert.throws(()=>parseReviewBundle(copy),/comment position/);
 }
 const extra=structuredClone(bundle);extra.review.comments[0].pinOffset={x:0,y:3,selector:'untrusted',__proto__:{polluted:true}};
 assert.deepEqual(parseReviewBundle(extra).review.comments[0].pinOffset,{x:0,y:3});
});

function remapped(source=fixture()) {
 const context={...source.comments[0].context.production,scroll:{x:0,y:760},nestedScroll:[{selector:'#sidebar',x:0,y:80}]};
 return {schemaVersion:1,kind:'element',selector:'#remapped',selectorFormat:'css',tagName:'button',component:{name:'Updated target',source:'data-component',selector:'#remapped'},
  anchor:{version:1,kind:'element',selector:'#remapped',identity:{tag:'button',attributes:{id:'remapped'}}},
  rect:{viewport:{x:24,y:48,width:120,height:44},document:{x:24,y:808,width:120,height:44}},context};
}
test('portable remapped anchors survive fresh-ID import without changing original captured context or evidence',()=>{
 const source=fixture();source.comments[0].pinSelection=remapped(source);source.comments[0].pinPoint={x:.25,y:.5};source.comments[0].pinOffset={x:0,y:0};
 const bundle=createReviewBundle(source,{now:when});assert.equal(bundle.version,1);
 let index=0;const imported=prepareImportedReview(JSON.stringify(bundle),{uuid:()=>`remap-${++index}`,now:when});
 for(const key of ['pinSelection','pinPoint','pinOffset','selection','context','evidence','fields'])assert.deepEqual(imported.comments[0][key],source.comments[0][key]);
 assert.equal(Object.hasOwn(parseReviewBundle(createReviewBundle(fixture(),{now:when})).review.comments[0],'pinSelection'),false);
});
test('portable remapped anchors validate element identity, dimensions and same-page context and drop undeclared data',()=>{
 const source=fixture(),bundle=createReviewBundle(source,{now:when}),valid=remapped(source);
 for(const invalid of [null,{}, {...valid,kind:'region'}, {...valid,selector:''}, {...valid,anchor:{...valid.anchor,selector:'#other'}}, {...valid,tagName:'html'}, {...valid,rect:{...valid.rect,viewport:{x:0,y:0,width:0,height:44}}}, {...valid,context:{...valid.context,url:'https://elsewhere.test/'}}]){
  const copy=structuredClone(bundle);copy.review.comments[0].pinSelection=invalid;assert.throws(()=>parseReviewBundle(copy),/remapped|data section/);
 }
 const copy=structuredClone(bundle);copy.review.comments[0].pinSelection={...structuredClone(valid),credential:'secret',onclick:'bad()'};copy.review.comments[0].pinSelection.anchor.identity.attributes.onclick='bad()';
 const parsed=parseReviewBundle(copy);assert.deepEqual(parsed.review.comments[0].pinSelection,valid);
});

test('portable normalized drop points remain bounded and require a remapped attachment',()=>{
 const source=fixture();source.comments[0].pinSelection=remapped(source);const bundle=createReviewBundle(source,{now:when});
 for(const point of [null,{},[],{x:0},{x:'0',y:1},{x:-.01,y:1},{x:0,y:1.01},{x:Infinity,y:0}]){
  const copy=structuredClone(bundle);copy.review.comments[0].pinPoint=point;assert.throws(()=>parseReviewBundle(copy),/drop point/);
 }
 const copy=structuredClone(bundle);copy.review.comments[0].pinPoint={x:0,y:1,credential:'secret'};assert.deepEqual(parseReviewBundle(copy).review.comments[0].pinPoint,{x:0,y:1});
 delete copy.review.comments[0].pinSelection;assert.throws(()=>parseReviewBundle(copy),/missing its element attachment/);
});

test('portable area remaps retain anchors or document fallback and never carry an element drop point',()=>{
 for(const anchored of [true,false]) {
  const source=fixture(),region=structuredClone(source.comments[0].selection);
  if(!anchored)delete region.anchor;
  source.comments[0].pinSelection=region;source.comments[0].pinOffset={x:0,y:0};
  const bundle=createReviewBundle(source,{now:when});let index=0;const imported=prepareImportedReview(bundle,{uuid:()=>`area-${++index}`,now:when});
  assert.deepEqual(imported.comments[0].pinSelection,region);assert.deepEqual(imported.comments[0].selection,source.comments[0].selection);assert.equal(Object.hasOwn(imported.comments[0],'pinPoint'),false);
  bundle.review.comments[0].pinPoint={x:.5,y:.5};assert.throws(()=>parseReviewBundle(bundle),/element attachment/);
 }
});


test('Figma design provenance and reference screenshot travel with the review, connection secrets do not',()=>{
 const source=fixture();source.comments[0].ai.designReference={url:'https://www.figma.com/design/Example?node-id=1-2',fileKey:'Example',nodeId:'1:2',serverName:'Figma Desktop',tools:['get_design_context'],text:'Spacing: 24',capturedAt:when,endpoint:'http://127.0.0.1:3845/mcp',token:'secret'};
 source.comments[0].evidence.designReference={dataUrl:png,width:500,height:300,capturedAt:when};
 source.comments[0].evidence.designReferenceAdditional=[{dataUrl:png,width:250,height:150,capturedAt:when}];
 const bundle=parseReviewBundle(JSON.stringify(createReviewBundle(source,{now:when})));
 const item=bundle.review.comments[0];
 assert.equal(item.ai.designReference.nodeId,'1:2');assert.equal(item.ai.designReference.text,'Spacing: 24');
 assert.equal(item.evidence.designReference.dataUrl,png);
 assert.equal(item.evidence.designReferenceAdditional[0].width,250);
 assert.equal(JSON.stringify(bundle).includes('secret'),false);assert.equal(item.ai.designReference.endpoint,undefined);
 source.comments[0].evidence.designReferenceAdditional.push(source.comments[0].evidence.designReference);
 assert.throws(()=>createReviewBundle(source,{now:when}),/list is invalid or too large/);
});
