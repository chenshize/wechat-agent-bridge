import assert from "node:assert/strict";
import test from "node:test";

import {
  findTaskByPublicId,
  formatTaskDetail,
  formatTaskList,
  taskPublicId,
} from "../src/task-view.js";

const record = {
  id: "wechat-message-123",
  kind: "work",
  status: "interrupted",
  receivedAt: Date.parse("2026-07-17T08:00:00Z"),
  updatedAt: Date.parse("2026-07-17T08:01:00Z"),
  lastError: "bridge stopped",
  runtimeSnapshot: {
    provider: "codex",
    cwd: "/projects/weclaudex",
    accessMode: "workspace",
    model: "gpt-test",
    effort: "high",
  },
};

test("task ids are stable, opaque, and usable for lookup", () => {
  const id = taskPublicId(record);
  assert.match(id, /^[a-f0-9]{8}$/);
  assert.equal(findTaskByPublicId([record], id.slice(0, 6)), record);
  assert.equal(findTaskByPublicId([record], "missing"), null);
});

test("task list and detail expose persisted execution state", () => {
  assert.match(formatTaskList([record]), new RegExp(taskPublicId(record)));
  assert.match(formatTaskList([record]), /Codex/);
  const detail = formatTaskDetail(record);
  assert.match(detail, /已中断/);
  assert.match(detail, /gpt-test/);
  assert.match(detail, /\/retry/);
});
