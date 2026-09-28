-- Explicit migration. No user data is copied into the singleton job-status row.
BEGIN;
ALTER TABLE diffuse_jira_connections
  ADD COLUMN IF NOT EXISTS privacy_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_last_reported_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_next_report_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_cycle_ms bigint NOT NULL DEFAULT 604800000;
CREATE INDEX IF NOT EXISTS diffuse_jira_connections_account
  ON diffuse_jira_connections(account_id);
CREATE INDEX IF NOT EXISTS diffuse_jira_connections_privacy_due
  ON diffuse_jira_connections(privacy_next_report_at);

CREATE TABLE IF NOT EXISTS diffuse_jira_privacy_job (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  not_before timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_status text,
  last_error_code text,
  last_counts jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO diffuse_jira_privacy_job(singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- No FK: a validated provider result can be saved while an account connection is
-- locked by another request. Applying it and clearing it are one transaction.
CREATE TABLE IF NOT EXISTS diffuse_jira_privacy_pending (
  account_id text PRIMARY KEY,
  reported_at timestamptz NOT NULL,
  cycle_ms bigint NOT NULL CHECK (cycle_ms > 0),
  erase boolean NOT NULL
);
COMMIT;
