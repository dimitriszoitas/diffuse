# Give and receive feedback on a pull request

A review has two roles. The reviewer might be a designer, stakeholder, or manager. The person working through the feedback might be a designer or engineer. These are activities within a review, not job titles or permanent account types; the same person can switch roles.

## Connect once

Open **Settings → GitHub reviews** and sign in with GitHub. The Diffuse Review app needs to be installed on the repository you choose. An owner can install it on selected repositories; an organization may require an administrator to approve it. You do not need a personal access token or your own server.

Sign-in uses Diffuse's OAuth app and enables public repositories by default. **Include private repositories** requests GitHub's broader `repo` permission, granting read/write access to public and private repositories your account can access. That OAuth permission is not limited to selected repositories. Diffuse additionally requires its GitHub App installation on each chosen repository. Expiring sign-in tokens are refreshed by the hosted service; no GitHub token is included in a shared review or the extension ZIP.

Connecting does not publish a review. Repository access is checked again when you load or update shared feedback. People with read access can read and load the review. Publishing evidence and recording shared status changes require write access to that repository. The role selector does not grant GitHub permissions.

## Give feedback

1. Review the working preview in Diffuse and save the findings you want to share.
2. Open the saved report and choose **Give feedback**. Select the findings for this PR.
3. Enter the GitHub PR link and the preview URL you actually reviewed.
4. Inspect the publication preview, including the destination's visibility, selected evidence, and current commit. Confirm that you reviewed that preview for the displayed commit.
5. Publish. Diffuse attaches the selected screenshots and recordings and maintains one review summary comment on the PR. The original publisher can later update its written findings; another collaborator's status checks do not overwrite that authorship.

The PR comment is readable without installing Diffuse. People who want to inspect pins on the running page can use the extension. GitHub determines access to the comment and its attachments; content posted to a public repository is public.

An interrupted transfer keeps its receipts. Use **Resume publishing** or **Check publication** to continue the approved transfer. Diffuse checks for the existing comment before creating another one. A saved status with a pending summary update can be synchronized separately without adding another check.

## Work through feedback

1. Open the preview you want to work on. In Diffuse, choose **Load review → Load from a GitHub PR**.
2. Enter the PR link, select the shared review, and confirm your preview URL.
3. Open a finding. Diffuse restores its recorded route and viewport on your chosen preview. Its original evidence remains available in the report.
4. Make the change using your usual design or development tools. Choose **Ready for recheck**, confirm the current commit, and open the finding on that preview.
5. Capture an updated screenshot or record up to 30 seconds of the behavior. Inspect the capture in Diffuse, add a note if helpful, then choose **Share update & mark ready**. Capturing alone does not publish anything.

If the component moved, drag the pin onto its new target. This stores an anchor for that build and preview; it does not rewrite the original capture. Missing elements need a remap or a human check, and are not automatically considered fixed.

## Review the change

Switch to **Give feedback**, refresh the shared review, and open the finding on the current preview. Capture a fresh screenshot or a short recording at the finding’s recorded route and viewport. Inspect it before sharing **Verified** or **Still present**. **Ready for recheck** reports a change; it does not verify the result.

The PR shows the **Original capture** and **Updated capture**, with the person, status, and commit associated with the update. Original evidence is preserved, and each later check is appended to the shared history. Recordings are limited to 30 seconds; a complex or high-motion clip may need to be shorter to fit the sharing limit.

A new PR commit makes earlier checks historical. It does not automatically prove that a preview has deployed that commit, or that a finding is fixed. The preview-to-commit association is confirmed by the person performing the review. Diffuse does not merge PRs, approve code, run builds, or bypass website logins.

## What travels with the review

The selected finding text, URLs, viewport and anchor details, screenshots, recordings, accepted AI context, and later verification history travel with the review. Credentials do not. Diffuse stores the portable bundle encrypted in its hosted service so authorized collaborators can load it; downloaded or imported copies remain on the recipient's device.

Private application screens can still contain sensitive information. Inspect the selected evidence and repository visibility before publishing. See [the privacy notice](PRIVACY.md) for service storage, disconnection, and retention details.
