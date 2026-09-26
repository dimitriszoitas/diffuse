import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const MESSAGES = Object.freeze({
  invalid_configuration: 'Jira connection settings are invalid.',
  invalid_request: 'The Jira connection request is invalid.',
  invalid_state: 'This Jira sign-in has expired or has already been used. Start again.',
  access_denied: 'Jira access was not approved. Connect the account again.',
  invalid_handoff: 'This Jira connection could not be completed. Start again.',
  unauthorized: 'This Jira connection is unavailable. Connect the account again.',
  no_sites: 'This account has no available Jira sites with the required permissions.',
  invalid_response: 'Jira returned an unexpected response. Connect the account again.',
  unavailable: 'The Jira connection service is unavailable. Try again later.',
  action_failed: 'The Jira request could not be completed. Try again later.'
});

export class JiraAuthError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'unavailable';
    super(MESSAGES[safeCode]);
    this.name = 'JiraAuthError';
    this.code = safeCode;
  }
}

export function failAuth(code) { throw new JiraAuthError(code); }
export function randomSecret() { return randomBytes(32).toString('base64url'); }
export function secretHash(value) {
  if (typeof value !== 'string' || !value.length || value.length > 16_384) failAuth('invalid_request');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function verifierChallenge(verifier) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) failAuth('invalid_request');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function equalHash(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseCredential(credential) {
  if (typeof credential !== 'string' || credential.length !== 80) failAuth('unauthorized');
  const [id, secret, extra] = credential.split('.');
  if (extra !== undefined || !UUID.test(id) || !isChallenge(secret)) failAuth('unauthorized');
  return { id, hash: secretHash(secret) };
}

/** Authenticated encryption is bound to a connection ID, so rows cannot swap tokens.
 * The only accepted configuration is a canonical base64-encoded 32-byte key.
 */
export function createTokenCipher(cryptoKey) {
  if (typeof cryptoKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(cryptoKey)) failAuth('invalid_configuration');
  const key = Buffer.from(cryptoKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== cryptoKey) failAuth('invalid_configuration');
  const aad = id => {
    if (typeof id !== 'string' || !UUID.test(id)) failAuth('invalid_request');
    return Buffer.from(`diffuse:jira:tokens:v1:${id}`, 'ascii');
  };
  return Object.freeze({
    encrypt(id, value) {
      try {
        const plaintext = JSON.stringify(value);
        if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > 65_536) failAuth('invalid_response');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(id));
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
      } catch { failAuth('unavailable'); }
    },
    decrypt(id, value) {
      try {
        if (typeof value !== 'string' || value.length > 88_000) failAuth('unavailable');
        const [version, iv, tag, encrypted, extra] = value.split('.');
        if (version !== 'v1' || extra !== undefined || !/^[A-Za-z0-9_-]{16}$/.test(iv) ||
            !/^[A-Za-z0-9_-]{22}$/.test(tag) || !/^[A-Za-z0-9_-]+$/.test(encrypted)) failAuth('unavailable');
        const buffers = [iv, tag, encrypted].map(item => Buffer.from(item, 'base64url'));
        if (buffers.some((buffer, index) => buffer.toString('base64url') !== [iv, tag, encrypted][index])) failAuth('unavailable');
        const decipher = createDecipheriv('aes-256-gcm', key, buffers[0]);
        decipher.setAAD(aad(id));
        decipher.setAuthTag(buffers[1]);
        return JSON.parse(Buffer.concat([decipher.update(buffers[2]), decipher.final()]).toString('utf8'));
      } catch { failAuth('unavailable'); }
    }
  });
}
