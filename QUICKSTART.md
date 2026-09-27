# Try Diffuse 0.8.0

Compare a live prototype over production or audit one page. Leave pinned comments on elements or areas, record a short silent interaction, and copy the review for your engineering team. Claude can suggest findings when you connect your own Anthropic API key.

## Install or upgrade

For a first installation:

1. Unzip **Diffuse-0.8.0.zip**. Keep the resulting **Diffuse** folder somewhere permanent.
2. In your normal Chrome browser, open `chrome://extensions`.
3. Turn on **Developer mode**, then click **Load unpacked** and choose that **Diffuse** folder.
4. Pin **Diffuse — Live design comparison** using Chrome’s extensions menu.

**Already installed?** Replace the files inside your existing Diffuse folder, keeping its path unchanged, then click **Reload** on the existing extension card. Do not remove the extension or load it from a different folder: your saved reviews belong to its extension ID in this Chrome profile. Refresh both comparison pages after reloading.

You do not need to sign in to a special test browser or share a password with Diffuse.

## Start on the page you want to review

1. Open the page you want to review in Chrome.
2. Click the Diffuse extension icon, then **Start review**. Allow access to this page if requested.
3. Tap **C**, release it, then click anywhere on the page to leave a comment, or hold **C** and drag to select an area. Use the side drawer for recording, AI review and reports.

There is no floating toolbar. If the sidebar is closed, click the Diffuse extension icon and **Open review sidebar** to return to the controls.

There is no audit/comparison mode to choose. Without a reference, Diffuse reviews one page. Add a reference whenever you want to compare.

## Add a live reference with Diff

1. Open your reference or prototype in another tab, preferably in the same Chrome window.
2. On the page being reviewed, click **Diff** in the side drawer.
3. Choose the reference tab and click **Connect reference**. Allow access to that selected site if requested.
4. In Chrome’s sharing dialog, select **the same reference tab** and confirm sharing. Diffuse verifies the selected tab before connecting it.
5. Drag the divider, adjust opacity, or use **Hide reference / Show reference**. Scroll over either side to move that page independently. Enable **Link scroll** when you want production scrolling to move both pages.

Use **Diff** again to change or remove the reference. This keeps your current review and saved comments. Cancelling the tab picker or choosing the wrong shared tab leaves your current reference unchanged. Save or cancel an unfinished comment before changing reference; finish any recording or AI action first.

The live reference includes animation and interactions. Click **Prototype ↗** (or **Open prototype** in the drawer) to operate it, then return to the reviewed page. State changes are independent: opening a menu in one app does not open it in the other. If a reference fully reloads or sharing ends, use Diff to select it again; saved evidence is kept.

After opening/resizing a drawer or window, visit the reference once and return if Diffuse warns that viewport sizes differ. Chrome can keep an inactive tab at its old size. Match viewport and zoom before judging alignment.

## Review local HTML files

Open `chrome://extensions` → Diffuse → **Details**, then enable **Allow access to file URLs**. Return to your local HTML page and reopen Diffuse to start reviewing. The popup and drawer show a settings shortcut when access is off. You can use a local file as the reviewed page or select it as a live Diff reference. A `localhost` page uses the ordinary site-access flow instead.

## Use the side drawer

**Start review** opens the sidebar. For an active review, use **Open review sidebar** in the extension popup. Chrome gives Diffuse its own resizable space beside the page. All review controls live here; selection outlines and pins stay on the page.

Drag Chrome’s divider to resize the drawer. Close it using Chrome’s **×** above it to restore the page width. Closing keeps the active review and unfinished comment. **Stop** ends the review instead. Chrome controls which side the drawer uses.

On an unrelated tab, the drawer offers **Return to page**. Native drawer pixels are excluded from evidence. Saved pins follow their anchors within the current viewport view. AI preview highlights and older area captures without an anchor remain tied to their captured size; captured evidence stays unchanged.

## Check desktop, laptop, tablet and phone layouts

The **Viewport** segments in the drawer switch between Desktop (1440 × 900), Laptop (1280 × 800), Tablet (1024 × 768) and Phone (390 × 844). Comments stay with the view where they were captured. Use the report's viewport filter to see one view or all of them; Jira tickets retain the viewport label and dimensions.

Chrome asks for the updated extension's debugging permission and shows a notice while viewport control is active. Close DevTools on those tabs before switching. **Reset / Use window size** restores the normal layout. Save or cancel an open comment and finish recording or AI work before switching views.

## Add a comment

