# XoomAI Paperclip Slack Employee Gateway

Inbound file support and replay behavior: [installation and acceptance contract](INBOUND-ATTACHMENTS.md).

A XoomAI fork of `0xCVH/paperclip-plugin-slack-socket` that gives every Paperclip AI employee a native Slack bot identity while keeping Paperclip as the routing source of truth.

```text
Slack @XoomAI-Sales     -> Paperclip employee Sales
Slack @XoomAI-Marketing -> Paperclip employee Marketing
Slack @XoomAI-Finance   -> Paperclip employee Finance
```

One plugin worker manages all of the customer’s outbound Socket Mode WebSocket connections. No public Slack webhook URL is required.

## Routing contract

- One Slack App and bot user per Paperclip employee.
- One `xoxb` bot token and one `xapp` Socket Mode token per Slack App.
- No Paperclip employee IDs, employee names, aliases or routing table in plugin configuration.
- The plugin discovers active Paperclip employees and reads every Slack bot identity with `auth.test`.
- `XoomAI-Sales`, `Sales Agent` and `Sales Bot` normalize to the conservative alias `sales`.
- Routing succeeds only for one exact, unique Paperclip alias.
- Missing and ambiguous matches fail closed and list the currently routable employees.
- There is no default employee and no fallback route.

The employee registry is rebuilt when configuration is applied, every five minutes, and after Paperclip `agent.created`, `agent.updated` and `agent.status_changed` events. Paused, pending-approval and terminated employees are not routable.

## Conversations

Every Slack root conversation creates its own Paperclip session for the resolved employee. Session state is namespaced by Slack bot user ID, channel and root-thread timestamp, so:

- different employee bots never share sessions;
- different threads using the same employee remain independent;
- a reply in an established thread continues the same employee and session without another mention;
- a new root channel conversation still requires a native `@mention`;
- DMs do not require a mention;
- resetting or expiring a session requires a new root mention.

The bot posts `_Thinking…_` immediately, updates the elapsed time during long turns, and replaces it with the final response. Thread-history seeding and delta hydration preserve context while keeping every thread isolated.

## Human decisions and approvals

- `ask_human` follows the validated Paperclip task origin back to the same employee bot and Slack thread.
- It accepts typed answers or up to five button choices, permits one pending question per thread, records the answer as a task comment, wakes the assignee and retires the controls.
- Approval buttons are bound to the exact posted card and canonical pending Paperclip approval; only `humanDecisionSlackUserIds` may answer or decide, and an empty decision allowlist authorizes nobody.
- Tasks without a valid Slack origin can use only the configured approvals/management channel.
- The packaged `ops/xoomai-human` helper invokes the policy-enforced plugin API with the current employee run credential. It does not bypass Paperclip policy or require an owner token.

Installers must bind a company-scoped, default-deny tool policy that includes only `xoomai.slack-socket:ask_human`, verify the effective policy for every selected employee, and add the wait/read/resume workflow to each employee's instructions. Provider-native tool enumeration is separate; use `xoomai-human` for both Codex and Claude when the native tool list omits the plugin tool.

## Preserved operational features

The first configured Slack App is the operational app. It owns shared features that must not be duplicated across every employee bot:

- Paperclip issue, completion and failure notifications;
- approval buttons;
- `/paperclip` commands;
- `ask_human`;
- the `slack_post_message` tool.

Additional Slack Apps are employee chat endpoints. They retain DMs, mentions, thread continuity, session persistence and reconnect recovery.

## Install from the fork

Paperclip currently supports plugin installation from a local checkout:

```bash
git clone https://github.com/XoomCloud/paperclip-plugin-slack-socket.git
cd paperclip-plugin-slack-socket
npm ci
npm run build
paperclipai plugin install "$(pwd)"
```

The plugin ID is `xoomai.slack-socket`.

## Create the Slack Apps

Create one Slack App per employee at [api.slack.com/apps](https://api.slack.com/apps).

For the first/operational employee, use [`slack-app-manifest.json`](./slack-app-manifest.json). For every additional employee, use [`slack-app-manifest.chat-only.json`](./slack-app-manifest.chat-only.json).

For each app:

1. Choose **Create New App → From an app manifest**.
2. Paste the appropriate manifest.
3. Change the app and bot display names to `XoomAI-<Paperclip employee name>`, for example `XoomAI-Sales`.
4. Install the app to the customer workspace.
5. Copy its Bot User OAuth Token (`xoxb-…`).
6. Under **Basic Information → App-Level Tokens**, create a token with `connections:write` and copy the `xapp-…` token.
7. Invite the employee bot to every Slack channel where it should be usable.

Slack credentials cannot be discovered from Paperclip. Creating the apps and storing their token pairs is credential provisioning; the employee binding itself remains automatic.

## Configure Paperclip

Create Paperclip secrets for every `xoxb` and `xapp` token, then configure:

- `slackBotTokenRef`: bot-token secret for the first/operational Slack App.
- `slackAppTokenRef`: app-token secret for the first/operational Slack App.
- `companyId`: the customer’s Paperclip company UUID.
- `defaultChannelId`: fallback channel for operational notifications.
- `additionalBots`: one entry per additional employee containing only its two token secret references and, optionally, its Slack-user allowlist.

Do not enter a Paperclip employee ID or employee name. Those fields do not exist in the XoomAI schema.

Important defaults:

- `continueMentionedThreads: true` — after the root mention, thread replies do not require another mention.
- `seedThreadHistory: true` — the employee receives the relevant Slack thread context.
- `streamPartialReplies: false` — internal adapter output and reasoning are not streamed into Slack.
- `sessionIdleHours: 24` — idle sessions are closed and recreated.
- outbound agent posting is disabled until explicitly enabled and allowlisted.
- unanswered human questions expire after 24 hours by default; expiry is never approval.

Press **Save** before **Test Connection** the first time so Paperclip can authorize access to the selected secrets.

## Naming and resolution

Paperclip aliases are derived from each active employee’s `name`, `urlKey` and `title`. Slack bot names have XoomAI branding and generic suffixes (`agent`, `employee`, `bot`) removed before matching.

| Slack bot | Paperclip employee | Result |
|---|---|---|
| `XoomAI-Sales` | `Sales` | routed |
| `XoomAI-HR-Coordinator` | `HR Coordinator` | routed |
| `XoomAI-Marketing-Agent` | `Marketing` | routed |

If two employees expose the same normalized alias, neither is selected. Rename one side so the binding becomes unique.

## Security behaviour

- Unresolved routing never falls back to another employee.
- Slack user allowlists are checked before session routing.
- Employee status is checked through the refreshed Paperclip registry.
- Message text is escaped before Slack Markdown conversion, preventing agent-generated mass mentions.
- Thread transcripts are fenced and control tags are neutralized before they reach the employee.
- Bot credentials are Paperclip secret references; raw tokens are not stored in plugin config.
- One worker binds to one Paperclip company for its lifetime and rejects cross-company config changes.

## Development

```bash
npm ci
npm test -- --run
npm run typecheck
npm run build
```

The complete design is in [`docs/XOOMAI_MULTI_APP_ARCHITECTURE.md`](./docs/XOOMAI_MULTI_APP_ARCHITECTURE.md).

## Upstream

This fork preserves clean separation from Paperclip core and retains the upstream MIT licence. The upstream remote is `https://github.com/0xCVH/paperclip-plugin-slack-socket` so upstream updates can continue to be merged.
