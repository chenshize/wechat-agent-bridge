import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAccessMode, parseBridgeCommand, splitCommandArguments } from "../src/command-parser.js";

test("parses commands and aliases without treating normal slash text as a command", () => {
  assert.deepEqual(parseBridgeCommand(" /models gpt-5 "), { name: "model", argument: "gpt-5", raw: "/models gpt-5" });
  assert.deepEqual(parseBridgeCommand("/claude"), { name: "claude-code", argument: "", raw: "/claude" });
  assert.deepEqual(parseBridgeCommand("/jobs"), { name: "tasks", argument: "", raw: "/jobs" });
  assert.deepEqual(parseBridgeCommand("/task abc123"), { name: "task", argument: "abc123", raw: "/task abc123" });
  assert.equal(parseBridgeCommand("/unknown value"), null);
  assert.equal(parseBridgeCommand("hello"), null);
});

test("splits quoted workspace arguments", () => {
  assert.deepEqual(splitCommandArguments("save demo '/tmp/My Project'"), ["save", "demo", "/tmp/My Project"]);
  assert.throws(() => splitCommandArguments("'unterminated"), /引号/);
});

test("normalizes access aliases", () => {
  assert.equal(normalizeAccessMode("readonly"), "read-only");
  assert.equal(normalizeAccessMode("工作区"), "workspace");
  assert.equal(normalizeAccessMode("FULL"), "full");
  assert.equal(normalizeAccessMode("invalid"), "");
});
