import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageOutboundArtifact } from "../src/outbound-spool.js";

import {
  JsonPendingStore,
  SendScheduler,
  StaleContextError,
  classifySendOutcome,
  retryDelayMs,
} from "../src/send-scheduler.js";

test("send outcome classification distinguishes rate limits and stale contexts", () => {
  assert.equal(classifySendOutcome({ ret: 0 }).kind, "success");
  assert.equal(classifySendOutcome({ ret: -2, errmsg: "too frequent" }).kind, "rate-limit");
  assert.equal(classifySendOutcome({ ret: -2, errmsg: "unknown error" }).kind, "stale-context");
  assert.equal(classifySendOutcome({ ret: -14 }).kind, "stale-context");
  assert.equal(classifySendOutcome({ ret: 12, errmsg: "bad" }).kind, "fatal");
  assert.equal(retryDelayMs(0), 3_000);
  assert.equal(retryDelayMs(8), 15_000);
});

test("scheduler serializes each user and enforces per-user spacing", async () => {
  let now = 10_000;
  const sentAt = [];
  const scheduler = new SendScheduler({
    transport: { sendText: async () => sentAt.push(now) },
    minIntervalMs: 2_500,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await Promise.all([
    scheduler.sendText({ to: "user-a", text: "one", contextToken: "ctx" }),
    scheduler.sendText({ to: "user-a", text: "two", contextToken: "ctx" }),
  ]);
  assert.deepEqual(sentAt, [10_000, 12_500]);
  assert.equal(scheduler.pendingCount, 0);
  await scheduler.close();
});

test("scheduler retries ret=-2 a bounded number of times", async () => {
  let calls = 0;
  let now = 100_000;
  const clientIds = [];
  const scheduler = new SendScheduler({
    transport: {
      sendText: async ({ clientId }) => {
        calls += 1;
        clientIds.push(clientId);
        if (calls < 3) throw { ret: -2, errmsg: "too frequent" };
        return { ret: 0 };
      },
    },
    minIntervalMs: 0,
    maxRetries: 2,
    circuitThreshold: 99,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await scheduler.sendText({ to: "user-a", text: "hello", contextToken: "ctx" });
  assert.equal(calls, 3);
  assert.equal(new Set(clientIds).size, 1);
  assert.match(clientIds[0], /^wechat-agent-text-/);
  assert.equal(scheduler.pendingCount, 0);
  await scheduler.close();
});

test("scheduler drops a permanently invalid operation instead of poisoning the outbox", async () => {
  const scheduler = new SendScheduler({
    transport: { sendText: async () => { throw { ret: 400, errmsg: "invalid payload" }; } },
    minIntervalMs: 0,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "bad" }));
  assert.equal(scheduler.pendingCount, 0);
  await scheduler.close();
});

test("ephemeral progress is never persisted and is dropped after a send failure", async () => {
  const snapshots = [];
  const scheduler = new SendScheduler({
    pendingStore: { load: async () => [], save: async (records) => snapshots.push(records) },
    transport: { sendText: async () => { throw { ret: -2, errmsg: "unknown error" }; } },
    minIntervalMs: 0,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "progress", durable: false }));
  assert.equal(scheduler.pendingCount, 0);
  assert.ok(snapshots.every((records) => records.length === 0));
  await scheduler.close();
});

test("stale context remains pending and flush uses a fresh context token", async () => {
  const contexts = [];
  const runIds = [];
  const scheduler = new SendScheduler({
    transport: {
      sendText: async (payload) => {
        contexts.push(payload.contextToken);
        runIds.push(payload.runId);
        if (payload.contextToken === "old") throw { ret: -2, errmsg: "unknown error" };
        return { ret: 0 };
      },
    },
    minIntervalMs: 0,
  });
  await assert.rejects(
    scheduler.sendText({ to: "user-a", text: "hello", contextToken: "old", runId: "run-old" }),
    StaleContextError,
  );
  assert.equal(scheduler.pendingCount, 1);
  const result = await scheduler.flush({ userId: "user-a", contextToken: "fresh", runId: "run-fresh" });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0, pending: 0 });
  assert.deepEqual(contexts, ["old", "fresh"]);
  assert.deepEqual(runIds, ["run-old", "run-fresh"]);
  await scheduler.close();
});

test("JsonPendingStore persists records atomically with private permissions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pending-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "pending.json");
  const store = new JsonPendingStore(filePath);
  await store.save([{
    id: "id-1",
    userId: "user-a",
    kind: "text",
    contextToken: "ctx",
    payload: { text: "hello" },
    status: "queued",
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  }]);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await store.load())[0].payload.text, "hello");
  assert.deepEqual((await fs.readdir(dir)).sort(), ["pending.json"]);
});

test("JsonPendingStore quarantines invalid schemas without overwriting them", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pending-corrupt-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "pending.json");
  const original = '{"version":1,"pending":{"unexpected":true}}\n';
  await fs.writeFile(filePath, original, { mode: 0o600 });
  const store = new JsonPendingStore(filePath);
  await assert.rejects(store.load(), { code: "OUTBOX_CORRUPT" });
  assert.equal(await fs.readFile(filePath, "utf8"), original);
  assert.ok((await fs.readdir(dir)).some((name) => name.startsWith("pending.json.corrupt-")));
});

