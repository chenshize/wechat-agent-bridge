import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  acquireInstanceLock,
  agentLaneIdentity,
  agentLaneKey,
  appendHistory,
  claudeAccessArgs,
  clearAgentLane,
  clearDedupeEntries,
  clearHistory,
  clearPeerRuntime,
  codexAccessArgs,
  flushSerializedWrites,
  hasSeenMessageId,
  listWorkspaces,
  loadAccount,
  loadAgentLane,
  loadDedupeEntries,
  loadHistory,
  loadPeerRuntime,
  readJson,
  releaseInstanceLock,
  rememberMessageId,
  removeWorkspace,
  resolveWorkspacePath,
  saveAccount,
  saveAgentLaneSession,
  savePeerRuntime,
  savePeerModel,
  savePeerNotificationMode,
  savePeerReasoningEffort,
  saveWorkspace,
  secureStateDirectory,
  setActiveWorkspace,
  stateDir,
  useWorkspace,
  writeJson,
  writeJsonSerialized,
} from "../src/state.js";

const originalStateDir = process.env.WECHAT_BRIDGE_STATE_DIR;
let temporaryStateDir;

beforeEach(() => {
  temporaryStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-state-test-"));
  process.env.WECHAT_BRIDGE_STATE_DIR = temporaryStateDir;
});

afterEach(async () => {
  await flushSerializedWrites();
  fs.rmSync(temporaryStateDir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
  else process.env.WECHAT_BRIDGE_STATE_DIR = originalStateDir;
});

test("atomic and serialized JSON writes leave a private complete file", async () => {
  secureStateDirectory();
  if (process.platform !== "win32") assert.equal(fs.statSync(stateDir()).mode & 0o777, 0o700);
  const filePath = path.join(stateDir(), "atomic.json");
  writeJson(filePath, { value: 1 });
  assert.deepEqual(readJson(filePath), { value: 1 });
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  await Promise.all([
    writeJsonSerialized(filePath, { value: 2 }),
    writeJsonSerialized(filePath, { value: 3 }),
    writeJsonSerialized(filePath, { value: 4 }),
  ]);
  assert.deepEqual(readJson(filePath), { value: 4 });
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp")), []);
});

test("existing account and history JSON remains readable", () => {
  const accountDirectory = path.join(stateDir(), "accounts");
  fs.mkdirSync(accountDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDir(), "accounts.json"), JSON.stringify(["legacy"]));
  fs.writeFileSync(path.join(accountDirectory, "legacy.json"), JSON.stringify({ token: "old-token", custom: true }));
  assert.equal(loadAccount("legacy").token, "old-token");

  const saved = saveAccount({ accountId: "legacy", token: "new-token" });
  assert.equal(saved.custom, true);
  assert.equal(loadAccount("legacy").token, "new-token");

  appendHistory("peer/legacy", "hello", "world", 2);
  assert.deepEqual(loadHistory("peer/legacy").map((entry) => entry.content), ["hello", "world"]);
  clearHistory("peer/legacy");
  assert.deepEqual(loadHistory("peer/legacy"), []);
});

test("single-instance lock preserves a live owner and can be released", () => {
  const first = acquireInstanceLock("account-one");
  assert.throws(() => acquireInstanceLock("account-one"), { code: "BRIDGE_ALREADY_RUNNING" });
  assert.equal(releaseInstanceLock(first), true);
  assert.equal(releaseInstanceLock(first), false);

  const second = acquireInstanceLock("account-one");
  assert.equal(second.release(), true);
});

test("workspace validation resolves real paths and rejects broad or system roots", () => {
  const current = resolveWorkspacePath(process.cwd());
  assert.equal(current, fs.realpathSync.native(process.cwd()));
  assert.throws(() => resolveWorkspacePath(path.parse(current).root), { code: "UNSAFE_WORKSPACE" });
  assert.throws(() => resolveWorkspacePath(os.homedir()), { code: "UNSAFE_WORKSPACE" });
  assert.throws(() => resolveWorkspacePath(os.tmpdir()), { code: "UNSAFE_WORKSPACE" });
});

