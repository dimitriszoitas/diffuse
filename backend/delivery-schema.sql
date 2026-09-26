-- Durable delivery receipts and temporary evidence. Run explicitly after schema.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS diffuse_jira_deliveries (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES diffuse_jira_connections(id) ON DELETE CASCADE,
  stable_key text NOT NULL CHECK (stable_key ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  evidence_expires_at timestamptz NOT NULL,
  UNIQUE (connection_id, stable_key),
  UNIQUE (connection_id, id)
);
CREATE TABLE IF NOT EXISTS diffuse_jira_delivery_keys (
  connection_id uuid NOT NULL,
  client_delivery_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (connection_id, client_delivery_id),
  FOREIGN KEY (connection_id, delivery_id) REFERENCES diffuse_jira_deliveries(connection_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS diffuse_jira_delivery_chunks (
  delivery_id uuid NOT NULL REFERENCES diffuse_jira_deliveries(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 40),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) > 0 AND octet_length(bytes) <= 524288),
  PRIMARY KEY (delivery_id, attachment_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS diffuse_jira_deliveries_evidence_expiry ON diffuse_jira_deliveries(evidence_expires_at);
COMMIT;
