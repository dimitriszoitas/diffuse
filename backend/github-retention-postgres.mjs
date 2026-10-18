/** Optional SQL retention smoke. All tables are connection-local TEMP tables;
 * it never reads or changes live service records, credentials, or provider state.
 * Run with DATABASE_URL. A database migration is not required for this fixture. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabasePool} from './database.mjs';
import {createGitHubStore} from './github-store.mjs';

let pool,client;
try {
  pool=createDatabasePool(process.env.DATABASE_URL);client=await pool.connect();
  await client.query(`
    CREATE TEMP TABLE diffuse_github_reviews (
      id uuid PRIMARY KEY, repo_id bigint, pull_number bigint, review_key text,
      pull_url text, author_id text, revision integer NOT NULL DEFAULT 0,
      bundle_ciphertext text, data_ciphertext text NOT NULL,
      publication_pending boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(repo_id,pull_number,review_key)
    );
    CREATE TEMP TABLE diffuse_github_chunks (
      review_id uuid REFERENCES diffuse_github_reviews(id) ON DELETE CASCADE,
      digest text, chunk_index integer, data_ciphertext text, expires_at timestamptz,
      PRIMARY KEY(review_id,digest,chunk_index)
    );
    CREATE TEMP TABLE diffuse_github_oauth_states (expires_at timestamptz);
    CREATE TEMP TABLE diffuse_github_handoffs (expires_at timestamptz);
    CREATE TEMP TABLE diffuse_github_connections (pending_expires_at timestamptz,credential_hash text);
    CREATE TEMP TABLE diffuse_github_request_limits (expires_at timestamptz);
  `);
  const session={query:(...args)=>client.query(...args),on:(...args)=>client.on(...args),removeListener:(...args)=>client.removeListener(...args),release:()=>{}};
  const store=createGitHubStore({pool:{query:session.query,connect:async()=>session}}),time=Date.now(),expired=time-48*3600000,digest='a'.repeat(64);
  const ids={abandoned:randomUUID(),creating:randomUUID(),updating:randomUUID(),published:randomUUID()};
  for(const [name,id] of Object.entries(ids)) {
    await store.createReview({id,repoId:1,pullNumber:1,reviewKey:id,pullUrl:'https://github.com/test/repo/pull/1',authorId:'test',dataCiphertext:'fixture'});
    await store.withReviewLock(id,async(row,save)=>{
      assert.equal(row.publicationPending,false);
      await save({publicationPending:['creating','updating'].includes(name),revision:['updating','published'].includes(name)?1:0});
    });
    await store.putChunk({id,digest,index:0,ciphertext:'fixture',expiresAt:expired});
    await client.query('UPDATE diffuse_github_reviews SET updated_at=$2 WHERE id=$1',[id,new Date(expired)]);
  }
  await store.cleanup(time);
  assert.equal(await store.getReview(ids.abandoned),null);
  assert.equal((await store.chunks(ids.abandoned,digest)).length,0);
  for(const name of ['creating','updating']) {
    assert.equal((await store.getReview(ids[name])).publicationPending,true);
    assert.equal((await store.chunks(ids[name],digest)).length,1);
  }
  assert.equal((await store.getReview(ids.published)).revision,1);
  assert.equal((await store.chunks(ids.published,digest)).length,0);
  // A successful retry clears the durable flag. Completed bundles remain,
  // while obsolete staging chunks can now be reclaimed normally.
  for(const name of ['creating','updating'])await store.withReviewLock(ids[name],async(row,save)=>save({publicationPending:false,revision:row.revision+1,bundleCiphertext:'published fixture'}));
  await store.cleanup(time);
  for(const name of ['creating','updating']) {
    assert.equal((await store.getReview(ids[name])).publicationPending,false);
    assert.equal((await store.chunks(ids[name],digest)).length,0);
  }
  console.log('PASS: SQL cleanup expires abandoned uploads, preserves uncertain create/update receipts and chunks, and reclaims staging data only after recovery. Temporary tables only.');
} catch(error) {
  console.error(`GitHub retention SQL smoke failed: ${error instanceof assert.AssertionError?'assertion failed':'database or fixture unavailable'}. No credentials logged.`);
  process.exitCode=1;
} finally {
  if(client)client.release(true);
  if(pool)await pool.end();
}
