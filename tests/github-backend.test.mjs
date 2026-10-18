import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createGitHubCipher,parsePullUrl,hash,secret,verifierChallenge,GitHubError} from '../backend/github-security.mjs';
import {createGitHubAuth} from '../backend/github-auth.mjs';
import {createGitHubApi} from '../backend/github-api.mjs';
import {createGitHubReviews,GITHUB_CHUNK_BYTES} from '../backend/github-reviews.mjs';
import {createGitHubHandler} from '../backend/github-http.mjs';
import {formatGitHubSummary} from '../backend/github-format.mjs';

const key=Buffer.alloc(32,7).toString('base64'),extension='a'.repeat(32),now=Date.parse('2026-10-18T18:00:00Z');
const author={id:randomUUID(),accountId:'123',login:'reviewer',displayName:'Review Author'},recipient={id:randomUUID(),accountId:'456',login:'engineer',displayName:'Feedback Recipient'};
function memoryStore(){
  const reviews=new Map(),connections=new Map(),states=new Map(),handoffs=new Map(),chunks=new Map(),locks=new Map();
  async function lock(id,action){let release;const prior=locks.get(id)||Promise.resolve(),next=new Promise(r=>release=r);locks.set(id,next);await prior;try{return await action();}finally{release();}}
  return {reviews,connections,states,handoffs,chunksMap:chunks,
    async putState(s){states.set(s.stateHash,s);},async consumeState(h,t){const s=states.get(h);states.delete(h);return s&&s.expiresAt>t?s:null;},
    async createConnectionWithHandoff(c,h){connections.set(c.id,{...c,pendingExpiresAt:h.expiresAt});handoffs.set(h.codeHash,{...h,id:c.id});},
    async completeHandoff({codeHash,challenge,credentialHash,now}){return lock('handoff',async()=>{const h=handoffs.get(codeHash);if(!h||h.challenge!==challenge||h.expiresAt<=now)return null;handoffs.delete(codeHash);const c=connections.get(h.id);Object.assign(c,{credentialHash,pendingExpiresAt:null});return {...c};});},
    async getConnection(id){return connections.get(id);},async deleteConnection(id){connections.delete(id);},
    async withConnectionLock(id,action){return lock(id,()=>action(connections.get(id),async tokensCiphertext=>{connections.get(id).tokensCiphertext=tokensCiphertext;}));},
    async findReview(repo,number,rkey){return [...reviews.values()].find(r=>r.repoId===repo&&r.pullNumber===number&&r.reviewKey===rkey);},
    async getReview(id){return reviews.get(id);},async listReviews(repo,number){return [...reviews.values()].filter(r=>r.repoId===repo&&r.pullNumber===number&&r.revision>0);},
    async createReview(r){reviews.set(r.id,{...r,revision:0,bundleCiphertext:null});return reviews.get(r.id);},
    async withReviewLock(id,action){return lock(id,async()=>{const r=structuredClone(reviews.get(id));let next;const result=await action(r,async p=>{next={...r,...p};});if(next)reviews.set(id,next);return result;});},
    async chunks(id,digest){return [...chunks.values()].filter(c=>c.id===id&&c.digest===digest).sort((a,b)=>a.index-b.index);},
    async putChunk(c){chunks.set(`${c.id}:${c.digest}:${c.index}`,c);}
  };
}
function fixture(){
  const date='2026-10-18T17:00:00Z',reviewKey=randomUUID(),findingKey=randomUUID(),url='https://old-preview.test/items/1';
  return {format:'diffuse-review',version:1,exportedAt:date,review:{reviewKey,title:'Design review',createdAt:date,mode:'audit',productionUrl:url,comments:[{findingKey,createdAt:date,mode:'audit',fields:{comment:'Make the primary action clearer.',state:'Current state',category:'ux-issue',severity:'major'},context:{production:{url,capturedAt:date,viewport:{width:1200,height:800},viewportProfile:{key:'desktop',mode:'window'},scroll:{x:0,y:0}}},evidence:{production:{dataUrl:'data:image/png;base64,aW1hZ2U=',capturedAt:date,width:1200,height:800}}}]}};
}
const freshEvidence=()=>({dataUrl:'data:image/png;base64,bmV3LWltYWdl',capturedAt:'2026-10-18T17:59:00Z',pageUrl:'https://new-preview.test/items/1',width:1200,height:800});
function harness(){
  const store=memoryStore(),writes=[],uploads=[];let head='a'.repeat(40),canWrite=true,denied=false,remote=null,throwWrite=false,time=now;
  const api={
    async getPull(token,url){if(denied)throw new GitHubError('repository_unavailable');return {...parsePullUrl(url),title:'Example PR',headSha:head,state:'open',repoId:12,canWrite,private:true};},
    async upload(token,pull,asset){uploads.push(asset);return `https://github.com/user-attachments/assets/${randomUUID()}`;},
    async findSummary(){return remote;},
    async writeSummary(pull,input){writes.push(input);remote={id:29,url:`${pull.url}#issuecomment-29`,body:input.body};if(throwWrite)throw new GitHubError('unavailable');return {id:remote.id,url:remote.url};}
  };
  const service=createGitHubReviews({store,api,cryptoKey:key,clock:()=>time});
  async function prepare(bundle=fixture(),expectedRevision=0){const bytes=Buffer.from(JSON.stringify(bundle)),result=await service.prepare({accessToken:'user',connection:author,input:{pullUrl:'https://github.com/team/project/pull/1',reviewKey:bundle.review.reviewKey,expectedRevision,byteLength:bytes.length,sha256:hash(bytes),chunkCount:Math.ceil(bytes.length/GITHUB_CHUNK_BYTES),reviewedSha:head,previewUrl:'https://new-preview.test/',includeEvidence:true}});for(let index=0;index<Math.ceil(bytes.length/GITHUB_CHUNK_BYTES);index++)await service.putChunk({id:result.id,accessToken:'user',connection:author,input:{index,dataBase64:bytes.subarray(index*GITHUB_CHUNK_BYTES,(index+1)*GITHUB_CHUNK_BYTES).toString('base64')}});return {...result,bundle};}
  async function publish(prepared){let result;for(let i=0;i<10;i++){result=await service.publish({id:prepared.id,accessToken:'user',connection:author});if(result.done)return result;}throw Error('publish did not settle');}
  async function load(id){const meta=await service.get({id,accessToken:'recipient'}),parts=[];for(let index=0;index<meta.chunkCount;index++)parts.push(Buffer.from((await service.get({id,accessToken:'recipient',index})).dataBase64,'base64'));assert.equal(hash(Buffer.concat(parts)),meta.sha256);return JSON.parse(Buffer.concat(parts).toString('utf8'));}
  return {store,api,service,writes,uploads,prepare,publish,load,advance:ms=>time+=ms,setHead:v=>head=v,setWrite:v=>canWrite=v,setDenied:v=>denied=v,setThrow:v=>throwWrite=v};
}

