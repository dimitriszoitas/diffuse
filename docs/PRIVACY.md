# Diffuse Privacy Notice

Updated: 20 October 2026

This notice covers the Diffuse Chrome extension and its hosted Jira and GitHub connection services. Diffuse helps you compare pages, save review evidence, and optionally use AI, Figma references, Jira, and shared PR reviews.

## Reviews on your device

Diffuse reads the tabs and pages you select and captures review content after your actions and Chrome's permission prompts. Saved content can include page titles and URLs, comments, screenshots, silent recordings, viewport and element details, and accepted AI findings. Screenshots and recordings can include sensitive information visible on the page. Recordings do not capture microphone or tab audio.

Reviews and evidence are stored in the extension's local browser database in your Chrome profile. Settings and connection credentials use Chrome extension storage. Reviews are not automatically synchronized between devices. Explicit GitHub publication makes the selected review available to authorized collaborators as described below. The live comparison stream stays inside Chrome; the websites being reviewed continue their own normal network activity.

Delete a comment or review in Diffuse to remove its local review record and evidence. Clearing extension data or removing the extension can also remove local data. Downloaded reports, copied content, and files shared with other people remain wherever you saved or sent them. Review exports include saved evidence and context but exclude account credentials.

## Optional AI and Figma connections

Clicking **Run AI review** sends the current page screenshot, a reference-page screenshot when connected, your instructions, and any explicitly linked Figma design context and reference images directly to Anthropic using your API key. Opening the AI panel alone does not send an AI request. Anthropic processes these requests under the terms and policies applicable to your API account; API charges apply. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

Opening the Jira export preview uses your configured Anthropic key and model to suggest ticket titles for untitled comments. This sends only the selected authored comment text, expected results, and reproduction steps. It does not send screenshots, page URLs, or DOM details for title generation. Suggestions and edits are stored locally to keep retries consistent. Saving a comment does not make an AI request. If AI is unavailable, ticket titles use comment excerpts that you can edit.

Your Anthropic key is kept in Chrome session storage by default. **Remember my key on this device** saves it in local extension storage between sessions. This storage is restricted to trusted extension contexts, but is not an encrypted password vault. **Remove key** clears the stored key.

Figma references use the MCP server you configure. The default Figma Desktop connection runs on your computer. A custom remote server receives connection requests, the selected file/node identifiers, and any bearer token you configure. **Save & connect** checks the server; running an AI review with a Figma link reads design context and available reference images. Diffuse uses supported read tools. Retrieved context can be sent to Anthropic and retained with accepted findings, exports, and selected Jira submissions. Custom MCP tokens use session storage unless you choose to remember them locally. Disconnecting the Figma configuration clears its saved settings and token. Figma and custom server operators have their own data practices.

## AI journey reviews

Clicking **Start journey** lets Diffuse operate the current website toward your goal across multiple pages. It sends your goal, optional success criteria and test data, visible page text and controls, page URLs, action history, and screenshots to Anthropic using your configured key. Each decision can incur API charges. Opening the journey panel does not start this process.

Actions occur in your current signed-in browser session and can create records using the test data you supply. Use a test environment when appropriate. Diffuse limits each run to the starting website origin and a bounded number of actions. It does not send cookies, browser storage, passwords, or hidden application source to the model. Screenshots and visible text can still contain personal information.

A silent recording captures the reviewed tab throughout the journey, including page navigation and any visible test data. It does not capture microphone or tab audio. The full movie stays on your device and is not sent to Anthropic. Individual screenshots and page observations are sent for AI decisions as described above.

Pause stops further decisions and pauses recording until resumed; Stop ends the run and saves its movie. An action already dispatched cannot be undone. A run is limited to ten minutes and its selected action count; a recording is limited to 20 MiB. Journey history, screenshots, and recordings are stored in a separate local extension database, with at most ten recent runs and an approximate 80 MiB retention budget. Older history is removed as that budget is reached. Deleting the associated review removes its journey history. Removing the extension or clearing its data removes this local history too. Downloaded movies remain wherever you save them.

Accepting a journey finding adds its screenshot and reproduction steps to the review. Accepted findings can then be included in your usual JSON/HTML exports, Jira tickets, or GitHub PR review. The complete journey history and movie are not automatically included in those exports or published to any of those destinations. You can download the full movie separately to share it.

## Jira account connections and submissions

Jira sign-in takes place with Atlassian. Diffuse's hosted service receives OAuth tokens and stores them encrypted on the server. It also stores your Atlassian account ID and display name, authorized site IDs/names/URLs, connection identifiers, and a hash of the extension's connection credential. The service uses these records to authenticate your connection, refresh access, and make authorized Jira requests. It does not receive your Atlassian password.

Choosing an account or destination loads Jira sites, projects, issue types, and field information through the service. Clicking **Create N tickets** sends the selected observations, ticket fields, captured context and links, and selected evidence files to the Diffuse service and then to your chosen Jira destination. The service stores submission snapshots, delivery identifiers, attachment metadata, and issue receipts to support delivery and prevent duplicate submissions. Connecting Jira alone does not upload your saved reviews.