Starting a review from the real Chrome toolbar grants capture for that page. If Chrome needs access again—for example after starting from a persistent drawer on a newly selected tab—click the actual Diffuse icon on the reviewed page, then **Enable capture & return**. Your draft stays available.

1. Tap **C**, release it, then click an element to leave a comment. For an area, hold **C + left-click-drag** to draw a rectangle. Shortcuts are ignored while typing in editable inputs; Escape cancels.
2. Diffuse captures evidence before opening the form: both screens in comparison mode, or the one page in audit mode. Write your observation. **Title and expected result are optional**; an omitted title uses a short excerpt from your observation.
3. Under **Attach evidence**, keep **Screenshot** or choose **Short recording**. Your written text and selected element or region stay attached when recording.
4. Check the component name, label the state, choose a category and severity, and save. Categories have visible labels and distinct colors: **Design mismatch — purple**, **UX issue — amber**, and **Copy change — blue**. Comparison defaults to Design mismatch; audit defaults to UX issue.

Save comment stays visible at the bottom of the editor while its fields scroll. If the page disconnects, use **Reconnect review** to recover the pending evidence and your text, then save.

Saved comments appear as numbered pins for the current viewport. New pins follow their selected element or area through scrolling and resizing; they do not float at the screen edge after the target leaves view. Click one to open its comment bubble, or choose **Open in review** for full evidence. Pins appear only on their captured URL, follow the selected element when it can still be found, and otherwise use captured document coordinates only when the viewport still matches. The original screenshots keep the recorded location even if the live layout changes.

Component names come from available page labels such as `data-component`, `data-testid`, role, or tag and can be edited. They are not detected framework source components. **Current state** is an editable label for this capture, not a claim that other states were tested. The inspector records observed layout and state details without reading form values or passwords.

Drag a saved comment’s numbered marker to move it out of the way. It keeps its original element, follows scrolling, and remembers the new position. Open the comment and choose **Reset position** to put it back.

## Record an interaction

In the comment form, choose **Short recording**, then **Start recording**. Interact with the page and click **Stop recording**, or let it stop automatically after **30 seconds**. Your text and selected element or region return with the form; the original screenshot remains its location context.

The silent clip captures the whole visible page, including Diffuse’s controls and any comparison overlay. Selecting a region does not crop the video. Preview the clip and save with **Short recording** selected. If you switch to **Screenshot** before saving, that comment excludes the clip.

The drawer’s **Record page** control is also available. It captures starting screenshots and opens a comment form afterward. **Stop** ends the review; an unfinished recording is preserved in the report.

## Optional Claude review

1. Open **Settings → AI review** from the bottom of the sidebar. Add your **Anthropic API key**, choose a supported Claude model, and save. The default keeps your key for the Chrome session only; you may need to enter it again after reloading the extension. **Remember my key on this device** persists it in this Chrome profile, not an encrypted password vault. **Remove key** clears it.
2. On your page, open **AI review**, add optional instructions, and set the minimum issue size. Reopen the panel after changing AI settings.
3. Click **Run AI review**. This sends the current screenshot—or both screenshots in comparison mode—and your instructions **directly to Anthropic**. API charges apply to your account. Opening the panel does not send a request.
4. Review pending suggestions. **Show area** previews their approximate bounds. Choose **Accept comment** to add one to your saved review, or **Dismiss**. Nothing is saved as a comment automatically.

The threshold is **0–100**, default **35**. Lower includes smaller findings; higher focuses on larger ones. Adjusting it filters the existing suggestions without another model request. **Show all** reveals hidden findings without a new request or charge. **Accept all shown (N)** adds all suggestions passing the filter as comments; choose Show all first to include every pending finding. This estimated magnitude is separate from confidence and is not an exact pixel tolerance or accuracy guarantee.

Claude sees the captured screen, not hidden states or every interaction. A one-page audit has no prototype baseline and offers possible UX/copy improvements. AI errors distinguish key/model access, API credit, limits, and request problems; an HTTP status or request ID is included when available. Automated review-flow checks use local response fixtures without spending API credits.

New reviews ask for one actionable issue per finding. **Current** describes the observed result; **Change to** explains the location, concrete correction, reason and a visible check. The model is instructed to quote readable before/after copy and to identify unavailable details instead of inventing measurements. The report leads with focused evidence and lets you enlarge it; a prototype close-up appears only when its area was independently identified. Full screenshots remain available under **Full screenshots**. Existing saved wording is preserved; starting a new AI review is required to generate new explanations.

## Share a review with another Diffuse user

