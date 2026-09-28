/** Server-only privacy reporting repository. Account timestamps live on the original
 * connection records, so account erasure cascades through every stored delivery.
 * All user-supplied values remain SQL parameters. Run the explicit migration first.
 */
export function createPostgresPrivacyReportingStore({pool} = {}) {
  if (!pool?.query || !pool?.connect) throw new Error('Privacy repository is not configured.');
  async function transaction(action) {
    const client = await pool.connect(); let discard = false, broken = false;
    const onError = () => { discard = true; broken = true; };
    try {
      client.on('error', onError);
      await client.query('BEGIN');
      const result = await action(client);
      if (broken) throw new Error('Privacy repository unavailable.');
      await client.query('COMMIT');
      if (broken) throw new Error('Privacy repository unavailable.');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.removeListener('error', onError); client.release(discard); }
  }
  return Object.freeze({
    async withSweepLock(action) {
      // A dedicated transaction lock works through transaction-mode poolers too.
      // No connection/account rows are locked by this transaction; its only role
      // is excluding concurrent sweeps while the bounded provider work runs.
      const client = await pool.connect(); let acquired = false, discard = false, broken = false;
      const onError = () => { discard = true; broken = true; };
      try {
        client.on('error', onError);
        await client.query('BEGIN');
        acquired = (await client.query('SELECT pg_try_advisory_xact_lock(18273391, 1) AS acquired')).rows[0]?.acquired === true;
        if (!acquired) { await client.query('ROLLBACK'); return {acquired: false}; }
        const value = await action();
        if (broken) throw new Error('Privacy repository unavailable.');
        await client.query('COMMIT');
        if (broken) throw new Error('Privacy repository unavailable.');
        return {acquired: true, value};
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally {
        client.removeListener('error', onError); client.release(discard);
      }
    },
    async getJobState() {
      const row = (await pool.query('SELECT not_before FROM diffuse_jira_privacy_job WHERE singleton = true')).rows[0];
      return {notBefore: row?.not_before == null ? 0 : new Date(row.not_before).getTime()};
    },
    async startRun(now) {
      await pool.query("UPDATE diffuse_jira_privacy_job SET last_started_at = $1, last_status = 'running' WHERE singleton = true", [new Date(now)]);
    },
    async listDueAccounts({now, limit}) {
      const result = await pool.query(`SELECT account_id, MIN(created_at) AS oldest_collected_at,
          COALESCE(MAX(privacy_next_report_at), to_timestamp(0)) AS next_report_at
        FROM diffuse_jira_connections c
        WHERE NOT EXISTS (SELECT 1 FROM diffuse_jira_privacy_pending p WHERE p.account_id = c.account_id)
        GROUP BY account_id
        HAVING COALESCE(MAX(privacy_next_report_at), to_timestamp(0)) <= $1
        ORDER BY next_report_at, account_id LIMIT $2`, [new Date(now), limit]);
      return result.rows.map(row => ({accountId: row.account_id, oldestCollectedAt: new Date(row.oldest_collected_at).getTime()}));
    },
    async existingAccounts(accountIds) {
      const result = await pool.query(`SELECT account_id, MIN(created_at) AS oldest_collected_at
        FROM diffuse_jira_connections WHERE account_id = ANY($1::text[])
        GROUP BY account_id ORDER BY account_id`, [accountIds]);
      return result.rows.map(row => ({accountId: row.account_id, oldestCollectedAt: new Date(row.oldest_collected_at).getTime()}));
    },
    async listAccountConnections(accountId) {
      return (await pool.query(`SELECT id FROM diffuse_jira_connections
        WHERE account_id = $1 ORDER BY updated_at DESC, id LIMIT 10`, [accountId])).rows.map(row => row.id);
    },
    async eraseConnection(id) {
      return (await pool.query('DELETE FROM diffuse_jira_connections WHERE id = $1', [id])).rowCount;
    },
    async eraseAccounts(accountIds) {
      return (await pool.query('DELETE FROM diffuse_jira_connections WHERE account_id = ANY($1::text[])', [accountIds])).rowCount;
    },
    async reserveAccounts({accountIds, now}) {
      // Reserve the known cycle BEFORE the external call. A function crash or
      // uncertain network result cannot immediately resend the same accounts.
      await pool.query(`UPDATE diffuse_jira_connections c SET privacy_last_attempt_at = $2,
          privacy_next_report_at = $2::timestamptz + (s.cycle_ms * interval '1 millisecond'),
          privacy_cycle_ms = s.cycle_ms
        FROM (SELECT account_id, MAX(privacy_cycle_ms) AS cycle_ms
          FROM diffuse_jira_connections WHERE account_id = ANY($1::text[]) GROUP BY account_id) s
        WHERE c.account_id = s.account_id`, [accountIds, new Date(now)]);
    },
    async stageReportResult({accountIds, eraseAccountIds, now, cycleMs}) {
      await pool.query(`INSERT INTO diffuse_jira_privacy_pending(account_id, reported_at, cycle_ms, erase)
        SELECT account_id, $2::timestamptz, $3::bigint, account_id = ANY($4::text[])
        FROM unnest($1::text[]) AS account_id
        ON CONFLICT (account_id) DO UPDATE SET
          reported_at = GREATEST(diffuse_jira_privacy_pending.reported_at, EXCLUDED.reported_at),
          cycle_ms = GREATEST(diffuse_jira_privacy_pending.cycle_ms, EXCLUDED.cycle_ms),
          erase = diffuse_jira_privacy_pending.erase OR EXCLUDED.erase`,
      [accountIds, new Date(now), cycleMs, eraseAccountIds]);
    },
    async applyPendingReports({limit}) {
      return transaction(async client => {
        const pending = (await client.query(`SELECT account_id, reported_at, cycle_ms, erase
          FROM diffuse_jira_privacy_pending ORDER BY reported_at, account_id
          LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
        if (!pending.length) return {applied: 0, erasedAccounts: 0, erasedConnections: 0};
        const accountIds = pending.map(row => row.account_id);
        const eraseAccountIds = pending.filter(row => row.erase).map(row => row.account_id);
        const erased = eraseAccountIds.length ? (await client.query('DELETE FROM diffuse_jira_connections WHERE account_id = ANY($1::text[])', [eraseAccountIds])).rowCount : 0;
        await client.query(`UPDATE diffuse_jira_connections c SET privacy_last_reported_at = p.reported_at,
          privacy_next_report_at = p.reported_at + (p.cycle_ms * interval '1 millisecond'), privacy_cycle_ms = p.cycle_ms
          FROM diffuse_jira_privacy_pending p
          WHERE c.account_id = p.account_id AND p.account_id = ANY($1::text[]) AND NOT p.erase`, [accountIds]);
        await client.query('DELETE FROM diffuse_jira_privacy_pending WHERE account_id = ANY($1::text[])', [accountIds]);
        await client.query(`UPDATE diffuse_jira_privacy_job SET last_success_at = $1,
          last_error_code = NULL WHERE singleton = true`, [new Date(Math.max(...pending.map(row => new Date(row.reported_at).getTime())))]);
        return {applied: pending.length, erasedAccounts: eraseAccountIds.length, erasedConnections: erased};
      });
    },
    async recordFailure({accountIds, now, errorCode, retryAfterMs}) {
      await transaction(async client => {
        // 429 uses its supplied delay; explicit rejection uses a bounded delay.
        // Uncertain attempts retain their reserved cycle and remain observable.
        if (retryAfterMs != null) {
          await client.query('UPDATE diffuse_jira_connections SET privacy_next_report_at = $2 WHERE account_id = ANY($1::text[])', [accountIds, new Date(now + retryAfterMs)]);
          await client.query(`UPDATE diffuse_jira_privacy_job SET not_before = GREATEST(COALESCE(not_before, to_timestamp(0)), $1)
            WHERE singleton = true`, [new Date(now + retryAfterMs)]);
        }
        await client.query('UPDATE diffuse_jira_privacy_job SET last_error_code = $1 WHERE singleton = true', [errorCode]);
      });
    },
    async finishRun({now, status, counts}) {
      await pool.query(`UPDATE diffuse_jira_privacy_job SET last_finished_at = $1,
        last_status = $2, last_counts = $3::jsonb WHERE singleton = true`, [new Date(now), status, JSON.stringify(counts)]);
    }
  });
}
