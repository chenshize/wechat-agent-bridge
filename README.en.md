# WeClaudex

<p align="center">
  <img src="docs/images/weclaudex-intro.gif" width="800" alt="WeChat, Claude Code, and Codex merge into WeClaudex">
</p>

English | [简体中文](README.md)

[![GitHub Release](https://img.shields.io/github/v/release/chenshize/weclaudex?display_name=tag)](https://github.com/chenshize/weclaudex/releases/latest)
[![npm](https://img.shields.io/npm/v/weclaudex?logo=npm)](https://www.npmjs.com/package/weclaudex)
[![CI](https://github.com/chenshize/weclaudex/actions/workflows/ci.yml/badge.svg)](https://github.com/chenshize/weclaudex/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/chenshize/weclaudex)](LICENSE)

**Control your local Claude Code and Codex from WeChat.** Send requests, screenshots, files, or voice messages from your phone and let an agent work on your own computer and project directory. Switch backends, models, effort, workspaces, and access modes at any time, then safely receive results and artifacts in WeChat.

Real Codex threads and Claude Code sessions resume across switches and restarts. Tasks, replies, and queued files recover durably. Agent artifacts are never sent automatically; sending a file from WeChat requires an explicit `/send`. WeClaudex reuses your locally authenticated CLIs, so the bridge needs no separate model API key.

## Core capabilities

- **Remote task control:** submit work, follow progress, stop execution, retry interrupted tasks, and recover results from WeChat.
- **Two agents through one entry point:** switch with `/codex` and `/claude-code` while each backend retains its own native session and context.
- **Multimodal input:** text, screenshots, files, WeChat voice transcripts, and video can enter one task, with rapidly sent context coalesced automatically.
- **Durable recovery:** unstarted tasks, completed replies, and explicitly queued files recover across bridge restarts and network failures according to separate safety boundaries.
- **Cross-device handoff:** inspect saved native sessions and generate the exact terminal command that resumes the current conversation.
- **Always-on service:** macOS launchd and Linux systemd user services provide startup, restart, status, and logs.
- **WeChat micro-supervision:** choose quiet, normal, or verbose notifications for tool progress and long-task heartbeats while native input requests remain visible.
- **Layered safety controls:** sender allowlists, validated workspaces, `read-only / workspace / full`, explicit `/send`, and sensitive-path blocking constrain remote operations.

## Feature showcase

<p align="center">
  <img src="docs/images/feature-agent-response.png" width="360" alt="Agent progress and responses in WeChat">
  <img src="docs/images/feature-model-controls.png" width="360" alt="Model and effort controls in WeChat">
</p>

## Quick start

### Requirements

- Node.js 22+
- An installed and authenticated [Codex CLI](https://github.com/openai/codex#quickstart) and/or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- Access to WeChat ClawBot under WeChat's Plugins page
- A dedicated project directory for agent work

Installing only one agent is fine. The other CLI appears as unavailable when invoked or inspected with `/doctor`.

CI currently covers Ubuntu/Linux and macOS. Windows compatibility paths are implemented but not yet included in CI; Windows users should validate through WSL or Git Bash first.

### Install and run

```bash
npm install -g weclaudex
weclaudex init
weclaudex login
cd "/absolute/path/to/project"
weclaudex doctor
weclaudex service install
```

After scanning the QR code, send `/status` in WeChat, then send your first development task. You can keep using `weclaudex run` in the foreground instead of installing the background service.

> [!IMPORTANT]
> WeClaudex starts coding agents as your local OS user. Use a dedicated workspace and keep the default `workspace` access mode. A sender allowlist controls who can trigger the bridge; it does not make dangerous instructions safe. Enable `/access full` or `WECHAT_BRIDGE_ALLOW_ALL=1` only when you fully understand the risk.

## Connect through WeChat ClawBot

WeChat ClawBot is currently required for the WeChat connection. If your WeChat client does not show Plugins or WeChat ClawBot, WeClaudex cannot complete the connection yet.

1. Open the WeChat Plugins page, find WeChat ClawBot, and open its details.

   <p align="center">
     <img src="docs/images/setup-clawbot-plugin.png" width="360" alt="WeChat ClawBot on the Plugins page">
   </p>

2. On the computer running the bridge, execute:

```bash
weclaudex login
```

   You do not need to run the OpenClaw installation command shown on the ClawBot details page.

3. Tap “开始扫一扫” (Start scanning) on the ClawBot details page, scan the QR code shown in the terminal, and confirm the connection.

   <p align="center">
     <img src="docs/images/setup-clawbot-scan.png" width="360" alt="WeChat ClawBot details and scan action">
   </p>

4. After login, start the bridge:

```bash
cd "/absolute/path/to/project"
weclaudex service install
```

By default, the bridge only processes messages from the WeChat `userId` returned during QR login. Add any other sender explicitly through `WECHAT_BRIDGE_ALLOW_FROM`.

## Typical workflow

```text
/claude-code
Analyze this error screenshot and suggest a fix

/codex
Independently inspect the same error in the current project, implement the fix, and run the tests

/status
/artifacts
/send 1
```

Claude Code and Codex keep separate native sessions and do not automatically share each other's conversation context. Include any required context after switching.

## How it works

WeClaudex is not another agent. It hands WeChat messages to the Codex or Claude Code CLI already signed in on your computer, while coordinating sessions, tasks, and replies between both sides. WeClaudex does not provide a model service or copy your project to its own intermediary server; how model services process code still depends on each CLI's behavior and configuration.

```text
WeChat message
      ↓
Local task queue (persist first, then run)
      ↓
Agent Lane (select the matching independent session)
      ↓
Local Codex / Claude Code CLI
      ↓
Local reply queue (retain failed deliveries)
      ↓
WeChat reply
```

Four concepts appear throughout the rest of this README:

- **Agent Lane:** an independent agent conversation. It binds a WeChat sender, selected agent, project directory, and permission mode, then stores the native Codex thread or Claude Code session so you can switch away and resume later.
- **Workspace and access:** the workspace selects the project directory; `access` determines whether the agent can only read, modify the workspace, or receive unrestricted permissions.
- **Inbox and outbox:** the inbox is the local task queue and the outbox is the local reply queue. Together they let the bridge distinguish work that has not started from results that have not been delivered after a restart or network interruption.
- **Artifacts:** files created or modified by an agent. They are never sent to WeChat automatically; inspect them with `/artifacts`, then select one explicitly with `/send`.

### How sessions are isolated and resumed

Think of an Agent Lane as the conversation slot WeClaudex saves for one execution environment. Different senders, agents, projects, or permission levels never collapse into the same context:

```text
WeChat account × sender × agent × project directory × permission mode = one Agent Lane
```

A Codex Lane stores a real `threadId`; a Claude Code Lane stores a real `sessionId`. Switching agents, projects, or permissions enters another Lane. Returning to the original combination resumes its native session, while `/new` resets only the current Lane.

Model and effort are not part of Lane identity, but each task stores the agent, workspace, permission, model, and effort selected when it entered the queue. Changing settings later therefore affects only later messages and cannot silently mutate pending work. See the [architecture document](docs/ARCHITECTURE.md) for session-loss handling, persisted state, and recovery boundaries.

## Run from source

```bash
git clone https://github.com/chenshize/weclaudex.git
cd weclaudex
npm ci
npm run check
npm run login
WECHAT_BRIDGE_CWD=/absolute/path/to/project npm run run
```

The source checkout is best for auditing, testing, and contributing. Prefer the global npm installation for normal use.

## Run

```bash
cd "/absolute/path/to/project"
weclaudex run
```

The equivalent command from a source checkout is `npm run run`.

New installations store credentials and state in:

```text
~/.weclaudex
```

Set `WECHAT_BRIDGE_STATE_DIR` to use another directory.

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
| `/tasks` | List recent durable tasks with opaque short IDs; `/jobs` is an alias |
| `/task <id>` | Show the task state, agent, workspace, access, model, and latest error |
| `/retry` | Resubmit this sender's `failed` / `interrupted` tasks in receive order; queued tasks retain their frozen settings |
| `/sessions` | List native Codex threads and Claude Code sessions saved for this sender |
| `/resume-command` | Generate the terminal command for the current Lane; avoid driving one native session from terminal and WeChat simultaneously |
| `/notify` | Show the current notification mode and available values |
| `/notify quiet\|normal\|verbose` | Select critical results only, standard tool progress, or detailed heartbeats |
| `/watch` | Switch quickly to `verbose`; `/mute` switches to `quiet` |
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

### Notifications and native interactions

`normal` is the default: coalesced tool progress remains visible while the long-task heartbeat drops to once every three minutes. `verbose` uses a five-second tool-progress interval and a 45-second heartbeat for temporary observation. `quiet` suppresses tool progress and heartbeats, but final results, errors, native input requests, and confirmation requests still arrive.

When Codex structured output contains an input/approval item, or Claude Code emits `AskUserQuestion` / `ExitPlanMode`, WeClaudex shows the native request and task ID in WeChat. The bridge does not approve permissions for the agent or imitate its permission engine. Whether the current non-interactive CLI turn exits after the request depends on that upstream version; your WeChat reply continues the same native session as its next turn rather than being injected into a still-running tool call.

In normal and verbose mode, the final reply includes a compact receipt with task ID, agent, duration, CLI-reported token usage, and recent artifact count. `/tasks` uses the same ID for durable state inspection.

## Workspaces and permission control

Every development task needs two decisions: **which directory to work in** and **how much the agent may do**. Use `/cd` or `/ws` to select a project and `/access` to select permissions. Changing either one enters its matching Agent Lane so different projects or permission levels do not share conversation context.

### Choose a workspace

The workspace is the project directory used by Codex or Claude Code for a task. Give WeClaudex a well-bounded code repository that is safe for an agent to inspect, rather than an entire user directory.

`/cd` and `/ws` resolve canonical paths and reject:

- the filesystem root, the user's home directory, the entire `Desktop`, or the entire `Downloads` directory;
- macOS/Linux system directories and temporary directories;
- nonexistent paths, regular files, and paths that cannot be safely resolved.

These checks reduce accidental exposure of overly broad directory trees, but they **do not inspect every file in a project for sensitive content**. Use a dedicated project directory and do not keep credentials there if an agent should not read them.

### Choose a permission mode

`/access` controls the permissions for subsequent tasks:

- `read-only`: suited to analysis, explanation, and code review; the agent should not modify the project.
- `workspace`: the default for normal development; the agent may edit the project and run commands.
- `full`: disables the agent CLI's built-in approval or sandbox restrictions and should be used only when you understand the task and host-level risk.

WeClaudex translates the same permission choice into the native arguments supported by each CLI:

| Mode | Codex | Claude Code |
| --- | --- | --- |
| `read-only` | `--sandbox read-only`, with approval prompts disabled | `--permission-mode plan` |
| `workspace` (default) | `--sandbox workspace-write`, with approval prompts disabled | `--permission-mode acceptEdits` |
| `full` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |

> [!IMPORTANT]
> **Claude Code's `workspace` mode is not an operating-system sandbox.** It maps to Claude Code's `acceptEdits` permission mode and does not enforce an OS-level boundary around the current directory. `read-only` similarly relies on Claude Code's `plan` mode. Use a low-privilege OS account, container, or virtual machine when strong isolation is required.

`WECHAT_BRIDGE_CODEX_ARGS` and `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` are complete argv replacements, not appended arguments. They can replace the built-in access, model, JSON-stream, and resume arguments, which may break Lane resumption, progress parsing, or safety. They are intended only for users who understand both CLIs.

## How tasks and replies recover

A coding-agent task can run for several minutes while the bridge process, computer network, or WeChat connection may fail in the middle. If a task exists only in memory, a restart cannot tell whether it ran. If every uncertain task runs again automatically, it may repeat file changes or external calls. WeClaudex therefore uses two persistent local queues: the inbox records tasks, and the outbox records replies and files that have not yet been delivered.

### What happens when a task is interrupted

- **Tasks that have not started** resume in receive order after the bridge restarts.
- **Tasks interrupted during execution** are marked as interrupted and are not rerun silently. Inspect the workspace and Git state before using `/retry`.
- **Completed tasks** store their result first. If only the WeChat reply is pending, a restart redelivers the result without invoking the agent again.
- Tasks from one sender stay serial, while different senders may run concurrently. Every task keeps the agent, project, permission, model, and effort selected when it entered the queue.
- `/queue` shows waiting, interrupted, and pending-delivery counts. `/stop` cancels the active and unstarted work; `/new` also opens a fresh session for the current Lane.

### Why `/retry` asks for your decision

Recovery follows an **at-least-once** model rather than exactly-once semantics that cannot be guaranteed across an agent CLI, filesystem, and external services. Before the process stopped, the agent may already have edited files, run commands, or called an API even though the bridge did not record completion. An automatic rerun could repeat those side effects, so uncertain tasks wait for you to inspect them and explicitly use `/retry`.

### What happens when a reply cannot be delivered

Failed text, image, and file deliveries enter the local outbox and retry after connectivity returns. If the WeChat delivery context has expired, the bridge waits for that user's next message and then redelivers with the fresh context. Pending records are retained for 24 hours by default; corrupt queue files are quarantined instead of being overwritten as an empty queue.

This remains a best-effort local bridge and cannot provide a distributed transaction across WeChat, an agent CLI, the filesystem, and external services. Confirm important operations with `/status`, repository state, or local logs. See the [architecture document](docs/ARCHITECTURE.md) for the full state machine, concurrency limits, backoff, and capacity policies.

## Inbound images, files, voice, and video

You can send a screenshot, file, voice message, or video together with a task description in WeChat. WeClaudex gives it to the selected agent as input for that task, although format support differs between agents.

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
weclaudex send-image /absolute/path/to/image.png
weclaudex send-file /absolute/path/to/report.pdf
```

They send to the `userId` saved during login by default. Override the recipient for one invocation with:

```bash
WECHAT_BRIDGE_TO='user@im.wechat' weclaudex send-file /absolute/path/to/report.pdf
```

From a source checkout, `node src/cli.js send-image` / `send-file` is also available.

## Environment variables

Settings saved by WeChat commands generally take precedence over default environment values. Changing `WECHAT_BRIDGE_CWD`, `WECHAT_BRIDGE_ACCESS_MODE`, or `WECHAT_BRIDGE_DEFAULT_AGENT` does not overwrite an existing sender's saved runtime settings.

### Core settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECHAT_BRIDGE_STATE_DIR` | `~/.weclaudex` | Credentials, Lanes, peer settings, cursor, dedupe data, durable inbox, outbox, outbound spool, media cache, and run logs |
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
| `WECHAT_BRIDGE_STREAM_PROGRESS_MIN_INTERVAL_MS` | `normal: 15000` / `verbose: 5000` | Minimum interval between tool-progress messages |
| `WECHAT_BRIDGE_STREAM_PROGRESS_MAX_ITEMS` | `3` | Maximum tool-progress items coalesced per update |
| `WECHAT_BRIDGE_PROGRESS_INTERVAL_MS` | `quiet: 0` / `normal: 180000` / `verbose: 45000` | Override the long-running task status interval; set to `0` to disable |

### Login, files, and advanced settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECHAT_BRIDGE_LOGIN_TIMEOUT_MS` | `480000` | QR login wait time |
| `WECHAT_BRIDGE_BOT_TYPE` | `3` | ClawBot login bot type; normally unchanged |
| `WECHAT_BRIDGE_BOT_AGENT` | current `WeClaudex/<version>` | iLink `bot_agent` identifier; normally unchanged |
| `WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES` | `26214400` | `/send` file-selection limit; only lower values are useful |
| `WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS` | `0` | Set to `1` to let `/send` select credential-like paths; high risk |
| `WECHAT_BRIDGE_TO` | Login user | Recipient for local `send-image` / `send-file` commands only |

## Diagnostics and local state

```bash
weclaudex doctor
```

The equivalent command from a source checkout is `npm run doctor`.

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

WeClaudex uses atomic JSON replacement and attempts to set sensitive files to `0600` and directories to `0700`. This reduces partial-state corruption and accidental local disclosure, but it is not a replacement for disk encryption, OS-account isolation, or host security.

## Security boundary

- The default allowlist, workspace validation, and access modes are defense in depth, not proof that untrusted remote execution is safe.
- `full` allows access beyond the workspace. Claude's `workspace` mode is also not an OS sandbox.
- If the WeChat account or an allowed sender is compromised, an attacker may issue instructions to your local agent.
- Treat inbound attachments as untrusted. Do not let a fully privileged agent execute scripts or macros from an attachment without review.
- `/send` blocks common escapes and sensitive filenames, but cannot detect secrets or personal data inside an ordinary-looking file.
- The durable inbox prevents silent task loss; it cannot provide exactly-once execution. Before `/retry`, account for file, Git, database, or external API side effects that may already have happened.
- `outbound-spool/` contains complete copies of files authorized through `/send`; protect them as sensitive data until delivery, clearing, or expiry removes them.
- Custom CLI argv can bypass the bridge's default access behavior. Validate changes locally with `weclaudex doctor` and the relevant CLI.

Do not paste tokens, account IDs, or raw chat logs into a public issue. Follow the [security policy](SECURITY.md) for private vulnerability reports.

## Roadmap

Future releases will focus on completing real developer workflows in WeChat instead of merely adding more chat commands:

- use the other agent for a read-only `/review` of current changes and hand tasks between Codex and Claude Code;
- discover local Git repositories and switch by project name instead of phone-unfriendly absolute paths;
- provide isolated task workspaces, change summaries, and a safe `/undo`;
- turn Issue/PR/CI links, error screenshots, and voice into actionable development tasks.

If WeClaudex solves your remote-development workflow, a Star helps others discover it. Open an issue for real problems and feature requests. If you would like to implement one, read the [contributing guide](CONTRIBUTING.md) first.

## Notes

- Keep the bridge process running while you want messages delivered to an agent.
- This project does not use OpenClaw as its agent runtime or directly import `@tencent-weixin/openclaw-weixin`. It independently implements the iLink HTTP/CDN subset required by ClawBot and invokes your locally authenticated `codex` and `claude` CLIs.
- This is an independent community project and is not affiliated with or endorsed by Tencent, WeChat, Anthropic, or OpenAI.
- The WeChat iLink/ClawBot protocol may change. For login or delivery failures, run `weclaudex doctor` and inspect the local run log first.

## License

[MIT](LICENSE)
