# Diffuse Privacy Notice

Updated: 28 September 2026

This notice covers the Diffuse Chrome extension and its hosted Jira connection service. Diffuse helps you compare pages, save review evidence, and optionally use AI, Figma references, and Jira.

## Reviews on your device

Diffuse reads the tabs and pages you select and captures review content after your actions and Chrome's permission prompts. Saved content can include page titles and URLs, comments, screenshots, silent recordings, viewport and element details, and accepted AI findings. Screenshots and recordings can include sensitive information visible on the page. Recordings do not capture microphone or tab audio.

Reviews and evidence are stored in the extension's local browser database in your Chrome profile. Settings and connection credentials use Chrome extension storage. Diffuse does not sync reviews between devices. The live comparison stream stays inside Chrome; the websites being reviewed continue their own normal network activity.

Delete a comment or review in Diffuse to remove its local review record and evidence. Clearing extension data or removing the extension can also remove local data. Downloaded reports, copied content, and files shared with other people remain wherever you saved or sent them. Review exports include saved evidence and context but exclude account credentials.

## Optional AI and Figma connections

Clicking **Run AI review** sends the current page screenshot, a reference-page screenshot when connected, your instructions, and any explicitly linked Figma design context and reference images directly to Anthropic using your API key. Opening the AI panel alone does not send an AI request. Anthropic processes these requests under the terms and policies applicable to your API account; API charges apply. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

Your Anthropic key is kept in Chrome session storage by default. **Remember my key on this device** saves it in local extension storage between sessions. This storage is restricted to trusted extension contexts, but is not an encrypted password vault. **Remove key** clears the stored key.

Figma references use the MCP server you configure. The default Figma Desktop connection runs on your computer. A custom remote server receives connection requests, the selected file/node identifiers, and any bearer token you configure. **Save & connect** checks the server; running an AI review with a Figma link reads design context and available reference images. Diffuse uses supported read tools. Retrieved context can be sent to Anthropic and retained with accepted findings, exports, and selected Jira submissions. Custom MCP tokens use session storage unless you choose to remember them locally. Disconnecting the Figma configuration clears its saved settings and token. Figma and custom server operators have their own data practices.

## Jira account connections and submissions

Jira sign-in takes place with Atlassian. Diffuse's hosted service receives OAuth tokens and stores them encrypted on the server. It also stores your Atlassian account ID and display name, authorized site IDs/names/URLs, connection identifiers, and a hash of the extension's connection credential. The service uses these records to authenticate your connection, refresh access, and make authorized Jira requests. It does not receive your Atlassian password.

Choosing an account or destination loads Jira sites, projects, issue types, and field information through the service. Clicking **Create N tickets** sends the selected observations, ticket fields, captured context and links, and selected evidence files to the Diffuse service and then to your chosen Jira destination. The service stores submission snapshots, delivery identifiers, attachment metadata, and issue receipts to support delivery and prevent duplicate submissions. Connecting Jira alone does not upload your saved reviews.

The Jira service is hosted on Vercel and uses a Neon PostgreSQL database. These providers process the service's stored data and infrastructure traffic. Atlassian processes Jira content under your account and organization's settings and its applicable policies. See the privacy notices for [Vercel](https://vercel.com/legal/privacy-notice), [Neon/Databricks](https://www.databricks.com/legal/privacynotice), and [Atlassian](https://www.atlassian.com/legal/privacy-policy).

The service periodically reports stored Atlassian account IDs and the oldest collection time of their account data to Atlassian's Personal Data Reporting API. It follows Atlassian's reporting interval and retry instructions. When Atlassian reports an account as closed or its stored data as outdated, the service deletes all backend connections for that account and their associated delivery records and evidence. A confirmed unusable refresh grant also removes its connection. Locally cached connection profiles are cleared when the extension next validates the connection and receives an unauthorized response; an offline browser cannot be cleared immediately by the service.

## Retention and disconnection

- Uploaded evidence bytes are removed from the service's active database after confirmed successful attachment upload. Unfinished evidence expires seven days after the delivery is prepared; expired bytes are removed when backend cleanup next runs during a service request.
- Active connection records, ticket-text snapshots, and delivery receipts have no fixed time-based expiry. They are removed by the privacy-reporting actions described above or by a successful **Disconnect** in Jira connections. Disconnect deletes that connection and its associated snapshots, receipts, and remaining evidence from the active backend database, and removes its local connection credential.
- Local reviews and local Jira delivery history remain after disconnecting. Local delivery history helps prevent resending an observation after reconnection. Clearing extension data removes that local history.
- Disconnecting does not delete issues or attachments already created in Jira and does not revoke the Atlassian app grant. Manage those separately in Jira and Atlassian's connected-app settings. Revoking Atlassian access, deleting a local review, or uninstalling Diffuse does not itself delete backend records; disconnect first while you still have access to the extension.

These deletion actions apply to the application's active storage. Hosting-provider logs and backups follow their own retention practices.

## Operational data and contact

Diffuse includes no analytics or advertising service. The backend application avoids logging credentials, review content, and provider response bodies. Hosting infrastructure still receives network and request metadata, such as IP addresses, request paths, times, status codes, and diagnostics. The backend uses short-lived rate-limit counters keyed by a hash derived from the request IP address; this is separate from hosting-provider logs.

For privacy questions or help with connection data, use [Diffuse's GitHub issues](https://github.com/dimitriszoitas/diffuse/issues). Issues are public: do not include API keys, tokens, private reviews, or sensitive account details. Changes to this notice will be published here with an updated date.