test("named workspaces and per-peer runtime are persisted safely", () => {
  const cwd = resolveWorkspacePath(process.cwd());
  setActiveWorkspace(cwd);
  saveWorkspace("bridge", cwd);
  assert.deepEqual(listWorkspaces().map((entry) => entry.name), ["bridge"]);
  assert.equal(useWorkspace("bridge"), cwd);

  const saved = savePeerRuntime("peer-one", {
    provider: "claude-code",
    cwd,
    accessMode: "read-only",
  });
  assert.equal(saved.provider, "claude-code");
  assert.equal(loadPeerRuntime("peer-one").cwd, cwd);
  assert.equal(loadPeerRuntime("peer-one").accessMode, "read-only");
  savePeerModel("peer-one", "claude-code", "peer-one-model");
  savePeerReasoningEffort("peer-one", "claude-code", "high");
  assert.equal(loadPeerRuntime("peer-one").models["claude-code"], "peer-one-model");
  assert.equal(loadPeerRuntime("peer-one").efforts["claude-code"], "high");
  savePeerNotificationMode("peer-one", "quiet");
  assert.equal(loadPeerRuntime("peer-one").notificationMode, "quiet");
  assert.notEqual(loadPeerRuntime("peer-two").models["claude-code"], "peer-one-model");
  clearPeerRuntime("peer-one");

  assert.equal(removeWorkspace("bridge"), true);
  assert.equal(removeWorkspace("bridge"), false);
});

test("message dedupe entries are bounded and survive reload", () => {
  rememberMessageId("account-one", "m1", { maxEntries: 2 });
  rememberMessageId("account-one", "m2", { maxEntries: 2 });
  rememberMessageId("account-one", "m3", { maxEntries: 2 });
  assert.deepEqual(loadDedupeEntries("account-one").map((entry) => entry.id), ["m2", "m3"]);
  assert.equal(hasSeenMessageId("account-one", "m3"), true);
  assert.equal(rememberMessageId("account-one", "m3").duplicate, true);
  clearDedupeEntries("account-one");
  assert.deepEqual(loadDedupeEntries("account-one"), []);
});

test("agent lanes are isolated by provider, real cwd, and access mode", () => {
  const cwd = resolveWorkspacePath(process.cwd());
  const claude = agentLaneIdentity({
    peerId: "peer-one",
    provider: "claude-code",
    cwd,
    accessMode: "read-only",
  });
  const codex = agentLaneIdentity({
    peerId: "peer-one",
    provider: "codex",
    cwd,
    accessMode: "workspace",
  });
  assert.notEqual(agentLaneKey(claude), agentLaneKey(codex));

  saveAgentLaneSession(claude, "claude-session-1", { source: "test" });
  saveAgentLaneSession(codex, "codex-thread-1");
  assert.equal(loadAgentLane(claude).sessionId, "claude-session-1");
  assert.equal(loadAgentLane(codex).threadId, "codex-thread-1");
  assert.equal(loadAgentLane(claude).threadId, undefined);

  const result = clearAgentLane(claude, { archive: true, reason: "new topic" });
  assert.equal(result.cleared, true);
  assert.equal(result.archived, true);
  assert.equal(fs.existsSync(result.archivePath), true);
  assert.equal(loadAgentLane(claude), null);
});

test("access mappings use non-interactive sandboxed arguments", () => {
  assert.deepEqual(codexAccessArgs("read-only").slice(0, 2), ["--sandbox", "read-only"]);
  assert.deepEqual(codexAccessArgs("workspace").slice(0, 2), ["--sandbox", "workspace-write"]);
  assert.equal(codexAccessArgs("read-only").includes("--ask-for-approval"), false);
  assert.deepEqual(codexAccessArgs("full"), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(claudeAccessArgs("read-only"), ["--permission-mode", "plan"]);
  assert.deepEqual(claudeAccessArgs("workspace"), ["--permission-mode", "acceptEdits"]);
});
