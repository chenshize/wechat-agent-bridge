# Changelog

## Unreleased

## 0.7.2 - 2026-07-17

- Replaced per-tool progress delivery with bounded execution summaries: normal mode emits at most one changed summary per 30 seconds with an eight-message task budget, while verbose mode aggregates five-second windows.
- Count every structured tool event, deduplicate representative commands, fold high-volume reads/searches, and retain a generic fallback for unknown commands and custom tools.
- Send the first significant normal-mode operation immediately and correlate failed tool results back to their starting command; repeated failures are deduplicated and immediate failures remain visible in quiet mode.
- Changed `/watch` and `/mute` into in-memory overrides for the active or next task that automatically restore the persisted `/notify` default when the task finishes.
- Bounded tracked samples, active tool IDs, command detail length, immediate failure count, and per-task progress messages so command-heavy tasks cannot grow memory or WeChat traffic without limit.

## 0.7.1 - 2026-07-17

- Show the redacted, bounded command text for Codex `command_execution` and Claude Code Bash progress instead of only the generic tool name.
- Show concise targets for file, search, URL, and similar tool calls when structured input is available.
- Redact common token, password, API-key, Authorization-header, and credential-bearing URL forms before tool details are sent to WeChat.

## 0.7.0 - 2026-07-17

- Added `/review [codex|claude-code] [focus]` for an independent read-only review of the current worktree by either native Agent.
- Added `/handoff [codex|claude-code] [goal]` for explicit cross-Agent continuation in the same workspace and access boundary.
- Kept collaboration bridge-native and non-autonomous: the selected default Agent is unchanged, tasks use durable inbox scheduling, and execution remains inside Codex or Claude Code.
- Added structured handoff prompts that treat repository state as the source of truth instead of copying full chat transcripts between incompatible native sessions.

## 0.6.0 - 2026-07-17

- Added per-sender `quiet`, `normal`, and `verbose` notification policies through `/notify`, `/watch`, and `/mute`.
- Normalized native question, approval-request, diff, and test-result event types without adding a bridge-owned permission engine.
- Recognized Codex structured input/approval items and Claude Code `AskUserQuestion` / `ExitPlanMode` tool events, forwarding concise prompts to WeChat when upstream emits them.
- Added opaque task IDs to progress heartbeats and durable completion receipts with Agent, duration, reported token usage, and artifact count.
- Reduced default normal-mode heartbeats to three minutes; quiet mode suppresses tool progress and heartbeats while retaining final results, failures, and native interaction requests.

## 0.5.0 - 2026-07-17

- Added `weclaudex init` to inspect the saved WeChat account, local agents, workspace, access mode, and recommended next steps.
- Added user-level background service management for macOS launchd and Linux systemd with install, start, stop, restart, status, logs, and uninstall commands.
- Added `/sessions` and `/resume-command` so bridge-managed native Codex threads and Claude Code sessions are visible and can be continued directly in a terminal.
- Added `/tasks` and `/task <id>` to expose recent durable inbox state through stable opaque task identifiers without revealing raw WeChat message IDs.
- Centralized the package, bridge log, diagnostics, lock metadata, and WeChat client user-agent version.

## 0.4.2 - 2026-07-16

- Published WeClaudex as a compact npm CLI package installable with `npm install -g weclaudex`.
- Added a package smoke test that installs the generated tarball and executes the packaged `weclaudex` binary.
- Limited npm contents to runtime source and essential project documentation.

## 0.4.1 - 2026-07-16

- Renamed the project, repository, package, and CLI to **WeClaudex** / `weclaudex`.
- New installations use `~/.weclaudex`; an existing local state directory is reused automatically so saved QR credentials are not lost.
- Added GitHub Actions checks for supported Node.js versions on Ubuntu and macOS.
- Added a bridge-level integration test that drives both fake Codex and Claude Code processes through durable inbound handling, result delivery, restart, and native session resumption.

## 0.4.0

This release combines the planned 0.3 runtime work and 0.4 workspace/media work.

### Agent runtime (0.3 milestone)

- Added resumable Agent Lanes isolated by WeChat peer, provider, real workspace path, and access mode.
- Codex resumes the recorded thread ID; Claude Code resumes the recorded session ID.
- Replaced the busy rejection with a bounded per-peer queue, short-message coalescing, and a durable account-scoped inbox.
- Persisted every authorized server batch before advancing its sync cursor. `received` and `queued` work now resume automatically after restart; `running`, `failed`, and `interrupted` work is retained for explicit `/retry`. Completed Agent replies use a separate `completed` recovery state and resume delivery without rerunning the Agent.
- Froze provider, canonical workspace, access mode, model, and effort as soon as a message is classified as work, before attachment materialization. Messages with different frozen snapshots are kept in separate agent turns.
- Added a fair installation-wide agent concurrency limit, configurable with `WECHAT_BRIDGE_MAX_CONCURRENT_AGENTS` and defaulting to two, while preserving strict per-peer serialization.
- Added persistent message deduplication, poll backoff with jitter, atomic state writes, and one installation-wide bridge lock per state directory.
- Namespaced peer runtime, Agent Lanes, inboxes, outboxes, dedupe data, and artifacts by WeChat account so saved accounts cannot share execution state accidentally.
- Documented the at-least-once delivery boundary and made interrupted/failed retries explicit to reduce accidental duplicate side effects.
- Added normalized agent events, structured private run logs, progress delivery, and persistent outbound retry scheduling.
- Added critical final-reply capacity reservations, strict outbox validation/quarantine, and stable result-chunk IDs so an Agent starts only when its bounded final reply can be durably admitted.
- Limited automatic stale-session fallback to precise missing-session errors before any meaningful Agent activity, preventing prompt replay after tools or file changes begin.
- Changed `/stop` to terminate the complete Codex/Claude process tree instead of only the CLI leader.
- Preserved the legacy state directory, QR credentials, settings, and history migration path.

### Workspace and media (0.4 milestone)

- Added safe workspaces and `/pwd`, `/cd`, and `/ws` commands.
- Added `read-only`, `workspace`, and `full` access modes with independent Codex and Claude Code mappings.
- Added encrypted inbound image, voice, file, and video download with official-host pinning, size limits, MIME detection, and a private bounded cache.
- Pinned inbound cache files referenced by unfinished inbox tasks so TTL/count pruning cannot invalidate a recovered task.
- Added generic outbound image/file upload.
- Added explicit `/artifacts` discovery and guarded `/send` delivery for workspace-contained files.
- Made `/send` stage a private content snapshot under `outbound-spool/` before enqueueing. Deferred sends retain the authorized bytes even if the workspace source changes; every dispatch revalidates the UUID path, strict manifest, file identity, size, and SHA-256 and uploads the verified buffer. Snapshots are removed after success, fatal discard, explicit outbox clearing, or TTL expiry.
- Added credential/path traversal protection and redacted diagnostics.
- Added automated coverage for state, adapters, queues, media cryptography, transport errors, and scheduler behavior.

## 0.2.0

- Added Claude Code alongside Codex.
- Added backend, model, and reasoning-level commands.
- Added bilingual documentation and WeChat ClawBot setup screenshots.
