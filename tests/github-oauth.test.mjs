import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createGitHubApi} from '../backend/github-api.mjs';
import {createGitHubAuth} from '../backend/github-auth.mjs';
import {createGitHubCipher,hash,secret,verifierChallenge} from '../backend/github-security.mjs';

const cryptoKey=Buffer.alloc(32,21).toString('base64'),extensionId='a'.repeat(32),now=Date.parse('2026-10-19T00:00:00Z');
const user={accountId:'123',login:'reviewer',displayName:'Reviewer'};
const gho='gho_'+'a'.repeat(36),ghu='ghu_'+'b'.repeat(36),ghr='ghr_'+'c'.repeat(36);
function store(){const states=new Map(),connections=new Map(),handoffs=new Map(),locks=new Map();return {states,connections,
  async putState(v){states.set(v.stateHash,v);},async consumeState(h,t){const v=states.get(h);states.delete(h);return v?.expiresAt>t?v:null;},
  async createConnectionWithHandoff(c,h){connections.set(c.id,{...c,pendingExpiresAt:h.expiresAt});handoffs.set(h.codeHash,{...h,id:c.id});},
  async completeHandoff({codeHash,challenge,credentialHash,now}){const h=handoffs.get(codeHash);if(!h||h.challenge!==challenge||h.expiresAt<=now)return null;handoffs.delete(codeHash);const c=connections.get(h.id);Object.assign(c,{credentialHash,pendingExpiresAt:null});return c;},
  async getConnection(id){return connections.get(id);},async withConnectionLock(id,action){let release;const previous=locks.get(id)||Promise.resolve();locks.set(id,new Promise(resolve=>{release=resolve;}));await previous;try{return await action(connections.get(id),async value=>{connections.get(id).tokensCiphertext=value;});}finally{release();}}
};}
function api(fetchImpl){return createGitHubApi({clientId:'Iv1.legacy',clientSecret:'legacy-secret',oauthClientId:'ordinary-oauth-client',oauthClientSecret:'ordinary-oauth-secret',publicOrigin:'https://diffuse.test',appId:42,privateKey:'unused',appSlug:'diffuse-test',clock:()=>now,fetchImpl});}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('single OAuth sign-in pins explicit public/private scope with PKCE and separate client credentials',async()=>{
  for(const privateRepositoryAccess of [false,true]){
    const db=store(),proof=secret(),requests=[],scope=privateRepositoryAccess?'repo':'public_repo';
    const provider=api(async(url,options)=>{requests.push({url,options});if(url.endsWith('/access_token'))return json({access_token:gho,token_type:'bearer',scope});return json({id:123,login:'reviewer',name:'Reviewer'});});
    const auth=createGitHubAuth({store:db,api:provider,cryptoKey,allowedExtensionIds:[extensionId],clock:()=>now});
    const started=await auth.start({extensionId,challenge:verifierChallenge(proof),privateRepositoryAccess}),url=new URL(started.authorizationUrl);
    assert.equal(url.searchParams.get('client_id'),'ordinary-oauth-client');assert.equal(url.searchParams.get('scope'),`${scope} offline_access`);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),'https://diffuse.test/github/oauth/callback');
    const sealed=db.states.get(hash(url.searchParams.get('state'))),payload=createGitHubCipher(cryptoKey).decrypt(`oauth:${sealed.stateHash}`,sealed.verifierCiphertext);
    assert.equal(payload.provider,'oauth');assert.equal(payload.scope,scope);assert.equal(verifierChallenge(payload.verifier),url.searchParams.get('code_challenge'));
    const result=await auth.callback({state:url.searchParams.get('state'),code:'valid-code'}),handoff=new URL(result.redirectUrl).searchParams.get('code');
    const completed=await auth.complete({code:handoff,verifier:proof});assert.equal(completed.connection.accountId,'123');
    const exchange=JSON.parse(requests[0].options.body);assert.equal(exchange.client_id,'ordinary-oauth-client');assert.equal(exchange.client_secret,'ordinary-oauth-secret');assert.equal(exchange.code_verifier,payload.verifier);assert.equal(exchange.redirect_uri,'https://diffuse.test/github/oauth/callback');
    const stored=db.connections.get(completed.connection.id),pair=createGitHubCipher(cryptoKey).decrypt(`tokens:${stored.id}`,stored.tokensCiphertext);
    assert.deepEqual(pair,{kind:'oauth',accessToken:gho,scope});assert(!JSON.stringify(completed).includes(gho));
    assert.equal(await auth.withAccessToken(completed.connection.credential,async token=>token),gho);
    await assert.rejects(()=>auth.callback({state:url.searchParams.get('state'),code:'valid-code'}),e=>e.code==='invalid_state');
  }
});

test('private scope requires a real boolean choice and cannot be widened through callback parameters',async()=>{
  const db=store(),calls=[],provider={authorizationUrl:p=>{calls.push(p);return `https://github.com/login/oauth/authorize?state=${p.state}`;},exchangeCode:async p=>{calls.push(p);return {kind:'oauth',accessToken:gho,scope:'public_repo'};},user:async()=>user};
  const auth=createGitHubAuth({store:db,api:provider,cryptoKey,allowedExtensionIds:[extensionId],clock:()=>now});
  await assert.rejects(()=>auth.start({extensionId,challenge:verifierChallenge(secret()),privateRepositoryAccess:'true'}),e=>e.code==='invalid_request');
  const started=await auth.start({extensionId,challenge:verifierChallenge(secret())});
  await auth.callback({state:new URL(started.authorizationUrl).searchParams.get('state'),code:'code',provider:'github-app',scope:'repo'});
  assert.equal(calls[0].scope,'public_repo');assert.equal(calls[1].scope,'public_repo');assert.equal(calls[1].provider,'oauth');
});

