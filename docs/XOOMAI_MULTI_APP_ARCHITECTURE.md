# XoomAI multi-app routing architecture

## Decision

Each Paperclip employee is represented by one native Slack App/bot identity. A single plugin worker supervises every Socket Mode connection for the customer.

```text
Slack App @XoomAI-Sales     -- xoxb/xapp + WebSocket --> plugin -- employee id --> Paperclip Sales
Slack App @XoomAI-Marketing -- xoxb/xapp + WebSocket --> plugin -- employee id --> Paperclip Marketing
Slack App @XoomAI-Finance   -- xoxb/xapp + WebSocket --> plugin -- employee id --> Paperclip Finance
```

## Source of truth

Paperclip is the only routing source of truth. Configuration contains Slack secret references but no employee IDs, employee names, aliases or routing table.

The registry indexes the active Paperclip employees by conservative aliases derived from `name`, `urlKey` and `title`. Slack bot usernames are normalized by removing XoomAI branding and generic `agent`, `employee` or `bot` suffixes. Routing succeeds only when the result has exactly one match.

## Fail-closed rules

- No match: do not create a Paperclip session; reply with the currently routable employee names.
- Multiple matches: do not choose; identify the ambiguity and require a rename.
- Paused, pending-approval or terminated employee: remove it from the routable registry.
- Duplicate Slack bot user IDs: reject the configuration.
- There is no default employee and no fallback path.

## Conversation binding

State keys include the Slack bot user ID, Slack channel and root-thread timestamp. The stored session entry also includes the Paperclip employee ID. This gives every root Slack thread its own Paperclip provider session and prevents collisions across employee bots.

Once a root mention establishes the session, ordinary replies in that same Slack thread continue the existing employee session without another mention. A new root message still requires a native mention.

## Reconciliation

The employee registry refreshes:

- when plugin configuration is applied;
- every five minutes through a Paperclip scheduled job; and
- after `agent.created`, `agent.updated` and `agent.status_changed` events.

Slack credentials cannot be discovered from Paperclip. Each Slack App must still be created, installed and represented by an `xoxb`/`xapp` secret pair. Adding those secret references is credential provisioning, not routing configuration.

## Operational surfaces

The first configured Slack App owns shared operational features: Paperclip notifications, approval buttons, `/paperclip`, `ask_human` and the registered outbound posting tool. Additional apps are chat endpoints. This prevents every employee app from duplicating operational notifications and action handling.
