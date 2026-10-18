import {equal,fail} from './github-security.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
const connection=r=>r?{id:r.id,accountId:r.account_id,login:r.login,displayName:r.display_name,extensionId:r.extension_id,tokensCiphertext:r.tokens_ciphertext,credentialHash:r.credential_hash,pendingExpiresAt:r.pending_expires_at&&new Date(r.pending_expires_at).getTime()}:null;
const review=r=>r?{id:r.id,repoId:Number(r.repo_id),pullNumber:Number(r.pull_number),reviewKey:r.review_key,pullUrl:r.pull_url,authorId:r.author_id,revision:r.revision,bundleCiphertext:r.bundle_ciphertext,dataCiphertext:r.data_ciphertext,publicationPending:r.publication_pending===true}:null;
export function createGitHubStore({pool}) {
  const active=new AsyncLocalStorage();
  const query=(...args)=>(active.getStore()||pool).query(...args);
  async function transaction(action){
    const client=await pool.connect();let discard=false;const onError=()=>{discard=true;};
    try{client.on('error',onError);await client.query('BEGIN');const value=await active.run(client,()=>action(client));if(discard)fail('unavailable');await client.query('COMMIT');return value;}
    catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
    finally{client.removeListener('error',onError);client.release(discard);}
  }
  return {
    async putState(s){await pool.query('INSERT INTO diffuse_github_oauth_states(state_hash,challenge,extension_id,verifier_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5)',[s.stateHash,s.challenge,s.extensionId,s.verifierCiphertext,new Date(s.expiresAt)]);},
    async consumeState(stateHash,now){const r=(await pool.query('DELETE FROM diffuse_github_oauth_states WHERE state_hash=$1 AND expires_at>$2 RETURNING *',[stateHash,new Date(now)])).rows[0];return r?{challenge:r.challenge,extensionId:r.extension_id,verifierCiphertext:r.verifier_ciphertext}:null;},
    async createConnectionWithHandoff(c,h){await transaction(async db=>{
      await db.query('INSERT INTO diffuse_github_connections(id,account_id,login,display_name,extension_id,tokens_ciphertext,pending_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,c.accountId,c.login,c.displayName,c.extensionId,c.tokensCiphertext,new Date(h.expiresAt)]);
      await db.query('INSERT INTO diffuse_github_handoffs(code_hash,connection_id,challenge,expires_at) VALUES($1,$2,$3,$4)',[h.codeHash,c.id,h.challenge,new Date(h.expiresAt)]);
    });},
    async completeHandoff({codeHash,challenge,credentialHash,extensionIds,now}){return transaction(async db=>{
      const h=(await db.query('DELETE FROM diffuse_github_handoffs WHERE code_hash=$1 AND challenge=$2 AND expires_at>$3 RETURNING connection_id',[codeHash,challenge,new Date(now)])).rows[0];if(!h)return null;
      const c=(await db.query('UPDATE diffuse_github_connections SET credential_hash=$2,pending_expires_at=NULL,updated_at=$3 WHERE id=$1 AND credential_hash IS NULL AND pending_expires_at>$3 AND extension_id=ANY($4::text[]) RETURNING *',[h.connection_id,credentialHash,new Date(now),extensionIds])).rows[0];if(!c)fail('invalid_handoff');return connection(c);
    });},
    async getConnection(id){return connection((await pool.query('SELECT * FROM diffuse_github_connections WHERE id=$1',[id])).rows[0]);},
    async deleteConnection(id,credentialHash){return transaction(async db=>{const r=(await db.query('SELECT credential_hash FROM diffuse_github_connections WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r||!equal(r.credential_hash,credentialHash))fail('unauthorized');await db.query('DELETE FROM diffuse_github_connections WHERE id=$1',[id]);});},
    async withConnectionLock(id,action){return transaction(async db=>action(connection((await db.query('SELECT * FROM diffuse_github_connections WHERE id=$1 FOR UPDATE',[id])).rows[0]),async ciphertext=>db.query('UPDATE diffuse_github_connections SET tokens_ciphertext=$2,updated_at=now() WHERE id=$1',[id,ciphertext])));},
    async findReview(repoId,number,key){return review((await pool.query('SELECT * FROM diffuse_github_reviews WHERE repo_id=$1 AND pull_number=$2 AND review_key=$3',[repoId,number,key])).rows[0]);},
    async getReview(id){return review((await pool.query('SELECT * FROM diffuse_github_reviews WHERE id=$1',[id])).rows[0]);},
    async listReviews(repoId,number){return (await pool.query('SELECT * FROM diffuse_github_reviews WHERE repo_id=$1 AND pull_number=$2 AND revision>0 ORDER BY created_at DESC LIMIT 100',[repoId,number])).rows.map(review);},
    async createReview(r){return review((await pool.query('INSERT INTO diffuse_github_reviews(id,repo_id,pull_number,review_key,pull_url,author_id,data_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repo_id,pull_number,review_key) DO NOTHING RETURNING *',[r.id,r.repoId,r.pullNumber,r.reviewKey,r.pullUrl,r.authorId,r.dataCiphertext])).rows[0]);},
    async withReviewLock(id,action){return transaction(async db=>{
      const r=review((await db.query('SELECT * FROM diffuse_github_reviews WHERE id=$1 FOR UPDATE',[id])).rows[0]);
      return action(r,async patch=>{await db.query('UPDATE diffuse_github_reviews SET revision=$2,bundle_ciphertext=$3,data_ciphertext=$4,publication_pending=$5,updated_at=now() WHERE id=$1',[id,patch.revision??r.revision,patch.bundleCiphertext??r.bundleCiphertext,patch.dataCiphertext??r.dataCiphertext,patch.publicationPending??r.publicationPending]);});
    });},
    async putChunk({id,digest,index,ciphertext,expiresAt}){await query('INSERT INTO diffuse_github_chunks(review_id,digest,chunk_index,data_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(review_id,digest,chunk_index) DO UPDATE SET data_ciphertext=EXCLUDED.data_ciphertext,expires_at=EXCLUDED.expires_at',[id,digest,index,ciphertext,new Date(expiresAt)]);},
    async chunks(id,digest){return (await query('SELECT chunk_index,data_ciphertext FROM diffuse_github_chunks WHERE review_id=$1 AND digest=$2 ORDER BY chunk_index',[id,digest])).rows.map(r=>({index:r.chunk_index,ciphertext:r.data_ciphertext}));},
    async cleanup(now){await transaction(async db=>{
      await db.query('DELETE FROM diffuse_github_oauth_states WHERE expires_at<$1',[new Date(now)]);
      await db.query('DELETE FROM diffuse_github_handoffs WHERE expires_at<$1',[new Date(now)]);
      await db.query('DELETE FROM diffuse_github_connections WHERE pending_expires_at<$1 AND credential_hash IS NULL',[new Date(now)]);
      await db.query('WITH expiring_reviews AS (SELECT r.id FROM diffuse_github_reviews r WHERE NOT r.publication_pending AND EXISTS (SELECT 1 FROM diffuse_github_chunks c WHERE c.review_id=r.id AND c.expires_at<$1) FOR UPDATE SKIP LOCKED) DELETE FROM diffuse_github_chunks c USING expiring_reviews r WHERE c.review_id=r.id AND c.expires_at<$1',[new Date(now)]);
      await db.query("DELETE FROM diffuse_github_reviews WHERE revision=0 AND updated_at<$1 AND NOT publication_pending",[new Date(now-86400000)]);
      await db.query('DELETE FROM diffuse_github_request_limits WHERE expires_at<$1',[new Date(now)]);
    });}
  };
}
