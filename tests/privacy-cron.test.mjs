import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivacyCronHandler} from '../backend/privacy-cron.mjs';

const secret = 'test-only-'.repeat(5);
async function request(options = {}) {
  let calls = 0;
  const handler = createPrivacyCronHandler({secret, run: async () => {calls++; return {status: 'complete', reported: 3, accountId: 'private-account', accessToken: 'secret'};}, ...options.config});
  const response = {headers: {}, setHeader(k, v) {this.headers[k] = v;}, end(value) {this.body = JSON.parse(value);}};
  await handler({method: options.method || 'GET', headers: options.headers || {}}, response);
  return {...response, calls};
}
test('scheduled reporting requires its server secret before invoking any service', async () => {
  for (const authorization of [undefined, `Bearer ${secret}x`, `Bearer ${'x'.repeat(secret.length)}`]) {
    const r = await request({headers: {authorization}});
    assert.equal(r.statusCode, 401); assert.equal(r.calls, 0);
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
  }
});
test('scheduled reporting returns safe aggregate counts only', async () => {
  const r = await request({headers: {authorization: `Bearer ${secret}`}});
  assert.equal(r.statusCode, 200); assert.equal(r.calls, 1);
  assert.deepEqual(r.body, {status: 'complete', counts: {reported: 3}});
  assert.match(r.headers['Cache-Control'], /no-store/);
});
test('failed or partial scheduled work surfaces as an operational failure', async () => {
  for (const status of ['partial', 'failed']) {
    const r = await request({headers: {authorization: `Bearer ${secret}`}, config: {run: async () => ({status, failed: 1, errors: ['private-provider-detail']})}});
    assert.equal(r.statusCode, 503); assert.deepEqual(r.body, {status, counts: {failed: 1}});
  }
});
test('wrong methods, missing setup and errors do not expose private details', async () => {
  const headers = {authorization: `Bearer ${secret}`};
  assert.equal((await request({method: 'POST', headers})).statusCode, 405);
  assert.equal((await request({config: {secret: undefined}, headers})).statusCode, 503);
  const failure = await request({config: {run: async () => {throw new Error('provider-private-data');}}, headers});
  assert.equal(failure.statusCode, 503); assert.doesNotMatch(JSON.stringify(failure.body), /provider-private/);
});