Open the **⋯ Review options** menu beside the review title and choose **Export review** to download a `.diffuse-review.json` file. It includes every saved comment across pages and viewports, the captured URLs and anchors, written fields, screenshots, recordings and accepted AI context. Account credentials and local session identifiers are excluded.

The recipient chooses **Import review** in their notebook and selects that file. The import creates a separate saved review, preserving existing reviews. **Open review page** opens the saved URL and restores the comment pins. Chrome may first ask for access to that site. Clicking a comment in the sidebar returns to its captured URL and viewport, then reveals its location.

The recipient needs access to the reviewed website. An export does not include the website itself, its login session, or unsaved application state. Local files and localhost addresses must also exist on their computer; original screenshot and recording evidence remains readable in the notebook even when the page is unavailable. A live Diff reference can be connected again separately.

The notebook sidebar can be collapsed and expanded using its sidebar icon. **Settings** at the bottom of the sidebar brings AI configuration, Jira accounts and page-access information together.

## Copy or download your review

Open **Review reports** in the drawer or extension popup. Earlier saved reviews remain in the notebook. Use **Hide** beside a review to clear it from the list; find it under **Hidden** and choose **Restore** when needed. Hiding preserves its comments and evidence.

The **⋯ Review options** menu beside the review title contains the sharing and download actions. **Delete** remains beside it.

- **Copy entire report** copies formatted text and screenshots. If the destination drops images, use **Copy image** or **Download image** for each screenshot.
- **Download HTML** keeps embedded screenshots and playable recordings together in one file that opens offline.
- **AI handoff .md ↓** gives a coding assistant the entire review, across all viewports, with Current → Change to → Verify for every finding. Include the HTML report or evidence files alongside it; the Markdown contains filenames instead of bulky image/video data. Generating it makes no AI request.

For a single accepted AI finding, expand **Suggested AI prompt** and choose **Copy AI prompt**. The same prompt appears in its Jira description, alongside formatted sections and numbered steps. Jira evidence remains in attachments.

Comments and evidence stay locally in this Chrome profile across comparison sessions. Reload the same installed folder when upgrading. Use Export review when another Diffuse user needs to load the review and its page pins.

Reports contain manual comments and accepted AI comments. Pending suggestions and your configured API key are never exported.

## Send one or several observations to Jira

1. Open **Settings → Jira connections** and select **Connect Jira**. Sign in with the Atlassian account you want to use. Jira does not use your Anthropic key.
2. In a saved review, click **Send to Jira** on one observation. For several, check **Select for Jira**, then **Send selected to Jira**. The selected count includes any items hidden by a category filter.
3. Pick the connected account, site, project and issue type. Fill in the required fields and review each ticket's description and saved evidence.
4. Click **Create N tickets** to send. Each observation creates its own issue, followed by its screenshot or recording attachments. Nothing becomes a ticket merely by connecting an account or opening the preview.
5. Keep the report open until sending finishes. Each item shows progress and its Jira link. Resume reuses the existing issue for remaining attachments. A confirmed failure can be retried; an uncertain result requires checking Jira before another write.

Selected ticket text and evidence pass through the hosted Diffuse service to Jira. Files must fit both Diffuse's limits (20 MiB per file, 40 MiB per observation) and the site's attachment policy. Unfinished temporary evidence expires after seven days.

**Setup status:** the backend is configured, but a real account grant and live ticket creation have not yet been tested. The Atlassian app is currently private to its owner, and the backend allows the existing approved extension installation. Other accounts need Atlassian app sharing enabled separately; another installation needs its ID approved. Separate account connections are supported once access is enabled.

## Local demo

While the included demo server is running, try these two tabs:

- [Production](http://127.0.0.1:4178/production.html)
- [Prototype](http://127.0.0.1:4178/prototype.html)

Start the review on the **production** tab, then use **Diff** to choose the prototype. No login is needed for these demo pages. See the README for starting the demo server and the full behavior notes.

## Keyboard and readable controls

Tap **C**, release it, then click on the reviewed page to start a comment. The element picker supports arrow keys and **Enter**; Escape cancels. Viewport icons have accessible names, and the information icon shows help on both hover and keyboard focus. **Adjust reference → Reveal position** supports clicks and arrow keys.

## Coming soon

**Asana** and **ClickUp** integrations are planned. Jira handoff is included in 0.7.0 with the rollout limits above.

To open a shared review, click **Load review** below **Start review** in the Diffuse popup, then **Choose review file**. You can also browse your saved reviews from the loader.
