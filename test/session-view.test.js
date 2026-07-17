import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionList, nativeResumeCommand, shellQuote } from "../src/session-view.js";

test("native resume commands preserve provider, cwd, and session identity", () => {
  assert.equal(
    nativeResumeCommand({ provider: "codex", cwd: "/tmp/project one", threadId: "thread-1" }),
    "cd '/tmp/project one' && codex resume 'thread-1'",
  );
  assert.equal(
    nativeResumeCommand({ provider: "claude-code", cwd: "/tmp/project", sessionId: "session-1" }),
    "cd '/tmp/project' && claude --resume 'session-1'",
  );
  assert.equal(shellQuote("it's safe"), "'it'\"'\"'s safe'");
});

test("session list masks native references", () => {
  const text = formatSessionList([{
    provider: "claude-code",
    cwd: "/tmp/project",
    accessMode: "read-only",
    sessionId: "session-secret-1234",
    updatedAt: "2026-07-17T10:00:00Z",
  }]);
  assert.match(text, /Claude Code/);
  assert.match(text, /sess…1234/);
  assert.doesNotMatch(text, /session-secret-1234/);
});
