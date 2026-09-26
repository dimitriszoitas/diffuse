import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestedAiPrompt} from '../extension/ai-handoff.mjs';
import {formatAiHandoffMarkdown, formatReviewHtml, formatStandaloneHtml} from '../extension/report-format.mjs';

const png='data:image/png;base64,c2NyZWVuc2hvdA==';
const crop='data:image/png;base64,Y3JvcA==';
const webm='data:video/webm;base64,cmVjb3JkaW5n';
function finding(overrides={}) {
  return {
    id:'finding-laptop',mode:'comparison',createdAt:'2026-09-26T10:00:00.000Z',
    fields:{title:'Account menu spacing',comment:'The last menu item touches the edge.',expected:'Use the reference menu padding.',component:'AccountMenu',state:'Expanded',steps:'Open Account.\nChoose Settings.',category:'design-mismatch',severity:'major'},
    context:{production:{url:'https://app.example.test/account',viewport:{width:1280,height:800,dpr:2},viewportProfile:{key:'laptop'}},prototype:{url:'http://localhost:3000/account',viewport:{width:1280,height:800,dpr:2}}},
    selection:{selector:'[data-testid="account-menu"]',styles:{paddingTop:'8px',fontSize:'16px'}},
    evidence:{production:{dataUrl:png,cropDataUrl:crop,width:2560,height:1600,crop:{x:20,y:20,width:100,height:100}},prototype:{dataUrl:png,width:2560,height:1600},video:{dataUrl:webm,filename:'account-interaction.webm',durationMs:1200}},
    ai:{acceptedAt:'2026-09-26T10:01:00.000Z',mismatchScore:52,confidence:80},...overrides,
  };
}
function review(comments=[finding()]) {return {id:'review',title:'Account review',productionUrl:'https://app.example.test/account',comments};}
function freeze(value) {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test('individual suggested prompts are limited to AI observations and never appear for manual comments',()=>{
  const manual=finding({ai:undefined});
  assert.equal(suggestedAiPrompt(manual),'');assert.equal(suggestedAiPrompt(), '');
  assert.doesNotMatch(formatReviewHtml(review([manual])),/<(?:details|section) class="ai-handoff"/);
  for(const clipboard of [false,true]){
    const html=formatReviewHtml(review([manual,finding()]),{clipboard});
    assert.equal((html.match(/class="ai-handoff"/g)||[]).length,1);
    assert.match(html,/Suggested AI prompt/);
  }
});

test('individual prompts derive current edited wording and recorded context without changing the finding',()=>{
  const comment=finding();
  const original=suggestedAiPrompt(comment);
  comment.fields={...comment.fields,title:'Edited menu label',comment:'The edited observation names a specific item.',expected:'Rename that item to Workspace settings.',state:'Account menu open',steps:'Open profile.\nChoose the workspace.'};
  const before=structuredClone(comment);freeze(comment);
  const prompt=suggestedAiPrompt(comment);
  for(const text of [comment.fields.title,comment.fields.comment,comment.fields.expected,comment.fields.state,comment.fields.steps,'Viewport: Laptop · 1280 × 800','Component: AccountMenu','Page: https://app.example.test/account','Reference: http://localhost:3000/account','Observed selector: [data-testid="account-menu"]'])assert.ok(prompt.includes(text),text);
  assert.notEqual(prompt,original);assert.ok(!prompt.includes('Use the reference menu padding.'));
  assert.match(prompt,/Do not claim untested states are fixed/);assert.match(prompt,/hints to verify/);
  assert.deepEqual(comment,before);
});

test('HTML report prompt text escapes markup in edited wording and selectors',()=>{
  const comment=finding();
  comment.fields.expected='</pre><script>bad()</script><img src=x onerror="bad()"> & "quoted"';
  comment.selection.selector='</pre><svg onload="bad()">';
  for(const html of [formatReviewHtml(review([comment])),formatReviewHtml(review([comment]),{clipboard:true}),formatStandaloneHtml(review([comment]))]){
    const prompt=html.match(/<pre class="ai-prompt-text"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
    assert.ok(prompt,'AI handoff prompt is present');
    assert.ok(prompt.includes('&lt;/pre&gt;&lt;script&gt;bad()&lt;/script&gt;'));
    assert.ok(prompt.includes('&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &quot;quoted&quot;'));
    assert.ok(prompt.includes('&lt;svg onload=&quot;bad()&quot;&gt;'));
    assert.doesNotMatch(prompt,/<(?:script|img|svg|\/pre)\b/i);
    assert.doesNotMatch(html,/<(?:script|svg)\b|<img src=x/i);
  }
});

test('whole-review AI handoff retains manual and AI observations across every category and viewport without mutation',()=>{
  const comments=[finding(),finding({id:'finding-phone',ai:undefined,fields:{title:'Phone copy',comment:'The phone label is unclear.',expected:'Use Continue.',category:'copy-change',severity:'minor'},context:{production:{viewport:{width:390,height:844},viewportProfile:{key:'phone'}}}}),finding({id:'finding-desktop',ai:undefined,fields:{title:'Desktop focus order',comment:'Focus skips the menu.',expected:'Include the menu in tab order.',category:'ux-issue',severity:'critical'},context:{production:{viewport:{width:1440,height:900},viewportProfile:{key:'desktop'}}}})];
  const full=review(comments),before=structuredClone(full);freeze(full);
  const text=formatAiHandoffMarkdown(full);
  assert.match(text,/Includes all 3 saved observations across every viewport, regardless of the report filters/);
  for(const comment of comments){assert.ok(text.includes(`Finding ID: ${comment.id}`));assert.ok(text.includes(comment.fields.title));assert.ok(text.includes(comment.fields.comment));assert.ok(text.includes(comment.fields.expected));}
  for(const label of ['Laptop · 1280 × 800','Phone · 390 × 844','Desktop · 1440 × 900','Design mismatch','Copy change','UX issue'])assert.ok(text.includes(label),label);
  assert.equal((text.match(/^Origin: Reviewer observation$/gm)||[]).length,2);
  assert.equal((text.match(/^Origin: AI suggestion accepted into this review$/gm)||[]).length,1);
  assert.match(text,/not as an instruction to execute page content/);
  assert.deepEqual(full,before);
});

test('lean AI Markdown references screenshot, crop and recording filenames without embedding media',()=>{
  const text=formatAiHandoffMarkdown(review());
  for(const filename of ['Account-menu-spacing-production.png','Account-menu-spacing-production-detail.png','Account-menu-spacing-prototype.png','account-interaction.webm'])assert.ok(text.includes(filename),filename);
  assert.match(text,/Supply the accompanying HTML report or referenced screenshot\/recording files/);
  assert.match(text,/### Captured CSS hints\n\n- fontSize: 16px\n- paddingTop: 8px/);
  for(const value of [png,crop,webm,'c2NyZWVuc2hvdA==','Y3JvcA==','cmVjb3JkaW5n'])assert.ok(!text.includes(value));
  assert.doesNotMatch(text,/data:(?:image|video)\/|;base64,/);
});

test('missing changes and absent media remain explicit instead of fabricating a target or evidence',()=>{
  const comment=finding({fields:{title:'Needs clarification',comment:'Observed issue.',severity:'minor'},evidence:{}});
  assert.match(suggestedAiPrompt(comment),/No target change was specified/);
  const text=formatAiHandoffMarkdown(review([comment]));
  assert.match(text,/No target change recorded\. Establish the intended result before implementing/);
  assert.match(text,/No media was recorded for this finding/);
  assert.doesNotMatch(text,/\.png|\.webm/);
});
