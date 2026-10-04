# Inbound attachments and failed-file replay

The canonical 0.14.0-xoomai.1 source integrates metadata mapping on events/history,
gateway-owned Slack downloads, private intake storage, Paperclip task evidence,
and persistent failure state. It does not modify Paperclip core.

Configure `inboundFileRoot` (default `/var/lib/paperclip/slack-inbound`) and
`inboundFileMaxBytes` (default/hard ceiling 10 MiB) plus the existing Paperclip
service grant reference. Every employee Slack app requires `files:read` and
`files:write`, customer consent/reinstallation and effective-grant verification.
Never copy bot tokens into employee workspaces or prompts.

After provisioning employees, resolve each real Paperclip UUID and Linux user,
then run `ops/provision-inbound-spool` with those values. It requires the
`paperclip` service account, `acl`, and the default reviewed root. A non-default
root requires a security review. Employees read their own spool but cannot write,
enumerate siblings or read another employee's spool. Prove this on Ubuntu; local
Windows tests do not verify POSIX ACL enforcement.

Downloads accept only validated `https://files.slack.com` URLs with redirects
disabled, a 30-second timeout, supported document/image MIME types and byte caps
before/during streaming. Ten unique files are selected per turn, current first,
then recent bounded history. Downloads occur after the history-fetch timeout.
Bytes and provenance persist before remote upload. Upload attempts are recorded
before posting; uncertain uploads reconcile by filename/size/SHA-256 without a
blind duplicate. The exact conversation/employee task binding is reused; absent
bindings get one backlog evidence issue rather than another autonomous run.

Failure keys include employee, conversation and Slack file ID. Duplicate events
and historical rehydration reuse unavailable evidence without another download or
warning, even across worker restarts. A new message reattaching the same file at
a different Slack timestamp retries it and clears failure state on success.
Current failures notify once with one message-text fallback and a reattach-to-retry
instruction. Historical-only turns never show “Reading the attached files”.
Unavailable evidence remains explicit inside the hardened prompt context; silence
never means the attachment was read.

## Required installation acceptance

- Run typecheck, build and the complete gateway suite against the pinned source.
- For every selected employee, verify effective read/write grants without tokens.
- Send real PDF/image attachments with distinctive facts not pasted in message text;
  confirm content comprehension, same-thread later retrieval and native output upload.
- Force a file failure, send ordinary “Hi” and another reply, restart the worker,
  then reply again: no repeated download/status/warning, but unavailable evidence
  remains. Fresh reattachment retries, recovers and clears the failure record.
- Verify size/type/URL/redirect failures, concurrent event deduplication, one durable
  task attachment, uncertain-upload reconciliation, private ACLs and sibling denial.
- Restart only in an approved window with no active runs; check services, health and
  all configured Socket Mode connections. A healthy service is not file acceptance.

No new live Slack acceptance messages were sent while integrating this source.
Client deployment state, hosts, credentials and logs are not included.
