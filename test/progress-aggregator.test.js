import assert from "node:assert/strict";
import test from "node:test";

import { ProgressAggregator } from "../src/progress-aggregator.js";

test("large tool volumes stay bounded while every operation is counted", () => {
  const aggregator = new ProgressAggregator({ maxTrackedSamples: 20 });
  for (let index = 0; index < 500; index += 1) {
    aggregator.record({ type: "tool_use", id: `read-${index}`, name: "Read", input: { file_path: `src/${index}.js` } });
  }
  for (let index = 0; index < 120; index += 1) {
    aggregator.record({ type: "tool_use", id: `cmd-${index}`, name: "Bash", input: { command: `npm test package-${index}` } });
  }
  const summary = aggregator.takeSummary("normal", { maxExamples: 3 });
  assert.match(summary, /命令 120/);
  assert.match(summary, /读取 500/);
  assert.match(summary, /npm test.*×120/);
  assert.match(summary, /另有 500 项已折叠/);
  assert.equal(aggregator.hasPending(), false);
  assert(aggregator.started.size <= 200);
});

test("unknown tools have a safe fallback and only the first key operation is immediate", () => {
  const aggregator = new ProgressAggregator();
  const first = aggregator.record({ type: "tool_use", id: "one", name: "CompanyDeploy", input: { description: "staging" } });
  const second = aggregator.record({ type: "tool_use", id: "two", name: "CompanyDeploy", input: { description: "production" } });
  assert.equal(first.significant, true);
  assert.equal(second.significant, true);
  assert.match(aggregator.takeSummary("normal"), /其他 2/);
});

test("routine shell inspection is counted without becoming the first key operation", () => {
  const aggregator = new ProgressAggregator();
  const pwd = aggregator.record({ type: "tool_use", id: "pwd", name: "command_execution", input: "pwd" });
  const diff = aggregator.record({ type: "tool_use", id: "diff", name: "Bash", input: { command: "git diff --stat" } });
  const testRun = aggregator.record({ type: "tool_use", id: "test", name: "Bash", input: { command: "npm test" } });
  assert.equal(pwd.significant, false);
  assert.equal(diff.significant, false);
  assert.equal(testRun.significant, true);
});

test("failed tool results are immediate, correlated, and deduplicated", () => {
  const aggregator = new ProgressAggregator();
  aggregator.record({ type: "tool_use", id: "test-1", name: "command_execution", input: "npm test" });
  const failed = aggregator.record({
    type: "tool_result",
    id: "test-1",
    name: "command_execution",
    status: "failed",
    raw: { item: { exit_code: 1 } },
  });
  assert.equal(failed.failure, true);
  assert.match(failed.immediate, /npm test/);
  assert.match(failed.immediate, /退出码：1/);

  aggregator.record({ type: "tool_use", id: "test-2", name: "command_execution", input: "npm test --again" });
  const duplicate = aggregator.record({ type: "tool_result", id: "test-2", status: "failed" });
  assert.equal(duplicate.duplicateFailure, true);
});

test("discarding a quiet window prevents delayed replay", () => {
  const aggregator = new ProgressAggregator();
  aggregator.record({ type: "tool_use", name: "Read", input: { file_path: "secret.txt" } });
  aggregator.discardPending();
  assert.equal(aggregator.hasPending(), false);
  assert.equal(aggregator.takeSummary("verbose"), "");
});
