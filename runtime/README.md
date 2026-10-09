# XoomAI runtime companion — 0.1.0 review candidate

Supported Paperclip server: **2026.916.1 only**, original heartbeat SHA256 `4606c12bd4de2e1e69daec8e820fea3460e686ba5b06d4fedc5159e261770d33`. This is real checked-in source, not an unnamed package. It derives from approved dev runtime sources, removes customer values and adds fail-closed installation and durable delivery state. It is NOT yet qualified on a fresh Ubuntu VM or with live Slack/provider OAuth. Do not claim production acceptance from the local tests.

## Contents

- `dispatch.py`: validates root-owned employee map, Paperclip caller, private handoff, workspace/company/agent; drops groups/GID/UID; links credential-scoped native history; restores managed-home ACLs on exit.
- `patch-session.py` / `session-config.mjs`: checksum-qualified heartbeat patch; original backup and restore command; normalize only ephemeral managed-home paths and compare original credential identity.
- `xoomai-task`: assigned-task reuse by authoritative conversation marker, serialized creation and attributed comments/status updates.
- `xoomai-artifact`: owned workspace file intake, assigned-task check, persistent upload identity and native Slack delivery status.
- `delivery-service.mjs`: company/active-registry discovery, exact unique Slack bot matching, verified persisted thread binding, task-comment relay and artifact delivery with reserved Slack IDs and retry/uncertain state.
- `image-service.mjs` / `xoomai-image`: optional loopback-only text-to-image and artifact handoff; disabled by default; operator-authorized USD reserve/cap. AUD conversion/approval automation is NOT implemented; leave disabled until approved.
- `install.py`: plans by default; validates config/checksums/version; creates missing selected users only; protects existing storage; generates wrappers, narrowly scoped dispatcher sudoers and disabled systemd units.

## Fresh installation

1. Install Ubuntu prerequisites `python3 acl sudo`, pinned Paperclip server plus its DB dependencies into a stable application directory, root-owned Codex/Claude CLIs and the pinned Slack gateway. Existing runbook host/Tailscale/role/QMD steps still apply. Do NOT rely on transient npx cache as the runtime's appRoot.
2. Create/onboard the company and selected employees using Paperclip. Capture their live UUIDs. Copy `config.example.json` outside this checkout to a protected installation work directory and replace every placeholder using THIS installation's values. No customer values are in the bundle. No tokens in this config; only encrypted secret references.
3. Map each selected role to the Linux user/workspace/native history from the manifest. Engine `codex` means `codex_local`; `claude` means `claude_local`. Map existing employee UUIDs, never catalogue numbers. The employee map controls Linux execution; Slack routing continues to discover live employees dynamically, not by configured agent IDs.
4. Set appRoot to the persistent directory holding `node_modules/@paperclipai/server`, `@paperclipai/db` and `drizzle-orm`; pluginRoot to the built pinned gateway. Fill private HTTPS origin, Slack workspace ID, company UUID, Slack bot secret references, company-scoped attachment-service secret reference, and the existing protected Paperclip environment file. That file supplies the actual DATABASE_URL and existing Paperclip secret/encryption settings; never print it or copy another client's environment.
5. Run `sha256sum -c runtime/SHA256SUMS` from runtime's parent only after changing into runtime (see exact runbook commands). Then run the PLAN:

```bash
cd runtime
sha256sum -c SHA256SUMS
sudo /usr/bin/python3 -I install.py --config /root/xoomai-install/runtime.json
```

6. Review plan, compatibility, exact account/storage mapping and backup. In approved zero-active-run window:

```bash
sudo /usr/bin/python3 -I install.py --config /root/xoomai-install/runtime.json --apply
```

