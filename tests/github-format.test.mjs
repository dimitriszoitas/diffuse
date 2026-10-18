import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatGitHubSummary} from '../extension/github-format.mjs';

const oldSha='a'.repeat(40),sha='b'.repeat(40),image='data:image/png;base64,aW1hZ2U=',video='data:video/webm;base64,dmlkZW8=';
const asset=id=>`https://github.com/user-attachments/assets/00000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const event=(id,status='ready-for-recheck',dataUrl=image)=>({id,status,buildSha:sha,previewUrl:'https://preview.test/',checkedAt:'2026-10-19T12:00:00.000Z',reviewer:{login:'recipient'},note:'Adjusted the spacing.',evidence:{dataUrl,kind:dataUrl===video?'recording':'screenshot'}});
const fixture=()=>({format:'diffuse-review',version:1,review:{reviewKey:'portable-review',title:'Review',prContext:{reviewedSha:oldSha},comments:[{findingKey:'portable-finding',fields:{comment:'Align the primary action.',category:'ux-issue',severity:'minor'},context:{production:{url:'https://preview.test/account',viewport:{width:390,height:844}}},evidence:{production:{dataUrl:image},video:{dataUrl:video}},verifications:[]}]}});
const assets=[{key:'portable-finding:image',url:asset(1)},{key:'portable-finding:video',url:asset(2)},{key:'check-first:verification',url:asset(3)},{key:'check-second:verification',url:asset(4)}];

test('PR shows original and updated screenshot with the authenticated event actor and build',()=>{
  const bundle=fixture();bundle.review.comments[0].verifications=[event('check-first')];
  const text=formatGitHubSummary(bundle,{pull:{headSha:sha},assets,author:{login:'author'}});
  assert.match(text,/\*\*Original capture\*\*/);assert.match(text,/\*\*Updated capture\*\*/);
  assert(text.indexOf(asset(1))<text.indexOf(asset(3)));assert(text.includes(`![Original screenshot](${asset(1)})`));assert(text.includes(`![Updated screenshot](${asset(3)})`));
  assert(text.includes(`Ready for recheck by recipient · Build \`${sha}\``));assert(text.includes(`Reviewed commit \`${oldSha}\``));
  assert(!text.includes('**Verified**'));assert(text.includes('Shared by author'));
});
test('recordings use standalone native GitHub attachment URLs for both original and changed behavior',()=>{
  const bundle=fixture();bundle.review.comments[0].verifications=[event('check-first','ready-for-recheck',video)];
  const text=formatGitHubSummary(bundle,{pull:{headSha:sha},assets});
  for(const url of [asset(2),asset(3)])assert(text.split('\n').includes(url));
  assert(text.includes('**Updated recording**'));assert(!text.includes(`![Updated screenshot](${asset(3)})`));
});
test('a new commit requires recheck and earlier proof remains identified as historical',()=>{
  const bundle=fixture();bundle.review.comments[0].verifications=[event('check-first','ready-for-recheck'),event('check-second','verified')];
  const text=formatGitHubSummary(bundle,{pull:{headSha:'c'.repeat(40)},assets});
  assert(text.includes('**Needs recheck on the current build**'));assert(text.includes('This capture is from an earlier commit. Recheck the current build.'));
  assert(text.includes('Earlier updates'));assert(text.includes(`View this capture](${asset(3)})`));assert(text.includes(`![Updated screenshot](${asset(4)})`));
});
test('a later remap request does not hide the latest changed capture',()=>{
  const bundle=fixture();const remap=event('remap-request','needs-remap');delete remap.evidence;
  bundle.review.comments[0].verifications=[event('check-first'),remap];
  const text=formatGitHubSummary(bundle,{pull:{headSha:sha},assets});
  assert(text.includes('**Needs remapping**'));assert(text.includes(`![Updated screenshot](${asset(3)})`));assert(text.includes('Last update: Needs remapping'));
});
test('only provider-selected native attachment URLs enter proof output and user prose remains escaped',()=>{
  const bundle=fixture();const check=event('check-first');check.note='<script> @everyone';bundle.review.comments[0].verifications=[check];
  const text=formatGitHubSummary(bundle,{pull:{headSha:sha},assets:[...assets.filter(a=>a.key!=='check-first:verification'),{key:'check-first:verification',url:'https://attacker.test/pixel'}]});
  assert(!text.includes('https://attacker.test'));assert(!text.includes('<script>'));assert(!text.includes('@everyone'));assert(text.includes('Updated screenshot will be attached when published'));
});
test('publication and preview use exactly the same renderer',async()=>{
  const [extension,backend]=await Promise.all(['../extension/github-format.mjs','../backend/github-format.mjs'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
  assert.equal(backend,extension);
});
