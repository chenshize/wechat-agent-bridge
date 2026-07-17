import assert from "node:assert/strict";
import test from "node:test";

import {
  completionReceipt,
  formatInteractionNotification,
  normalizeNotificationMode,
  progressHeartbeatMs,
  shouldRelayToolProgress,
} from "../src/notifications.js";

test("notification modes have conservative deterministic behavior", () => {
  assert.equal(normalizeNotificationMode("VERBOSE"), "verbose");
  assert.equal(normalizeNotificationMode("unknown"), "normal");
  assert.equal(shouldRelayToolProgress("quiet"), false);
  assert.equal(shouldRelayToolProgress("normal"), true);
  assert.equal(progressHeartbeatMs("quiet"), 0);
  assert.equal(progressHeartbeatMs("normal"), 180_000);
  assert.equal(progressHeartbeatMs("verbose"), 45_000);
});

test("native interaction notifications and completion receipts stay concise", () => {
  const question = formatInteractionNotification({ type: "question", question: "Which database?" }, "Codex");
  assert.match(question, /Codex 请求输入/);
  assert.match(question, /Which database/);
  const approval = formatInteractionNotification({ type: "approval_request", message: "Proceed with the plan" }, "Claude Code");
  assert.match(approval, /不会替 Agent 决定权限/);

  const receipt = completionReceipt({
    taskId: "a1b2c3d4",
    provider: "Codex",
    durationMs: 65_000,
    usage: { input_tokens: 10, output_tokens: 20 },
    artifactCount: 2,
  });
  assert.match(receipt, /任务 a1b2c3d4/);
  assert.match(receipt, /1 分 5 秒/);
  assert.match(receipt, /输入 10 \/ 输出 20 tokens/);
  assert.match(receipt, /产物 2 个/);
});
