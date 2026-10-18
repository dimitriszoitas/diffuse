import {createReviewBundle, parseReviewBundle} from './review-transfer.mjs';
import {cleanPRContext, cleanPreviewUrl, cleanCommitSha, createVerification, PR_PROOF_STATUSES} from './pr-review.mjs';

const MAX_BUNDLE_BYTES=20*1024*1024, CHUNK_BYTES=512*1024, PREVIEW_TTL=10*60*1000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APPROVAL_PREFIX='diffuseGitHubApprovalV1:', PUBLISH_PREFIX='diffuseGitHubPublishV1:', EVENT_PREFIX='diffuseGitHubEventV1:', PROOF_PREFIX='diffuseGitHubProofV1:', RECORD_PREFIX='diffuseGitHubRecordingV1:';
const REQUESTS=new Set(['GITHUB_GET_PR','GITHUB_LIST_REVIEWS','GITHUB_PREVIEW','GITHUB_PUBLISH','GITHUB_PUBLICATION_STATUS','GITHUB_LOAD','GITHUB_OPEN_FINDING','GITHUB_RECHECK','GITHUB_CAPTURE_PROOF','GITHUB_START_PROOF_RECORDING','GITHUB_STOP_PROOF_RECORDING','GITHUB_DISCARD_PROOF','GITHUB_SYNC_SUMMARY','GITHUB_REFRESH']);
export const isGitHubRequest=type=>REQUESTS.has(type);
const samePull=(a,b)=>canonicalPullUrl(a).toLowerCase()===canonicalPullUrl(b).toLowerCase();
const hash=async(value,cryptoApi)=>Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',value)),byte=>byte.toString(16).padStart(2,'0')).join('');
const encoded=value=>new TextEncoder().encode(JSON.stringify(value));
const actorMatches=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

