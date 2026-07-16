# Architecture and safety boundaries

WeClaudex is split into transport, durable coordination, agent adapters, and local safety/storage layers. WeChat protocol data does not become agent-session state, and Codex/Claude-specific event formats do not leak into the durable inbox.

```text
WeChat iLink long poll
        │ complete authorized server batch
        ▼
Account durable inbox ── persist batch ──► save sync cursor
        │ received / queued replay
        ▼
Peer task scheduler ─── frozen runtime snapshots
        │               per-peer serial + global concurrency cap
        ├── Agent Lane registry
        │     account + peer + provider + real cwd + access
        ├── Codex adapter ───── native thread resume + normalized events
        └── Claude adapter ──── native session resume + normalized events

Agent result / command reply
        ▼
Per-account outbox ─── rate spacing / retry / fresh context
        │
        └── /send payload ─── private outbound-spool snapshot

Workspace guard ─── pinned inbound media cache ─── artifact registry
        │
Atomic private state, installation lock, dedupe data and redacted logs
```

## Installation and account isolation

One running bridge is allowed for an entire state directory. `runBridge` acquires a global `bridge-global` lock before constructing account runtime state, so selecting a different `WECHAT_BRIDGE_ACCOUNT_ID` does not allow a second process in the same installation. Running accounts in parallel requires fully separate `WECHAT_BRIDGE_STATE_DIR` values.

The selected account forms an outer namespace around execution state:

- sync cursor, dedupe records, inbox, and outbox are keyed by account;
- the account scope is included in the internal peer ID used for peer settings, Agent Lanes, history compatibility, and artifact records;
- the same WeChat peer ID seen through two saved accounts therefore cannot share a provider, model, workspace, access mode, native session, queued task, or artifact list accidentally.

The named-workspace registry, media cache, outbound spool, and run-log directory are installation resources. Logical references into them remain account/task scoped, and the global installation lock prevents two bridge processes from mutating them concurrently.

## Durable inbound state machine

The local inbox is the durability barrier between WeChat polling and task dispatch. For every successful long-poll response, the coordinator:

1. filters the complete response batch to authorized user messages;
2. atomically stores any unseen messages in the selected account's inbox;
3. persists the response's new sync cursor only after the full batch is durable;
4. dispatches messages from the durable records.

This ordering prevents a process exit halfway through a response batch from advancing the server cursor past messages that exist nowhere locally.

```text
received ── classify + freeze ──► materialize ──► queued ── claim ──► running
   ▲                                │                                  │
   │                                └──── startup auto-replay ──────────┘
   │                                                                   │
   └──────── explicit /retry ◄──── failed / interrupted                ├── result persisted ──► completed ── reply admitted ──► done
                                                                       └── user clears unstarted work ──► cancelled
```

The persisted statuses have deliberate recovery semantics:

- `received`: raw WeChat message is durable but preprocessing may not have completed; replay automatically on startup.
- `queued`: materialized text/attachment paths plus a frozen runtime snapshot are durable; replay automatically on startup.
- `running`: an agent may already have produced side effects. On stop or next startup it becomes `interrupted`, not automatically queued.
- `failed`: preprocessing, queue execution, or the agent failed; retained for explicit `/retry`.
- `interrupted`: retained for explicit `/retry` because the previous process cannot prove how far the agent ran.
- `completed`: the Agent has finished and executable task data has been removed; only the persisted reply remains. Startup resumes reply admission without rerunning the Agent.
- `done`: eligible for message dedupe and pruned after the completed-record TTL (24 hours by default).
- `cancelled`: terminal unstarted work, or a not-yet-admitted completed reply, explicitly removed by `/stop` or `/new`; never replayed or offered by `/retry`.

`/retry` acts only on the requesting peer's work-classified `failed` and `interrupted` records, in receive order. Control commands are never replayed. It uses the current delivery context token/run ID while retaining the runtime snapshot frozen at first classification, including across an attachment-download failure. `/stop` and `/new` atomically mark unstarted work `cancelled` before removing it from memory.

An unreadable or invalid inbox is copied to a `.corrupt-*` quarantine file and is not overwritten. Failing closed avoids silently discarding the only durable copy of an inbound batch.

### At-least-once, not exactly-once

The inbox follows an at-least-once recovery model. A process can exit after an agent writes a file, creates a commit, updates a database, or calls an external API but before the inbox records `done`. Replaying that task can repeat the side effect; no local bridge can provide an atomic transaction spanning WeChat, a child CLI, the filesystem, and arbitrary external systems.

Automatic replay is therefore limited to work that had not entered `running`. The explicit `/retry` boundary gives the user a chance to inspect Git/workspace/external state first. Important workflows should use idempotency keys, deterministic destinations, check-before-create operations, database transactions, or temporary files followed by atomic rename.

## Frozen runtime snapshots and scheduling

As soon as a raw message is classified as work—before attachment materialization—the inbox freezes:

```text
provider + canonical cwd + accessMode + model + effort
```

Later `/codex`, `/claude-code`, `/cd`, `/ws`, `/access`, `/model`, or `/think` commands affect only messages queued afterward. The scheduler uses a hash of the five fields as its batch key, so adjacent messages with different settings are never merged into one agent turn.

Scheduling has two independent constraints:

- each peer is strictly serial, preserving conversation order;
- the whole bridge has a fair global agent-process cap, default `2`, controlled by `WECHAT_BRIDGE_MAX_CONCURRENT_AGENTS`.

Rapid messages with the same frozen snapshot are coalesced after the configurable debounce window. The default in-memory pending limit is 20 items per peer. The durable inbox remains the source of recovery truth; the in-memory queue only schedules work that has already been persisted.

