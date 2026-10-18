import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonicalPRUrl,PR_ROLE_COPY,safeGitHubReviewLink} from '../extension/github-review.mjs';

test('PR input canonicalizes only a real GitHub pull request destination',()=>{
 assert.equal(canonicalPRUrl(' https://github.com/team/project/pull/42/?tab=files#discussion '),'https://github.com/team/project/pull/42');
 for(const value of ['https://github.com.evil.test/team/project/pull/42','https://user:password@github.com/team/project/pull/42','http://github.com/team/project/pull/42','https://github.com/team/project/issues/42','https://github.com/team/project/pull/0','https://github.com/team/project/pull/42/files','javascript:alert(1)','https://github.com/team/project/pull/42%2f..'])assert.throws(()=>canonicalPRUrl(value),/GitHub pull request link/);
});
test('Review roles describe the activity and never restrict a profession',()=>{
 assert.deepEqual(Object.keys(PR_ROLE_COPY),['reviewer','recipient']);
 const copy=JSON.stringify(PR_ROLE_COPY);assert.doesNotMatch(copy,/engineer|designer|manager|stakeholder/i);
 assert.equal(PR_ROLE_COPY.recipient.label,'Work through feedback');
});

test('The extension publish preview and service renderer stay byte-identical',async()=>{
 const [preview,service]=await Promise.all([readFile(new URL('../extension/github-format.mjs',import.meta.url)),readFile(new URL('../backend/github-format.mjs',import.meta.url))]);assert.deepEqual(preview,service);
});

test('Published links cannot redirect to another repository, account route, or external site',()=>{
 const pr='https://github.com/team/project/pull/42';
 assert.equal(safeGitHubReviewLink(pr+'#issuecomment-123',pr,{comment:true}),pr+'#issuecomment-123');
 for(const url of ['https://github.com.evil.test/team/project/pull/42#issuecomment-1','https://user:pass@github.com/team/project/pull/42#issuecomment-1','https://github.com/another/project/pull/42#issuecomment-1','https://github.com/login/oauth/authorize','javascript:alert(1)',pr+'?redirect=elsewhere#issuecomment-1',pr+'#invalid'])assert.equal(safeGitHubReviewLink(url,pr,{comment:true}),'');
});