test('GitHub encryption binds domain, connection, payload and authentication tag',()=>{
  const c=createGitHubCipher(key),id=randomUUID(),sealed=c.encrypt(`tokens:${id}`,{secret:'private'});assert.deepEqual(c.decrypt(`tokens:${id}`,sealed),{secret:'private'});
  assert.throws(()=>c.decrypt(`bundle:${id}`,sealed));assert.throws(()=>c.decrypt(`tokens:${randomUUID()}`,sealed));assert.throws(()=>c.decrypt(`tokens:${id}`,sealed.slice(0,-4)+'aaaa'));
});
test('PR URLs accept only canonical github pull addresses',()=>{
  assert.deepEqual(parsePullUrl('https://github.com/team/repo/pull/12'),{owner:'team',repo:'repo',number:12,url:'https://github.com/team/repo/pull/12'});
  for(const value of ['http://github.com/a/b/pull/1','https://github.com.evil/a/b/pull/1','https://user@github.com/a/b/pull/1','https://github.com/a/b/pull/1?token=x','https://github.com/a/b/issues/1'])assert.throws(()=>parsePullUrl(value));
});
test('OAuth uses two independent verifier challenges and a one-use extension-bound handoff',async()=>{
  const store=memoryStore(),browserProof=secret();let codeVerifier;const api={authorizationUrl:p=>`https://github.com/login/oauth/authorize?state=${p.state}&code_challenge=${p.challenge}`,exchangeCode:async p=>{codeVerifier=p.verifier;return {accessToken:'user',refreshToken:'refresh',expiresAt:now+999999,refreshExpiresAt:now+9999999};},user:async()=>author};
  const auth=createGitHubAuth({store,api,cryptoKey:key,allowedExtensionIds:[extension],clock:()=>now}),start=await auth.start({extensionId:extension,challenge:verifierChallenge(browserProof)}),url=new URL(start.authorizationUrl);
  assert.notEqual(url.searchParams.get('code_challenge'),verifierChallenge(browserProof));const result=await auth.callback({state:url.searchParams.get('state'),code:'validcode'});
  assert.equal(verifierChallenge(codeVerifier),url.searchParams.get('code_challenge'));const redirect=new URL(result.redirectUrl);assert.equal(redirect.origin,`https://${extension}.chromiumapp.org`);assert.equal(redirect.pathname,'/github');
  await assert.rejects(()=>auth.complete({code:redirect.searchParams.get('code'),verifier:secret()}),e=>e.code==='invalid_handoff');
  const completed=await auth.complete({code:redirect.searchParams.get('code'),verifier:browserProof});assert.equal(completed.connection.login,author.login);assert(!JSON.stringify(completed).includes('refresh'));
  await assert.rejects(()=>auth.complete({code:redirect.searchParams.get('code'),verifier:browserProof}),e=>e.code==='invalid_handoff');await assert.rejects(()=>auth.callback({state:url.searchParams.get('state'),code:'validcode'}),e=>e.code==='invalid_state');
});
test('token refresh is serialized and persisted even when subsequent GitHub operation fails',async()=>{
  const store=memoryStore(),id=randomUUID(),keypart=secret(),cipher=createGitHubCipher(key);let refreshes=0;
  store.connections.set(id,{...author,id,extensionId:extension,credentialHash:hash(keypart),pendingExpiresAt:null,tokensCiphertext:cipher.encrypt(`tokens:${id}`,{accessToken:'expired',refreshToken:'old-refresh',expiresAt:now-1,refreshExpiresAt:now+999999})});
  const auth=createGitHubAuth({store,api:{refreshTokens:async()=>{refreshes++;return {accessToken:'fresh',refreshToken:'rotated',expiresAt:now+999999,refreshExpiresAt:now+9999999};}},cryptoKey:key,allowedExtensionIds:[extension],clock:()=>now});
  const results=await Promise.allSettled([auth.withAccessToken(`${id}.${keypart}`,async token=>{assert.equal(token,'fresh');throw Error('provider failed');}),auth.withAccessToken(`${id}.${keypart}`,async token=>token)]);
  assert.equal(refreshes,1);assert.equal(results[1].value,'fresh');assert.equal(cipher.decrypt(`tokens:${id}`,store.connections.get(id).tokensCiphertext).refreshToken,'rotated');
});
test('publish uploads evidence only on explicit publish, then creates one readable summary',async()=>{
  const h=harness(),p=await h.prepare();assert.equal(h.uploads.length,0);assert.equal(h.writes.length,0);const result=await h.publish(p);
  assert.equal(result.review.revision,1);assert.equal(h.uploads.length,1);assert.equal(h.writes.length,1);assert.match(h.writes[0].body,/Make the primary action clearer/);
  assert.match(h.writes[0].body,/github.com\/user-attachments\/assets/);assert.equal((await h.publish(p)).review.revision,1);assert.equal(h.writes.length,1);
});
test('valid imported portable identities are preserved even when not UUID-shaped',async()=>{
  const h=harness(),b=fixture();b.review.reviewKey='review:portable:example-123';b.review.comments[0].findingKey='finding:portable:example-456';const p=await h.prepare(b);await h.publish(p);assert.equal((await h.load(p.id)).review.reviewKey,b.review.reviewKey);
  const result=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{expectedRevision:1,findingKey:b.review.comments[0].findingKey,status:'ready-for-recheck',evidence:freshEvidence(),buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/'}});assert.equal(result.event.status,'ready-for-recheck');
});
test('only the snapshot author updates authored feedback; readers can load but need write access to change status',async()=>{
  const h=harness(),p=await h.prepare();await h.publish(p);h.setWrite(false);assert.equal((await h.load(p.id)).review.reviewKey,p.bundle.review.reviewKey);
  await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{expectedRevision:1,findingKey:p.bundle.review.comments[0].findingKey,status:'ready-for-recheck',evidence:freshEvidence(),buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/'}}),e=>e.code==='read_only');
  h.setWrite(true);await assert.rejects(()=>h.service.publish({id:p.id,accessToken:'recipient',connection:recipient}).then(async()=>{const input=await h.prepare(p.bundle,1);return h.service.publish({id:input.id,accessToken:'recipient',connection:recipient});}),e=>e.code==='author_only');
});
test('shared review retrieval rechecks current repository authorization for metadata and every chunk',async()=>{
  const h=harness(),p=await h.prepare();await h.publish(p);h.setDenied(true);
  await assert.rejects(()=>h.load(p.id),e=>e.code==='repository_unavailable');await assert.rejects(()=>h.service.get({id:p.id,accessToken:'user',index:0}),e=>e.code==='repository_unavailable');
});
test('untrusted imported verifications are discarded, authenticated cross-person events are appended and idempotent',async()=>{
  const h=harness(),bundle=fixture();bundle.review.comments[0].verifications=[{id:randomUUID(),status:'ready-for-recheck',buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/',reviewer:{login:'imposter'},checkedAt:'2026-10-18T17:30:00Z',note:''}];const p=await h.prepare(bundle);await h.publish(p);
  assert.deepEqual((await h.load(p.id)).review.comments[0].verifications,[]);
  const input={id:randomUUID(),expectedRevision:1,findingKey:bundle.review.comments[0].findingKey,status:'ready-for-recheck',evidence:freshEvidence(),buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/',reviewer:{login:'imposter'},note:'Ready now'};
  const result=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input});assert.equal(result.event.reviewer.login,'engineer');assert.equal(result.review.revision,2);assert.equal(result.summaryUpdated,true);
  const duplicate=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input});assert.equal(duplicate.review.revision,2);assert.equal((await h.load(p.id)).review.comments[0].verifications.length,1);
});
test('verified requires a fresh screenshot on the correct preview route and current commit',async()=>{
  const h=harness(),p=await h.prepare();await h.publish(p);const input={expectedRevision:1,findingKey:p.bundle.review.comments[0].findingKey,status:'verified',buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/'};
  await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input}),e=>e.code==='needs_evidence');
  const evidence={dataUrl:'data:image/png;base64,bmV3LWltYWdl',capturedAt:'2026-10-18T17:59:00Z',pageUrl:'https://new-preview.test/wrong',width:1200,height:800};
  await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,evidence}}),e=>e.code==='needs_evidence');
  evidence.pageUrl='https://new-preview.test/items/1';evidence.capturedAt='2026-10-18T17:00:00Z';await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,evidence}}),e=>e.code==='needs_evidence');
  evidence.capturedAt='2026-10-18T17:59:00Z';const success=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,evidence}});assert.equal(success.event.status,'verified');assert.equal(h.uploads.length,2);
  h.setHead('b'.repeat(40));await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,expectedRevision:2,evidence}}),e=>e.code==='preview_changed');
});
test('reported fixes and reviewer verdicts require fresh proof, including short behavior recordings',async()=>{
  for(const status of ['ready-for-recheck','verified','still-present']) {
    const h=harness(),p=await h.prepare();await h.publish(p);
    const input={expectedRevision:1,findingKey:p.bundle.review.comments[0].findingKey,status,buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/'};
    await assert.rejects(()=>h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input}),e=>e.code==='needs_evidence');
    const evidence={...freshEvidence(),dataUrl:'data:video/webm;base64,dmlkZW8=',mimeType:'video/webm',durationMs:30000};
    const result=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,evidence}});
    assert.equal(result.event.status,status);assert.equal(result.event.evidence.kind,'recording');
    assert.equal(result.event.reviewer.login,'engineer');assert.equal(h.uploads.at(-1).contentType,'video/webm');
    const loaded=await h.load(p.id);assert.equal(loaded.review.comments[0].evidence.production.dataUrl,p.bundle.review.comments[0].evidence.production.dataUrl);
    assert.equal(loaded.review.comments[0].verifications[0].evidence.durationMs,30000);
    assert.match(h.writes.at(-1).body,/Original capture/);assert.match(h.writes.at(-1).body,/Updated capture/);
  }
});
test('a later remap request preserves the updated proof through author republication and upload recovery',async()=>{
  for(const missingReceipt of [false,true]) {
    const h=harness(),p=await h.prepare();await h.publish(p);
    const input={expectedRevision:1,findingKey:p.bundle.review.comments[0].findingKey,status:'ready-for-recheck',buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/',evidence:freshEvidence()};
    const ready=await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input});
    await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input:{...input,evidence:undefined,status:'needs-remap',expectedRevision:2}});
    const before=h.uploads.length,cipher=createGitHubCipher(key),row=h.store.reviews.get(p.id);
    if(missingReceipt) {
      const data=cipher.decrypt(`bundle:${p.id}:meta`,row.dataCiphertext);
      data.assets=data.assets.filter(asset=>asset.key!==`${ready.event.id}:verification`);
      row.dataCiphertext=cipher.encrypt(`bundle:${p.id}:meta`,data);
    }
    const next=await h.prepare(p.bundle,3);await h.publish(next);
    const loaded=await h.load(p.id),text=h.writes.at(-1).body;
    assert.equal(loaded.review.comments[0].verifications.at(-1).status,'needs-remap');
    assert.equal(loaded.review.comments[0].verifications[0].id,ready.event.id);
    assert.equal(h.uploads.length,before+(missingReceipt?1:0));
    assert.match(text,/Updated capture/);assert.match(text,/!\[Updated screenshot\]\(https:\/\/github.com\/user-attachments\/assets\//);
    assert(!text.includes('Updated screenshot will be attached when published'));
  }
});
test('stale revision never overwrites another person’s event; original evidence/history survive author republish',async()=>{
  const h=harness(),p=await h.prepare();await h.publish(p);const input={expectedRevision:1,findingKey:p.bundle.review.comments[0].findingKey,status:'ready-for-recheck',evidence:freshEvidence(),buildSha:'a'.repeat(40),previewUrl:'https://new-preview.test/'};
  await h.service.event({id:p.id,accessToken:'recipient',connection:recipient,input});await assert.rejects(()=>h.prepare(p.bundle,1),e=>e.code==='review_changed');
  const edited=structuredClone(p.bundle);edited.review.comments[0].evidence.production.dataUrl='data:image/png;base64,b3RoZXI=';edited.review.comments[0].fields.comment='Updated text';const next=await h.prepare(edited,2);await h.publish(next);const loaded=await h.load(p.id);
  assert.equal(loaded.review.comments[0].fields.comment,'Updated text');assert.equal(loaded.review.comments[0].verifications[0].reviewer.login,'engineer');assert.equal(loaded.review.comments[0].evidence.production.dataUrl,p.bundle.review.comments[0].evidence.production.dataUrl);
});
test('uncertain create recovers the app-authored marker without a duplicate POST',async()=>{
  const h=harness(),p=await h.prepare();h.setThrow(true);await assert.rejects(()=>h.publish(p),e=>e.code==='unavailable');assert.equal(h.writes.length,1);h.setThrow(false);const recovered=await h.publish(p);assert.equal(recovered.done,true);assert.equal(h.writes.length,2);assert.equal(h.writes[1].commentId,29);
});
test('uncertain publication remains recoverable after transfer expiry and a newer PR commit',async()=>{
  const h=harness(),p=await h.prepare();h.setThrow(true);
  await assert.rejects(()=>h.publish(p),e=>e.code==='unavailable');
  assert.equal(h.store.reviews.get(p.id).publicationPending,true);
  h.advance(48*60*60*1000);h.setHead('b'.repeat(40));h.setThrow(false);
  const recovered=await h.publish(p);
  assert.equal(recovered.done,true);assert.equal(recovered.review.revision,1);
  assert.equal(h.writes.filter(write=>!write.commentId).length,1);
  assert.equal(h.writes.at(-1).commentId,29);
  assert.equal(h.store.reviews.get(p.id).publicationPending,false);
  assert.equal((await h.load(p.id)).review.prContext.reviewedSha,'a'.repeat(40));
});
test('an expired upload with no send intent cannot create a summary',async()=>{
  const h=harness(),p=await h.prepare();h.advance(48*60*60*1000);
  await assert.rejects(()=>h.publish(p),e=>e.code==='review_changed');
  assert.equal(h.writes.length,0);assert.equal(h.store.reviews.get(p.id).publicationPending,false);
});
test('concurrent publication retries cannot send delayed stale patches after a newer revision',async()=>{
  const h=harness(),original=await h.prepare();await h.publish(original);
  const edited=structuredClone(original.bundle);edited.review.comments[0].fields.comment='First correction';
  const pending=await h.prepare(edited,1),write=h.api.writeSummary;
  let begin,release;const started=new Promise(resolve=>begin=resolve),blocked=new Promise(resolve=>release=resolve);
  h.api.writeSummary=async(...args)=>{begin();await blocked;return write(...args);};
  const first=h.service.publish({id:pending.id,accessToken:'user',connection:author});
  await started;
  const retry=h.service.publish({id:pending.id,accessToken:'user',connection:author});
  // Both requests retain one staged identity; the second must finish from the
  // first receipt rather than scheduling its own delayed GitHub PATCH.
  release();const results=await Promise.all([first,retry]);
  assert.equal(results[0].review.revision,2);assert.equal(results[1].review.revision,2);
  assert.equal(h.writes.length,2);assert.equal(h.writes[1].commentId,29);
  h.api.writeSummary=write;
  edited.review.comments[0].fields.comment='Latest correction';const next=await h.prepare(edited,2);await h.publish(next);
  assert.equal(h.writes.length,3);assert.match(h.writes.at(-1).body,/Latest correction/);
});
test('an unconfirmed existing-summary update cannot be replaced by another snapshot',async()=>{
  const h=harness(),original=await h.prepare();await h.publish(original);
  const edited=structuredClone(original.bundle);edited.review.comments[0].fields.comment='Approved correction';
  const pending=await h.prepare(edited,1);h.setThrow(true);
  await assert.rejects(h.publish(pending),error=>error.code==='unavailable');
  const replacement=structuredClone(edited);replacement.review.comments[0].fields.comment='Unrelated newer correction';
  await assert.rejects(h.prepare(replacement,1),error=>error.code==='publication_uncertain');
  h.setThrow(false);const recovered=await h.publish(pending);
  assert.equal(recovered.review.revision,2);assert.equal((await h.load(pending.id)).review.comments[0].fields.comment,'Approved correction');
});
test('partial evidence receipts survive retry without silently skipping failed assets',async()=>{
  const h=harness(),b=fixture();b.review.comments[0].evidence.video={dataUrl:'data:video/webm;base64,dmlkZW8=',mimeType:'video/webm',durationMs:1000};const p=await h.prepare(b),upload=h.api.upload;let rejectVideo=true;
  h.api.upload=async(...args)=>{if(args[2].contentType==='video/webm'&&rejectVideo)throw new GitHubError('upload_failed');return upload(...args);};
  const first=await h.service.publish({id:p.id,accessToken:'user',connection:author});assert.equal(first.done,false);await assert.rejects(()=>h.publish(p),e=>e.code==='upload_failed');assert.equal(h.writes.length,0);assert.equal(h.uploads.length,1);
  rejectVideo=false;await h.publish(p);assert.equal(h.uploads.length,2);assert.equal(h.writes.length,1);
});
test('comparison and Figma reference images are included rather than omitted from GitHub evidence',async()=>{
  const h=harness(),b=fixture(),image=b.review.comments[0].evidence.production;
  Object.assign(b.review.comments[0].evidence,{prototype:image,designReference:image,designReferenceAdditional:[image]});
  const p=await h.prepare(b);await h.publish(p);assert.equal(h.uploads.length,4);assert.match(h.writes[0].body,/Comparison reference/);assert.match(h.writes[0].body,/Additional design reference/);
});
test('summary escapes user markdown, HTML and mentions, keeping evidence URLs server-selected',()=>{
  const b=fixture();b.review.title='<script>@everyone</script>';b.review.comments[0].fields.comment='[steal](javascript:alert(1)) @team <img onerror=x>';
  const text=formatGitHubSummary(b,{pull:{headSha:'a'.repeat(40)},assets:[{key:`${b.review.comments[0].findingKey}:image`,url:'https://attacker.test/pixel'}]});
  assert(!text.includes('<script>'));assert(!text.includes('@everyone'));assert(!text.includes('@team'));assert(!text.includes('https://attacker'));assert(text.includes('\\[steal\\]'));
});
test('HTTP boundary forbids foreign origins, oversized bodies and credential leakage',async()=>{
  const handler=createGitHubHandler({allowedExtensionIds:[extension],getServices:()=>{throw Error('secret database connection');}});
  const call=async(req)=>{const headers={};let output;const res={setHeader:(k,v)=>headers[k]=v,end:v=>output=v};await handler({headers:{},...req},res);return {status:res.statusCode,body:output&&JSON.parse(output),headers};};
  const foreign=await call({method:'POST',url:'/github/v1/oauth/start',headers:{origin:'https://evil.test','content-type':'application/json'},body:{}});assert.equal(foreign.status,403);
  const broken=await call({method:'GET',url:'/github/v1/connection'});assert.equal(broken.status,503);assert(!JSON.stringify(broken).includes('secret database'));
  const health=await call({method:'GET',url:'/github/health'});assert.equal(health.status,200);assert.match(health.headers['Cache-Control'],/no-store/);
});
test('provider requests refuse redirects and bind installation tokens to exactly one repository',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),requests=[];
  const api=createGitHubApi({clientId:'Iv1.test',clientSecret:'testsecret',publicOrigin:'https://diffuse.test',appId:42,privateKey:privateKey.export({type:'pkcs1',format:'pem'}),appSlug:'diffuse-test',clock:()=>now,fetchImpl:async(url,options)=>{
    requests.push({url,options});let result;
    if(url.endsWith('/installation'))result={id:52,app_id:42};
    else if(url.includes('/access_tokens'))result={token:'installation-token-123456'};
    else result={id:29,html_url:'https://github.com/team/project/pull/1#issuecomment-29'};
    return new Response(JSON.stringify(result),{status:200});
  }});
  await api.writeSummary({owner:'team',repo:'project',number:1,repoId:12,url:'https://github.com/team/project/pull/1'},{body:'safe body'});
  assert(requests.every(r=>r.options.redirect==='error'));assert.deepEqual(JSON.parse(requests.find(r=>r.url.includes('/access_tokens')).options.body),{repository_ids:[12],permissions:{pull_requests:'write',metadata:'read'}});
  assert(!requests.some(r=>r.url.includes('testsecret')));
});
test('upload failures report only endpoint/status/code and never follow redirects or log credentials',async()=>{
  const logs=[],original=console.warn;console.warn=value=>logs.push(JSON.parse(value));
  try {
    for(const status of [404,302]) {
      const api=createGitHubApi({clientId:'Iv1.test',clientSecret:'private-client-secret',publicOrigin:'https://diffuse.test',appId:42,privateKey:'unused-for-user-upload',appSlug:'diffuse-test',fetchImpl:async(url,options)=>{
        assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'token private-provider-token');
        return new Response('private-provider-message',{status,headers:{location:'https://example.invalid/never-follow'}});
      }});
      await assert.rejects(api.upload('private-provider-token',{repoId:12,canWrite:true},{name:'safe-test.png',contentType:'image/png',bytes:Buffer.from('test')}),error=>error.code==='upload_failed');
    }
  } finally {console.warn=original;}
  assert.deepEqual(logs,[{event:'diffuse_github_provider_error',endpoint:'attachment_upload',status:404,code:'http_error'},{event:'diffuse_github_provider_error',endpoint:'attachment_upload',status:302,code:'redirect_blocked'}]);
});
test('deploy-contained portable validators match extension sources',async()=>{
  const portable=await readFile(new URL('../backend/github-portable.mjs',import.meta.url),'utf8'),source=await readFile(new URL('../extension/review-transfer.mjs',import.meta.url),'utf8');
  assert.equal(portable.split('\n').slice(1).join('\n'),source.replace("'./pr-review.mjs'","'./github-pr-review.mjs'"));
  const model=await readFile(new URL('../backend/github-pr-review.mjs',import.meta.url),'utf8'),original=await readFile(new URL('../extension/pr-review.mjs',import.meta.url),'utf8');
  assert.equal(model.split('\n').slice(1).join('\n'),original);
});
