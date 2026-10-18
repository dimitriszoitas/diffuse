/** Optional integration smoke test. Uses only freshly generated test-owned rows.
 * Provider HTTP is mocked; this exercises the production SQL and encryption path.
 * Run with DATABASE_URL in environment after migration. An ephemeral test key
 * encrypts disposable rows; production encryption credentials are never needed.
 */
import assert from 'node:assert/strict';
import {randomUUID,randomInt,randomBytes} from 'node:crypto';
import {createDatabasePool} from './database.mjs';
import {createGitHubStore} from './github-store.mjs';
import {createGitHubAuth} from './github-auth.mjs';
import {createGitHubReviews,GITHUB_CHUNK_BYTES} from './github-reviews.mjs';
import {createGitHubCipher,hash,secret,parsePullUrl,GitHubError} from './github-security.mjs';

let pool;const own={connectionIds:[],reviewIds:[],stateHashes:[]};
try{
  const testKey=randomBytes(32).toString('base64');
  pool=createDatabasePool(process.env.DATABASE_URL);const store=createGitHubStore({pool}),cipher=createGitHubCipher(testKey),now=Date.now(),extension='a'.repeat(32);
  const stateHash=hash(secret());own.stateHashes.push(stateHash);
  await store.putState({stateHash,challenge:secret(),extensionId:extension,verifierCiphertext:cipher.encrypt(`oauth:${stateHash}`,'test-verifier'),expiresAt:now+60000});
  const stateClaims=await Promise.all([store.consumeState(stateHash,now),store.consumeState(stateHash,now)]);assert.equal(stateClaims.filter(Boolean).length,1);
  const id=randomUUID();own.connectionIds.push(id);const code=secret(),proof=secret(),credentialPart=secret();
  await store.createConnectionWithHandoff({id,accountId:`diffuse-test-${id}`,login:'diffuse-sql-test',displayName:'Disposable SQL test',extensionId:extension,tokensCiphertext:cipher.encrypt(`tokens:${id}`,{accessToken:'test-expired',refreshToken:'test-refresh',expiresAt:now-1,refreshExpiresAt:now+3600000})},{codeHash:hash(code),challenge:proof,expiresAt:now+60000});
  assert.equal(await store.completeHandoff({codeHash:hash(code),challenge:secret(),credentialHash:hash(credentialPart),extensionIds:[extension],now}),null);
  const handoffs=await Promise.all([0,1].map(()=>store.completeHandoff({codeHash:hash(code),challenge:proof,credentialHash:hash(credentialPart),extensionIds:[extension],now})));assert.equal(handoffs.filter(Boolean).length,1);
  let refreshes=0;
  const auth=createGitHubAuth({store,cryptoKey:testKey,allowedExtensionIds:[extension],api:{async refreshTokens(){refreshes++;await new Promise(resolve=>setTimeout(resolve,20));return {accessToken:'test-new',refreshToken:'test-rotated',expiresAt:now+3600000,refreshExpiresAt:now+7200000};}},clock:()=>now});
  await Promise.all(Array.from({length:6},()=>auth.withAccessToken(`${id}.${credentialPart}`,async token=>assert.equal(token,'test-new'))));assert.equal(refreshes,1);
  await assert.rejects(()=>auth.withAccessToken(`${id}.${credentialPart}`,async()=>{throw new Error('mock-operation-failed');}),/mock-operation-failed/);
  assert.equal(cipher.decrypt(`tokens:${id}`,(await store.getConnection(id)).tokensCiphertext).refreshToken,'test-rotated');

  const repoId=7_000_000_000+randomInt(1000000),reviewKey=randomUUID(),findingKey=randomUUID(),commentId=100,actor=await auth.authenticate(`${id}.${credentialPart}`);
  let writeCount=0,readDenied=false;const pullUrl='https://github.com/diffuse-sql-test/disposable/pull/1';
  const api={async getPull(token,url){if(readDenied)throw new GitHubError('repository_unavailable');return {...parsePullUrl(url),title:'Disposable SQL test',headSha:'a'.repeat(40),repoId,canWrite:true,private:true,state:'open'};},async upload(){return `https://github.com/user-attachments/assets/${randomUUID()}`;},async findSummary(){return null;},async writeSummary(pull){writeCount++;return {id:commentId,url:`${pull.url}#issuecomment-${commentId}`};}};
  const reviews=createGitHubReviews({store,api,cryptoKey:testKey,clock:()=>now}),then=new Date(now-3600000).toISOString(),dataUrl=`data:image/png;base64,${Buffer.alloc(430000,11).toString('base64')}`;
  const input={format:'diffuse-review',version:1,exportedAt:then,review:{reviewKey,title:'Disposable database test',createdAt:then,productionUrl:'https://preview.test/item/1',mode:'audit',comments:[{findingKey,createdAt:then,mode:'audit',fields:{comment:'SQL smoke test finding',state:'Current state',severity:'minor',category:'ux-issue'},context:{production:{url:'https://preview.test/item/1',capturedAt:then,viewport:{width:1200,height:800},scroll:{x:0,y:0}}},evidence:{production:{dataUrl,width:1200,height:800,capturedAt:then}}}]}};
  const bytes=Buffer.from(JSON.stringify(input));assert(bytes.length>GITHUB_CHUNK_BYTES);
  const prepared=await reviews.prepare({accessToken:'mock',connection:actor,input:{pullUrl,reviewKey,expectedRevision:0,byteLength:bytes.length,sha256:hash(bytes),chunkCount:Math.ceil(bytes.length/GITHUB_CHUNK_BYTES),reviewedSha:'a'.repeat(40),previewUrl:'https://preview.test/',includeEvidence:true}});own.reviewIds.push(prepared.id);
  const uploadChunks=()=>Promise.all(Array.from({length:Math.ceil(bytes.length/GITHUB_CHUNK_BYTES)},(_,index)=>reviews.putChunk({id:prepared.id,accessToken:'mock',connection:actor,input:{index,dataBase64:bytes.subarray(index*GITHUB_CHUNK_BYTES,(index+1)*GITHUB_CHUNK_BYTES).toString('base64')}})));
  await uploadChunks();await uploadChunks();assert.equal((await store.chunks(prepared.id,hash(bytes))).length,2);
  let published;for(let count=0;count<5;count++){published=await reviews.publish({id:prepared.id,accessToken:'mock',connection:actor});if(published.done)break;}assert.equal(published.done,true);assert.equal(published.review.revision,1);assert.equal(writeCount,1);
  const competing=await Promise.allSettled([0,1].map(i=>reviews.event({id:prepared.id,accessToken:'mock',connection:{...actor,login:'diffuse-sql-test-recipient'},input:{id:randomUUID(),expectedRevision:1,findingKey,status:'ready-for-recheck',buildSha:'a'.repeat(40),previewUrl:'https://preview.test/',evidence:{dataUrl,width:1200,height:800,capturedAt:new Date(now).toISOString(),pageUrl:'https://preview.test/item/1'},note:`Competing event ${i}`}})));
  assert.equal(competing.filter(v=>v.status==='fulfilled').length,1);assert.equal(competing.find(v=>v.status==='rejected').reason.code,'review_changed');
  const description=await reviews.get({id:prepared.id,accessToken:'mock'}),download=[];for(let index=0;index<description.chunkCount;index++)download.push(Buffer.from((await reviews.get({id:prepared.id,accessToken:'mock',index})).dataBase64,'base64'));
  const received=Buffer.concat(download);assert.equal(hash(received),description.sha256);const downloaded=JSON.parse(received);assert.equal(downloaded.review.comments[0].verifications.length,1);assert.equal(description.review.revision,2);
  await reviews.prepare({accessToken:'mock',connection:actor,input:{pullUrl,reviewKey,expectedRevision:2,byteLength:bytes.length,sha256:hash(bytes),chunkCount:Math.ceil(bytes.length/GITHUB_CHUNK_BYTES),reviewedSha:'a'.repeat(40),previewUrl:'https://preview.test/',includeEvidence:true}});
  const writeBefore=writeCount,write=api.writeSummary;let began,release;
  const started=new Promise(resolve=>began=resolve),gate=new Promise(resolve=>release=resolve);
  api.writeSummary=async(...args)=>{began();await gate;return write(...args);};
  const first=reviews.publish({id:prepared.id,accessToken:'mock',connection:actor});await started;
  const retry=reviews.publish({id:prepared.id,accessToken:'mock',connection:actor});release();
  const pair=await Promise.all([first,retry]);assert.equal(pair[0].review.revision,3);assert.equal(pair[1].review.revision,3);assert.equal(writeCount,writeBefore+1);
  const row=await store.getReview(prepared.id);assert(!JSON.stringify(row).includes('SQL smoke test finding'));assert(!row.bundleCiphertext.includes('base64,'));
  readDenied=true;await assert.rejects(()=>reviews.get({id:prepared.id,accessToken:'mock',index:0}),e=>e.code==='repository_unavailable');
  console.log('PASS: real PostgreSQL one-use state/handoff, serialized refresh, chunk upsert, encrypted bundle roundtrip, optimistic cross-person conflict, serialized publication retry and permission recheck. GitHub HTTP remained mocked.');
}catch(error){console.error(`GitHub SQL smoke test failed: ${error instanceof assert.AssertionError?'assertion failed':error instanceof GitHubError?error.code:'database or test setup unavailable'}. Credentials and provider data were not logged.`);process.exitCode=1;}
finally{
  if(pool){try{for(const id of own.reviewIds)await pool.query('DELETE FROM diffuse_github_reviews WHERE id=$1',[id]);for(const id of own.connectionIds)await pool.query('DELETE FROM diffuse_github_connections WHERE id=$1',[id]);for(const stateHash of own.stateHashes)await pool.query('DELETE FROM diffuse_github_oauth_states WHERE state_hash=$1',[stateHash]);console.log('Disposable GitHub test rows removed.');}catch{console.error('Could not remove all disposable test rows.');process.exitCode=1;}await pool.end();}
}
