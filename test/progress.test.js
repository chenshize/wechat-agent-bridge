import assert from "node:assert/strict";
import test from "node:test";

import { formatToolProgress, redactCommand } from "../src/progress.js";

test("Codex command progress includes the actual command", () => {
  assert.equal(
    formatToolProgress({ name: "command_execution", input: "npm test -- --runInBand" }),
    "💻 正在执行命令：\nnpm test -- --runInBand\n请稍等…",
  );
});

test("Claude Bash progress reads command from structured input", () => {
  assert.match(
    formatToolProgress({ name: "Bash", input: { command: "git status --short", description: "Inspect changes" } }),
    /git status --short/,
  );
});

test("command progress redacts common credentials before delivery", () => {
  const redacted = redactCommand(
    "API_TOKEN=abc123 curl --password hunter2 -H 'Authorization: Bearer topsecret' https://user:pass@example.com",
  );
  assert.doesNotMatch(redacted, /abc123|hunter2|topsecret|:pass@/);
  assert.match(redacted, /API_TOKEN=<redacted>/);
  assert.match(redacted, /--password <redacted>/);
  assert.match(redacted, /Authorization: Bearer <redacted>/);
  assert.match(redacted, /user:<redacted>@example\.com/);
});

test("non-command tools show a concise target and long commands are bounded", () => {
  assert.match(
    formatToolProgress({ name: "Read", input: { file_path: "src/bridge.js" } }),
    /目标：src\/bridge\.js/,
  );
  const message = formatToolProgress({ name: "Bash", input: { command: `echo ${"x".repeat(1000)}` } });
  assert(message.length < 350);
  assert.match(message, /…/);
  const web = formatToolProgress({ name: "WebFetch", input: { url: "https://user:password@example.com/private" } });
  assert.doesNotMatch(web, /:password@/);
  assert.match(web, /user:<redacted>@example\.com/);
});
