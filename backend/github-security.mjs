import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const messages = {
  invalid_request: 'This GitHub request is invalid.',
  invalid_configuration: 'The GitHub connection is still being configured.',
  installation_not_allowed: 'Install the current official Diffuse release to connect GitHub.',
  invalid_state: 'This GitHub sign-in has expired. Connect again.',
  invalid_handoff: 'This GitHub sign-in could not be completed. Connect again.',
  unauthorized: 'Connect your GitHub account again.',
  reconnect_required: 'Reconnect GitHub to enable screenshots and recordings in pull requests.',
  access_denied: 'GitHub access was not approved.',
  repository_unavailable: 'Give Diffuse access to this repository, then refresh the pull request.',
  read_only: 'Publishing feedback requires write access to this repository. You can still read shared reviews.',
  author_only: 'Only the original author can replace this feedback. You can still recheck findings and update their status.',
  unavailable: 'The GitHub connection service is unavailable. Try again shortly.',
  invalid_response: 'GitHub returned an unexpected response. Try again.',
  rate_limited: 'GitHub is limiting requests. Wait a little and try again.',
  conflict: 'This review changed. Load the latest review before saving your changes.',
  review_changed: 'This review changed. Refresh the feedback and review your changes before trying again.',
  not_found: 'This shared review is unavailable.',
  too_large: 'This review is too large. Publish fewer findings or shorter recordings.',
  upload_failed: 'GitHub could not attach the evidence. Nothing has been silently omitted; retry publishing.',
  publication_uncertain: 'GitHub did not confirm publication. Refresh to check for the existing summary before trying again.',
  needs_evidence: 'Attach a fresh screenshot or recording from the selected build before sharing this update.',
  preview_changed: 'The pull request changed. Confirm the current build before publishing.'
};
export class GitHubError extends Error {
  constructor(code, status) {
    const safe = Object.hasOwn(messages, code) ? code : 'unavailable';
    super(messages[safe]); this.name = 'GitHubError'; this.code = safe;
    this.status = status || ({unauthorized:401,reconnect_required:409,access_denied:401,installation_not_allowed:403,read_only:403,author_only:403,repository_unavailable:404,not_found:404,conflict:409,review_changed:409,preview_changed:409,too_large:413,rate_limited:429,invalid_configuration:503,unavailable:503,publication_uncertain:409,upload_failed:502}[safe] || 400);
  }
}
export function fail(code, status) { throw new GitHubError(code, status); }
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export const PORTABLE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
export const EXTENSION = /^[a-p]{32}$/;
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const challenge = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value,'base64url').toString('base64url') === value;
export function verifierChallenge(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) fail('invalid_request');
  return createHash('sha256').update(value).digest('base64url');
}
export function equal(a,b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex')); }
export function parseCredential(value) {
  if (typeof value !== 'string' || value.length !== 80) fail('unauthorized');
  const [id,key,extra] = value.split('.');
  if (extra || !UUID.test(id) || !challenge(key)) fail('unauthorized');
  return {id,hash:hash(key)};
}
/** Separate encryption domains prevent token, review and Jira ciphertext substitution. */
export function createGitHubCipher(encodedKey) {
  if (typeof encodedKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) fail('invalid_configuration');
  const key = Buffer.from(encodedKey,'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) fail('invalid_configuration');
  const aad = context => {
    if (typeof context !== 'string' || !/^(tokens|oauth|bundle|chunk|asset):[a-zA-Z0-9:_-]{1,200}$/.test(context)) fail('invalid_request');
    return Buffer.from(`diffuse:github:v1:${context}`);
  };
  return {
    encrypt(context,value) {
      const plain = JSON.stringify(value);
      if (Buffer.byteLength(plain) > 30*1024*1024) fail('too_large');
      const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad(context));
      const bytes=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);
      return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),bytes.toString('base64url')].join('.');
    },
    decrypt(context,value) {
      try {
        if (typeof value !== 'string' || value.length > 42*1024*1024) fail('unavailable');
        const [v,iv,tag,data,extra]=value.split('.');
        if (v!=='v1'||extra||!/^[A-Za-z0-9_-]{16}$/.test(iv)||!/^[A-Za-z0-9_-]{22}$/.test(tag)||!/^[A-Za-z0-9_-]+$/.test(data)) fail('unavailable');
        const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url')); decipher.setAAD(aad(context)); decipher.setAuthTag(Buffer.from(tag,'base64url'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'));
      } catch { fail('unavailable'); }
    }
  };
}
export function parsePullUrl(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_request'); }
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  if (url.origin!=='https://github.com'||url.username||url.password||url.search||url.hash||!match||['.','..'].includes(match[2])) fail('invalid_request');
  const [,owner,repo,n]=match; return {owner,repo,number:Number(n),url:`https://github.com/${owner}/${repo}/pull/${n}`};
}
