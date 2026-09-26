# Jira integration — 0.7.0

Individual and bulk-selected review handoff is implemented. The hosted backend, database, callback and extension allowlist are configured. **A real Atlassian account grant and live ticket creation have not yet been tested.** Automated provider tests do not establish that end-to-end result.

## Current rollout

- OAuth app: **Diffuse**, registered as a resource-level app. It is still **private to its owner**; enable Atlassian app sharing separately before other accounts can authorize it.
- Jira scopes: `read:jira-work`, `read:jira-user`, `write:jira-work`, plus `offline_access` in the authorization request. No project administration, configuration, webhook or development-data scopes are requested.
- Backend: `https://diffuse-jira-api.vercel.app`.
- Registered callback: `https://diffuse-jira-api.vercel.app/oauth/jira/callback`.
- Database: isolated `diffuse-jira-db`, using the existing Neon Launch subscription managed by Vercel, connected to this backend's Production environment.
- Approved existing extension ID: `golpalifffajniiianpkpfmmijmcdmeh`. Update its existing installed folder and reload it to preserve its identity and saved reviews. A fresh installation ID needs an explicit server allowlist update.
- The client secret and token-encryption key are sensitive server environment variables. No secret or database URL belongs in extension files, reports or source control.

The connection UI supports separate Atlassian accounts and sites. App sharing is an additional rollout prerequisite, not something creating another local connection can bypass. The Anthropic key is unrelated to Jira authorization.

## Review-to-ticket flow

1. Connect an account from **Jira connections**.
2. Use **Send to Jira** on an observation, or explicitly select several and choose **Send selected to Jira**. A category filter does not silently change the selection; hidden selected items remain counted.
3. Choose the posting account, site, project and issue type. Current paginated Jira metadata supplies required fields and valid options. Unsupported required field types block submission.
4. Preview one ticket per selected observation, including its readable summary, description and saved evidence. Shared field selections apply to the whole selected batch.
5. **Create N tickets** is the explicit sending action. Keep the report open while it works. Individual receipts and Jira links show issue creation and evidence progress separately.

Descriptions include Current, Requested change, Component, State, Steps, Category, Severity and captured page/reference links when available. Missing titles use a readable observation excerpt. Each observation keeps its own capture context; changing a live reference does not relabel old evidence. Pending AI suggestions and unselected observations are never part of the export.

## Delivery and recovery

The extension and backend retain immutable submission snapshots and stable delivery IDs. The server also deduplicates a repeated observation revision for the same connection and destination. A durable claim precedes every Jira write; the confirmed issue ID/key is saved before evidence uploads.

Screenshots and recordings upload in bounded 512 KiB chunks, then attach as files to the confirmed issue. Limits are 20 files, 20 MiB per file and 40 MiB per observation, additionally bounded by the site's attachment policy. Full file size, SHA-256 and supported container signature are verified before issue creation and again before attachment upload.

A confirmed rejection can be retried explicitly. An uncertain response or interrupted write becomes **needs-check** and is not automatically repeated. Failed attachment retries target the existing issue; incomplete evidence remains visible. Closing the report can interrupt processing, but saved delivery receipts allow a safe resume. Temporary evidence is deleted after successful upload or expires after seven days; receipts remain. Disconnecting removes that connection's server records, while locally saved delivery references still prevent blind resubmission after reconnecting.

## Backend boundary

OAuth exchange and rotating refresh tokens remain server-side. Tokens use authenticated encryption; refreshes are serialized and persisted before the downstream Jira operation. Authorization uses hashed expiring state, a verifier-bound one-time handoff, fixed callbacks and approved extension IDs. Connection credentials are available only to trusted extension contexts.

Every delivery belongs to its authenticated connection. The backend rechecks authorized sites, destination metadata and attachment policy; it provides fixed Jira operations, never an arbitrary URL proxy. PostgreSQL retains connections, delivery state and temporary evidence across function restarts. Schema changes are explicit migrations. Selected Jira submissions leave the local browser; ordinary manual comparison and unsent reviews remain local.

## Verification still required

Authorize the owner account from the approved installation, verify its sites/projects and required fields, then explicitly create a test issue with screenshot and recording evidence. Confirm the ticket and attachments in Jira. Other-account authorization needs a separate check after app sharing is configured.

## Official references

- [OAuth registration, site access and refresh tokens](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [Issue creation and required fields](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Attachment settings and uploads](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/)
- [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
