import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDeliveryService} from '../backend/delivery-service.mjs';

const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const ADF = {type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: 'Explain the requested change.'}]}]};
function fixture(fieldValue) {
  let persisted;
  const page = values => ({values, startAt: 0, isLast: true, nextStartAt: null});
  const service = createDeliveryService({
    store: {
      async prepare({job}) { persisted = job; return {job, conflict: false}; },
      async withJobLock() { assert.fail('Preparation must not claim any Jira write'); },
      async get() { return null; }
    },
    oauth: {async discoverResources() { return [{id: CLOUD, url: 'https://fixture.atlassian.net'}]; }},
    jira: {
      async listProjects() { return page([{id: '10001'}]); },
      async listIssueTypes() { return page([{id: '10002'}]); },
      async getCreateFields() { return page([{fieldId: 'customfield_10001', required: true, operations: ['set'],
        schema: {type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'}}]); }
    }
  });
  return {
    async prepare() {
      return service.prepare({connection: {id: randomUUID()}, accessToken: 'fixture-token', request: {
        clientDeliveryId: randomUUID(), commentId: randomUUID(), revision: 'a'.repeat(64), cloudId: CLOUD,
        projectId: '10001', issueTypeId: '10002', summary: 'Review observation', description: ADF,
        fields: fieldValue === undefined ? {} : {customfield_10001: fieldValue}, attachments: []
      }});
    },
    saved: () => persisted
  };
}

test('required Jira textarea fields accept and preserve the ADF object produced by the export UI', async () => {
  const app = fixture(ADF);
  assert.equal((await app.prepare()).status, 'prepared');
  assert.deepEqual(app.saved().request.fields.customfield_10001, ADF);
});

test('missing required textarea fails before persisting a delivery', async () => {
  const app = fixture(undefined);
  await assert.rejects(app.prepare(), error => error.code === 'required_fields');
  assert.equal(app.saved(), undefined);
});

test('a malformed rich-text document is rejected before persisting a delivery', async () => {
  const app = fixture({type: 'doc', version: 1, content: [{type: 'html', content: [{type: 'text', text: '<script>fixture</script>'}]}]});
  await assert.rejects(app.prepare(), error => error.code === 'invalid_input');
  assert.equal(app.saved(), undefined);
});
