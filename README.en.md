# WeClaudex

<p align="center">
  <img src="docs/images/weclaudex-intro.gif" width="800" alt="WeChat, Claude Code, and Codex merge into WeClaudex">
</p>

English | [简体中文](README.md)

[![GitHub Release](https://img.shields.io/github/v/release/chenshize/weclaudex?display_name=tag)](https://github.com/chenshize/weclaudex/releases/latest)
[![CI](https://github.com/chenshize/weclaudex/actions/workflows/ci.yml/badge.svg)](https://github.com/chenshize/weclaudex/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/chenshize/weclaudex)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/chenshize/weclaudex?style=social)](https://github.com/chenshize/weclaudex/stargazers)

**Control your local Claude Code and Codex from WeChat.** Send requests, screenshots, files, voice, or video from your phone and let an agent work on your own computer and project directory. Switch backends, models, effort, workspaces, and access modes at any time, then safely receive results and artifacts in WeChat.

This is more than a message-forwarding wrapper: real Codex threads and Claude Code sessions resume across switches and restarts, tasks and final replies have durable recovery, attachments are cached safely, and files leave the machine only after an explicit `/send`.

> [!WARNING]
> This is a remote entry point that starts coding agents as your local OS user. A sender allowlist controls who can trigger the bridge; it does not make a dangerous instruction safe. Use a dedicated workspace, keep the default `workspace` access mode, and only enable `/access full` or `WECHAT_BRIDGE_ALLOW_ALL=1` when you fully understand the risk.

This project does not use OpenClaw as its agent runtime and does not import `@tencent-weixin/openclaw-weixin`. It independently implements the small iLink HTTP/CDN protocol surface required by WeChat ClawBot, then runs your locally authenticated `codex` and `claude` CLIs.

## Core capabilities

- **Remote task control:** submit work, follow progress, stop execution, retry interrupted tasks, and recover results from WeChat.
- **Two agents through one entry point:** switch with `/codex` and `/claude-code` while each backend retains its own native session and context.
- **Multimodal input:** text, screenshots, files, WeChat voice transcripts, and video can enter one task, with rapidly sent context coalesced automatically.
- **Durable recovery:** unstarted tasks, completed replies, and explicitly queued files recover across bridge restarts and network failures according to separate safety boundaries.
- **Layered safety controls:** sender allowlists, validated workspaces, `read-only / workspace / full`, explicit `/send`, and sensitive-path blocking constrain remote operations.

A typical flow looks like this:

```text
/claude-code
Analyze this error screenshot and propose a fix

/codex
Implement the requested change and run the tests

/status
/artifacts
/send 1
```

## What 0.4.0 provides

- **Two agents with native session resumption:** Codex threads and Claude Code sessions are saved separately. Switching back invokes each CLI's native resume feature instead of rebuilding context from chat transcripts.
- **Agent Lane and account isolation:** within each account, every combination of sender, agent, canonical workspace path, and access mode owns a separate Lane. Peer settings, sessions, inboxes, outboxes, dedupe data, and artifact records do not cross account boundaries.
- **Durable inbound task queue:** a complete server batch is written to the local inbox before its cursor advances. `received` / `queued` work is restored automatically; `running` / `failed` / `interrupted` work is retained for explicit `/retry`. If an Agent has finished but its reply has not been admitted, `completed` replays only the result and never reruns the Agent.
- **Frozen execution settings and bounded concurrency:** provider, workspace, access, model, and effort are frozen as soon as a message is classified as work, even before an attachment finishes downloading. A sender remains serial, while the installation runs at most two agents at once by default.
- **Resilient transport:** polling failures use exponential backoff; one bridge process may run for the entire state directory; outbound delivery is rate-spaced, retried within bounds, and persisted to an outbox for redelivery when a fresh context arrives.
- **Safe workspaces and access modes:** manage validated workspaces with `/cd` and `/ws`, then choose `read-only`, `workspace`, or `full` with `/access`.
- **Inbound media:** receive and decrypt WeChat images, files, voice, and video. A voice transcript supplied by WeChat is also included as text in the turn.
- **Explicit artifact delivery:** inspect files from the most recent run with `/artifacts`, then explicitly send one with `/send`. A path mentioned by a model is never sent automatically.
- **Dynamic status:** `/status`, `/model`, and `/think` report controls for the active agent, including its model, effort, Lane, workspace, access, and queues.

### How Agent Lanes work

A Lane lives inside an account namespace and is identified by all four values:

```text
WeChat account namespace × (sender × codex/claude-code × canonical workspace path × access mode)
```

A Codex Lane stores a real `threadId`; a Claude Code Lane stores a real `sessionId`. Return to the same combination and the bridge resumes that native session, including after a bridge restart. `/new` archives and clears only the current Lane. The bridge retries with a fresh session only when the CLI precisely reports that the saved thread/session is missing and the turn has produced no text, thinking, or tool activity; otherwise it retains the failure for explicit review to avoid duplicated side effects.

The Lane key does not include model or effort, but every inbound task freezes `provider`, `cwd`, `accessMode`, `model`, and `effort` in the durable inbox. Running `/model`, `/think`, `/cd`, `/access`, or switching agents after a message is queued affects only later messages. Consecutive messages with different frozen snapshots are not merged into one agent turn.

## Feature showcase

<p align="center">
  <img src="docs/images/feature-agent-response.png" width="360" alt="Agent progress and responses in WeChat">
  <img src="docs/images/feature-model-controls.png" width="360" alt="Model and effort controls in WeChat">
</p>

## Requirements

- Node.js 22+
- An installed and authenticated `codex` and/or `claude` CLI
- A dedicated project directory for agent work; do not use your home directory, a system directory, or the whole Downloads directory as a workspace

Installing only one agent is fine. The other CLI appears as unavailable when invoked or inspected with `/doctor`.

## Start in five minutes

```bash
git clone https://github.com/chenshize/weclaudex.git
cd weclaudex
npm ci
npm run check
```

Confirm that at least one authenticated coding-agent CLI is available:

```bash
codex --version
claude --version
```

Then connect WeChat and start the bridge:

```bash
npm run login
WECHAT_BRIDGE_CWD=/absolute/path/to/project npm run run
```

Send `/status` in WeChat, then send your first development task directly. `npm run check` runs entry-point syntax checks and the complete test suite; `npm run doctor` verifies the account, workspace, Codex CLI, and Claude Code CLI.

You can also install the CLI globally straight from GitHub:

```bash
npm install -g git+https://github.com/chenshize/weclaudex.git
weclaudex doctor
weclaudex login
WECHAT_BRIDGE_CWD=/absolute/path/to/project weclaudex run
```

The source checkout is easier to audit, test, and contribute to; the global install is convenient when you just want to start using the bridge.

## Connect through WeChat ClawBot

1. Open the WeChat Plugins page, find WeChat ClawBot, and open its details.

   <p align="center">
     <img src="docs/images/setup-clawbot-plugin.png" width="360" alt="WeChat ClawBot on the Plugins page">
   </p>

2. On the computer running the bridge, execute:

```bash
npm run login
```

   You do not need to run the OpenClaw installation command shown on the ClawBot details page.

3. Tap “开始扫一扫” (Start scanning) on the ClawBot details page, scan the QR code shown in the terminal, and confirm the connection.

   <p align="center">
     <img src="docs/images/setup-clawbot-scan.png" width="360" alt="WeChat ClawBot details and scan action">
   </p>

4. After login, prepare a dedicated project directory and start the bridge:

```bash
WECHAT_BRIDGE_CWD=/absolute/path/to/project npm run run
```

By default, the bridge only processes messages from the WeChat `userId` returned during QR login. Add any other sender explicitly through `WECHAT_BRIDGE_ALLOW_FROM`.

## Run and upgrade

```bash
npm run run
```

New installations store credentials and state in:

```text
~/.weclaudex
```

Set `WECHAT_BRIDGE_STATE_DIR` to use another directory.

### Upgrading from 0.2.x

- If `~/.weixin-codex-bridge` or `~/.wechat-agent-bridge` already exists and no state directory is explicitly configured, WeClaudex continues using it. Existing accounts, tokens, sync cursors, model settings, and legacy conversation files are neither moved nor deleted.
- Common legacy `WEIXIN_CODEX_*` environment variables remain supported as compatibility aliases. New deployments should use `WECHAT_BRIDGE_*`.
- Agent Lanes are new 0.4.0 state. The first post-upgrade message creates a real Codex thread or Claude Code session; subsequent switches and restarts can resume it.
- The bridge now defaults to `workspace` access instead of full access. If full access is intentional, select it explicitly with `/access full`.
- A single installation-wide lock is now enforced per state directory, rather than one lock per account. Stop an older bridge first. Even different accounts cannot run concurrently from the same `WECHAT_BRIDGE_STATE_DIR`; use fully separate state directories when parallel account processes are required.

## WeChat commands

| Command | Behavior |
| --- | --- |
| `/codex` | Switch to Codex; resume the matching thread when a Lane exists |
| `/claude-code` | Switch to Claude Code; resume the matching session when a Lane exists |
| `/status` | Show agent, model, effort, access, workspace, Lane, inbound queue, pending outbound messages, and recent artifacts |
| `/model` | Show the active agent's current and available models |
| `/model <name>` | Change the active agent's model |
| `/think` | Show the active agent's current and available effort levels |
| `/think <level>` | Change the active agent's effort level |
| `/new` | Stop the active run, clear queued input, and start a new session for the current Lane |
| `/reset` | Alias for `/new` |
| `/stop` | Stop the active run and cancel unprocessed inbound work plus completed replies not yet admitted by the outbox; keep the current Lane and do not delete already-admitted result/file deliveries |
| `/queue` | Show active-task, queued-input, interrupted-task, and pending-outbound counts |
| `/retry` | Resubmit this sender's `failed` / `interrupted` tasks in receive order; queued tasks retain their frozen settings |
| `/pwd` | Show the current workspace |
| `/cd <path>` | Change workspace; accepts an absolute path or a path relative to the current workspace |
| `/ws list` | List named workspaces |
| `/ws save <name> [path]` | Save the current workspace or a specified path |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Remove the saved name without deleting the directory |
| `/access` | Show the current access mode |
| `/access read-only\|workspace\|full` | Change access mode; the next message uses the corresponding Lane |
| `/artifacts` | List sendable files created or modified by the most recent agent run in this workspace |
| `/send <number>` | Send a file from the `/artifacts` list |
| `/send <relative-path>` | Explicitly send a file inside the current workspace; quote paths containing spaces |
| `/doctor` | Show bridge version, CLI, account, state-directory, Lane, and outbox health in WeChat |
| `/help` | Show command help |

Compatibility aliases are `/claude`, `/models`, `/reasoning`, and `/workspace`. Claude Code effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Its model accepts aliases such as `sonnet`, `opus`, and `haiku`, plus full model IDs accepted by Claude Code. Codex model and effort options come from the local Codex model cache; `/model` and `/think` are authoritative for the current machine.

Bridge commands are recognized only in messages with **no attachments**. Command-looking text sent alongside an attachment is treated as a regular agent request.

## Workspaces and access modes

### Workspace boundary

`/cd` and `/ws` resolve canonical paths and reject:

- the filesystem root, the user's home directory, the entire `Desktop`, or the entire `Downloads` directory;
- macOS/Linux system directories and temporary directories;
- nonexistent paths, regular files, and paths that cannot be safely resolved.

These checks reduce accidental exposure of overly broad directory trees, but they **do not inspect every file in a project for sensitive content**. Use a dedicated project directory and do not keep credentials there if an agent should not read them.

### Access mapping

| Mode | Codex | Claude Code |
| --- | --- | --- |
| `read-only` | `--sandbox read-only`, with approval prompts disabled | `--permission-mode plan` |
| `workspace` (default) | `--sandbox workspace-write`, with approval prompts disabled | `--permission-mode acceptEdits` |
| `full` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |

> [!IMPORTANT]
> **Claude Code's `workspace` mode is not an operating-system sandbox.** It maps to Claude Code's `acceptEdits` permission mode and does not enforce an OS-level boundary around the current directory. `read-only` similarly relies on Claude Code's `plan` mode. Use a low-privilege OS account, container, or virtual machine when strong isolation is required.

`WECHAT_BRIDGE_CODEX_ARGS` and `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` are complete argv replacements, not appended arguments. They can replace the built-in access, model, JSON-stream, and resume arguments, which may break Lane resumption, progress parsing, or safety. They are intended only for users who understand both CLIs.

## Queues and reliability

### Inbound queue

- After each long poll returns, the bridge atomically writes every authorized user message in the complete server batch to the account-specific `<stateDir>/inbox/` before saving the new sync cursor. If the process exits halfway through dispatch, later messages remain replayable from the local inbox.
- Inbox records in `received` or `queued` state are restored in receive order at startup. Work that had entered `running` becomes `interrupted` when the process stops or next starts; agent/queue failures become `failed`. The latter two classes are not rerun automatically and require `/retry` from the same sender.
- Agent output is first atomically recorded as `completed`; it becomes `done` only after every reply chunk is delivered or durably admitted by the outbox. Restart resumes delivery without rerunning the Agent. Unstarted work cleared by `/stop` or `/new` becomes terminal `cancelled`. `done` / `cancelled` records are pruned after 24 hours by default. A corrupt inbox is quarantined and the bridge refuses to overwrite the original file.
- Each sender is still strictly serial. Messages arriving within 650 ms while idle are coalesced, and messages received during a run become the next turn. The installation-wide agent concurrency limit is two by default, with waiting senders admitted fairly.
- Provider, workspace, access, model, and effort are frozen and persisted when a message is first classified as work, before attachment download. Setting changes affect only later messages, and messages with different runtime snapshots are never coalesced into one batch.
- The default in-memory scheduling limit is 20 pending items per sender. Overflow remains recoverable as `failed`; `/stop` and `/new` mark unstarted tasks `cancelled` and remove them so they cannot reappear after restart.

### At-least-once delivery and side-effect safety

The durable inbox follows an **at-least-once** model, not exactly-once. `received` / `queued` work can replay automatically. `running` / `failed` work deliberately requires `/retry`, because an agent may already have written a file, run a command, or called an external service before the bridge could record `done`. Retrying across that crash boundary can therefore repeat side effects.

Inspect the workspace, Git state, and external systems before retrying. For important work, prefer deterministic filenames, temporary files plus atomic rename, database transactions, API idempotency keys, or “check before create” instructions. `/retry` uses the current WeChat delivery context while retaining the original frozen settings for work that had already reached the queue.

### Polling and outbound redelivery

- The WeChat long-poll cursor, account inbox, and completed-message IDs are persisted to reduce duplicate execution after reconnects or API replay.
- Network and API failures use jittered exponential backoff, reset after a successful poll.
- Outbound text, images, and files are serialized per sender, spaced by 2.5 seconds by default, and use bounded retries plus a short circuit breaker for retryable failures.
- Undelivered records are atomically persisted under `<stateDir>/outbox/` for up to 24 hours by default. If a context token is stale, delivery waits for that user's next message and retries with the fresh context. Final Agent replies use reserved critical capacity allocated before the Agent starts. A corrupt or incompatible outbox is quarantined and fails closed instead of being overwritten with an empty queue.

This is a best-effort local bridge. It cannot provide a distributed transaction across WeChat, an agent CLI, the filesystem, and external services. Confirm important operations with `/status`, repository state, or local logs.

## Inbound images, files, voice, and video

The bridge downloads encrypted content from the official WeChat CDN, decrypts it locally, detects the MIME type from content, and stores it under `<stateDir>/media-cache/` using a content hash as the filename. The cache is accessible only to the current user and retains up to 100 files or 24 hours by default. Attachments referenced by unfinished inbox tasks are **pinned** against TTL and count pruning. A backlog of attachment tasks can therefore temporarily raise the cache above 100 files until those tasks complete and a later prune runs.

Current fixed boundaries are:

- up to 25 MiB per decrypted attachment;
- up to 8 attachments per WeChat message;
- up to 50 MiB of attachments in one message;
- official WeChat HTTPS API/CDN hosts only.

Backend behavior differs:

- Codex: images are passed with the native `--image` option. Non-image attachments are added to the turn as safe local cache paths for tool-based reading, but are not presented as native Codex attachments.
- Claude Code: local cache paths are included in the turn prompt so Claude Code can read them when needed. Format support depends on Claude Code and its available tools.
- Voice: when WeChat supplies a transcript, it is included as text. An accompanying audio payload is also treated as an attachment.
- Video: the bridge receives and caches it, but does not promise that the selected agent can analyze audio or video.

## Artifacts and file delivery

After an agent run, the bridge records the most recent files created or modified in the active workspace since that run began. It never sends them automatically:

```text
/artifacts
/send 1
/send "reports/final report.pdf"
```

`/send` resolves the canonical path again, requires a regular file inside the current workspace, and blocks `.env`, `.ssh`, `.gnupg`, private keys, certificates, and paths resembling credentials, secrets, or tokens by default. After validation, the bridge rechecks file identity and metadata before and after reading, copies the authorized bytes into private `<stateDir>/outbound-spool/`, and records their size and SHA-256. The outbox persists the snapshot identity and integrity metadata. Immediately before every upload, the bridge revalidates the UUID path, manifest, regular-file identity, size, and SHA-256, then uploads the exact bytes read during that verification. A later edit or deletion of the workspace source therefore does not change the version selected by `/send`. The effective upload limit is 25 MiB.

The spool and snapshot directories use `0700`; payload and manifest files use `0600`. A snapshot is deleted after successful delivery, unrecoverable rejection, explicit outbox clearing, or TTL pruning. `/stop` and `/new` do not silently discard an already-admitted snapshot. The spool is a **second complete copy** required for safe redelivery, so protect the state directory and account for its disk usage.

`WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS=1` disables the sensitive-path filter and is high risk. `WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES` can lower the `/send` selection limit, but the WeChat upload hard limit remains 25 MiB.

The local `send-image` and `send-file` terminal commands are explicit administrator actions and do not apply the workspace or sensitive-name filter:

```bash
node src/cli.js send-image /absolute/path/to/image.png
node src/cli.js send-file /absolute/path/to/report.pdf
```

They send to the `userId` saved during login by default. Override the recipient for one invocation with:

```bash
WECHAT_BRIDGE_TO='user@im.wechat' node src/cli.js send-file /absolute/path/to/report.pdf
```

## Environment variables

Settings saved by WeChat commands generally take precedence over default environment values. Changing `WECHAT_BRIDGE_CWD`, `WECHAT_BRIDGE_ACCESS_MODE`, or `WECHAT_BRIDGE_DEFAULT_AGENT` does not overwrite an existing sender's saved runtime settings.

### Core settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECHAT_BRIDGE_STATE_DIR` | `~/.weclaudex`, or an existing legacy directory | Credentials, Lanes, peer settings, cursor, dedupe data, durable inbox, outbox, outbound spool, media cache, and run logs |
| `WECHAT_BRIDGE_ACCOUNT_ID` | Most recent login | Select the account to run when more than one is saved |
| `WECHAT_BRIDGE_ALLOW_FROM` | Login `userId` | Comma-separated sender allowlist; merged with the login user |
| `WECHAT_BRIDGE_ALLOW_ALL` | `0` | Set to `1` to accept any sender; strongly discouraged |
| `WECHAT_BRIDGE_CWD` | Process working directory | Initial safe workspace for a new sender |
| `WECHAT_BRIDGE_ACCESS_MODE` | `workspace` | Initial `read-only`, `workspace`, or `full` mode for a new sender |
| `WECHAT_BRIDGE_DEFAULT_AGENT` | `codex` | Initial `codex` or `claude-code` provider for a new sender |
| `WECHAT_BRIDGE_TIMEOUT_MS` | `600000` | Timeout for one agent run |
| `WECHAT_BRIDGE_CODEX_DEFAULT_MODEL` | First local Codex cache entry | Initial Codex model |
| `WECHAT_BRIDGE_CLAUDE_CODE_MODEL` | Claude setting or `sonnet` | Initial Claude Code model |
| `WECHAT_BRIDGE_CLAUDE_CODE_EFFORT` | `high` | Initial Claude Code effort |
| `WECHAT_BRIDGE_CODEX_ARGS` | Empty | Replace the complete Codex argv; expert option |
| `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` | Empty | Replace the complete Claude Code argv; expert option |

### Queues, polling, and feedback

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECHAT_BRIDGE_INPUT_DEBOUNCE_MS` | `650` | Window for coalescing rapid messages while idle or after a turn |
| `WECHAT_BRIDGE_MAX_PENDING_MESSAGES` | `20` | Maximum queued inbound messages per sender |
| `WECHAT_BRIDGE_MAX_CONCURRENT_AGENTS` | `2` | Total agent processes allowed concurrently in one bridge; each sender remains serial |
| `WECHAT_BRIDGE_POLL_BACKOFF_BASE_MS` | `1000` | Initial polling failure backoff |
| `WECHAT_BRIDGE_POLL_BACKOFF_MAX_MS` | `30000` | Maximum polling failure backoff |
| `WECHAT_BRIDGE_SEND_INTERVAL_MS` | `2500` | Minimum outbound interval for one sender |
| `WECHAT_BRIDGE_SEND_MAX_RETRIES` | `2` | Additional outbound scheduler retries |
| `WECHAT_BRIDGE_SEND_MAX_PENDING` | `200` | Maximum regular durable outbound records |
| `WECHAT_BRIDGE_SEND_CRITICAL_RESERVE` | `512` | Durable chunk capacity reserved for completed Agent replies; a new Agent does not start if it cannot reserve enough |
| `WECHAT_BRIDGE_REPLY_CHUNK_LENGTH` | `1200` | Long-reply chunk length in characters; minimum 200 |
| `WECHAT_BRIDGE_TYPING_HEARTBEAT_MS` | `15000` | WeChat typing-state heartbeat; set to `0` to disable the heartbeat |
| `WECHAT_BRIDGE_STREAM_PROGRESS_MIN_INTERVAL_MS` | `5000` | Minimum interval between tool-progress messages |
| `WECHAT_BRIDGE_STREAM_PROGRESS_MAX_ITEMS` | `3` | Maximum tool-progress items coalesced per update |
| `WECHAT_BRIDGE_PROGRESS_INTERVAL_MS` | `45000` | Long-running task status interval; set to `0` to disable |

### Login, files, and advanced settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECHAT_BRIDGE_LOGIN_TIMEOUT_MS` | `480000` | QR login wait time |
| `WECHAT_BRIDGE_BOT_TYPE` | `3` | ClawBot login bot type; normally unchanged |
| `WECHAT_BRIDGE_BOT_AGENT` | `WeClaudex/0.4.1` | iLink `bot_agent` identifier; normally unchanged |
| `WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES` | `26214400` | `/send` file-selection limit; only lower values are useful |
| `WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS` | `0` | Set to `1` to let `/send` select credential-like paths; high risk |
| `WECHAT_BRIDGE_TO` | Login user | Recipient for local `send-image` / `send-file` commands only |

## Diagnostics and local state

```bash
npm run doctor
```

Terminal diagnostics mask account IDs and never print tokens. Runtime events are written to `<stateDir>/runs/YYYY-MM-DD.jsonl`; peer IDs are hashed, and fields resembling tokens, secrets, passwords, or authorization data are filtered.

Important persistent directories are:

```text
accounts/          account credentials and sync cursors
peers/ lanes/      account-isolated peer settings and native session refs
inbox/             account-specific state machine and frozen task snapshots
outbox/            account-specific deferred outbound operations
outbound-spool/    private content snapshots created by /send
media-cache/       inbound attachments; unfinished tasks pin referenced files
runs/              redacted structured runtime logs
```

Version 0.4.0 uses atomic JSON replacement and attempts to set sensitive files to `0600` and directories to `0700`. This reduces partial-state corruption and accidental local disclosure, but it is not a replacement for disk encryption, OS-account isolation, or host security.

## Security boundary

- The default allowlist, workspace validation, and access modes are defense in depth, not proof that untrusted remote execution is safe.
- `full` allows access beyond the workspace. Claude's `workspace` mode is also not an OS sandbox.
- If the WeChat account or an allowed sender is compromised, an attacker may issue instructions to your local agent.
- Treat inbound attachments as untrusted. Do not let a fully privileged agent execute scripts or macros from an attachment without review.
- `/send` blocks common escapes and sensitive filenames, but cannot detect secrets or personal data inside an ordinary-looking file.
- The durable inbox prevents silent task loss; it cannot provide exactly-once execution. Before `/retry`, account for file, Git, database, or external API side effects that may already have happened.
- `outbound-spool/` contains complete copies of files authorized through `/send`; protect them as sensitive data until delivery, clearing, or expiry removes them.
- Custom CLI argv can bypass the bridge's default access behavior. Validate changes locally with `npm run doctor` and the relevant CLI.

Do not paste tokens, account IDs, or raw chat logs into a public issue. Follow the [security policy](SECURITY.md) for private vulnerability reports.

## Roadmap

Future releases will focus on completing real developer workflows in WeChat instead of merely adding more chat commands:

- use the other agent for a read-only `/review` of recent changes and hand tasks between Codex and Claude Code;
- discover local Git repositories and switch by project name instead of phone-unfriendly absolute paths;
- provide isolated task workspaces, change summaries, and a safe `/undo`;
- turn Issue/PR/CI links, error screenshots, and voice into actionable development tasks.

Open an issue to share the workflow you need most. If you would like to implement it, read the [contributing guide](CONTRIBUTING.md) first.

## Notes

- Keep the bridge process running while you want messages delivered to an agent.
- This is an independent community project and is not affiliated with or endorsed by Tencent, WeChat, Anthropic, or OpenAI.
- The WeChat iLink/ClawBot protocol may change. For login or delivery failures, run `npm run doctor` and inspect the local run log first.

## License

[MIT](LICENSE)
