# GitHub review service

This service shares one visual review summary on a pull request and lets an
authorized recipient load the portable review, open its pins on a chosen preview,
and append a recheck result. Workflow roles are activities, not job titles.

## Deployment

The existing Vercel backend hosts GitHub separately from Jira at `/github/*`.
Run `npm run migrate` from this directory after adding `github-schema.sql`.
No Jira authentication rows or credentials are changed.

Required server environment variables:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: existing GitHub App credentials, retained for legacy user-token refresh.
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`: ordinary OAuth App credentials for user sign-in and native attachments.
- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`: the same GitHub App.
  The private key is a PEM, never an extension asset. Literal escaped newlines are accepted.
- Existing `PUBLIC_ORIGIN`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `ALLOWED_EXTENSION_IDS`.

Register both apps' callback as `https://diffuse-jira-api.vercel.app/github/oauth/callback`.
GitHub App repository permissions: pull requests **read/write**, metadata **read**,
deployments **read**. Install on selected repositories. Its installation token
writes the shared summary and its installation lookup limits Diffuse to selected
repositories even when the user's OAuth token has broader scope.

The single Connect GitHub flow uses the ordinary OAuth App with PKCE. Public
repositories use `public_repo`; the explicit private-repository choice requests
`repo`. GitHub's `repo` consent is broad, including code access, and must be
explained before requesting it. No user PAT is requested. `offline_access` opts
new OAuth App credentials into GitHub's actual expiry and refresh rotation; refresh
uses the OAuth App credentials under a database lock. Existing nonexpiring OAuth
rows retain their real lifetime, and revoked credentials require reconnecting.
Existing `ghu_` connections retain their GitHub App refresh path, but require
reconnecting for attachments.
Provider and requested scope are bound to the encrypted, one-use OAuth state.

GitHub's native attachment endpoint receives the signed-in user's ordinary OAuth
token; third-party GitHub App tokens cannot upload attachments. Completed upload
receipts survive an error. There is no public bucket or external evidence-viewer
fallback. All original images, reference images, and recordings selected for
publication are attached to the pull request.

## API contract

Every authenticated request uses `Authorization: Bearer <connection credential>`.
Credentials are opaque capabilities returned only after the one-use handoff.

| Method | Path | Input / result |
| --- | --- | --- |
| POST | `/github/v1/oauth/start` | `{extensionId,challenge,privateRepositoryAccess?:boolean}` → `{authorizationUrl}` |
| POST | `/github/v1/oauth/complete` | `{code,verifier}` → `{connection:{id,credential,accountId,login,displayName}}` |
| GET/DELETE | `/github/v1/connection` | Current connection or disconnect |
| GET | `/github/v1/pull?url=...` | `{pull,installationUrl,deployments}` |
| POST | `/github/v1/reviews/prepare` | `{pullUrl,reviewKey,expectedRevision,byteLength,sha256,chunkCount,reviewedSha,previewUrl,includeEvidence:true}` → `{id,revision,chunkSize,received}` |
| POST | `/github/v1/reviews/:id/chunks` | `{index,dataBase64}` → `{received:index}` |
| POST | `/github/v1/reviews/:id/publish` | `{}` → `{done,review,uploadedAssets?,totalAssets?,waiting?}` |
| GET | `/github/v1/reviews?pullUrl=...` | `{pull,reviews:[metadata]}` |
| GET | `/github/v1/reviews/:id` | `{review,byteLength,sha256,chunkCount,chunkSize}` |
| GET | `/github/v1/reviews/:id/chunks/:index` | `{revision,index,dataBase64}` |
| POST | `/github/v1/reviews/:id/events` | `{id?,expectedRevision,findingKey,status,buildSha,previewUrl,note,evidence?}` → `{event,review,summaryUpdated}` |

`pull` contains canonical `url`, `owner`, `repo`, `number`, `repoId`, `title`,
`headSha`, `state`, `private` and `canWrite`. Preview deployments are suggestions;
the user explicitly chooses the actual preview/build association.

The receiver must reassemble chunks, verify byte length and SHA256, and reject a
revision change during a download. Portable review/finding keys remain stable across
local imports. Published data is the normal sanitized Diffuse review bundle.

## Publishing and recovery

The original publisher can update authored text. Repository writers can append
`ready-for-recheck`, `verified`, `still-present`, or `needs-remap` events. Repository
readers can retrieve the review. Every retrieval rechecks current user access
through GitHub; knowledge of a review UUID alone grants no access.

All images and recordings in the selected findings are attached before posting
the summary. One call uploads one outstanding asset; the next call resumes from
durable receipts. The normal operation creates one app-owned comment and later
updates it. Reviewer names on shared events come from the authenticated connection,
not imported JSON. Existing authoritative histories and original screenshot data
are preserved on republish. Fresh screenshots or recordings of up to 30 seconds on the correct route and
current selected commit are required for `ready-for-recheck`, `verified`, and
`still-present`.

A create intent is persisted before sending GitHub a comment POST. If the response
is lost, retry the **same** `/publish` URL. Recovery searches the deterministic
review marker and verifies the app identity. It never blindly creates a second
summary. `publication_uncertain` needs recovery, not a new `/prepare` call.
Provider writes and their revision commits are serialized under the review lock
after the intent is committed. A new snapshot cannot replace any pending
publication, so an overlapping retry cannot overwrite a later summary.
If event storage succeeds but updating the comment fails, `summaryUpdated:false`
means the status is saved; retry the same event ID to refresh the summary.

## Bounds and data handling

- 50 findings and 20 MiB per bundle; 512 KiB chunks; 10 MiB per native media asset.
- Event requests are limited to 3 MiB. Compress screenshots before sending.
- Imported history is never accepted as an authenticated verification claim.
- OAuth verifiers, provider tokens, staged chunks, full review bundles and review
  metadata are encrypted with AES-256-GCM. Separate GitHub encryption domains and
  row-bound AAD prevent ciphertext substitution with Jira or another review.
- Stage chunks expire after 24 hours. Abandoned unpublished reviews are removed
  after 24 hours. Published reviews remain available to repository collaborators;
  disconnecting a GitHub account removes its token, not shared project evidence.
- OAuth state lasts 10 minutes; extension handoffs last 2 minutes and are one-use.
- GitHub requests allow fixed hosts only, disable redirects, have bounded response
  sizes and deadlines, and never log provider payloads or credentials.

`github-portable.mjs` and `github-pr-review.mjs` are deploy-contained mirrors of the
extension's portable validators. The backend tests assert exact synchronization.
`github-format.mjs` is pure and must match the extension's publication preview.

Validation: `node --test tests/github-backend.test.mjs tests/github-oauth.test.mjs` from the repository root.