7. PATCH ONLY each existing employee's `adapterConfig.command` to `/usr/local/bin/xoomai-run-<key>`; preserve other config, model, grants, engine, scopes and heartbeat. Set local adapter engine to `cli` for this bundle; ACP subprocess behavior is not qualified. The dispatcher requires the supported Paperclip temporary managed HOME with company and grant UUID. Test Environment's `--version` probe is supported. CLI binaries must be root-owned and executable; helper wrappers must never point recursively to themselves.
8. The direct sudo dispatcher requires `NoNewPrivileges=false` on the Paperclip service, NOT on the delivery/image service. Make an explicit reviewed service drop-in, preserving all other hardening. Do not retain `PrivateTmp=true` on the Paperclip service for this release: the dispatcher validates handoffs and managed HOME below the real /tmp. This release supports default company-state layout only; non-default instance paths need qualification. Do not grant sudo to normal employees; the installer grants only the service's exact dispatcher entry. Administrative employee sudo is a separate owner-approved policy.
9. Before restart, validate unit and sudoers configuration. Restart Paperclip only after backing up and draining runs; ensure employees still have the same UUIDs. Enable delivery after the first acceptance checks:

```bash
sudo systemctl enable --now xoomai-delivery.service
sudo systemctl is-active xoomai-delivery.service
```

10. Keep image service disabled until operator approves an image budget/provider. The bundled image endpoint follows the dev source's OpenRouter contract and must be checked against current provider documentation/model discovery on the target. Then enable `xoomai-image.service` and test it; no API request is made by the installer.
11. Run EVERY test in the recovery guide plus provider UID, same-native-session reuse after restart, account/model invalidation, distinct thread isolation, task creation/progress, file retries, inbound comprehension, sibling-denial and QMD. A running unit is not acceptance.

## Existing installation adoption

Do not rerun onboarding or create new employees. Inventory versions, existing UUIDs/users/home/workspace/history and running jobs first. If prior custom dispatcher/session/delivery services exist, preserve their source/state/units and keep their original outboxes: this new service must not run alongside a legacy relay. Disable old delivery only in an approved drain/migration window. It does not import a legacy outbox automatically. Native history must be reconciled per employee/grant without copying auth; do not merge sibling/account histories. Adapt the map to existing Linux names/roots rather than renaming accounts.

Use the install PLAN first. `--adopt-existing` permits correctly owned private directories, not replacement of conflicting helpers, config or patches. Existing managed files that differ cause a stop, not overwrite. Stage a reviewed migration of those specific paths after backup; do not delete directories broadly to bypass the check. The patch script refuses any unknown heartbeat source; preserve prior patches and qualify them rather than replacing them with pristine source.

## Rollback and uncertain sends

Drain runs and stop only newly enabled runtime units. Restore the backed-up adapter command/unit drop-in/config; restore the original pinned heartbeat with `sudo python3 -I /usr/local/lib/xoomai-runtime/patch-session.py --server-root <ACTUAL_SERVER_PACKAGE_ROOT> --restore`. Retain all native history, provider auth managed by Paperclip, Paperclip tasks/uploads and delivery state. Do NOT rerun initial startup with a new state file to resend old artifacts.

A send/completion interrupted after submission becomes `uncertain`; inspect the recorded Slack file ID/message identity privately in Slack before any manual retry. Never delete the record and upload again. First boot sets an intake timestamp to avoid bulk replaying old artifacts/comments. Existing pending artifacts need explicit reconciliation/migration. Completed/uncertain entries remain durable. This service relays agent comments; task runs must write concise milestones/blockers/completion comments. Bare status changes without comments are not relayed by this release.

## Known limitations / release gate

This candidate uses Paperclip's private DB and secrets interfaces and an exact heartbeat patch. A Paperclip upgrade needs requalification; do not run it against a different package. Live providers/Slack, Linux ACLs and a clean-VM install have not been validated by Windows unit tests. A failed alias currently pauses the service refresh conservatively rather than guessing. Provider native-history paths and managed-home cleanup must be proven for the installed CLI versions. Host multi-run cleanup and use of task-specific artifact paths need target tests. No live client server was connected to or modified to produce this package.
