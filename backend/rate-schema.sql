BEGIN;
CREATE TABLE IF NOT EXISTS diffuse_jira_request_limits (
  bucket text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS diffuse_jira_request_limits_expiry ON diffuse_jira_request_limits(expires_at);
COMMIT;
