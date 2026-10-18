import {randomUUID} from 'node:crypto';
import {createGitHubCipher,equal,fail,challenge,EXTENSION,hash,parseCredential,secret,verifierChallenge,GitHubError} from './github-security.mjs';

const publicConnection=c=>({id:c.id,accountId:c.accountId,login:c.login,displayName:c.displayName});
export function createGitHubAuth({store,api,cryptoKey,allowedExtensionIds,clock=Date.now}) {
  if(!Array.isArray(allowedExtensionIds)||!allowedExtensionIds.length||allowedExtensionIds.some(id=>!EXTENSION.test(id)))fail('invalid_configuration');
  const ids=new Set(allowedExtensionIds),cipher=createGitHubCipher(cryptoKey);
  const own=(c,h)=>{if(!c||c.pendingExpiresAt||!ids.has(c.extensionId)||!equal(c.credentialHash,h))fail('unauthorized');return c;};
  return {
    async start(input){
      if(!challenge(input?.challenge)||!EXTENSION.test(input?.extensionId)||(input.privateRepositoryAccess!==undefined&&typeof input.privateRepositoryAccess!=='boolean'))fail('invalid_request');if(!ids.has(input.extensionId))fail('installation_not_allowed');
      const state=secret(),verifier=secret(),stateHash=hash(state),provider='oauth',scope=input.privateRepositoryAccess===true?'repo':'public_repo';
      await store.putState({stateHash,challenge:input.challenge,extensionId:input.extensionId,verifierCiphertext:cipher.encrypt(`oauth:${stateHash}`,{verifier,provider,scope}),expiresAt:clock()+600000});
      return {authorizationUrl:api.authorizationUrl({state,challenge:verifierChallenge(verifier),provider,scope})};
    },
    async callback({state,code,error}){
      if(!challenge(state))fail('invalid_state');
      const stateHash=hash(state),claim=await store.consumeState(stateHash,clock());if(!claim||!ids.has(claim.extensionId))fail('invalid_state');
      const base=`https://${claim.extensionId}.chromiumapp.org/github`;
      try {
        if(error!==undefined)fail('access_denied');if(typeof code!=='string'||!/^[A-Za-z0-9_-]{1,1000}$/.test(code))fail('invalid_request');
        const saved=cipher.decrypt(`oauth:${stateHash}`,claim.verifierCiphertext);
        const proof=typeof saved==='string'?{verifier:saved,provider:'github-app'}:saved;
        if(!proof||!challenge(proof.verifier)||!['oauth','github-app'].includes(proof.provider)||(proof.provider==='oauth'&&!['public_repo','repo'].includes(proof.scope)))fail('invalid_state');
        const pair=await api.exchangeCode({code,...proof}),user=await api.user(pair.accessToken);
        const id=randomUUID(),handoff=secret();
        await store.createConnectionWithHandoff({id,...user,extensionId:claim.extensionId,tokensCiphertext:cipher.encrypt(`tokens:${id}`,pair)},{codeHash:hash(handoff),challenge:claim.challenge,expiresAt:clock()+120000});
        return {redirectUrl:`${base}?code=${handoff}`};
      }catch(failure){return {redirectUrl:`${base}?error=${failure instanceof GitHubError?failure.code:'unavailable'}`};}
    },
    async complete({code,verifier}){
      if(!challenge(code))fail('invalid_handoff');let proof;try{proof=verifierChallenge(verifier);}catch{fail('invalid_handoff');}
      const key=secret(),c=await store.completeHandoff({codeHash:hash(code),challenge:proof,credentialHash:hash(key),extensionIds:[...ids],now:clock()});if(!c)fail('invalid_handoff');
      return {connection:{...publicConnection(c),credential:`${c.id}.${key}`}};
    },
    async authenticate(value){const {id,hash:h}=parseCredential(value);return publicConnection(own(await store.getConnection(id),h));},
    async disconnect(value){const {id,hash:h}=parseCredential(value);await store.deleteConnection(id,h);return {disconnected:true};},
    async withAccessToken(value,action){
      const {id,hash:h}=parseCredential(value);
      const authorized=await store.withConnectionLock(id,async(c,save)=>{
        own(c,h);let pair=cipher.decrypt(`tokens:${id}`,c.tokensCiphertext);
        if(pair?.kind==='oauth'){
          if(!/^gho_[A-Za-z0-9_]{10,255}$/.test(pair.accessToken)||!['public_repo','repo'].includes(pair.scope))fail('unavailable');
          if(pair.refreshToken===undefined&&pair.expiresAt===undefined&&pair.refreshExpiresAt===undefined)return {token:pair.accessToken,connection:publicConnection(c)};
        }
        if(!pair?.accessToken||!pair?.refreshToken||!Number.isSafeInteger(pair.expiresAt)||!Number.isSafeInteger(pair.refreshExpiresAt))fail('unavailable');
        if(pair.expiresAt<clock()+60000){if(pair.refreshExpiresAt<clock()+60000)fail('unauthorized');pair=await api.refreshTokens({refreshToken:pair.refreshToken,...(pair.kind==='oauth'?{provider:'oauth',scope:pair.scope}:{})});await save(cipher.encrypt(`tokens:${id}`,pair));}
        return {token:pair.accessToken,connection:publicConnection(c)};
      });
      return action(authorized.token,authorized.connection);
    }
  };
}
