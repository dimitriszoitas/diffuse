import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createTokenCipher, equalHash, isChallenge, JiraAuthError, parseCredential,
  randomSecret, secretHash, verifierChallenge
} from '../backend/security.mjs';

const KEY = Buffer.alloc(32, 19).toString('base64');
const TOKEN = { accessToken: 'fixture-access-private', refreshToken: 'fixture-refresh-private', expiresAt: 42, scopes: ['read:jira-work'] };
const hasCode = code => error => error instanceof JiraAuthError && error.code === code && !String(error).includes('private');

test('opaque capabilities contain 256 random bits and only hashed forms are compared', () => {
  const generated = Array.from({ length: 100 }, randomSecret);
  assert.equal(new Set(generated).size, 100);
  assert.ok(generated.every(value => isChallenge(value) && Buffer.from(value, 'base64url').length === 32));
  const hash = secretHash(generated[0]);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(equalHash(hash, secretHash(generated[0])), true);
  for (const other of [null, '', generated[0], 'g'.repeat(64), 'A'.repeat(64), secretHash(generated[1])]) {
    assert.equal(equalHash(hash, other), false);
    assert.equal(equalHash(other, hash), false);
  }
});

test('verifier challenge matches RFC 7636 S256 vector and rejects malformed verifiers', () => {
  assert.equal(verifierChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  for (const value of [undefined, '', 'a'.repeat(42), 'a'.repeat(129), 'a'.repeat(42) + '+', 'a'.repeat(43) + '\n']) {
    assert.throws(() => verifierChallenge(value), hasCode('invalid_request'));
  }
  for (const value of [undefined, '', 'a'.repeat(42), 'a'.repeat(44), 'A'.repeat(42) + 'B', 'a'.repeat(42) + '=']) {
    assert.equal(isChallenge(value), false, 'Challenges must be a canonical SHA256-sized base64url encoding');
  }
});

test('opaque credential parsing requires exact UUIDv4 plus canonical random secret', () => {
  const id = randomUUID();
  const secret = randomSecret();
  assert.deepEqual(parseCredential(`${id}.${secret}`), { id, hash: secretHash(secret) });
  for (const value of [undefined, '', `${id}.${secret}.extra`, `${id}.${secret}\n`, `${id}.${secret.slice(1)}`, `${id.toUpperCase()}.${secret}`, `../other.${secret}`]) {
    assert.throws(() => parseCredential(value), hasCode('unauthorized'));
  }
});

test('token cipher requires a canonical 32-byte base64 key', () => {
  for (const key of [undefined, '', 'private-key', KEY.trimEnd() + '\n', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'A'.repeat(42) + 'B=']) {
    assert.throws(() => createTokenCipher(key), hasCode('invalid_configuration'));
  }
});

test('AES-GCM ciphertext hides tokens, uses fresh nonces, and authenticates connection ownership', () => {
  const cipher = createTokenCipher(KEY);
  const id = randomUUID();
  const first = cipher.encrypt(id, TOKEN);
  const second = cipher.encrypt(id, TOKEN);
  assert.notEqual(first, second);
  assert.deepEqual(cipher.decrypt(id, first), TOKEN);
  assert.ok(!first.includes('private'));
  assert.throws(() => cipher.decrypt(randomUUID(), first), hasCode('unavailable'));
  assert.throws(() => createTokenCipher(Buffer.alloc(32, 20).toString('base64')).decrypt(id, first), hasCode('unavailable'));
  const parts = first.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  const tampered = [...parts.slice(0, 3), ciphertext.toString('base64url')].join('.');
  for (const value of [tampered, `${first}.extra`, first.replace(/^v1/, 'v2'), '', null, 'private', first + '=']) {
    assert.throws(() => cipher.decrypt(id, value), hasCode('unavailable'));
  }
});

test('security failures never echo plaintext, unsupported error codes or parser excerpts', () => {
  const cipher = createTokenCipher(KEY);
  assert.throws(() => cipher.encrypt(randomUUID(), 'private'.repeat(10000)), hasCode('unavailable'));
  const error = new JiraAuthError('private-provider-error');
  assert.equal(error.code, 'unavailable');
  assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes('private'));
});
