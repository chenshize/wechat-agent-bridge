import assert from "node:assert/strict";
import test from "node:test";

import { PeerTaskQueue } from "../src/inbound-queue.js";

test("coalesces messages received during debounce", async () => {
  const batches = [];
  const queue = new PeerTaskQueue({
    debounceMs: 5,
    handler: async (_peerId, items) => batches.push(items),
  });
  queue.enqueue("alice", "one");
  queue.enqueue("alice", "two");
  await queue.waitForIdle("alice");
  assert.deepEqual(batches, [["one", "two"]]);
});

test("retains messages received while a task is active", async () => {
  const batches = [];
  let release;
  const firstRun = new Promise((resolve) => { release = resolve; });
  const queue = new PeerTaskQueue({
    debounceMs: 0,
    handler: async (_peerId, items) => {
      batches.push(items);
      if (batches.length === 1) await firstRun;
    },
  });
  queue.enqueue("alice", "one", { immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.enqueue("alice", "two", { immediate: true });
  queue.enqueue("alice", "three", { immediate: true });
  assert.deepEqual(queue.status("alice"), { active: true, pending: 2, debouncing: false });
  release();
  await queue.waitForIdle("alice");
  assert.deepEqual(batches, [["one"], ["two", "three"]]);
});

test("enforces a bounded pending queue", () => {
  const queue = new PeerTaskQueue({ debounceMs: 60_000, maxPendingPerPeer: 1, handler: async () => {} });
  assert.equal(queue.enqueue("alice", "one").accepted, true);
  assert.equal(queue.enqueue("alice", "two").accepted, false);
  queue.clear("alice");
});

test("close cancels debounced work and rejects later input", async () => {
  let runs = 0;
  const queue = new PeerTaskQueue({ debounceMs: 10, handler: async () => { runs += 1; } });
  queue.enqueue("alice", "one");
  assert.equal(queue.close(), 1);
  assert.equal(queue.enqueue("alice", "two").accepted, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runs, 0);
});

test("different frozen runtime snapshots are drained as separate batches", async () => {
  const batches = [];
  const queue = new PeerTaskQueue({
    debounceMs: 0,
    batchKey: (item) => item.snapshot,
    handler: async (_peerId, items) => batches.push(items.map((item) => item.value)),
  });
  queue.enqueue("alice", { value: "old-a", snapshot: "old" });
  queue.enqueue("alice", { value: "old-b", snapshot: "old" });
  queue.enqueue("alice", { value: "new", snapshot: "new" });
  await queue.waitForIdle("alice");
  assert.deepEqual(batches, [["old-a", "old-b"], ["new"]]);
});

test("close waits for an active handler to finish", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new PeerTaskQueue({ debounceMs: 0, handler: async () => gate });
  queue.enqueue("alice", "one", { immediate: true });
  while (!queue.status("alice").active) await new Promise((resolve) => setTimeout(resolve, 1));
  queue.close();
  let drained = false;
  const wait = queue.waitForAllIdle().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await wait;
  assert.equal(drained, true);
});

test("account-wide concurrency is bounded and waiting peers are fair", async () => {
  let releaseAlice;
  const aliceGate = new Promise((resolve) => { releaseAlice = resolve; });
  const started = [];
  const queue = new PeerTaskQueue({
    debounceMs: 0,
    maxConcurrent: 1,
    handler: async (peerId) => {
      started.push(peerId);
      if (peerId === "alice") await aliceGate;
    },
  });
  queue.enqueue("alice", "one", { immediate: true });
  queue.enqueue("bob", "two", { immediate: true });
  while (!queue.status("alice").active) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ["alice"]);
  releaseAlice();
  await Promise.all([queue.waitForIdle("alice"), queue.waitForIdle("bob")]);
  assert.deepEqual(started, ["alice", "bob"]);
});