The Jira service is hosted on Vercel and uses a Neon PostgreSQL database. These providers process the service's stored data and infrastructure traffic. Atlassian processes Jira content under your account and organization's settings and its applicable policies. See the privacy notices for [Vercel](https://vercel.com/legal/privacy-notice), [Neon/Databricks](https://www.databricks.com/legal/privacynotice), and [Atlassian](https://www.atlassian.com/legal/privacy-policy).

The service periodically reports stored Atlassian account IDs and the oldest collection time of their account data to Atlassian's Personal Data Reporting API. It follows Atlassian's reporting interval and retry instructions. When Atlassian reports an account as closed or its stored data as outdated, the service deletes all backend connections for that account and their associated delivery records and evidence. A confirmed unusable refresh grant also removes its connection. Locally cached connection profiles are cleared when the extension next validates the connection and receives an unauthorized response; an offline browser cannot be cleared immediately by the service.

## GitHub account connections and shared reviews

GitHub sign-in takes place with GitHub through Diffuse's OAuth app. The hosted Diffuse service encrypts its expiring access and refresh tokens and stores your account identifier, login and display name. It keeps a hash of the extension's connection credential. The service checks the signed-in account's current repository access before returning shared feedback or accepting an update. It does not receive your GitHub password. Connecting an account does not upload reviews.

Sign-in requests public-repository access (`public_repo`) by default. Selecting **Include private repositories** requests GitHub's broader `repo` permission, which grants read/write access to public and private repositories your account can access. The OAuth permission itself is not limited to a chosen repository. Diffuse separately requires its GitHub App to be installed on each repository used for shared reviews and checks both the installation and your current access. Both sign-in choices include `offline_access` so the service can refresh expiring tokens. You can manage the OAuth authorization and the repository app installation separately in GitHub.

Looking up a PR sends its link to the service and GitHub to retrieve the PR, current commit, repository access, and available deployment URLs. Publishing sends only the selected findings and their evidence to the service. This includes authored text, page URLs and context, element and viewport details, screenshots, recordings, and accepted AI reference context. The service stores the portable review encrypted so authorized collaborators can load it into Diffuse. It uploads the selected media to GitHub's native attachment service and writes one summary comment using the installed Diffuse app. Public-repository comments and attachments are public; GitHub applies its own access rules to private-repository content.

Shared status updates store the signed-in person's GitHub identity, status, time, commit, preview URL, optional note, and updated evidence. New **Ready for recheck**, **Verified**, and **Still present** updates require a fresh screenshot or silent recording of up to 30 seconds. Capturing creates a private draft for inspection; the final **Share** action sends it to the service and GitHub. The original and updated captures remain available in the PR. Imported names are not treated as authenticated verification claims. The person confirms which build they checked; Diffuse does not independently prove that a preview URL serves that commit. Loading a shared review saves a local copy in the recipient's Chrome profile. Remapping a finding on a new preview keeps the original evidence and records a separate anchor.

GitHub data uses the same Vercel and Neon hosting providers as the Jira service, with separate encrypted records. GitHub processes comments, media, and sign-in data under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Abandoned GitHub uploads with no publication attempt expire after 24 hours and are removed during service cleanup. If a publication attempt has an unconfirmed outcome, its receipt and required transfer chunks remain available until that outcome is resolved, so retrying cannot create a duplicate PR comment. Published review bundles, evidence, publication receipts, and verification history have no fixed time-based expiry so collaborators can reopen them. Disconnecting GitHub deletes that connection's server token and the local connection credential; it does not delete shared project reviews, local copies, or GitHub comments and attachments. Deleting a local review also does not remove shared copies. Contact the maintainer using the contact route below for help removing stored shared review data. Manage the app installation and authorization separately in GitHub.

## Jira retention and disconnection

- Uploaded evidence bytes are removed from the service's active database after confirmed successful attachment upload. Unfinished evidence expires seven days after the delivery is prepared; expired bytes are removed when backend cleanup next runs during a service request.
- Active connection records, ticket-text snapshots, and delivery receipts have no fixed time-based expiry. They are removed by the privacy-reporting actions described above or by a successful **Disconnect** in Jira connections. Disconnect deletes that connection and its associated snapshots, receipts, and remaining evidence from the active backend database, and removes its local connection credential.
- Local reviews and local Jira delivery history remain after disconnecting. Local delivery history helps prevent resending an observation after reconnection. Clearing extension data removes that local history.
- Disconnecting does not delete issues or attachments already created in Jira and does not revoke the Atlassian app grant. Manage those separately in Jira and Atlassian's connected-app settings. Revoking Atlassian access, deleting a local review, or uninstalling Diffuse does not itself delete backend records; disconnect first while you still have access to the extension.

These deletion actions apply to the application's active storage. Hosting-provider logs and backups follow their own retention practices.

## Operational data and contact

Diffuse includes no analytics or advertising service. The backend application avoids logging credentials, review content, and provider response bodies. Hosting infrastructure still receives network and request metadata, such as IP addresses, request paths, times, status codes, and diagnostics. The backend uses short-lived rate-limit counters keyed by a hash derived from the request IP address; this is separate from hosting-provider logs.

For privacy questions or help with connection data, use [Diffuse's GitHub issues](https://github.com/dimitriszoitas/diffuse/issues). Issues are public: do not include API keys, tokens, private reviews, or sensitive account details. Changes to this notice will be published here with an updated date.
