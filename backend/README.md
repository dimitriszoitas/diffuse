# Diffuse Jira backend

Server-only OAuth and Jira delivery service for Diffuse 0.7.0, deployed independently of the Chrome extension. Keep environment files, credentials, database URLs and `.vercel` out of source control and extension ZIPs.

**Current status:** the hosted backend and callback are configured. Real account authorization and live ticket creation remain unverified. The Atlassian app is private to its owner, and the server currently allows the existing approved extension installation. Other accounts require Atlassian app sharing; other installations require an allowlist update.

## Setup

Run `npm ci` in this directory. Use `.env.example` as the template for an ignored local environment file. Set these Production variables in Vercel:

- `DATABASE_URL`: the dedicated PostgreSQL database connection, supplied by the database integration.
- `PUBLIC_ORIGIN`: the exact HTTPS service origin, without a path.
- `ATLASSIAN_CLIENT_ID`: the public OAuth client ID.
- `ATLASSIAN_CLIENT_SECRET`: sensitive server secret.
- `TOKEN_ENCRYPTION_KEY`: sensitive canonical base64 encoding of 32 cryptographically random bytes.
- `ALLOWED_EXTENSION_IDS`: comma-separated approved Diffuse installation IDs.

Register `${PUBLIC_ORIGIN}/oauth/jira/callback` in Atlassian. Use `read:jira-work`, `read:jira-user`, `write:jira-work` and request `offline_access`. Configure distribution separately before people other than the app owner connect.

Run `node --env-file=.env.production.local migrate.mjs` explicitly to apply the authentication, rate-limit and delivery schemas. Requests never create or alter tables. Database connections use verified TLS; URL options cannot disable verification. Rotating the encryption key without migrating encrypted tokens makes existing connections unreadable.

## Sending and recovery

Connecting an account and loading export metadata create no tickets. The extension previews individual or bulk-selected observations, their destination, required fields and evidence. Only **Create N tickets** starts delivery. Each observation gets its own issue and durable receipt; evidence uploads attach to that confirmed issue.

The backend authenticates ownership, rechecks site access, loads all destination metadata pages and validates required fields. It accepts fixed Jira operations only. Tokens are encrypted; refreshes are serialized and committed before downstream API calls. OAuth uses hashed expiring state, a verifier-bound one-time handoff and fixed Chrome redirects.

Descriptions use a bounded ADF subset shared by delivery validation and the outbound Jira client: headings, paragraphs, highlighted change panels, numbered reproduction steps, evidence lists and plain-text AI handoff blocks. The extension preview renders this same document. Jira supplies its own colors and typography. Evidence filenames in the description match separate uploads; no unverified Jira media IDs are embedded. Tables, mentions, arbitrary HTML and embed/extension nodes are rejected. Deploy this validator together with extension builds that produce the richer document.

Evidence uses 512 KiB chunks to stay below hosted request limits. Limits are 20 files, 20 MiB per file and 40 MiB per observation, plus the Jira site's limit. Size, complete SHA-256 and file signature are validated before issue creation. Successful uploads delete temporary bytes; unfinished evidence expires after seven days while delivery receipts remain.

Confirmed rejections allow an explicit retry. Unknown write outcomes are **needs-check**, with no automatic retry. A failed attachment resumes against the already-created issue. Closing the report can stop processing, but the delivery state persists. No request log should contain credentials, evidence bytes, ticket text or raw provider responses.

## Verification

From the parent directory, run `npm test` and `npm run check`. Provider and delivery tests use injected responses, including concurrent submissions, ownership checks and uncertain outcomes; they perform no real Jira writes. `GET /health` checks liveness only.

On **2026-09-26**, all three schemas were explicitly applied to the hosted PostgreSQL database. The authorized `node smoke-postgres.mjs` check passed handoff/replay protection, concurrent token refresh, required ADF textarea fields, delivery deduplication, chunk storage, concurrent issue/attachment claims, receipts and synthetic-record cleanup. It used fake OAuth/Jira providers: no real Atlassian grant or Jira write occurred. The script creates temporary database records and deletes only the records it generated; this check does not verify a new deployment.

Complete a real owner-account grant from the approved extension, then explicitly create a test ticket and verify its screenshot and recording in Jira before calling the integration end-to-end verified. See `../docs/jira-integration.md` for the deployment and rollout details.