test("scheduler startup fails closed on a corrupt outbox", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-scheduler-corrupt-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "pending.json");
  const original = '{"version":1,"pending":[{"id":"important"}]}\n';
  await fs.writeFile(filePath, original, { mode: 0o600 });
  const scheduler = new SendScheduler({
    pendingStore: new JsonPendingStore(filePath),
    transport: { sendText: async () => ({ ret: 0 }) },
  });
  await assert.rejects(scheduler.ready, { code: "OUTBOX_CORRUPT" });
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("critical reply reservations remain available when the regular outbox is full", async () => {
  const scheduler = new SendScheduler({
    transport: { sendText: async () => { throw { ret: -2, errmsg: "unknown error" }; } },
    minIntervalMs: 0,
    maxPending: 1,
    criticalReserve: 1,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "regular", contextToken: "old" }));
  await assert.rejects(
    scheduler.sendText({ to: "user-a", text: "overflow", contextToken: "old" }),
    { code: "WECHAT_SEND_QUEUE_FULL" },
  );
  const reservation = await scheduler.reserveCritical(1);
  await assert.rejects(scheduler.sendText({
    to: "user-a",
    text: "completed result",
    contextToken: "old",
    critical: true,
    reservationId: reservation.id,
    clientId: "stable-result-0",
  }));
  assert.equal(scheduler.regularPendingCount, 1);
  assert.equal(scheduler.criticalPendingCount, 1);
  reservation.release();
  await scheduler.clear();
  await scheduler.close();
});

test("a record persisted as sending is retried after process restoration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pending-restore-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonPendingStore(path.join(dir, "pending.json"));
  await store.save([{
    id: "crashed-send",
    userId: "user-a",
    kind: "text",
    contextToken: "old",
    payload: { to: "user-a", text: "recover me", contextToken: "old" },
    status: "sending",
    attempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }]);
  const delivered = [];
  const scheduler = new SendScheduler({
    pendingStore: store,
    transport: { sendText: async ({ text }) => delivered.push(text) },
    minIntervalMs: 0,
  });
  const result = await scheduler.flush({ userId: "user-a", contextToken: "fresh" });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0, pending: 0 });
  assert.deepEqual(delivered, ["recover me"]);
  await scheduler.close();
});

test("flush does not duplicate a record already waiting in a user lane", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const messages = [];
  const scheduler = new SendScheduler({
    transport: {
      sendText: async ({ text }) => {
        messages.push(text);
        if (text === "one") await gate;
      },
    },
    minIntervalMs: 0,
  });
  const one = scheduler.sendText({ to: "user-a", text: "one" });
  const two = scheduler.sendText({ to: "user-a", text: "two" });
  await new Promise((resolve) => setImmediate(resolve));
  const flush = scheduler.flush({ userId: "user-a" });
  releaseFirst();
  await Promise.all([one, two, flush]);
  assert.deepEqual(messages, ["one", "two"]);
  await scheduler.close();
});

test("flush recovers an in-memory sending record after its persist failed", async () => {
  let saveCalls = 0;
  let transportCalls = 0;
  const scheduler = new SendScheduler({
    pendingStore: {
      load: async () => [],
      save: async () => {
        saveCalls += 1;
        if (saveCalls === 3) throw new Error("disk hiccup");
      },
    },
    transport: { sendText: async () => { transportCalls += 1; } },
    minIntervalMs: 0,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "recover" }), /disk hiccup/);
  const result = await scheduler.flush({ userId: "user-a" });
  assert.equal(result.sent, 1);
  assert.equal(transportCalls, 1);
  await scheduler.close();
});

test("fresh context can explicitly clear a stale run id", async () => {
  const delivered = [];
  const scheduler = new SendScheduler({
    transport: {
      sendText: async (payload) => {
        delivered.push([payload.contextToken, payload.runId]);
        if (payload.contextToken === "old") throw { ret: -2, errmsg: "unknown error" };
      },
    },
    minIntervalMs: 0,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "hello", contextToken: "old", runId: "old-run" }));
  await scheduler.flush({ userId: "user-a", contextToken: "fresh", runId: "" });
  assert.deepEqual(delivered, [["old", "old-run"], ["fresh", ""]]);
  await scheduler.close();
});

test("long-lived scheduler prunes expired deferred sends", async () => {
  let now = 0;
  const scheduler = new SendScheduler({
    transport: { sendText: async () => { throw { ret: -2, errmsg: "unknown error" }; } },
    minIntervalMs: 0,
    pendingTtlMs: 60_000,
    now: () => now,
  });
  await assert.rejects(scheduler.sendText({ to: "user-a", text: "old", contextToken: "stale" }));
  assert.equal(scheduler.pendingCount, 1);
  now = 60_001;
  await scheduler.flush({ userId: "user-a" });
  assert.equal(scheduler.pendingCount, 0);
  await scheduler.close();
});

test("outbound snapshots survive deferral and are removed after clear", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-scheduler-spool-test-"));
  const workspace = path.join(dir, "workspace");
  const oldState = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = path.join(dir, "state");
  await fs.mkdir(workspace);
  t.after(async () => {
    if (oldState === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = oldState;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(workspace, "result.txt");
  await fs.writeFile(source, "frozen");
  const snapshot = await stageOutboundArtifact({ path: source, kind: "file" }, { workspace });
  const scheduler = new SendScheduler({
    transport: { sendFile: async () => { throw { ret: -2, errmsg: "unknown error" }; } },
    minIntervalMs: 0,
  });
  await assert.rejects(scheduler.sendFile({ to: "user-a", filePath: snapshot.path, contextToken: "stale" }));
  assert.equal(await fs.readFile(snapshot.path, "utf8"), "frozen");
  await scheduler.clear({ userId: "user-a" });
  await scheduler.close();
  await assert.rejects(fs.stat(snapshot.path), { code: "ENOENT" });
});
