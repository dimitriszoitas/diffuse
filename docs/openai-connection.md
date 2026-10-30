# OpenAI connection

1. Open Diffuse **Settings → AI review**.
2. Choose **OpenAI**, enter your OpenAI API key, choose whether to remember it on this device, and save. API billing is separate from a chat subscription. Diffuse leaves the other provider’s key and configuration intact.
3. Direct reviews use the configured OpenAI model, defaulting to `gpt-6.1-sol`. Managed agents use GPT-6.1 Sol with Max effort.
4. To use named agents, choose **Set up reviewer** in UX & accessibility review, and **Set up journey agents** in Journey testing. These actions create a Diffuse UX & Accessibility Reviewer, Journey User and Journey Evaluator in the API project associated with that key. They use bounded Diffuse functions, no hosted shell/web tools, no delegated agents, and no hosted browser environment.
5. Start from **Review with AI**, then choose **Screen review** or **Journey test**. The provider shown in settings governs all new AI work, including Jira title suggestions. Existing saved journeys remain tied to their original provider.

The original movie and review library remain on your device. When you run AI, supplied evidence goes to the selected API provider. Managed agents retain their sessions in that provider account. Deleting local data does not delete those sessions. See [privacy](PRIVACY.md).

OpenAI’s amounts are **estimated spending guards**: Diffuse checks reported usage between requests and persists the guard across reloads. This is not a provider-enforced hard cap, and a request in flight can exceed it. Unknown usage or uncertain paid mutations stop the flow for inspection; they do not trigger silent duplicate sessions or a fallback provider.

Selecting a radio is a draft until Save or agent setup succeeds. Both provider keys have independent local/session-only storage preferences. Removing one provider’s key leaves the other intact. Stored keys never reappear in the form.

The 0.19.0 OpenAI implementation is tested with documented API fixtures and browser tests. A live account check requires your saved OpenAI key and account access to the Agents API. A successful setup check verifies definitions, not a completed inference or real website journey.
