/** Production adapter. Inject a pg Pool configured with the deployment's secret
 * DATABASE_URL. All request values are SQL parameters; schema.sql is an explicit migration.
 */
import { equalHash, failAuth } from './security.mjs';

function connection(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, displayName: row.display_name,
    sites: row.sites, extensionId: row.extension_id, tokensCiphertext: row.tokens_ciphertext,
    credentialHash: row.credential_hash, createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    pendingExpiresAt: row.pending_expires_at == null ? null : new Date(row.pending_expires_at).getTime()
  };
}

export function createPostgresStore({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') failAuth('invalid_configuration');
  async function transaction(action) {
    const client = await pool.connect();
    let discard = false;
    let connectionFailed = false;
    // A checked-out pg client has no pool idle-error listener. It can emit an
    // error between SQL queries while the caller awaits an OAuth refresh.
    const onClientError = () => { connectionFailed = true; discard = true; };
    try {
      client.on('error', onClientError);
      await client.query('BEGIN');
      const result = await action(client);
      if (connectionFailed) failAuth('unavailable');
      await client.query('COMMIT');
      if (connectionFailed) failAuth('unavailable');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      client.removeListener('error', onClientError);
      client.release(discard);
    }
  }
  return Object.freeze({
    async putState({ stateHash, challenge, extensionId, expiresAt }) {
      await pool.query(`INSERT INTO diffuse_jira_oauth_states
        (state_hash, challenge, extension_id, expires_at) VALUES ($1, $2, $3, $4)`,
      [stateHash, challenge, extensionId, new Date(expiresAt)]);
    },
    async consumeState({ stateHash, now }) {
      // DELETE is the atomic one-use claim, including concurrent callbacks.
      const result = await pool.query(`DELETE FROM diffuse_jira_oauth_states
        WHERE state_hash = $1 AND expires_at > $2 RETURNING challenge, extension_id`, [stateHash, new Date(now)]);
      const row = result.rows[0];
      return row ? { challenge: row.challenge, extensionId: row.extension_id } : null;
    },
    async createConnectionWithHandoff({ connection: item, handoff }) {
      await transaction(async client => {
        await client.query(`INSERT INTO diffuse_jira_connections
          (id, account_id, display_name, sites, extension_id, tokens_ciphertext, credential_hash,
           created_at, updated_at, pending_expires_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, NULL, $7, $7, $8)`,
        [item.id, item.accountId, item.displayName, JSON.stringify(item.sites), item.extensionId,
          item.tokensCiphertext, new Date(item.createdAt), new Date(handoff.expiresAt)]);
        await client.query(`INSERT INTO diffuse_jira_handoffs
          (code_hash, connection_id, challenge, expires_at) VALUES ($1, $2, $3, $4)`,
        [handoff.codeHash, item.id, handoff.challenge, new Date(handoff.expiresAt)]);
      });
    },
    async completeHandoff({ codeHash, challenge, credentialHash, allowedExtensionIds, now }) {
      return transaction(async client => {
        const claimed = await client.query(`DELETE FROM diffuse_jira_handoffs
          WHERE code_hash = $1 AND challenge = $2 AND expires_at > $3 RETURNING connection_id`,
        [codeHash, challenge, new Date(now)]);
        if (!claimed.rows[0]) return null;
        const activated = await client.query(`UPDATE diffuse_jira_connections
          SET credential_hash = $2, pending_expires_at = NULL, updated_at = $3
          WHERE id = $1 AND credential_hash IS NULL AND pending_expires_at > $3
            AND extension_id = ANY($4::text[]) RETURNING *`,
        [claimed.rows[0].connection_id, credentialHash, new Date(now), allowedExtensionIds]);
        if (!activated.rows[0]) failAuth('invalid_handoff');
        return connection(activated.rows[0]);
      });
    },
    async getConnection(id) {
      return connection((await pool.query('SELECT * FROM diffuse_jira_connections WHERE id = $1', [id])).rows[0]);
    },
    async deleteConnection({ id, credentialHash }) {
      return transaction(async client => {
        const row = (await client.query('SELECT credential_hash FROM diffuse_jira_connections WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!row || !equalHash(row.credential_hash, credentialHash)) return false;
        await client.query('DELETE FROM diffuse_jira_connections WHERE id = $1', [id]);
        return true;
      });
    },
    async withConnectionLock(id, action) {
      return transaction(async client => {
        const item = connection((await client.query('SELECT * FROM diffuse_jira_connections WHERE id = $1 FOR UPDATE', [id])).rows[0]);
        return action(item, {
          async updateTokens({ tokensCiphertext, updatedAt }) {
            await client.query(`UPDATE diffuse_jira_connections SET tokens_ciphertext = $2, updated_at = $3
              WHERE id = $1`, [id, tokensCiphertext, new Date(updatedAt)]);
          }
        });
      });
    },
    async cleanupExpired(now) {
      await transaction(async client => {
        await client.query('DELETE FROM diffuse_jira_oauth_states WHERE expires_at <= $1', [new Date(now)]);
        await client.query('DELETE FROM diffuse_jira_connections WHERE credential_hash IS NULL AND pending_expires_at <= $1', [new Date(now)]);
        await client.query('DELETE FROM diffuse_jira_handoffs WHERE expires_at <= $1', [new Date(now)]);
      });
    }
  });
}