export function canonicalPullUrl(value) {
  let url;try{url=new URL(value);}catch{throw new Error('Paste a GitHub pull request URL.');}
  const match=/^\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d._-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/i.exec(url.pathname);
  if(url.origin!=='https://github.com'||url.username||url.password||!match||url.search||url.hash)throw new Error('Use a github.com pull request URL, without a fragment or query.');
  return `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}`;
}
function selectedReview(review,ids) {
  if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('Select between 1 and 50 findings to publish.');
  const comments=ids.map(id=>review.comments.find(comment=>comment.id===id));
  if(comments.some(comment=>!comment))throw new Error('A selected finding has changed. Open the publish preview again.');
  return {...review,comments};
}
function safePull(value,expectedUrl) {
  if(!value||!Number.isSafeInteger(value.number)||value.number<1||typeof value.owner!=='string'||typeof value.repo!=='string'||!samePull(value.url,expectedUrl)||!samePull(value.url,`https://github.com/${value.owner}/${value.repo}/pull/${value.number}`))throw new Error('GitHub returned an unexpected pull request.');
  return {...value,url:`https://github.com/${value.owner}/${value.repo}/pull/${value.number}`,headSha:cleanCommitSha(value.headSha)};
}
function bytesToBase64(bytes) {
  let value='';for(let offset=0;offset<bytes.length;offset+=8192)value+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(value);
}
function verifiedMetadata(value,id) {
  if(!value||!UUID.test(value.id)||(id&&value.id!==id)||!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error('The shared review response could not be verified.');
  return value;
}

/** Trusted worker only. Durable receipts contain approval identifiers and hashes,
 * never account credentials, bundles or screenshots. Pending recheck evidence
 * uses the existing IndexedDB draft store. */
export function createGitHubWorker({client,store,formatSummary,openReview,captureVerification,captureProofRecording,onReviewChanged=async()=>{},cryptoApi=globalThis.crypto,
  storage=globalThis.chrome?.storage?.local,now=()=>Date.now(),maxOperations=12,maxRunMs=12000}={}) {
  const busy=new Set();
  const api=(connectionId,path,options)=>client.request(connectionId,`/github/v1${path}`,options);
  const post=(connectionId,path,body)=>api(connectionId,path,{method:'POST',body});
  const read=async key=>{if(!storage?.get)throw new Error('Reload Diffuse so it can safely resume GitHub updates.');return (await storage.get(key))?.[key];};
  const write=async(key,value)=>{if(!storage?.set)throw new Error('Reload Diffuse so it can safely resume GitHub updates.');await storage.set({[key]:value});};
  const remove=async key=>{await storage.remove(key);};
  const identity=async connectionId=>{const user=await client.refresh(connectionId);if(!user||!/^[-a-z\d]{1,39}$/i.test(user.login))throw new Error('Refresh this GitHub connection before continuing.');return {login:user.login,name:user.displayName||user.login};};
  async function pruneApprovals() {
    const values=await storage.get(null),protectedTokens=new Set(Object.entries(values).filter(([key])=>key.startsWith(PUBLISH_PREFIX)).map(([,value])=>value?.payload?.previewToken));
    const approvals=Object.entries(values).filter(([key])=>key.startsWith(APPROVAL_PREFIX)).sort((a,b)=>(b[1]?.expiresAt||0)-(a[1]?.expiresAt||0));
    let retained=0;
    for(const [key,value] of approvals) {
      if(protectedTokens.has(key.slice(APPROVAL_PREFIX.length)))continue;
      if(value?.expiresAt<now()||retained>=19)await remove(key);else retained++;
    }
  }

  async function getPull(connectionId,url) {
    const prUrl=canonicalPullUrl(url),result=await api(connectionId,`/pull?url=${encodeURIComponent(prUrl)}`);
    return {...result,pull:safePull(result.pull,prUrl)};
  }
  function contextFor(review,pull,message) {
    return cleanPRContext({owner:pull.owner,repo:pull.repo,number:pull.number,url:pull.url,headSha:pull.headSha,
      previewUrl:cleanPreviewUrl(message.previewUrl||review.prContext?.previewUrl||review.productionUrl),sourcePreviewUrl:review.prContext?.sourcePreviewUrl||review.productionUrl,association:'manual',
      ...(message.reviewedSha?{reviewedSha:cleanCommitSha(message.reviewedSha)}:{})});
  }
  async function publicationInput(message,{exportedAt}={}) {
    const review=await store.ensureReviewIdentities(message.reviewId),{pull}=await getPull(message.connectionId,message.prUrl||review.prContext?.url),user=await identity(message.connectionId);
    const context=contextFor(review,pull,message);
    const bundle=createReviewBundle({...selectedReview(review,message.commentIds),prContext:context},{now:exportedAt||new Date(now()).toISOString()});
    const bytes=encoded(bundle);if(bytes.length>MAX_BUNDLE_BYTES)throw new Error('These findings exceed the 20 MB sharing limit. Select fewer findings or shorter recordings.');
    let author=user,expectedRevision=0;
    if(review.prRemote&&review.prContext&&samePull(review.prContext.url,pull.url)) {
      const remote=await api(message.connectionId,`/reviews/${review.prRemote.remoteReviewId}`),metadata=verifiedMetadata(remote.review,review.prRemote.remoteReviewId);
      if(!samePull(metadata.pullUrl,pull.url)||metadata.reviewKey!==review.reviewKey)throw new Error('The existing publication does not match this review.');
      if(!metadata.author?.login)throw new Error('The original publisher could not be verified.');
      author=metadata.author;expectedRevision=metadata.revision;
    }
    const canPublish=pull.canWrite!==false&&actorMatches(author.login,user.login);
    const digest=await hash(encoded({review:bundle.review,pull:pull.url,headSha:pull.headSha,private:pull.private,author:author.login,expectedRevision}),cryptoApi);
    return {review,pull,context,bundle,bytes,digest,user,author,canPublish,expectedRevision};
  }
  function approvedPayload(message,input,token) {
    return {type:'GITHUB_PUBLISH',connectionId:message.connectionId,reviewId:input.review.id,commentIds:[...message.commentIds],prUrl:input.pull.url,previewUrl:input.context.previewUrl,
      ...(input.context.reviewedSha?{reviewedSha:input.context.reviewedSha}:{}),expectedHeadSha:input.pull.headSha,expectedRevision:input.expectedRevision,previewToken:token,previewDigest:input.digest};
  }
  function progress(receipt,waiting=false) {
    return {phase:receipt.phase==='upload'?'upload':'publish',completed:receipt.phase==='upload'?receipt.received.length:receipt.uploadedAssets||0,
      total:receipt.phase==='upload'?receipt.chunkCount:receipt.totalAssets||0,waiting};
  }
  function pendingResult(receipt,waiting=false) {
    return {ok:true,pending:true,canResume:true,message:waiting?'GitHub is confirming the previous publication. Wait a moment, then resume the same update.':'Publication is in progress. Resume to finish sharing the remaining evidence.',progress:progress(receipt,waiting)};
  }
  async function saveRemote(connectionId,response,{reviewId,expectedPullUrl,expectedRemoteId}={}) {
    const metadata=verifiedMetadata(response?.review,expectedRemoteId);
    if(expectedPullUrl&&!samePull(metadata.pullUrl||response.bundle?.review?.prContext?.url,expectedPullUrl))throw new Error('This review belongs to a different pull request.');
    if(!response.bundle) {
      const transfer=response.transfer||response,count=transfer.chunkCount,byteLength=transfer.byteLength,sha256=transfer.sha256;
      if(!Number.isInteger(count)||count<1||count!==Math.ceil(byteLength/CHUNK_BYTES)||!Number.isInteger(byteLength)||byteLength<1||byteLength>MAX_BUNDLE_BYTES||!/^[a-f0-9]{64}$/.test(sha256)||(transfer.chunkSize!==undefined&&transfer.chunkSize!==CHUNK_BYTES))throw new Error('The shared review download could not be verified.');
      const bytes=new Uint8Array(byteLength);let offset=0;
      for(let index=0;index<count;index++) {
        const part=await api(connectionId,`/reviews/${metadata.id}/chunks/${index}`);
        if(part.revision!==metadata.revision||part.index!==index||typeof part.dataBase64!=='string'||part.dataBase64.length>Math.ceil(CHUNK_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(part.dataBase64)||part.dataBase64.length%4)throw new Error('The shared review changed while downloading. Refresh it.');
        const raw=atob(part.dataBase64),expected=Math.min(CHUNK_BYTES,byteLength-offset);
        if(raw.length!==expected||btoa(raw)!==part.dataBase64)throw new Error('A review download chunk is invalid.');
        for(let i=0;i<raw.length;i++)bytes[offset+i]=raw.charCodeAt(i);offset+=raw.length;
      }
      if(offset!==byteLength||await hash(bytes,cryptoApi)!==sha256)throw new Error('The shared review changed while downloading. Refresh it.');
      response={...response,bundle:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
    }
    const bundle=parseReviewBundle(response.bundle);
    if(bundle.review.reviewKey!==metadata.reviewKey||!samePull(bundle.review.prContext?.url,metadata.pullUrl)||expectedPullUrl&&!samePull(bundle.review.prContext?.url,expectedPullUrl))throw new Error('The downloaded review does not match its pull request.');
    const saved=await store.mergePRReviewBundle(bundle,{reviewId,remoteReviewId:metadata.id,remoteRevision:metadata.revision}),localId=saved.id||saved.review?.id;
    if(!localId)throw new Error('The shared review could not be saved.');
    await store.setPRRemoteBinding(localId,{remoteReviewId:metadata.id,remoteRevision:metadata.revision,connectionId,commentUrl:metadata.commentUrl});
    await onReviewChanged(localId);return store.getReview(localId);
  }
  async function refresh(message) {
    const review=await store.getReview(message.reviewId),remote=review.prRemote;
    if(!remote)throw new Error('Publish or load this review from a pull request first.');
    const connectionId=message.connectionId||remote.connectionId,response=await api(connectionId,`/reviews/${remote.remoteReviewId}`);
    if(response.review?.reviewKey!==review.reviewKey)throw new Error('This shared review no longer matches the local review.');
    const saved=await saveRemote(connectionId,response,{reviewId:review.id,expectedPullUrl:review.prContext?.url,expectedRemoteId:remote.remoteReviewId});
    return {ok:true,reviewId:saved.id,review:saved};
  }
  async function publicationStatus(message) {
    const receipt=await read(PUBLISH_PREFIX+message.reviewId),event=await read(EVENT_PREFIX+message.reviewId);
    const matchingEvent=event&&(!message.connectionId||event.connectionId===message.connectionId);
    const result={ok:true,pending:false,summaryPending:!!matchingEvent,...(matchingEvent?{eventPending:true,eventState:event.state,eventMessage:event.state==='sending'?'A previous status update needs confirmation. Sync it before recording another check.':'The status was saved. Sync to refresh the GitHub summary.'}:{})};
    if(!receipt||message.connectionId&&receipt.payload.connectionId!==message.connectionId)return result;
    return {...result,...pendingResult(receipt,receipt.waiting===true),resume:receipt.payload};
  }
  async function finishPublication(receipt,published) {
    const metadata=verifiedMetadata(published?.review,receipt.id);
    if(!metadata.commentUrl||!samePull(metadata.pullUrl,receipt.payload.prUrl)||metadata.reviewKey!==receipt.reviewKey)throw new Error('GitHub has not confirmed the review was published. Resume this publication to recover it.');
    receipt.phase='complete';receipt.completedReview=metadata;await write(PUBLISH_PREFIX+receipt.payload.reviewId,receipt);
    const current=await store.getReview(receipt.payload.reviewId);
    if(!current.prContext||JSON.stringify(current.prContext)===JSON.stringify(receipt.previousContext))await store.setPRReviewContext(receipt.payload.reviewId,receipt.context);
    await store.setPRRemoteBinding(receipt.payload.reviewId,{remoteReviewId:receipt.id,remoteRevision:metadata.revision,connectionId:receipt.payload.connectionId,commentUrl:metadata.commentUrl});
    await onReviewChanged(receipt.payload.reviewId);
    await remove(PUBLISH_PREFIX+receipt.payload.reviewId);await remove(APPROVAL_PREFIX+receipt.payload.previewToken);
    return {ok:true,pending:false,url:metadata.commentUrl,review:await store.getReview(receipt.payload.reviewId)};
  }
  async function publish(message) {
    const receiptKey=PUBLISH_PREFIX+message.reviewId;let receipt=await read(receiptKey);
    if(receipt&&(receipt.payload.connectionId!==message.connectionId||receipt.payload.previewToken!==message.previewToken||receipt.payload.previewDigest!==message.previewDigest))throw new Error('Resume the unfinished publication before starting a different update.');
    const approved=await read(APPROVAL_PREFIX+message.previewToken);
    if(!approved||approved.payload.reviewId!==message.reviewId||approved.payload.connectionId!==message.connectionId||approved.payload.previewDigest!==message.previewDigest||approved.payload.expectedHeadSha!==message.expectedHeadSha||(!receipt&&approved.expiresAt<now()))throw new Error('Open the publish preview before posting this review.');
    const payload=approved.payload;
    if(receipt?.phase==='complete')return finishPublication(receipt,{review:receipt.completedReview});
    const started=now();let operations=0,input;
    const budget=()=>operations<Math.max(1,maxOperations)&&now()-started<maxRunMs;
    if(!receipt||receipt.phase==='upload') {
      input=await publicationInput(payload,{exportedAt:approved.exportedAt});
      if(input.digest!==payload.previewDigest||input.pull.headSha!==payload.expectedHeadSha) {
        // Upload-only staging has never attempted a comment write. A fresh
        // approval may safely replace it; preserve receipts after /publish.
        if(receipt?.phase==='upload'){await remove(receiptKey);await remove(APPROVAL_PREFIX+payload.previewToken);}
        throw Object.assign(new Error('The review or pull request changed. Preview the current findings before publishing.'),{code:'review_changed'});
      }
      if(!input.canPublish)throw new Error('Only the original publisher with repository write access can update this review summary.');
      if(message.expectedRevision!==undefined&&message.expectedRevision!==payload.expectedRevision)throw new Error('The shared review changed. Refresh and preview it again.');
      if(!receipt) {
        const sha256=await hash(input.bytes,cryptoApi),chunkCount=Math.ceil(input.bytes.length/CHUNK_BYTES);
        const transfer=await post(payload.connectionId,'/reviews/prepare',{pullUrl:input.pull.url,reviewKey:input.review.reviewKey,expectedRevision:payload.expectedRevision,byteLength:input.bytes.length,sha256,chunkCount,reviewedSha:input.context.reviewedSha||input.context.headSha,previewUrl:input.context.previewUrl,includeEvidence:true});operations++;
        if(!UUID.test(transfer.id)||transfer.revision!==payload.expectedRevision||transfer.chunkSize!==CHUNK_BYTES||!Array.isArray(transfer.received)||transfer.received.some(index=>!Number.isInteger(index)||index<0||index>=chunkCount))throw new Error('The review upload could not be prepared.');
        receipt={version:1,id:transfer.id,payload,reviewKey:input.review.reviewKey,context:input.context,previousContext:input.review.prContext,exportedAt:approved.exportedAt,byteLength:input.bytes.length,sha256,chunkCount,received:[...new Set(transfer.received)],phase:'upload',createdAt:now()};
        // No chunk or publication write happens before persisting the server ID.
        await write(receiptKey,receipt);
      }
      if(input.bytes.length!==receipt.byteLength||await hash(input.bytes,cryptoApi)!==receipt.sha256)throw new Error('The saved findings changed during upload. Restore the approved review before resuming it.');
      for(let index=0;index<receipt.chunkCount;index++) {
        if(receipt.received.includes(index))continue;
        if(!budget())return pendingResult(receipt);
        const offset=index*CHUNK_BYTES,result=await post(payload.connectionId,`/reviews/${receipt.id}/chunks`,{index,dataBase64:bytesToBase64(input.bytes.subarray(offset,offset+CHUNK_BYTES))});operations++;
        if(result.received!==index)throw new Error('GitHub did not confirm the uploaded review chunk. Resume this publication.');
        receipt.received.push(index);await write(receiptKey,receipt);
      }
      receipt.phase='publish';await write(receiptKey,receipt);
    }
    while(budget()) {
      // Recover this exact endpoint before any new prepare. The service can
      // recover an already-sent older build while rejecting new stale writes.
      let result;
      try {result=await post(payload.connectionId,`/reviews/${receipt.id}/publish`,{});operations++;}
      catch(error) {
        // The service only reports preview_changed when no comment-send
        // intent exists. Unknown outcomes always keep their recovery receipt.
        if(error?.code==='preview_changed'){await remove(receiptKey);await remove(APPROVAL_PREFIX+payload.previewToken);}
        throw error;
      }
      if(result.done===true)return finishPublication(receipt,result);
      if(result.done!==false)throw new Error('GitHub has not confirmed this publication. Resume the same update.');
      if(result.uploadedAssets!==undefined||result.totalAssets!==undefined) {
        if(!Number.isInteger(result.uploadedAssets)||!Number.isInteger(result.totalAssets)||result.uploadedAssets<0||result.totalAssets<result.uploadedAssets||result.totalAssets>300)throw new Error('GitHub returned invalid evidence-upload progress.');
        receipt.uploadedAssets=result.uploadedAssets;receipt.totalAssets=result.totalAssets;
      }
      receipt.waiting=result.waiting===true;await write(receiptKey,receipt);
      if(receipt.waiting)return pendingResult(receipt,true);
    }
    return pendingResult(receipt);
  }
  async function sendEvent(receipt) {
    const draft=await store.getDraft(receipt.draftId),body=draft?.githubEvent?.body||receipt.body;
    let response;
    try {response=await post(receipt.connectionId,`/reviews/${receipt.remoteReviewId}/events`,body);}
    catch(error) {
      // Existing event IDs are recovered before this server check, so this
      // rejection proves this event was not saved: its build/revision changed,
      // or its captured proof is no longer valid. Unknown outcomes stay pending.
      if(['preview_changed','review_changed','needs_evidence'].includes(error?.code)){await store.discardDraft(receipt.draftId);await remove(EVENT_PREFIX+receipt.reviewId);}
      throw error;
    }
    if(response.event?.id!==receipt.eventId||!actorMatches(response.event?.reviewer?.login,receipt.actorLogin)||typeof response.summaryUpdated!=='boolean')throw new Error('GitHub has not confirmed this check. Retry the same update.');
    verifiedMetadata(response.review,receipt.remoteReviewId);
    const firstConfirmation=receipt.state==='sending';
    receipt.state=response.summaryUpdated?'saved':'summary-pending';await write(EVENT_PREFIX+receipt.reviewId,receipt);
    const current=await store.getReview(receipt.reviewId);
    // A late summary retry must not send the recipient back to an older
    // preview they have already moved beyond while waiting for confirmation.
    if(firstConfirmation&&JSON.stringify(current.prContext)===JSON.stringify(receipt.previousContext))await store.setPRReviewContext(receipt.reviewId,receipt.context);
    if(response.bundle)await saveRemote(receipt.connectionId,response,{reviewId:receipt.reviewId,expectedPullUrl:receipt.context.url,expectedRemoteId:receipt.remoteReviewId});
    else await refresh({reviewId:receipt.reviewId,connectionId:receipt.connectionId});
    if(response.summaryUpdated){await store.discardDraft(receipt.draftId);await remove(EVENT_PREFIX+receipt.reviewId);}
    return {ok:true,summaryUpdated:response.summaryUpdated,review:await store.getReview(receipt.reviewId)};
  }
  async function proofInput(message) {
    const review=await store.getReview(message.reviewId),remote=review.prRemote;
    if(!remote)throw new Error('Publish or load this review from GitHub before capturing updated evidence.');
    const connectionId=message.connectionId||remote.connectionId,comment=review.comments.find(item=>item.id===message.commentId);
    if(!comment)throw new Error('This finding is no longer available.');
    const {pull}=await getPull(connectionId,review.prContext?.url);
    if(cleanCommitSha(message.expectedHeadSha)!==pull.headSha)throw new Error('The pull request changed. Open the finding on its current preview.');
    if(pull.canWrite===false)throw new Error('Repository write access is needed to share updated evidence.');
    const context=contextFor(review,pull,message),user=await identity(connectionId);
    const binding={connectionId,reviewId:review.id,remoteReviewId:remote.remoteReviewId,commentId:comment.id,findingKey:comment.findingKey,
      buildSha:context.headSha,previewUrl:context.previewUrl,actorLogin:user.login.toLowerCase()};
    return {review,comment,context,user,binding};
  }
  async function discardProof(reviewId,proofToken) {
    const key=PROOF_PREFIX+reviewId,prior=await read(key);
    if(prior&&(!proofToken||prior.proofToken===proofToken)) {await remove(key);await store.discardDraft(prior.draftId);}
  }
  async function retainProof(input,evidence) {
    // Validation here and at final sharing binds the capture to its route,
    // build and freshness; caller-supplied image data is never accepted.
    createVerification({status:'ready-for-recheck',reviewer:input.user,evidence},
      {comment:input.comment,context:input.context,now:new Date(now()).toISOString(),uuid:()=>cryptoApi.randomUUID()});
    if(evidence.dataUrl.length>2*1024*1024)throw new Error('This capture is too large to share. Record a shorter clip or use a screenshot.');
    const proofToken=cryptoApi.randomUUID(),draftId=`github-proof:${proofToken}`;
    await discardProof(input.review.id);
    await store.putDraft({id:draftId,reviewId:input.review.id,createdAt:new Date(now()).toISOString(),githubProof:{evidence}});
    try {await write(PROOF_PREFIX+input.review.id,{proofToken,draftId,binding:input.binding,expiresAt:now()+PREVIEW_TTL});}
    catch(error){await store.discardDraft(draftId);throw error;}
    return {ok:true,proofToken,evidence,context:input.context};
  }
  async function captureProof(message) {
    const input=await proofInput(message);
    const evidence=await captureVerification(input);
    // Reject a new commit that arrived while the screenshot was processed.
    const {pull}=await getPull(input.binding.connectionId,input.context.url);
    if(pull.headSha!==input.context.headSha)throw new Error('The pull request changed during capture. Capture the updated build again.');
    return retainProof(input,evidence);
  }
  async function recordProof(message) {
    if(typeof captureProofRecording!=='function')throw new Error('Reload Diffuse before recording updated evidence.');
    const key=RECORD_PREFIX+message.reviewId;
    if(message.type==='GITHUB_START_PROOF_RECORDING') {
      const input=await proofInput(message),prior=await read(key);
      if(prior) {
        if(prior.binding.connectionId!==input.binding.connectionId)throw new Error('Select the account that started the previous recording before starting another.');
        // Starting again is an explicit replacement. The media process may
        // already be gone after a restart; cancellation is idempotent.
        await captureProofRecording({action:'cancel',recordingToken:prior.recordingToken});
        await remove(key);
      }
      const result=await captureProofRecording({...input,action:'start'});
      if(!result?.recordingToken)throw new Error('The proof recording could not start.');
      try {await write(key,{recordingToken:result.recordingToken,binding:input.binding});}
      catch(error) {
        await captureProofRecording({action:'cancel',recordingToken:result.recordingToken}).catch(()=>{});
        await remove(key).catch(()=>{});throw error;
      }
      return {ok:true,recordingToken:result.recordingToken,maxDurationMs:30000};
    }
    const recording=await read(key);
    if(!recording||recording.recordingToken!==message.recordingToken||(message.connectionId&&recording.binding.connectionId!==message.connectionId))throw new Error('This recording belongs to a different finding or account.');
    try {
      const input=await proofInput(message);
      if(JSON.stringify(recording.binding)!==JSON.stringify(input.binding))throw new Error('This recording belongs to a different finding or build.');
      const evidence=await captureProofRecording({...input,action:'stop',recordingToken:recording.recordingToken});
      const {pull}=await getPull(input.binding.connectionId,input.context.url);
      if(pull.headSha!==input.context.headSha)throw new Error('The pull request changed during recording. Capture the updated build again.');
      return await retainProof(input,evidence);
    } finally {
      // A rejected capture must not strand recording controls or a durable
      // receipt, including when the PR changed before Stop could run.
      await captureProofRecording({action:'cancel',recordingToken:recording.recordingToken}).catch(()=>{});
      await remove(key);
    }
  }
  async function recheck(message) {
    const review=await store.getReview(message.reviewId),remote=review.prRemote;
    if(!remote)throw new Error('Publish or load this review from GitHub before changing its shared status.');
    const connectionId=message.connectionId||remote.connectionId,comment=review.comments.find(item=>item.id===message.commentId);
    if(!comment)throw new Error('This finding is no longer available.');
    if(!['ready-for-recheck','verified','still-present','needs-remap'].includes(message.status))throw new Error('Choose a finding status.');
    const intent={connectionId,reviewId:review.id,commentId:comment.id,remoteReviewId:remote.remoteReviewId,status:message.status,note:message.note||'',buildSha:cleanCommitSha(message.expectedHeadSha),previewUrl:cleanPreviewUrl(message.previewUrl||review.prContext?.previewUrl)};
    const digest=await hash(encoded(intent),cryptoApi),prior=await read(EVENT_PREFIX+review.id);
    if(prior){if(prior.digest!==digest)throw new Error('Finish syncing the previous check before recording another.');return sendEvent(prior);}
    const {pull}=await getPull(connectionId,review.prContext?.url);
    if(intent.buildSha!==pull.headSha)throw new Error('The pull request changed. Refresh and choose its current preview before rechecking.');
    if(pull.canWrite===false)throw new Error('Repository write access is needed to record a shared check.');
    const context=contextFor(review,pull,message),user=await identity(connectionId);
    let evidence;
    if(PR_PROOF_STATUSES.includes(message.status)) {
      const proof=await read(PROOF_PREFIX+review.id);
      const binding={connectionId,reviewId:review.id,remoteReviewId:remote.remoteReviewId,commentId:comment.id,findingKey:comment.findingKey,
        buildSha:context.headSha,previewUrl:context.previewUrl,actorLogin:user.login.toLowerCase()};
      if(!proof||!message.proofToken||proof.proofToken!==message.proofToken||proof.expiresAt<now()||JSON.stringify(proof.binding)!==JSON.stringify(binding))throw new Error('Capture and preview fresh evidence for this finding before sharing the update.');
      evidence=(await store.getDraft(proof.draftId))?.githubProof?.evidence;
      if(!evidence)throw new Error('This evidence preview expired. Capture it again.');
    }
    const event=createVerification({status:message.status,note:intent.note,reviewer:{login:user.login},...(evidence?{evidence}:{})},{comment,context,now:new Date(now()).toISOString(),uuid:()=>cryptoApi.randomUUID()});
    const body={id:event.id,expectedRevision:message.expectedRevision??remote.remoteRevision,findingKey:comment.findingKey,status:event.status,buildSha:event.buildSha,previewUrl:event.previewUrl,note:event.note};
    const draftId=`github-event:${event.id}`;
    await store.putDraft({id:draftId,reviewId:review.id,createdAt:event.checkedAt,githubEvent:{body:{...body,...(evidence?{evidence}:{})}}});
    const receipt={version:1,eventId:event.id,draftId,reviewId:review.id,connectionId,remoteReviewId:remote.remoteReviewId,actorLogin:user.login,digest,body,context,previousContext:review.prContext,state:'sending'};
    await write(EVENT_PREFIX+review.id,receipt);await discardProof(review.id,message.proofToken);return sendEvent(receipt);
  }
  async function handle(message) {
    if(!REQUESTS.has(message.type))throw new Error('This GitHub action is not supported.');
    if(message.type==='GITHUB_GET_PR')return {ok:true,...await getPull(message.connectionId,message.url||message.prUrl)};
    if(message.type==='GITHUB_LIST_REVIEWS') {
      const url=canonicalPullUrl(message.prUrl),result=await api(message.connectionId,`/reviews?pullUrl=${encodeURIComponent(url)}`);safePull(result.pull,url);return {ok:true,...result};
    }
    if(message.type==='GITHUB_PUBLICATION_STATUS')return publicationStatus(message);
    if(message.type==='GITHUB_PREVIEW') {
      const existing=await read(PUBLISH_PREFIX+message.reviewId);
      if(existing) {
        if(existing.payload.connectionId!==message.connectionId)throw new Error('Select the original publishing account to resume the unfinished update.');
        return {...await publicationStatus(message),requiresResume:true};
      }
      const input=await publicationInput(message),token=cryptoApi.randomUUID(),payload=approvedPayload(message,input,token);
      await pruneApprovals();
      await write(APPROVAL_PREFIX+token,{version:1,payload,exportedAt:input.bundle.exportedAt,expiresAt:now()+PREVIEW_TTL});
      return {ok:true,previewToken:token,previewDigest:input.digest,preview:{markdown:formatSummary(input.bundle,{pull:input.pull,author:input.author}),context:input.context,pull:input.pull,author:input.author,canPublish:input.canPublish,expectedRevision:input.expectedRevision,commentCount:input.bundle.review.comments.length,bytes:input.bytes.length}};
    }
    if(message.type==='GITHUB_REFRESH')return refresh(message);
    if(message.type==='GITHUB_OPEN_FINDING') {
      const review=await store.getReview(message.reviewId);if(!review.prContext)throw new Error('Choose a pull request preview first.');
      const connectionId=message.connectionId||review.prRemote?.connectionId,{pull}=await getPull(connectionId,review.prContext.url);
      if(message.expectedHeadSha&&message.expectedHeadSha!==pull.headSha)throw new Error('The pull request changed. Refresh its details before opening this preview.');
      await store.setPRReviewContext(review.id,contextFor(review,pull,message));
      return openReview({reviewId:review.id,commentId:message.commentId});
    }
    if(message.type==='GITHUB_LOAD') {
      const {pull}=await getPull(message.connectionId,message.prUrl);
      if(message.expectedHeadSha&&message.expectedHeadSha!==pull.headSha)throw new Error('The pull request changed. Refresh its details before opening this preview.');
      if(!UUID.test(message.remoteReviewId))throw new Error('Choose the review you want to open.');
      const response=await api(message.connectionId,`/reviews/${message.remoteReviewId}`),saved=await saveRemote(message.connectionId,response,{expectedPullUrl:pull.url,expectedRemoteId:message.remoteReviewId});
      await store.setPRReviewContext(saved.id,contextFor(saved,pull,message));const opened=await openReview({reviewId:saved.id});return {...opened,ok:true,reviewId:saved.id};
    }
    if(!message.reviewId||busy.has(message.reviewId))throw new Error('Wait for the current GitHub action to finish.');
    busy.add(message.reviewId);
    try {
      if(message.type==='GITHUB_PUBLISH')return await publish(message);
      if(message.type==='GITHUB_CAPTURE_PROOF')return await captureProof(message);
      if(message.type==='GITHUB_START_PROOF_RECORDING'||message.type==='GITHUB_STOP_PROOF_RECORDING')return await recordProof(message);
      if(message.type==='GITHUB_DISCARD_PROOF') {
        const recording=await read(RECORD_PREFIX+message.reviewId);
        if(recording&&recording.recordingToken===message.recordingToken&&recording.binding.connectionId===message.connectionId) {
          await captureProofRecording({action:'cancel',recordingToken:recording.recordingToken});await remove(RECORD_PREFIX+message.reviewId);
        }
        if(message.proofToken)await discardProof(message.reviewId,message.proofToken);
        return {ok:true};
      }
      if(message.type==='GITHUB_RECHECK')return await recheck(message);
      if(message.type==='GITHUB_SYNC_SUMMARY') {
        const receipt=await read(EVENT_PREFIX+message.reviewId);if(!receipt||message.connectionId&&receipt.connectionId!==message.connectionId)throw new Error('There is no pending GitHub summary for this account.');return await sendEvent(receipt);
      }
      throw new Error('This GitHub action is not supported.');
    } catch(error) {
      if(message.type==='GITHUB_PUBLISH'&&['preview_changed','review_changed'].includes(error?.code)) {
        // These server codes explicitly guarantee there is no pending comment
        // send intent. Generic conflicts and uncertain writes retain receipts.
        const receipt=await read(PUBLISH_PREFIX+message.reviewId);
        if(!receipt||receipt.payload.previewToken===message.previewToken){await remove(PUBLISH_PREFIX+message.reviewId);await remove(APPROVAL_PREFIX+message.previewToken);}
      }
      throw error;
    } finally {busy.delete(message.reviewId);}
  }
  return {handle};
}
