import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InboxStore } from "../src/inbox-store.js";

test("durable inbox preserves unfinished work and prunes completed records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let now = 100_000;
  const store = new InboxStore("account", { now: () => now, doneTtlMs: 60_000 });
  assert.equal(store.receive("m1", { from_user_id: "a", item_list: [] }).duplicate, false);
  assert.equal(store.receive("m1", { from_user_id: "a", item_list: [] }).duplicate, true);
  store.mark("m1", "queued");
  store.mark("m1", "running");
  assert.equal(store.get("m1").attempts, 1);
  assert.deepEqual(store.pending(), []);

  const restored = new InboxStore("account", { now: () => now, doneTtlMs: 60_000 });
  assert.equal(restored.interruptRunning("test restart"), 1);
  assert.equal(restored.recoverable("a")[0].status, "interrupted");
  restored.mark("m1", "done");
  now += 61_000;
  restored.receive("m2", { from_user_id: "a", item_list: [] });
  assert.equal(restored.get("m1"), null);
  assert.equal(restored.pending()[0].id, "m2");
});

test("queued tasks retain their frozen runtime snapshot across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-task-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new InboxStore("account");
  store.receive("m1", { from_user_id: "a", item_list: [] });
  store.queue("m1", {
    text: "hello",
    runtimeSnapshot: { provider: "codex", accessMode: "read-only", key: "frozen" },
  });
  const restored = new InboxStore("account");
  assert.equal(restored.pending()[0].task.runtimeSnapshot.accessMode, "read-only");
});

test("a corrupt inbox is quarantined and never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-corrupt-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new InboxStore("account");
  store.receive("m1", { from_user_id: "a", item_list: [] });
  const inboxDir = path.join(dir, "inbox");
  const fileName = fs.readdirSync(inboxDir).find((name) => name.endsWith(".json"));
  const filePath = path.join(inboxDir, fileName);
  fs.writeFileSync(filePath, "{truncated", { mode: 0o600 });
  assert.throws(() => store.receive("m2", { from_user_id: "a", item_list: [] }), { code: "INBOX_CORRUPT" });
  assert.equal(fs.readFileSync(filePath, "utf8"), "{truncated");
  assert.ok(fs.readdirSync(inboxDir).some((name) => name.includes(".corrupt-")));
});

test("queued cancellation is atomic and terminal across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-cancel-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new InboxStore("account");
  store.receive("m1", { from_user_id: "a", item_list: [] });
  store.queue("m1", { text: "dangerous task", attachments: [] });
  assert.equal(store.cancelMany(["m1"]), 1);
  const restored = new InboxStore("account");
  assert.equal(restored.get("m1").status, "cancelled");
  assert.deepEqual(restored.pending(), []);
  assert.deepEqual(restored.recoverable("a"), []);
});

test("batch status updates validate every id before writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-batch-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new InboxStore("account");
  store.receive("m1", { from_user_id: "a", item_list: [] });
  assert.throws(() => store.markMany(["m1", "missing"], "done"), { code: "INBOX_RECORD_MISSING" });
  assert.equal(new InboxStore("account").get("m1").status, "received");
});

test("completed agent replies survive restart without retaining executable work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbox-completion-test-"));
  const old = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = dir;
  test.after(() => {
    if (old === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new InboxStore("account");
  for (const id of ["m1", "m2"]) {
    store.receive(id, { from_user_id: "a", item_list: [] });
    store.queue(id, { text: id, runtimeSnapshot: { key: "frozen" } });
  }
  store.markMany(["m1", "m2"], "running");
  store.saveCompletion(["m1", "m2"], { id: "result-1", chunks: ["one", "two"] });
  const restored = new InboxStore("account");
  assert.equal(restored.get("m1").status, "completed");
  assert.equal(restored.get("m1").task, undefined);
  assert.equal(restored.get("m2").status, "done");
  assert.deepEqual(restored.pending().map((record) => record.id), ["m1"]);
  restored.advanceCompletion("m1", 1);
  assert.equal(new InboxStore("account").get("m1").completion.nextChunkIndex, 1);
});
