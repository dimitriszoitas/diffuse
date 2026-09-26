-- Run explicitly during deployment; request handlers never mutate the schema.
BEGIN;
CREATE TABLE IF NOT EXISTS diffuse_jira_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  extension_id text NOT NULL CHECK (extension_id ~ '^[a-p]{32}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS diffuse_jira_oauth_states_expiry ON diffuse_jira_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS diffuse_jira_connections (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  display_name text NOT NULL,
  sites jsonb NOT NULL CHECK (jsonb_typeof(sites) = 'array'),
  extension_id text NOT NULL CHECK (extension_id ~ '^[a-p]{32}$'),
  tokens_ciphertext text NOT NULL,
  credential_hash text CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  pending_expires_at timestamptz,
  CHECK ((credential_hash IS NULL AND pending_expires_at IS NOT NULL) OR
         (credential_hash IS NOT NULL AND pending_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS diffuse_jira_connections_pending_expiry
  ON diffuse_jira_connections(pending_expires_at) WHERE credential_hash IS NULL;

CREATE TABLE IF NOT EXISTS diffuse_jira_handoffs (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  connection_id uuid NOT NULL UNIQUE REFERENCES diffuse_jira_connections(id) ON DELETE CASCADE,
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS diffuse_jira_handoffs_expiry ON diffuse_jira_handoffs(expires_at);
COMMIT;
