/** Parameterized SQL only. No Jira call is made while a delivery row is locked. */
export function createPostgresDeliveryStore({pool} = {}) {
  if (!pool?.query || !pool?.connect) throw new Error('Delivery store requires a database pool.');
  async function transaction(action) {
    const client = await pool.connect(); let discard = false, broken = false;
    const onError = () => { discard = broken = true; };
    try {
      client.on('error', onError); await client.query('BEGIN');
      const result = await action(client);
      if (broken) throw new Error('Database unavailable.');
      await client.query('COMMIT');
      if (broken) throw new Error('Database unavailable.');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.removeListener('error', onError); client.release(discard); }
  }
  return Object.freeze({
    async prepare({job, payloadHash, stableKey}) {
      return transaction(async client => {
        // Serializes only prepare calls for one connection, including new client IDs.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 4917))', [job.connectionId]);
        const key = (await client.query(`SELECT k.payload_hash, d.document FROM diffuse_jira_delivery_keys k
          JOIN diffuse_jira_deliveries d ON d.id = k.delivery_id AND d.connection_id = k.connection_id
          WHERE k.connection_id = $1 AND k.client_delivery_id = $2`, [job.connectionId, job.request.clientDeliveryId])).rows[0];
        if (key) return {job: key.document, conflict: key.payload_hash !== payloadHash};
        let saved = (await client.query('SELECT document FROM diffuse_jira_deliveries WHERE connection_id = $1 AND stable_key = $2', [job.connectionId, stableKey])).rows[0]?.document;
        if (!saved) {
          await client.query(`INSERT INTO diffuse_jira_deliveries (id, connection_id, stable_key, document, evidence_expires_at)
            VALUES ($1,$2,$3,$4::jsonb,$5)`, [job.id, job.connectionId, stableKey, JSON.stringify(job), new Date(job.evidenceExpiresAt)]);
          saved = job;
        }
        await client.query(`INSERT INTO diffuse_jira_delivery_keys (connection_id, client_delivery_id, delivery_id, payload_hash)
          VALUES ($1,$2,$3,$4)`, [job.connectionId, job.request.clientDeliveryId, saved.id, payloadHash]);
        return {job: saved, conflict: false};
      });
    },
    async get({connectionId, id}) {
      return (await pool.query('SELECT document FROM diffuse_jira_deliveries WHERE id = $1 AND connection_id = $2', [id, connectionId])).rows[0]?.document ?? null;
    },
    async withJobLock({connectionId, id}, action) {
      return transaction(async client => {
        const row = (await client.query('SELECT document FROM diffuse_jira_deliveries WHERE id = $1 AND connection_id = $2 FOR UPDATE', [id, connectionId])).rows[0];
        if (!row) return action(null, null);
        const job = row.document;
        const result = await action(job, {
          async putChunk({attachmentId, index, hash, bytes}) {
            const previous = (await client.query(`SELECT sha256 FROM diffuse_jira_delivery_chunks
              WHERE delivery_id = $1 AND attachment_id = $2 AND chunk_index = $3`, [id, attachmentId, index])).rows[0];
            if (previous) return previous.sha256 === hash;
            await client.query(`INSERT INTO diffuse_jira_delivery_chunks (delivery_id, attachment_id, chunk_index, sha256, bytes)
              VALUES ($1,$2,$3,$4,$5)`, [id, attachmentId, index, hash, bytes]);
            return true;
          },
          async readChunks(attachmentId) {
            return (await client.query(`SELECT chunk_index, bytes FROM diffuse_jira_delivery_chunks
              WHERE delivery_id = $1 AND attachment_id = $2 ORDER BY chunk_index`, [id, attachmentId])).rows.map(row => ({index: row.chunk_index, bytes: row.bytes}));
          },
          async deleteChunks(attachmentId) {
            await client.query('DELETE FROM diffuse_jira_delivery_chunks WHERE delivery_id = $1 AND attachment_id = $2', [id, attachmentId]);
          }
        });
        await client.query('UPDATE diffuse_jira_deliveries SET document = $3::jsonb WHERE id = $1 AND connection_id = $2', [id, connectionId, JSON.stringify(job)]);
        return result;
      });
    },
    async cleanupExpired(now) {
      await pool.query(`DELETE FROM diffuse_jira_delivery_chunks c USING diffuse_jira_deliveries d
        WHERE c.delivery_id = d.id AND d.evidence_expires_at <= $1`, [new Date(now)]);
    }
  });
}
