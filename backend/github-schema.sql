CREATE TABLE IF NOT EXISTS diffuse_github_oauth_states (
  state_hash text PRIMARY KEY, challenge text NOT NULL, extension_id text NOT NULL,
  verifier_ciphertext text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS diffuse_github_connections (
  id uuid PRIMARY KEY, account_id text NOT NULL, login text NOT NULL, display_name text NOT NULL,
  extension_id text NOT NULL, tokens_ciphertext text NOT NULL, credential_hash text,
  pending_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS diffuse_github_handoffs (
  code_hash text PRIMARY KEY, connection_id uuid NOT NULL REFERENCES diffuse_github_connections(id) ON DELETE CASCADE,
  challenge text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS diffuse_github_reviews (
  id uuid PRIMARY KEY, repo_id bigint NOT NULL, pull_number bigint NOT NULL, review_key text NOT NULL,
  pull_url text NOT NULL, author_id text NOT NULL, revision integer NOT NULL DEFAULT 0,
  bundle_ciphertext text, data_ciphertext text NOT NULL, publication_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id,pull_number,review_key)
);
ALTER TABLE diffuse_github_reviews ALTER COLUMN review_key TYPE text USING review_key::text;
ALTER TABLE diffuse_github_reviews ADD COLUMN IF NOT EXISTS publication_pending boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS diffuse_github_chunks (
  review_id uuid NOT NULL REFERENCES diffuse_github_reviews(id) ON DELETE CASCADE,
  digest text NOT NULL, chunk_index integer NOT NULL CHECK(chunk_index>=0 AND chunk_index<40),
  data_ciphertext text NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (review_id,digest,chunk_index)
);
CREATE INDEX IF NOT EXISTS diffuse_github_reviews_pull ON diffuse_github_reviews(repo_id,pull_number);
CREATE INDEX IF NOT EXISTS diffuse_github_chunks_expiry ON diffuse_github_chunks(expires_at);
CREATE TABLE IF NOT EXISTS diffuse_github_request_limits (bucket text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
