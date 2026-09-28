import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createPublicKey} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// A changed key is an identity/storage migration, not an ordinary release.
const DISTRIBUTED_ID = 'gdoidkknjbnfmeikloaafdohpjlafgbj';

test('the distributed manifest keeps a valid public key and the approved portable identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(typeof manifest.key, 'string');
  const bytes = Buffer.from(manifest.key, 'base64');
  assert.equal(bytes.toString('base64'), manifest.key, 'The key must be canonical base64 SPKI');
  const key = createPublicKey({key: bytes, type: 'spki', format: 'der'});
  assert.equal(key.type, 'public');
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 2048);
  const id = [...createHash('sha256').update(bytes).digest('hex').slice(0, 32)]
    .map(value => String.fromCharCode(97 + parseInt(value, 16))).join('');
  assert.equal(id, DISTRIBUTED_ID, 'Changing the public key requires an explicit identity migration');
});
