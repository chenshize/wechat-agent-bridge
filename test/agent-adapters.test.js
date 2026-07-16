import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeAccessMode, splitCommandArgs, startJsonLineAgent } from "../src/agent-runtime.js";
import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  parseCodexJsonLine,
} from "../src/codex.js";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  normalizeClaudeEvent,
  parseClaudeJsonLine,
} from "../src/claude-code.js";

test("Codex new-session argv applies model, effort, cwd and full access", () => {
  const args = buildCodexArgs({
    outputFile: "/tmp/final.txt",
    cwd: "/tmp/project",
    model: "gpt-test",
    effort: "high",
    accessMode: "full",
  });

  assert.deepEqual(args, [
    "exec",
    "--model",
    "gpt-test",
    "-c",
    'model_reasoning_effort="high"',
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    "/tmp/project",
    "--json",
    "--output-last-message",
    "/tmp/final.txt",
    "-",
  ]);
});

test("Codex read-only approval flag precedes exec and resume flags follow resume", () => {
  const args = buildCodexArgs({
    outputFile: "/tmp/final.txt",
    cwd: "/tmp/project",
    threadId: "thread-123",
    model: "gpt-test",
    effort: "medium",
    accessMode: "read-only",
    imagePaths: ["/tmp/screenshot.png"],
  });

  assert.deepEqual(args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
  assert.ok(args.indexOf("--sandbox") > args.indexOf("exec"));
  assert.ok(args.indexOf("-C") < args.indexOf("resume"));
  assert.ok(args.indexOf("--json") > args.indexOf("resume"));
  assert.deepEqual(args.slice(-4), ["--image", "/tmp/screenshot.png", "thread-123", "-"]);
});

test("Codex workspace access is non-interactive and sandboxed", () => {
  const args = buildCodexArgs({
    cwd: "/tmp/project",
    model: "gpt-test",
    effort: "low",
    accessMode: "workspace",
  });
  assert.deepEqual(args.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), [
    "--sandbox",
    "workspace-write",
  ]);
});

test("Codex parser discovers a thread and normalizes text, tools and usage", () => {
  const started = parseCodexJsonLine('{"type":"thread.started","thread_id":"abc"}');
  assert.equal(started.sessionRef, "abc");
  assert.equal(started.events[0].type, "system");

  const text = normalizeCodexEvent({
    type: "item.completed",
    item: { id: "m1", type: "agent_message", text: "完成" },
  });
  assert.equal(text.finalText, "完成");
  assert.deepEqual(text.events.map((event) => event.type), ["text"]);

  const toolStart = normalizeCodexEvent({
    type: "item.started",
    item: { id: "t1", type: "command_execution", command: "npm test" },
  });
  assert.equal(toolStart.events[0].type, "tool_use");
  assert.equal(toolStart.events[0].input, "npm test");

  const toolDone = normalizeCodexEvent({
    type: "item.completed",
    item: { id: "t1", type: "command_execution", aggregated_output: "ok", exit_code: 0 },
  });
  assert.equal(toolDone.events[0].type, "tool_result");
  assert.equal(toolDone.events[0].status, "completed");

  const usage = normalizeCodexEvent({ type: "turn.completed", usage: { input_tokens: 10 } });
  assert.equal(usage.events[0].type, "usage");
  assert.equal(usage.usage.input_tokens, 10);
});

test("a resumed Codex prompt does not replay bridge history", () => {
  const prompt = buildCodexPrompt({
    text: "继续",
    history: [{ role: "assistant", content: "不应出现" }],
    resumed: true,
  });
  assert.equal(prompt, "继续");
});

test("Codex prompt exposes non-image attachment paths without duplicating native images", () => {
  const prompt = buildCodexPrompt({
    text: "summarize",
    resumed: true,
    attachments: [
      { path: "/safe/cache/report.pdf", kind: "file", mime: "application/pdf" },
      { path: "/safe/cache/photo.png", kind: "image", mime: "image/png" },
    ],
  });
  assert.match(prompt, /report\.pdf/);
  assert.doesNotMatch(prompt, /photo\.png/);
});

test("Claude argv resumes the requested session with independent access mapping", () => {
  const args = buildClaudeArgs({
    sessionId: "session-123",
    model: "sonnet",
    effort: "xhigh",
    accessMode: "workspace",
  });
  assert.deepEqual(args, [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "sonnet",
    "--effort",
    "xhigh",
    "--resume",
    "session-123",
  ]);
  assert.ok(buildClaudeArgs({ model: "haiku", effort: "low", accessMode: "full" })
    .includes("--dangerously-skip-permissions"));
  assert.deepEqual(
    buildClaudeArgs({ model: "haiku", effort: "low", accessMode: "read-only" }).slice(4, 6),
    ["--permission-mode", "plan"],
  );
});

