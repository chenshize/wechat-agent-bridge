# Changelog

## Unreleased

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
