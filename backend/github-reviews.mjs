import {randomUUID} from 'node:crypto';
import {createGitHubCipher,fail,hash,UUID,SHA,PORTABLE_KEY} from './github-security.mjs';
import {parseReviewBundle} from './github-portable.mjs';
import {cleanPreviewUrl,createVerification} from './github-pr-review.mjs';
import {formatGitHubSummary,githubReviewMarker} from './github-format.mjs';

export const GITHUB_CHUNK_BYTES=512*1024;
export const GITHUB_REVIEW_BYTES=20*1024*1024;
const expiry=24*60*60*1000;
const maxFindings=50;
const validRevision=v=>Number.isSafeInteger(v)&&v>=0;
const requireId=id=>{if(!UUID.test(id))fail('invalid_request');};
function media(dataUrl,key){
  const match=/^data:(image\/(?:png|jpeg|webp)|video\/(?:webm|mp4))(?:;codecs=[a-zA-Z0-9., _-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl||'');
  if(!match)fail('invalid_request');const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.toString('base64')!==match[2]||bytes.length>10*1024*1024)fail('too_large');
  const type=match[1],ext=type.split('/')[1];return {key,bytes,contentType:type,name:`diffuse-${hash(key).slice(0,24)}.${ext}`,sha:hash(bytes)};
}
function assetsFor(bundle){
  const items=[];
  for(const comment of bundle.review.comments){
    const production=comment.evidence?.production;
    if(production?.dataUrl)items.push(media(production.annotatedDataUrl||production.dataUrl,`${comment.findingKey}:image`));
    for(const [role,image] of [['prototype',comment.evidence?.prototype],['design-reference',comment.evidence?.designReference],['design-reference-2',comment.evidence?.designReferenceAdditional?.[0]]]){
      if(image?.dataUrl)items.push(media(image.annotatedDataUrl||image.dataUrl,`${comment.findingKey}:${role}`));
    }
    if(comment.evidence?.video?.dataUrl)items.push(media(comment.evidence.video.dataUrl,`${comment.findingKey}:video`));
    // A later remap request has no capture of its own. Keep the same latest
    // proof selected by the PR renderer, and recover its upload if necessary.
    const latest=comment.verifications?.findLast(event=>event.evidence?.dataUrl);
    if(latest?.evidence?.dataUrl)items.push(media(latest.evidence.dataUrl,`${latest.id}:verification`));
  }
  return items;
}

/** Cross-person state lives here, not in a publisher's imported JSON. Every read
 * rechecks current GitHub repository access. Every mutation checks its revision. */