test("Claude parser discovers session, normalizes content and retains result", () => {
  const init = parseClaudeJsonLine(
    '{"type":"system","subtype":"init","session_id":"session-abc","model":"sonnet"}',
  );
  assert.equal(init.sessionRef, "session-abc");
  assert.equal(init.events[0].type, "system");

  const assistant = normalizeClaudeEvent({
    type: "assistant",
    session_id: "session-abc",
    message: {
      content: [
        { type: "thinking", thinking: "分析" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.js" } },
        { type: "text", text: "处理中" },
      ],
      usage: { input_tokens: 12 },
    },
  });
  assert.deepEqual(assistant.events.map((event) => event.type), ["thinking", "tool_use", "text", "usage"]);
  assert.equal(assistant.finalText, "处理中");

  const result = normalizeClaudeEvent({
    type: "result",
    subtype: "success",
    session_id: "session-abc",
    result: "最终回复",
    usage: { output_tokens: 9 },
  });
  assert.equal(result.finalText, "最终回复");
  assert.equal(result.usage.output_tokens, 9);
});

test("Claude resumed prompt contains only current input and safe attachment paths", () => {
  const prompt = buildClaudePrompt({
    text: "看看图片",
    history: [{ role: "assistant", content: "不应出现" }],
    resumed: true,
    attachments: ["/tmp/image.png"],
  });
  assert.match(prompt, /^看看图片/);
  assert.match(prompt, /\/tmp\/image\.png/);
  assert.doesNotMatch(prompt, /不应出现/);
});

test("shared argument and access helpers are deterministic", () => {
  assert.deepEqual(splitCommandArgs('--model "some model" --flag'), ["--model", "some model", "--flag"]);
  assert.equal(normalizeAccessMode("workspace-write"), "workspace");
  assert.throws(() => normalizeAccessMode("unknown"), /unsupported access mode/);
});

test("shared runtime keeps the legacy reply promise and exposes structured completion", async () => {
  const events = [];
  const output = [];
  const script = [
    'console.log(JSON.stringify({kind:"init",session:"session-1"}));',
    'console.log(JSON.stringify({kind:"reply",text:"hello"}));',
  ].join("");
  const task = startJsonLineAgent({
    provider: "test-agent",
    bin: process.execPath,
    args: ["-e", script],
    prompt: "ignored",
    onEvent: (event) => events.push(event),
    onOutput: (event) => output.push(event),
    parseLine(line) {
      const raw = JSON.parse(line);
      if (raw.kind === "init") {
        return {
          sessionRef: raw.session,
          events: [{ type: "system", name: "session_started", sessionRef: raw.session }],
        };
      }
      return { finalText: raw.text, events: [{ type: "text", text: raw.text }] };
    },
    timeoutMs: 2000,
  });

  const [legacyReply, result] = await Promise.all([task.promise, task.resultPromise]);
  assert.equal(legacyReply, "hello");
  assert.deepEqual(result, {
    provider: "test-agent",
    reply: "hello",
    sessionRef: "session-1",
    usage: null,
  });
  assert.equal(task.sessionRef, "session-1");
  assert.deepEqual(events.map((event) => event.type), ["system", "text", "done"]);
  assert.ok(output.some((event) => event.stream === "stdout"));
});

test("shared runtime rejects a fatal agent event even when the process exits zero", async () => {
  const task = startJsonLineAgent({
    provider: "test-agent",
    bin: process.execPath,
    args: ["-e", 'console.log(JSON.stringify({kind:"fatal"}))'],
    parseLine(line) {
      JSON.parse(line);
      return { events: [{ type: "error", fatal: true, code: "UPSTREAM_FAILED", message: "upstream failed" }] };
    },
    timeoutMs: 2000,
  });
  await assert.rejects(task.resultPromise, { code: "UPSTREAM_FAILED", message: "upstream failed" });
});

test("shared runtime never forwards raw JSONL when no final response exists", async () => {
  const task = startJsonLineAgent({
    provider: "test-agent",
    bin: process.execPath,
    args: ["-e", 'console.log(JSON.stringify({kind:"tool",secret:"local-path"}))'],
    parseLine(line) {
      JSON.parse(line);
      return { events: [{ type: "tool_result", output: "diagnostic" }] };
    },
    timeoutMs: 2000,
  });
  await assert.rejects(task.resultPromise, { code: "AGENT_EMPTY_RESPONSE" });
});

test("shared runtime discards an oversized event and continues at the next line", async () => {
  const script = [
    'console.log(JSON.stringify({kind:"oversized",data:"x".repeat(256)}));',
    'console.log(JSON.stringify({kind:"reply",text:"safe-final"}));',
  ].join("");
  const task = startJsonLineAgent({
    provider: "test-agent",
    bin: process.execPath,
    args: ["-e", script],
    maxLineChars: 80,
    parseLine(line) {
      const raw = JSON.parse(line);
      return raw.kind === "reply" ? { finalText: raw.text, events: [{ type: "text", text: raw.text }] } : null;
    },
    timeoutMs: 2000,
  });
  assert.equal((await task.resultPromise).reply, "safe-final");
});

test("cancelling an agent terminates its whole POSIX process group", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are not available");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-agent-tree-test-"));
  const marker = path.join(directory, "grandchild-survived");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const grandchild = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "unsafe"), 350);`,
    'setInterval(() => {}, 1000);',
  ].join("");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
    'console.log(JSON.stringify({ kind: "ready" }));',
    'setInterval(() => {}, 1000);',
  ].join("");
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const task = startJsonLineAgent({
    provider: "tree-test",
    bin: process.execPath,
    args: ["-e", parent],
    killGraceMs: 100,
    timeoutMs: 2000,
    parseLine(line) {
      const raw = JSON.parse(line);
      if (raw.kind === "ready") {
        return { events: [{ type: "system", name: "ready" }] };
      }
      return null;
    },
    onEvent(event) {
      if (event.name === "ready") ready();
    },
  });
  await readyPromise;
  task.cancel();
  await assert.rejects(task.resultPromise, { code: "AGENT_STOPPED" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});
