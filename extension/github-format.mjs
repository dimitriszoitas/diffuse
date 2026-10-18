/** Pure shared renderer. Keep the extension preview byte-identical to publication. */
export const githubReviewMarker = reviewKey => `<!-- diffuse-review:v1:${reviewKey} -->`;
const escape = value => String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g,'\\$1').replace(/@/g,'@\u200b');
const limited=(value,max=1200)=>{const text=String(value??'');return escape(text.slice(0,max))+(text.length>max?'…':'');};
const safeUrl=value=>{try{const u=new URL(value);return u.origin==='https://github.com'&&/^\/user-attachments\/assets\/[a-f0-9-]{36}$/.test(u.pathname)&&!u.search&&!u.hash?u.href:null;}catch{return null;}};
const states={'ready-for-recheck':'Ready for recheck',verified:'Verified','still-present':'Still present','needs-remap':'Needs remapping'};
const updateLabel=event=>`${limited(states[event.status]||event.status,60)} by ${limited(event.reviewer?.login||'Reviewer',100)} · Build \`${event.buildSha}\`${event.checkedAt?` · ${limited(event.checkedAt,50)}`:''}`;
function appendProof(lines,evidence,asset,label) {
  const url=safeUrl(asset?.url),recording=evidence?.kind==='recording'||evidence?.dataUrl?.startsWith('data:video/');
  if(url) {
    // GitHub renders a standalone native video attachment URL as a player.
    if(recording)lines.push('',`**${label} recording**`,'',url);
    else lines.push('',`![${label} screenshot](${url})`);
  } else if(evidence?.dataUrl)lines.push('',`_${label} ${recording?'recording':'screenshot'} will be attached when published._`);
}
export function formatGitHubSummary(bundle,{pull,assets=[],author}={}) {
  const review=bundle.review, context=review.prContext||{};
  const sha=context.reviewedSha||context.headSha||pull?.headSha||'';
  const lines=[githubReviewMarker(review.reviewKey),'## Diffuse visual review','',`**${limited(review.title,300)}**`,`${review.comments.length} ${review.comments.length===1?'finding':'findings'} · Reviewed commit \`${sha}\`${author?.login?` · Shared by ${limited(author.login,100)}`:''}`,'',
    'Open Diffuse on the preview, choose **Load from PR**, and paste this pull request URL to see these findings on the page.','',
    '“Ready for recheck” means the recipient reports a fix. “Verified” means someone checked it with fresh evidence on the recorded build.',''];
  for(const [index,item] of review.comments.entries()){
    const f=item.fields||{}, history=item.verifications||[],latest=history.at(-1);
    const stale=latest&&pull?.headSha&&latest.buildSha!==pull.headSha;
    const state=latest?(stale?'Needs recheck on the current build':states[latest.status]||'Open'):'Open';
    const heading=f.title?.trim()||f.comment?.split('\n')[0]||'Feedback';
    lines.push(`### ${index+1}. ${limited(heading,130)}`,'',`**${state}** · ${limited(f.category||'Feedback',50)} · ${limited(f.severity||'minor',30)}`,'',limited(f.comment,1800));
    if(f.expected)lines.push('',`**Expected:** ${limited(f.expected,800)}`);
    if(f.steps)lines.push('','<details><summary>Steps to reproduce</summary>','',limited(f.steps,1000),'','</details>');
    const viewport=item.context?.production?.viewport,profile=item.context?.production?.viewportProfile?.key;
    let pagePath='';try{pagePath=new URL(item.context?.production?.url).pathname;}catch{}
    if(pagePath||viewport)lines.push('',`Page: ${limited(pagePath||'/',300)}${profile?` · ${limited(profile,30)}`:''}${viewport?` · ${Number(viewport.width)||0} × ${Number(viewport.height)||0}`:''}`);
    const screenshot=assets.find(a=>a.key===`${item.findingKey}:image`),video=assets.find(a=>a.key===`${item.findingKey}:video`);
    if(item.evidence?.production?.dataUrl||item.evidence?.video?.dataUrl)lines.push('','**Original capture**');
    appendProof(lines,item.evidence?.production,screenshot,'Original');
    for(const [role,label,present] of [['prototype','Comparison reference',item.evidence?.prototype],['design-reference','Design reference',item.evidence?.designReference],['design-reference-2','Additional design reference',item.evidence?.designReferenceAdditional?.[0]]]){
      const image=assets.find(a=>a.key===`${item.findingKey}:${role}`);
      if(safeUrl(image?.url))lines.push('',`![${label}](${safeUrl(image.url)})`);
      else if(present?.dataUrl)lines.push('',`_${label} will be attached when published._`);
    }
    appendProof(lines,item.evidence?.video,video,'Original');
    if(latest){
      const updated=history.findLast(event=>event.evidence?.dataUrl);
      if(updated){
        lines.push('','**Updated capture**',updateLabel(updated));
        if(pull?.headSha&&updated.buildSha!==pull.headSha)lines.push('','_This capture is from an earlier commit. Recheck the current build._');
        if(updated.note)lines.push('',limited(updated.note,700));
        appendProof(lines,updated.evidence,assets.find(a=>a.key===`${updated.id}:verification`),'Updated');
      }
      if(latest!==updated){lines.push('',`Last update: ${updateLabel(latest)}`);if(latest.note)lines.push('',limited(latest.note,700));}
      const prior=history.filter(event=>event!==updated&&event!==latest);
      if(prior.length){
        lines.push('','<details><summary>Earlier updates</summary>','');
        for(const event of prior.slice(-5)) {
          lines.push(`- ${updateLabel(event)}`);
          if(event.note)lines.push(`  ${limited(event.note,300)}`);
          const proof=safeUrl(assets.find(asset=>asset.key===`${event.id}:verification`)?.url);
          if(proof)lines.push(`  [View this capture](${proof})`);
        }
        if(prior.length>5)lines.push('',`${prior.length-5} earlier updates remain in the shared review history in Diffuse.`);
        lines.push('','</details>');
      }
    }
    lines.push('',`Finding: \`${item.findingKey}\``,'');
  }
  lines.push('---','Review history and the original evidence stay available in Diffuse.');
  return lines.join('\n');
}
