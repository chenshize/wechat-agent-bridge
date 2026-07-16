import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WechatAgentBridge,
  allowedSender,
  isMeaningfulAgentEvent,
  isMissingSessionError,
  normalizeReplyText,
  splitReplyText,
} from "../src/bridge.js";
import { InboxStore } from "../src/inbox-store.js";
import { stageOutboundArtifact } from "../src/outbound-spool.js";
import { loadSyncBuf } from "../src/state.js";

function isolatedBridge(t, suffix = "bridge") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wechat-${suffix}-`));
  const oldState = process.env.WECHAT_BRIDGE_STATE_DIR;
  const oldDebounce = process.env.WECHAT_BRIDGE_INPUT_DEBOUNCE_MS;
  process.env.WECHAT_BRIDGE_STATE_DIR = directory;
  process.env.WECHAT_BRIDGE_INPUT_DEBOUNCE_MS = "60000";
  t.after(() => {
    if (oldState === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = oldState;
    if (oldDebounce === undefined) delete process.env.WECHAT_BRIDGE_INPUT_DEBOUNCE_MS;
    else process.env.WECHAT_BRIDGE_INPUT_DEBOUNCE_MS = oldDebounce;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const account = { accountId: `account-${suffix}`, token: "test-token", userId: "owner" };
  const bridge = new WechatAgentBridge({ account });
  bridge.sender = {
    flush: async () => ({ attempted: 0 }),
    sendText: async () => ({ ok: true }),
    sendFile: async () => ({ ok: true }),
    sendImage: async () => ({ ok: true }),
    listPending: () => [],
    pendingCount: 0,
    ready: Promise.resolve(),
    close: async () => {},
  };
  return { account, bridge, directory };
}

test("sender authorization defaults to the QR-login user", () => {
  const oldAllow = process.env.WECHAT_BRIDGE_ALLOW_FROM;
  const oldAll = process.env.WECHAT_BRIDGE_ALLOW_ALL;
  delete process.env.WECHAT_BRIDGE_ALLOW_FROM;
  delete process.env.WECHAT_BRIDGE_ALLOW_ALL;
  test.after(() => {
    if (oldAllow === undefined) delete process.env.WECHAT_BRIDGE_ALLOW_FROM;
    else process.env.WECHAT_BRIDGE_ALLOW_FROM = oldAllow;
    if (oldAll === undefined) delete process.env.WECHAT_BRIDGE_ALLOW_ALL;
    else process.env.WECHAT_BRIDGE_ALLOW_ALL = oldAll;
  });
  assert.equal(allowedSender({ userId: "owner" }, "owner"), true);
  assert.equal(allowedSender({ userId: "owner" }, "stranger"), false);
  process.env.WECHAT_BRIDGE_ALLOW_FROM = "friend";
  assert.equal(allowedSender({ userId: "owner" }, "friend"), true);
});

test("reply normalization and chunking preserve all content", () => {
  const source = `**title**\n\n${"a".repeat(25)}\n\n${"b".repeat(25)}`;
  const chunks = splitReplyText(source, 20);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
  assert.equal(chunks.join("").replace(/\n/g, ""), normalizeReplyText(source).replace(/\n/g, ""));
});

test("a full poll batch is durable before stop interrupts dispatch", async (t) => {
  const { account, bridge } = isolatedBridge(t, "cursor");
  const handled = [];
  bridge.handleMessage = async (message) => {
    handled.push(message.message_id);
    bridge.stop();
  };
  const durable = await bridge.processUpdateResponse({
    msgs: [
      { message_id: "one", message_type: 1, from_user_id: "owner", item_list: [] },
      { message_id: "two", message_type: 1, from_user_id: "owner", item_list: [] },
    ],
    get_updates_buf: "next-cursor",
  });
  assert.equal(durable, true);
  assert.deepEqual(handled, ["one"]);
  assert.equal(loadSyncBuf(account.accountId), "next-cursor");
  assert.deepEqual(new InboxStore(account.accountId).pending().map((record) => record.id), ["one", "two"]);
});

test("user stop completes cleared queued inbox tasks so restart cannot revive them", async (t) => {
  const { account, bridge } = isolatedBridge(t, "stop-clear");
  await bridge.handleMessage({
    message_id: "work",
    message_type: 1,
    from_user_id: "owner",
    context_token: "ctx-work",
    item_list: [{ type: 1, text_item: { text: "do work" } }],
  });
  assert.equal(bridge.taskQueue.status("owner").pending, 1);
  await bridge.handleMessage({
    message_id: "stop",
    message_type: 1,
    from_user_id: "owner",
    context_token: "ctx-stop",
    item_list: [{ type: 1, text_item: { text: "/stop" } }],
  });
  assert.equal(bridge.taskQueue.status("owner").pending, 0);
  const restored = new InboxStore(account.accountId);
  assert.equal(restored.get("work").status, "cancelled");
  assert.deepEqual(restored.pending(), []);
  bridge.stop();
});

test("explicit retry uses the current delivery context and preserves frozen runtime", async (t) => {
  const { account, bridge } = isolatedBridge(t, "retry");
  const inbox = new InboxStore(account.accountId);
  const raw = {
    message_id: "interrupted",
    message_type: 1,
    from_user_id: "owner",
    context_token: "old-context",
    item_list: [{ type: 1, text_item: { text: "resume me" } }],
  };
  inbox.receive("interrupted", raw);
  inbox.queue("interrupted", {
    text: "resume me",
    attachments: [],
    context: { contextToken: "old-context", runId: "old-run" },
    runtimeSnapshot: { provider: "codex", cwd: process.cwd(), accessMode: "read-only", model: "old-model", effort: "low", key: "frozen" },
    inboxId: "interrupted",
  });
  inbox.mark("interrupted", "running");
  inbox.interruptRunning();
  const queued = [];
  bridge.taskQueue = {
    status: () => ({ active: false, pending: 0, debouncing: false }),
    enqueue: (_peerId, item) => { queued.push(item); return { accepted: true, active: false, pending: 1 }; },
  };
  await bridge.handleCommand("owner", { contextToken: "fresh-context", runId: "" }, { name: "retry", argument: "" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].context.contextToken, "fresh-context");
  assert.equal(queued[0].context.runId, "");
  assert.equal(queued[0].runtimeSnapshot.key, "frozen");
});

test("stop cancels the active agent before a durable queue cancellation failure", async (t) => {
  const { bridge } = isolatedBridge(t, "stop-order");
  let cancelled = false;
  const active = { task: { cancel: () => { cancelled = true; } }, stopRequested: false };
  bridge.activeAgents.set("owner", active);
  bridge.taskQueue.enqueue("owner", { inboxId: "queued" });
  bridge.inbox.cancelMany = () => {
    const error = new Error("disk full");
    error.code = "ENOSPC";
    throw error;
  };
  await assert.rejects(
    bridge.handleCommand("owner", { contextToken: "ctx", runId: "" }, { name: "stop", argument: "" }),
    /disk full/,
  );
  assert.equal(cancelled, true);
  assert.equal(active.stopRequested, true);
  assert.equal(bridge.taskQueue.status("owner").pending, 0);
});

test("legacy interrupted control commands are excluded from explicit retry", async (t) => {
  const { account, bridge } = isolatedBridge(t, "legacy-command");
  const raw = {
    message_id: "old-stop",
    message_type: 1,
    from_user_id: "owner",
    item_list: [{ type: 1, text_item: { text: "/stop" } }],
  };
  const inbox = new InboxStore(account.accountId);
  inbox.receive("old-stop", raw);
  inbox.mark("old-stop", "running");
  inbox.interruptRunning();
  await bridge.handleCommand("owner", { contextToken: "fresh", runId: "" }, { name: "retry", argument: "" });
  assert.equal(new InboxStore(account.accountId).get("old-stop").status, "cancelled");
  assert.equal(bridge.taskQueue.status("owner").pending, 0);
});

test("work frozen before materialization keeps its original runtime on retry", async (t) => {
  const { account, bridge } = isolatedBridge(t, "pre-materialize-freeze");
  const raw = {
    message_id: "media-retry",
    message_type: 1,
    from_user_id: "owner",
    item_list: [{ type: 1, text_item: { text: "retry safely" } }],
  };
  const inbox = new InboxStore(account.accountId);
  inbox.receive("media-retry", raw);
  inbox.classify("media-retry", "work", {
    runtimeSnapshot: {
      provider: "codex",
      cwd: process.cwd(),
      accessMode: "read-only",
      model: "frozen-model",
      effort: "low",
      key: "pre-materialize",
    },
    statePeerId: "frozen-peer",
  });
  inbox.mark("media-retry", "failed", "temporary CDN error");
  const queued = [];
  bridge.taskQueue = {
    status: () => ({ active: false, pending: 0, debouncing: false }),
    enqueue: (_peerId, item) => { queued.push(item); return { accepted: true, active: false, pending: 1 }; },
  };
  await bridge.handleCommand("owner", { contextToken: "new-context", runId: "" }, { name: "retry", argument: "" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].runtimeSnapshot.accessMode, "read-only");
  assert.equal(queued[0].runtimeSnapshot.model, "frozen-model");
  assert.equal(queued[0].statePeerId, "frozen-peer");
});

test("a completed reply is replayed without enqueuing the Agent again", async (t) => {
  const { account, bridge } = isolatedBridge(t, "completed-reply");
  const raw = {
    message_id: "completed-work",
    message_type: 1,
    from_user_id: "owner",
    context_token: "old-context",
    item_list: [{ type: 1, text_item: { text: "already executed" } }],
  };
  const inbox = new InboxStore(account.accountId);
  inbox.receive("completed-work", raw);
  inbox.classify("completed-work", "work", { runtimeSnapshot: { key: "frozen" }, statePeerId: "peer" });
  inbox.queue("completed-work", { text: "already executed", runtimeSnapshot: { key: "frozen" } });
  inbox.mark("completed-work", "running");
  inbox.saveCompletion(["completed-work"], { id: "result-safe", chunks: ["durable result"] });
  let sent = "";
  bridge.sender.sendText = async ({ text }) => { sent = text; return { ok: true }; };
  bridge.taskQueue.enqueue = () => { throw new Error("Agent must not be queued"); };
  await bridge.handleMessage(raw, { replay: true, deliveryContext: { contextToken: "fresh", runId: "" } });
  assert.equal(sent, "durable result");
  assert.equal(new InboxStore(account.accountId).get("completed-work").status, "done");
});

test("an unaccepted completed reply remains replayable instead of rerunning work", async (t) => {
  const { account, bridge } = isolatedBridge(t, "completed-deferred");
  const raw = {
    message_id: "completed-deferred",
    message_type: 1,
    from_user_id: "owner",
    item_list: [{ type: 1, text_item: { text: "already executed" } }],
  };
  const inbox = new InboxStore(account.accountId);
  inbox.receive("completed-deferred", raw);
  inbox.classify("completed-deferred", "work", { runtimeSnapshot: { key: "frozen" }, statePeerId: "peer" });
  inbox.queue("completed-deferred", { text: "already executed", runtimeSnapshot: { key: "frozen" } });
  inbox.mark("completed-deferred", "running");
  inbox.saveCompletion(["completed-deferred"], { id: "result-deferred", chunks: ["keep me"] });
  const full = new Error("critical queue full");
  full.code = "WECHAT_SEND_QUEUE_FULL";
  bridge.sender.sendText = async () => { throw full; };
  bridge.sender.listPending = () => [];
  await bridge.handleMessage(raw, { replay: true });
  assert.equal(new InboxStore(account.accountId).get("completed-deferred").status, "completed");
});

test("a live inbound queue overflow remains recoverable instead of being marked done", async (t) => {
  const { account, bridge } = isolatedBridge(t, "queue-overflow");
  bridge.taskQueue.maxPendingPerPeer = 1;
  const message = (id, text) => ({
    message_id: id,
    message_type: 1,
    from_user_id: "owner",
    item_list: [{ type: 1, text_item: { text } }],
  });
  await bridge.handleMessage(message("first", "first task"));
  await bridge.handleMessage(message("second", "second task"));
  const restored = new InboxStore(account.accountId);
  assert.equal(restored.get("first").status, "queued");
  assert.equal(restored.get("second").status, "failed");
  assert.deepEqual(restored.recoverable("owner").map((record) => record.id), ["second"]);
  bridge.stop();
});

test("resume fallback accepts only precise missing-session errors before meaningful activity", () => {
  assert.equal(isMissingSessionError(new Error("thread abc not found"), "codex"), true);
  assert.equal(isMissingSessionError(new Error("tool failed because session token is invalid"), "codex"), false);
  assert.equal(isMissingSessionError(new Error("No conversation found with session ID abc"), "claude-code"), true);
  assert.equal(isMeaningfulAgentEvent({ type: "system", name: "session_started" }), false);
  assert.equal(isMeaningfulAgentEvent({ type: "tool_use", name: "Bash" }), true);
  assert.equal(isMeaningfulAgentEvent({ type: "thinking" }), true);
});

test("an artifact not admitted to the outbox is reported as a send failure", async (t) => {
  const { bridge, directory } = isolatedBridge(t, "artifact-admission");
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const source = path.join(workspace, "result.txt");
  fs.writeFileSync(source, "safe result");
  const snapshot = await stageOutboundArtifact({ path: source, kind: "file" }, { workspace });
  const full = new Error("outbox full");
  full.code = "WECHAT_SEND_QUEUE_FULL";
  bridge.sender.sendFile = async () => { throw full; };
  bridge.sender.listPending = () => [];
  await assert.rejects(
    bridge.safeSendArtifact("owner", { contextToken: "ctx", runId: "" }, snapshot),
    { code: "WECHAT_SEND_QUEUE_FULL" },
  );
  assert.throws(() => fs.statSync(snapshot.path), { code: "ENOENT" });
});