test('existing string-verifier OAuth claims retain their GitHub App exchange and rotating token behavior',async()=>{
  const db=store(),state=secret(),verifier=secret(),proof=secret(),cipher=createGitHubCipher(cryptoKey),requests=[];
  await db.putState({stateHash:hash(state),extensionId,challenge:verifierChallenge(proof),verifierCiphertext:cipher.encrypt(`oauth:${hash(state)}`,verifier),expiresAt:now+600000});
  const provider=api(async(url,options)=>{requests.push({url,options});if(url.endsWith('/access_token'))return json({access_token:ghu,refresh_token:ghr,expires_in:28800,refresh_token_expires_in:15552000});return json({id:123,login:'reviewer'});});
  const auth=createGitHubAuth({store:db,api:provider,cryptoKey,allowedExtensionIds:[extensionId],clock:()=>now}),result=await auth.callback({state,code:'valid-code'});
  assert.equal(JSON.parse(requests[0].options.body).client_id,'Iv1.legacy');assert.equal(JSON.parse(requests[0].options.body).client_secret,'legacy-secret');
  const completed=await auth.complete({code:new URL(result.redirectUrl).searchParams.get('code'),verifier:proof});assert.equal(await auth.withAccessToken(completed.connection.credential,async token=>token),ghu);
  await provider.refreshTokens({refreshToken:ghr});const refreshed=JSON.parse(requests.at(-1).options.body);assert.equal(refreshed.client_id,'Iv1.legacy');assert.equal(refreshed.grant_type,'refresh_token');
});

test('ordinary OAuth tokens have no fake expiry or refresh and revoked tokens require reconnect',async()=>{
  const db=store(),id=randomUUID(),credential=secret(),cipher=createGitHubCipher(cryptoKey);let refreshCalls=0;
  db.connections.set(id,{...user,id,extensionId,pendingExpiresAt:null,credentialHash:hash(credential),tokensCiphertext:cipher.encrypt(`tokens:${id}`,{kind:'oauth',accessToken:gho,scope:'public_repo'})});
  const provider=api(async()=>json({message:'Bad credentials'},401));provider.refreshTokens=async()=>{refreshCalls++;throw Error('must not refresh ordinary OAuth');};
  const auth=createGitHubAuth({store:db,api:provider,cryptoKey,allowedExtensionIds:[extensionId],clock:()=>now+365*86400000});
  assert.equal(await auth.withAccessToken(`${id}.${credential}`,async token=>token),gho);
  await assert.rejects(()=>auth.withAccessToken(`${id}.${credential}`,token=>provider.user(token)),e=>e.code==='unauthorized');assert.equal(refreshCalls,0);
});

test('OAuth token responses reject ungranted, wider, or incomplete expiring credentials',async()=>{
  for(const response of [
    {access_token:gho,token_type:'bearer',scope:'repo'},
    {access_token:gho,token_type:'bearer',scope:''},
    {access_token:ghu,token_type:'bearer',scope:'public_repo'},
    {access_token:gho,token_type:'bearer',scope:'public_repo',expires_in:28800,refresh_token:ghr}
  ])await assert.rejects(()=>api(async()=>json(response)).exchangeCode({code:'code',verifier:secret(),provider:'oauth',scope:'public_repo'}));
});


test('expiring ordinary OAuth credentials use provider-specific refresh and serialize actual expiry rotation',async()=>{
  const db=store(),id=randomUUID(),credential=secret(),cipher=createGitHubCipher(cryptoKey),requests=[];
  const provider=api(async(url,options)=>{requests.push({url,options});return json({access_token:gho,token_type:'bearer',scope:'repo',refresh_token:ghr,expires_in:28800,refresh_token_expires_in:15552000});});
  const pair=await provider.exchangeCode({code:'code',verifier:secret(),provider:'oauth',scope:'repo'});
  assert.equal(pair.kind,'oauth');assert.equal(pair.expiresAt,now+28800000);assert.equal(pair.refreshExpiresAt,now+15552000000);
  db.connections.set(id,{...user,id,extensionId,pendingExpiresAt:null,credentialHash:hash(credential),tokensCiphertext:cipher.encrypt(`tokens:${id}`,{...pair,expiresAt:now-1})});
  const auth=createGitHubAuth({store:db,api:provider,cryptoKey,allowedExtensionIds:[extensionId],clock:()=>now});
  await Promise.all([auth.withAccessToken(`${id}.${credential}`,async token=>assert.equal(token,gho)),auth.withAccessToken(`${id}.${credential}`,async token=>assert.equal(token,gho))]);
  const refreshes=requests.filter(v=>JSON.parse(v.options.body).grant_type==='refresh_token');assert.equal(refreshes.length,1);
  const body=JSON.parse(refreshes[0].options.body);assert.equal(body.client_id,'ordinary-oauth-client');assert.equal(body.client_secret,'ordinary-oauth-secret');assert.equal(body.refresh_token,ghr);
  const stored=cipher.decrypt(`tokens:${id}`,db.connections.get(id).tokensCiphertext);assert.equal(stored.kind,'oauth');assert.equal(stored.expiresAt,now+28800000);
});


test('legacy GitHub App user tokens fail attachment preflight with reconnect rather than uploading',async()=>{
  let calls=0;const provider=api(async()=>{calls++;return json({});});
  await assert.rejects(()=>provider.upload(ghu,{canWrite:true,repoId:12},{name:'evidence.png',contentType:'image/png',bytes:Buffer.from('png')}),e=>e.code==='reconnect_required'&&e.status===409);
  assert.equal(calls,0);
});