## Agent Lanes

A Lane is keyed within its account namespace by:

1. the authorized WeChat peer;
2. `codex` or `claude-code`;
3. the workspace's resolved real path;
4. `read-only`, `workspace`, or `full` access.

Switching provider, workspace, or access selects a different conversation rather than mixing incompatible state. `/new` archives and clears the selected Lane. The bridge stores the native Codex thread ID or Claude Code session ID; manual transcript replay remains only as a one-time compatibility path for pre-0.3 state.

Model and effort are intentionally not part of the Lane key, so a new turn can use updated model controls on the same native conversation. Frozen task snapshots ensure an update cannot retroactively change work already in the durable queue.

## Outbound scheduling and content snapshots

The account-specific outbox serializes visible messages per peer, enforces a minimum send interval, performs bounded retries, and opens a short circuit after repeated rate limits. A stale WeChat context leaves the operation pending until that peer sends another message; the fresh context token and run ID are then applied before a flush. Each persisted operation keeps a stable client ID across retry attempts. Final Agent replies use a separate critical capacity pool; the bridge reserves the maximum bounded reply chunk count before launching an Agent.

Durable outbox records survive process restart for up to 24 hours by default. Unsupported schemas, malformed records, and duplicate IDs quarantine the file and fail closed rather than overwriting it. Tool-progress and typing feedback are intentionally non-durable, because replaying stale progress is less useful than preserving final replies and explicitly requested files.

### `/send` snapshot flow

Persisting only a workspace path would create a time-of-check/time-of-use problem: the file could change or disappear while an upload is deferred. `/send` therefore stages content before enqueueing:

1. resolve the requested path inside the current canonical workspace;
2. reject non-regular, oversized, symlink-escaped, or credential-like paths;
3. open without following a final symlink and compare device/inode/size/mtime/ctime before, during, and after reading;
4. copy the authorized bytes to a UUID entry under private `outbound-spool/`;
5. write a `0600` manifest containing the original name, size, kind, creation time, and SHA-256;
6. persist the spool payload path plus snapshot UUID, name, manifest path, size, SHA-256, kind, and creation metadata in the outbox;
7. immediately before upload, reopen with no-follow semantics, validate the UUID tree and strict manifest, hash the regular-file bytes, and upload that verified buffer directly.

The spool directory hierarchy is `0700`; payload and manifest files are `0600`. A later edit or deletion of the workspace source cannot change the bytes queued for delivery, and mutation of the snapshot itself is detected before upload. The scheduler removes the corresponding snapshot after success, fatal discard, explicit outbox clearing, or TTL pruning. `/stop` and `/new` do not silently clear already-admitted outbox records. Because this mechanism stores a second complete copy, `outbound-spool/` must be protected as sensitive data.

## Workspace and access boundaries

Workspace paths are resolved through `realpath`. Filesystem roots, home itself, system directories, and temporary roots are rejected. Lane identity uses the resolved path, so symlink aliases cannot silently merge sessions.

Codex modes use its native sandbox:

- `read-only` → `read-only` sandbox with non-interactive approval policy;
- `workspace` → `workspace-write` sandbox with non-interactive approval policy;
- `full` → explicit sandbox/approval bypass.

Claude Code does not currently provide an operating-system workspace sandbox through its CLI. Its mappings are:

- `read-only` → `plan`;
- `workspace` → `acceptEdits`;
- `full` → permission bypass.

Consequently, Claude Code `workspace` is a workflow permission mode, not a hard filesystem boundary. Use `read-only`, a dedicated OS account/container, or another external sandbox when that distinction matters.

## Inbound media and artifacts

Inbound encrypted media is downloaded only from official WeChat CDN hosts, bounded before and during streaming, decrypted locally, identified by file signature, and stored under a SHA-256 name with private permissions. Cache count and lifetime are bounded under normal operation.

Attachment paths referenced by executable unfinished inbox work are pinned during cache pruning. TTL and count pruning cannot delete them until the work becomes `completed`, `done`, or `cancelled`; a backlog can therefore temporarily exceed the normal cache-count bound. This preserves the attachment dependency of a recovered `queued`, `failed`, or `interrupted` task while releasing it as soon as the Agent result is durable.

The bridge never scans an agent response for paths and never auto-sends a generated file. A user must request `/send`; the resolved target must remain inside the active workspace, be a regular file, fit the size limit, and not match common credential/private-key names. Only after these checks is the content snapshot described above created.

## Private state layout

```text
<stateDir>/
  accounts/          credentials and per-account sync cursors
  peers/             account-namespaced provider/workspace/access/model/effort
  lanes/             native Codex thread and Claude session references
  inbox/             per-account durable inbound state machines
  dedupe/            completed-message IDs, scoped by account
  outbox/            per-account deferred outbound operations
  outbound-spool/    private `/send` content snapshots
  media-cache/       inbound decrypted attachments, with task pins
  artifacts/         account/peer-scoped recent artifact registries
  runs/              redacted structured runtime logs
  locks/             installation-wide bridge lock
```

JSON state uses atomic replacement. Sensitive files are written as `0600` and private directories are enforced as `0700` where the platform supports POSIX modes. These measures reduce partial writes and accidental same-host disclosure; they do not replace disk encryption or OS-account isolation.

## Independent implementation

The project uses its own module boundaries, state format, command flow, and tests. Other coding-agent bridges informed general product questions—such as session continuity, queueing, workspace selection, and media handling—but their source code and user-facing interaction designs are not dependencies of this implementation.