export function createGitHubReviews({store,api,cryptoKey,clock=Date.now}) {
  const cipher=createGitHubCipher(cryptoKey);
  const meta=r=>cipher.decrypt(`bundle:${r.id}:meta`,r.dataCiphertext);
  const bundle=r=>r.bundleCiphertext?cipher.decrypt(`bundle:${r.id}:published`,r.bundleCiphertext):null;
  const saveMeta=(r,data,save,extra={})=>save({...extra,publicationPending:Boolean(data.publication),dataCiphertext:cipher.encrypt(`bundle:${r.id}:meta`,data)});
  const summary=(r,data=meta(r))=>({id:r.id,reviewKey:r.reviewKey,revision:r.revision,pullUrl:r.pullUrl,author:data.author,title:data.title||'Shared review',commentUrl:data.comment?.url||null,publishedAt:data.publishedAt||null,count:data.count||0});
  async function authorize(r,accessToken,write=false){
    if(!r)fail('not_found');const p=await api.getPull(accessToken,r.pullUrl);
    if(p.repoId!==r.repoId||p.number!==r.pullNumber)fail('not_found');if(write&&!p.canWrite)fail('read_only');return p;
  }
  async function candidate(r,data){
    const stage=data.stage;
    if(!stage)fail('conflict');
    if(stage.expiresAt<clock()&&!data.publication)fail('review_changed');
    const rows=await store.chunks(r.id,stage.digest);
    if(rows.length!==stage.chunkCount||rows.some((c,i)=>c.index!==i))fail('invalid_request');
    const bytes=Buffer.concat(rows.map(c=>Buffer.from(cipher.decrypt(`chunk:${r.id}:${stage.digest}:${c.index}`,c.ciphertext),'base64')));
    if(bytes.length!==stage.byteLength||hash(bytes)!==stage.digest)fail('invalid_request');
    let value;try{value=parseReviewBundle(bytes.toString('utf8'));}catch{fail('invalid_request');}
    if(value.review.reviewKey!==r.reviewKey||value.review.comments.length<1||value.review.comments.length>maxFindings||value.review.comments.some(c=>!PORTABLE_KEY.test(c.findingKey)))fail('invalid_request');
    const previous=bundle(r),known=new Map((previous?.review.comments||[]).map(c=>[c.findingKey,c]));
    for(const c of value.review.comments){
      // Imported history cannot impersonate a signed-in person or remove a check.
      const old=known.get(c.findingKey);c.verifications=old?.verifications||[];
      // Original evidence remains immutable across author updates.
      if(old){c.evidence=old.evidence;c.createdAt=old.createdAt;c.context=old.context;c.selection=old.selection;if(old.prSourcePreviewUrl)c.prSourcePreviewUrl=old.prSourcePreviewUrl;}
    }
    // Retain findings that already have shared history, even if absent locally.
    for(const old of known.values())if(!value.review.comments.some(c=>c.findingKey===old.findingKey))value.review.comments.push(old);
    if(value.review.comments.length>maxFindings)fail('too_large');
    value.review.prContext={owner:stage.pull.owner,repo:stage.pull.repo,number:stage.pull.number,url:stage.pull.url,headSha:stage.reviewedSha,reviewedSha:stage.reviewedSha,previewUrl:stage.previewUrl,sourcePreviewUrl:previous?.review.prContext?.sourcePreviewUrl||value.review.prContext?.sourcePreviewUrl||value.review.productionUrl,association:'manual'};
    const normalized=JSON.stringify(value);if(Buffer.byteLength(normalized)>GITHUB_REVIEW_BYTES)fail('too_large');
    try{return parseReviewBundle(value);}catch{fail('invalid_request');}
  }
  async function publishSnapshot({id,accessToken,connection}){
    const initial=await store.getReview(id),pull=await authorize(initial,accessToken,true);
    let send;
    const result=await store.withReviewLock(id,async(r,save)=>{
      const data=meta(r);
      if(!data.stage){if(r.revision>0)return {done:true,review:summary(r,data)};fail('conflict');}
      if(r.authorId!==connection.accountId)fail('author_only');
      if(data.stage.expectedRevision!==r.revision)fail(data.publication?'conflict':'review_changed');
      // A changed PR blocks a new publication, but cannot strand recovery of
      // an already-sent summary. Its originally reviewed SHA stays unchanged.
      if(data.stage.reviewedSha!==pull.headSha&&!data.publication)fail('preview_changed');
      const value=await candidate(r,data),assets=assetsFor(value);
      const sizedAssets=assets.map(a=>({key:a.key,url:'https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000000'}));
      if(formatGitHubSummary(value,{pull,assets:sizedAssets,author:data.author}).length>60000)fail('too_large');
      data.assets||=[];
      const missing=assets.find(a=>!data.assets.some(old=>old.key===a.key&&old.sha===a.sha));
      if(missing){
        const url=await api.upload(accessToken,pull,missing);
        data.assets=data.assets.filter(a=>a.key!==missing.key);data.assets.push({key:missing.key,sha:missing.sha,url});
        await saveMeta(r,data,save);return {done:false,review:summary(r,data),uploadedAssets:assets.filter(a=>data.assets.some(old=>old.key===a.key&&old.sha===a.sha)).length,totalAssets:assets.length};
      }
      const marker=githubReviewMarker(r.reviewKey),body=formatGitHubSummary(value,{pull,assets:data.assets,author:data.author});if(body.length>60000)fail('too_large');
      if(data.publication?.phase==='creating'){
        const found=await api.findSummary(pull,marker);
        if(!found){if(clock()-data.publication.startedAt<30000)return {done:false,waiting:true,review:summary(r,data)};fail('publication_uncertain');}
        data.comment={id:found.id,url:found.url};
      }
      if(!data.comment){const found=await api.findSummary(pull,marker);if(found)data.comment={id:found.id,url:found.url};}
      data.publication={phase:data.comment?'updating':'creating',startedAt:clock()};
      // Persist a create intent before GitHub sees POST. A crash can recover by
      // marker, but must never blindly issue another create request.
      await saveMeta(r,data,save);
      send={r,data,value,body,pull};return null;
    });
    if(result)return result;
    return store.withReviewLock(id,async(r,save)=>{
      const data=meta(r);
      // The intent above is already committed. Serialize the provider write
      // and its revision commit so a delayed retry cannot PATCH stale content
      // after a newer snapshot or recipient check has been published.
      if(!data.stage&&data.lastDigest===send.data.stage.digest)return {done:true,review:summary(r,data)};
      if(r.revision!==send.r.revision||data.stage?.digest!==send.data.stage.digest)fail('conflict');
      const response=await api.writeSummary(send.pull,{commentId:data.comment?.id,body:send.body});
      data.comment=response;data.publication=null;data.lastDigest=data.stage.digest;data.stage=null;data.publishedAt=new Date(clock()).toISOString();data.title=send.value.review.title;data.count=send.value.review.comments.length;
      const revision=r.revision+1;
      await saveMeta(r,data,save,{revision,bundleCiphertext:cipher.encrypt(`bundle:${r.id}:published`,send.value)});
      return {done:true,review:summary({...r,revision},data)};
    });
  }
  return {
    async prepare({accessToken,connection,input}){
      if(!PORTABLE_KEY.test(input.reviewKey)||!validRevision(input.expectedRevision)||!Number.isSafeInteger(input.byteLength)||input.byteLength<1||input.byteLength>GITHUB_REVIEW_BYTES||!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isSafeInteger(input.chunkCount)||input.chunkCount!==Math.ceil(input.byteLength/GITHUB_CHUNK_BYTES)||!SHA.test(input.reviewedSha)||input.includeEvidence!==true)fail('invalid_request');
      let previewUrl;try{previewUrl=cleanPreviewUrl(input.previewUrl);}catch{fail('invalid_request');}
      const pull=await api.getPull(accessToken,input.pullUrl);if(!pull.canWrite)fail('read_only');if(pull.headSha!==input.reviewedSha)fail('preview_changed');
      let row=await store.findReview(pull.repoId,pull.number,input.reviewKey);
      if(!row){if(input.expectedRevision!==0)fail('conflict');const id=randomUUID(),data={author:{login:connection.login,name:connection.displayName},assets:[]};
        row=await store.createReview({id,repoId:pull.repoId,pullNumber:pull.number,reviewKey:input.reviewKey,pullUrl:pull.url,authorId:connection.accountId,dataCiphertext:cipher.encrypt(`bundle:${id}:meta`,data)})||await store.findReview(pull.repoId,pull.number,input.reviewKey);
      }
      return store.withReviewLock(row.id,async(r,save)=>{
        if(r.authorId!==connection.accountId)fail('author_only');const data=meta(r);
        if(data.publication)fail('publication_uncertain');
        if(r.revision!==input.expectedRevision)fail('review_changed');
        data.stage={digest:input.sha256,byteLength:input.byteLength,chunkCount:input.chunkCount,expectedRevision:input.expectedRevision,reviewedSha:input.reviewedSha,previewUrl,pull,expiresAt:clock()+expiry};
        await saveMeta(r,data,save);
        const received=(await store.chunks(r.id,input.sha256)).map(c=>c.index);
        return {id:r.id,revision:r.revision,chunkSize:GITHUB_CHUNK_BYTES,received};
      });
    },
    async putChunk({id,accessToken,connection,input}){
      requireId(id);const r=await store.getReview(id);await authorize(r,accessToken,true);
      return store.withReviewLock(id,async(record)=>{
        const data=meta(record),stage=data.stage;if(record.authorId!==connection.accountId)fail('author_only');
        if(data.publication)fail('publication_uncertain');
        if(!stage||stage.expiresAt<clock()||stage.expectedRevision!==record.revision)fail('review_changed');
        if(!Number.isInteger(input.index)||input.index<0||input.index>=stage.chunkCount||typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(GITHUB_CHUNK_BYTES/3)*4)fail('invalid_request');
        const bytes=Buffer.from(input.dataBase64,'base64'),expected=input.index===stage.chunkCount-1?stage.byteLength-input.index*GITHUB_CHUNK_BYTES:GITHUB_CHUNK_BYTES;
        if(bytes.length!==expected||bytes.toString('base64')!==input.dataBase64)fail('invalid_request');
        await store.putChunk({id,digest:stage.digest,index:input.index,ciphertext:cipher.encrypt(`chunk:${id}:${stage.digest}:${input.index}`,input.dataBase64),expiresAt:stage.expiresAt});return {received:input.index};
      });
    },
    async publish(input){requireId(input.id);return publishSnapshot(input);},
    async list({accessToken,pullUrl}){const pull=await api.getPull(accessToken,pullUrl);return {pull,reviews:(await store.listReviews(pull.repoId,pull.number)).map(r=>summary(r))};},
    async get({id,accessToken,index}){
      requireId(id);const r=await store.getReview(id);await authorize(r,accessToken);if(!r.bundleCiphertext)fail('not_found');
      const data=Buffer.from(JSON.stringify(bundle(r)));
      if(index!==undefined){if(!Number.isInteger(index)||index<0||index>=Math.ceil(data.length/GITHUB_CHUNK_BYTES))fail('invalid_request');return {revision:r.revision,index,dataBase64:data.subarray(index*GITHUB_CHUNK_BYTES,(index+1)*GITHUB_CHUNK_BYTES).toString('base64')};}
      return {review:summary(r),byteLength:data.length,sha256:hash(data),chunkCount:Math.ceil(data.length/GITHUB_CHUNK_BYTES),chunkSize:GITHUB_CHUNK_BYTES};
    },
    async event({id,accessToken,connection,input}){
      requireId(id);if(!validRevision(input.expectedRevision)||!PORTABLE_KEY.test(input.findingKey)||!SHA.test(input.buildSha)||(input.id!==undefined&&!UUID.test(input.id)))fail('invalid_request');
      const initial=await store.getReview(id),pull=await authorize(initial,accessToken,true);
      const result=await store.withReviewLock(id,async(r,save)=>{
        const value=bundle(r),data=meta(r);if(!value)fail('not_found');
        const finding=value.review.comments.find(c=>c.findingKey===input.findingKey);if(!finding)fail('not_found');
        if(input.id){const existing=(finding.verifications||[]).find(v=>v.id===input.id);if(existing){if(existing.reviewer.login!==connection.login)fail('conflict');return {event:existing,review:summary(r,data),alreadySaved:true};}}
        if(input.buildSha!==pull.headSha)fail('preview_changed');
        // Uploading a newer author snapshot does not lock out the recipient.
        // This event advances revision, making that staged snapshot conflict
        // rather than overwriting the recipient's newly recorded result.
        if(r.revision!==input.expectedRevision||data.publication)fail('review_changed');
        let event;try{event=createVerification({...input,reviewer:{login:connection.login,name:connection.displayName}}, {comment:finding,context:{...value.review.prContext,headSha:pull.headSha,previewUrl:input.previewUrl},now:new Date(clock()).toISOString(),uuid:()=>input.id||randomUUID()});}catch{fail(['ready-for-recheck','verified','still-present'].includes(input.status)?'needs_evidence':'invalid_request');}
        finding.verifications=[...(finding.verifications||[]),event];
        if(Buffer.byteLength(JSON.stringify(value))>GITHUB_REVIEW_BYTES)fail('too_large');
        if(event.evidence){const asset=media(event.evidence.dataUrl,`${event.id}:verification`);const url=await api.upload(accessToken,pull,asset);data.assets.push({key:asset.key,sha:asset.sha,url});}
        const body=formatGitHubSummary(value,{pull,assets:data.assets,author:data.author});if(body.length>60000)fail('too_large');
        // PATCH is idempotent. Keep local event history even if summary refresh
        // fails; retrying the same event only repeats the summary update.
        const revision=r.revision+1;data.summaryPending=true;
        await saveMeta(r,data,save,{revision,bundleCiphertext:cipher.encrypt(`bundle:${id}:published`,value)});
        return {event,review:summary({...r,revision},data)};
      });
      try{
        await store.withReviewLock(id,async(r,save)=>{const data=meta(r);if(!data.summaryPending)return;await api.writeSummary(pull,{commentId:data.comment.id,body:formatGitHubSummary(bundle(r),{pull,assets:data.assets,author:data.author})});data.summaryPending=false;await saveMeta(r,data,save);});
        return {...result,summaryUpdated:true};
      }catch{return {...result,summaryUpdated:false};}
    }
  };
}
