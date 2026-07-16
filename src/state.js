import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  atomicWriteJsonSync,
  flushSerializedWrites,
  serializedWriteJson,
} from "./runtime/atomic-json.js";
import {
  ACCESS_MODES,
  AGENT_ACCESS,
  accessArgs,
  accessConfig,
  claudeAccessArgs,
  codexAccessArgs,
  normalizeAccessMode,
} from "./runtime/access.js";
import { acquireFileLock } from "./runtime/instance-lock.js";
import { checkWorkspacePath, resolveWorkspacePath } from "./runtime/workspace.js";

export {
  ACCESS_MODES,
  AGENT_ACCESS,
  accessArgs,
  accessConfig,
  checkWorkspacePath,
  claudeAccessArgs,
  codexAccessArgs,
  flushSerializedWrites,
  normalizeAccessMode,
  resolveWorkspacePath,
};

export function stateDir() {
  const legacyDir = path.join(os.homedir(), ".weixin-codex-bridge");
  return process.env.WECHAT_BRIDGE_STATE_DIR?.trim() ||
    process.env.WEIXIN_CODEX_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    (fs.existsSync(legacyDir) ? legacyDir : path.join(os.homedir(), ".wechat-agent-bridge"));
}

export function secureStateDirectory() {
  const root = stateDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const privateDirectories = [
    root,
    "accounts",
    "history",
    "logs",
    "runs",
    "locks",
    "lanes",
    "peers",
    "dedupe",
    "inbox",
    "outbox",
    "outbound-spool",
    "artifacts",
    "media-cache",
  ].map((entry) => path.isAbsolute(entry) ? entry : path.join(root, entry));
  for (const directory of privateDirectories) {
    try {
      if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
    } catch {
      // POSIX modes are unavailable on some filesystems; file modes remain best effort there.
    }
  }
  return root;
}

export function accountsDir() {
  return path.join(stateDir(), "accounts");
}

export function accountIndexPath() {
  return path.join(stateDir(), "accounts.json");
}

function safeAccountId(accountId) {
  const value = String(accountId || "").trim();
  if (!value || value.length > 256 || value.includes("..") || /[\\/\u0000-\u001f]/.test(value)) {
    const error = new Error("invalid account id");
    error.code = "INVALID_ACCOUNT_ID";
    throw error;
  }
  return value;
}

export function accountPath(accountId) {
  return path.join(accountsDir(), `${safeAccountId(accountId)}.json`);
}

export function syncPath(accountId) {
  return path.join(accountsDir(), `${safeAccountId(accountId)}.sync.json`);
}

export function dedupePath(scopeId = "default") {
  return path.join(stateDir(), "dedupe", `${safeStateKey(scopeId)}.json`);
}

export function peerRuntimePath(peerId) {
  return path.join(stateDir(), "peers", `${safeStateKey(peerId)}.json`);
}

export function historyPath(peerId) {
  const safe = peerId.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  return path.join(stateDir(), "history", `${safe}.json`);
}

export function settingsPath() {
  return path.join(stateDir(), "settings.json");
}

function safeStateKey(value) {
  const input = String(value || "default").trim() || "default";
  const label = input.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "instance";
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `${label}-${digest}`;
}

export function instanceLockPath(instanceId = "default") {
  return path.join(stateDir(), "locks", `${safeStateKey(instanceId)}.lock`);
}

export function acquireInstanceLock(instanceId = "default", metadata = {}) {
  return acquireFileLock(instanceLockPath(instanceId), { instanceId, ...metadata });
}

export function releaseInstanceLock(lock) {
  return lock?.release?.() || false;
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value, mode = 0o600) {
  atomicWriteJsonSync(filePath, value, mode);
}

export function writeJsonSerialized(filePath, value, mode = 0o600) {
  return serializedWriteJson(filePath, value, mode);
}

export function listAccountIds() {
  const parsed = readJson(accountIndexPath(), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id) => {
    if (typeof id !== "string") return false;
    try {
      safeAccountId(id);
      return true;
    } catch {
      return false;
    }
  });
}

export function saveAccount(account) {
  if (!account?.accountId) throw new Error("accountId is required");
  const existing = readJson(accountPath(account.accountId), {});
  const saved = {
    ...existing,
    ...account,
    savedAt: new Date().toISOString(),
  };
  writeJson(accountPath(account.accountId), saved);

  const ids = listAccountIds();
  if (!ids.includes(account.accountId)) {
    writeJson(accountIndexPath(), [...ids, account.accountId]);
  }
  return saved;
}

export function loadAccount(accountId) {
  const ids = listAccountIds();
  const selected = accountId || ids.at(-1);
  if (!selected) return null;
  const account = readJson(accountPath(selected), null);
  return account ? { ...account, accountId: selected } : null;
}

export function loadSyncBuf(accountId) {
  const data = readJson(syncPath(accountId), {});
  return typeof data?.get_updates_buf === "string" ? data.get_updates_buf : "";
}

export function saveSyncBuf(accountId, getUpdatesBuf) {
  writeJson(syncPath(accountId), { get_updates_buf: getUpdatesBuf ?? "" });
}

export function loadDedupeEntries(scopeId = "default") {
  const data = readJson(dedupePath(scopeId), {});
  if (!Array.isArray(data?.entries)) return [];
  return data.entries
    .map((entry) => typeof entry === "string" ? { id: entry, seenAt: "" } : entry)
    .filter((entry) => entry && typeof entry.id === "string" && entry.id.trim())
    .map((entry) => ({ id: entry.id, seenAt: typeof entry.seenAt === "string" ? entry.seenAt : "" }));
}

export function hasSeenMessageId(scopeId, messageId) {
  const normalized = String(messageId || "").trim();
  return normalized ? loadDedupeEntries(scopeId).some((entry) => entry.id === normalized) : false;
}

export function rememberMessageId(scopeId, messageId, { maxEntries = 1000 } = {}) {
  const normalized = String(messageId || "").trim();
  if (!normalized || normalized.length > 512) {
    const error = new Error("message id must be 1-512 characters");
    error.code = "INVALID_MESSAGE_ID";
    throw error;
  }
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1000;
  const entries = loadDedupeEntries(scopeId);
  const duplicate = entries.some((entry) => entry.id === normalized);
  if (duplicate) return { duplicate: true, entries };

  const nextEntries = [...entries, { id: normalized, seenAt: new Date().toISOString() }].slice(-limit);
  writeJson(dedupePath(scopeId), { version: 1, entries: nextEntries, updatedAt: new Date().toISOString() });
  return { duplicate: false, entries: nextEntries };
}

export function clearDedupeEntries(scopeId = "default") {
  fs.rmSync(dedupePath(scopeId), { force: true });
}

export function loadHistory(peerId) {
  const data = readJson(historyPath(peerId), []);
  return Array.isArray(data) ? data : [];
}

export function appendHistory(peerId, userText, assistantText, maxTurns = 12) {
  const history = loadHistory(peerId);
  history.push({ role: "user", content: userText, at: new Date().toISOString() });
  history.push({ role: "assistant", content: assistantText, at: new Date().toISOString() });
  writeJson(historyPath(peerId), history.slice(-maxTurns * 2));
}

export function clearHistory(peerId) {
  const filePath = historyPath(peerId);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort; a missing or locked history file should not break chat commands.
  }
}

export function loadSettings() {
  return readJson(settingsPath(), {});
}

export function saveSettings(update) {
  const next = { ...loadSettings(), ...update, updatedAt: new Date().toISOString() };
  writeJson(settingsPath(), next);
  return next;
}

export function workspaceStorePath() {
  return path.join(stateDir(), "workspaces.json");
}

function normalizeWorkspaceName(name) {
  const normalized = String(name || "").trim();
  if (!normalized || normalized.length > 64 || /[\\/\u0000-\u001f]/.test(normalized)) {
    const error = new Error("workspace name must be 1-64 characters and cannot contain slashes or controls");
    error.code = "INVALID_WORKSPACE_NAME";
    throw error;
  }
  return normalized;
}

function normalizeWorkspaceStore(data) {
  const entries = Array.isArray(data?.entries)
    ? data.entries
        .filter((entry) => entry && typeof entry.name === "string" && typeof entry.path === "string")
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }))
    : [];
  return {
    version: 1,
    activePath: typeof data?.activePath === "string" ? data.activePath : "",
    entries,
    updatedAt: data?.updatedAt,
  };
}

export function loadWorkspaceStore() {
  return normalizeWorkspaceStore(readJson(workspaceStorePath(), {}));
}

function persistWorkspaceStore(store) {
  const next = {
    ...normalizeWorkspaceStore(store),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  writeJson(workspaceStorePath(), next);
  return next;
}

export function listWorkspaces() {
  return loadWorkspaceStore().entries.map((entry) => ({ ...entry }));
}

export function setActiveWorkspace(cwd, options) {
  const resolved = resolveWorkspacePath(cwd, options);
  const store = loadWorkspaceStore();
  persistWorkspaceStore({ ...store, activePath: resolved });
  return resolved;
}

export function loadActiveWorkspace(fallback) {
  const store = loadWorkspaceStore();
  if (store.activePath) {
    try {
      return resolveWorkspacePath(store.activePath);
    } catch {
      // A moved/deleted workspace falls through to the configured default.
    }
  }
  const configured = fallback ||
    process.env.WECHAT_BRIDGE_CWD?.trim() ||
    process.env.WEIXIN_CODEX_CWD?.trim() ||
    process.cwd();
  return resolveWorkspacePath(configured);
}

export function saveWorkspace(name, cwd = loadActiveWorkspace()) {
  const normalizedName = normalizeWorkspaceName(name);
  const resolved = resolveWorkspacePath(cwd);
  const store = loadWorkspaceStore();
  const existing = store.entries.find((entry) => entry.name === normalizedName);
  const now = new Date().toISOString();
  const entry = {
    name: normalizedName,
    path: resolved,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const entries = store.entries.filter((item) => item.name !== normalizedName);
  persistWorkspaceStore({ ...store, entries: [...entries, entry] });
  return { ...entry };
}

export function useWorkspace(name) {
  const normalizedName = normalizeWorkspaceName(name);
  const store = loadWorkspaceStore();
  const entry = store.entries.find((item) => item.name === normalizedName);
  if (!entry) {
    const error = new Error(`unknown workspace: ${normalizedName}`);
    error.code = "WORKSPACE_NOT_SAVED";
    throw error;
  }
  const resolved = resolveWorkspacePath(entry.path);
  persistWorkspaceStore({ ...store, activePath: resolved });
  return resolved;
}

export function removeWorkspace(name) {
  const normalizedName = normalizeWorkspaceName(name);
  const store = loadWorkspaceStore();
  const entries = store.entries.filter((item) => item.name !== normalizedName);
  if (entries.length === store.entries.length) return false;
  persistWorkspaceStore({ ...store, entries });
  return true;
}

export const deleteWorkspace = removeWorkspace;

export function loadAccessMode() {
  const configured = loadSettings().accessMode;
  if (ACCESS_MODES.includes(configured)) return configured;
  return normalizeAccessMode(process.env.WECHAT_BRIDGE_ACCESS_MODE, "workspace");
}

export function saveAccessMode(mode) {
  return saveSettings({ accessMode: normalizeAccessMode(mode, null) });
}

export const AGENT_PROVIDERS = ["codex", "claude-code"];

export function loadAgentProvider() {
  const configured = loadSettings().agentProvider;
  const fallback = process.env.WECHAT_BRIDGE_DEFAULT_AGENT?.trim().toLowerCase() || "codex";
  return AGENT_PROVIDERS.includes(configured) ? configured :
    AGENT_PROVIDERS.includes(fallback) ? fallback : "codex";
}

export function saveAgentProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!AGENT_PROVIDERS.includes(normalized)) {
    throw new Error(`unsupported agent provider: ${normalized || "<empty>"}`);
  }
  return saveSettings({ agentProvider: normalized });
}

function normalizePeerId(peerId) {
  const normalized = String(peerId || "").trim();
  if (!normalized) {
    const error = new Error("peerId is required");
    error.code = "INVALID_PEER";
    throw error;
  }
  return normalized;
}

export function loadPeerRuntime(peerId) {
  const normalizedPeerId = normalizePeerId(peerId);
  const stored = readJson(peerRuntimePath(normalizedPeerId), {});
  const provider = AGENT_PROVIDERS.includes(stored?.provider) ? stored.provider : loadAgentProvider();
  const accessMode = ACCESS_MODES.includes(stored?.accessMode) ? stored.accessMode : loadAccessMode();
  const codexModel = String(stored?.models?.codex || loadCodexModel()).trim() || loadCodexModel();
  const claudeModel = String(stored?.models?.["claude-code"] || loadClaudeModel()).trim() || loadClaudeModel();
  const configuredCodexEffort = String(stored?.efforts?.codex || "").trim().toLowerCase();
  const configuredClaudeEffort = String(stored?.efforts?.["claude-code"] || "").trim().toLowerCase();
  const codexEfforts = listCodexReasoningEfforts(codexModel);
  const claudeEfforts = listClaudeReasoningEfforts();
  let cwd;
  try {
    cwd = stored?.cwd ? resolveWorkspacePath(stored.cwd) : loadActiveWorkspace();
  } catch {
    cwd = loadActiveWorkspace();
  }
  return {
    version: 2,
    peerId: normalizedPeerId,
    provider,
    cwd,
    accessMode,
    models: {
      codex: codexModel,
      "claude-code": claudeModel,
    },
    efforts: {
      codex: codexEfforts.includes(configuredCodexEffort)
        ? configuredCodexEffort
        : defaultCodexReasoningEffort(codexModel),
      "claude-code": claudeEfforts.includes(configuredClaudeEffort)
        ? configuredClaudeEffort
        : loadClaudeReasoningEffort(),
    },
    createdAt: stored?.createdAt,
    updatedAt: stored?.updatedAt,
  };
}

export function savePeerRuntime(peerId, update = {}) {
  const normalizedPeerId = normalizePeerId(peerId);
  const existing = readJson(peerRuntimePath(normalizedPeerId), {});
  const current = loadPeerRuntime(normalizedPeerId);
  const provider = Object.hasOwn(update, "provider")
    ? String(update.provider || "").trim().toLowerCase()
    : current.provider;
  if (!AGENT_PROVIDERS.includes(provider)) {
    const error = new Error(`unsupported agent provider: ${provider || "<empty>"}`);
    error.code = "UNSUPPORTED_AGENT_PROVIDER";
    throw error;
  }
  const cwd = Object.hasOwn(update, "cwd") ? resolveWorkspacePath(update.cwd) : current.cwd;
  const accessMode = Object.hasOwn(update, "accessMode")
    ? normalizeAccessMode(update.accessMode, null)
    : current.accessMode;
  const models = {
    ...current.models,
    ...(update?.models && typeof update.models === "object" ? update.models : {}),
  };
  for (const provider of AGENT_PROVIDERS) {
    models[provider] = String(models[provider] || "").trim();
    if (!models[provider]) throw new Error(`${provider} model cannot be empty`);
  }
  const efforts = {
    ...current.efforts,
    ...(update?.efforts && typeof update.efforts === "object" ? update.efforts : {}),
  };
  const allowedEfforts = {
    codex: listCodexReasoningEfforts(models.codex),
    "claude-code": listClaudeReasoningEfforts(),
  };
  for (const agent of AGENT_PROVIDERS) {
    efforts[agent] = String(efforts[agent] || "").trim().toLowerCase();
    if (!allowedEfforts[agent].includes(efforts[agent])) {
      efforts[agent] = agent === "codex" ? defaultCodexReasoningEffort(models.codex) : loadClaudeReasoningEffort();
    }
  }
  const now = new Date().toISOString();
  const next = {
    version: 2,
    peerId: normalizedPeerId,
    provider,
    cwd,
    accessMode,
    models,
    efforts,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeJson(peerRuntimePath(normalizedPeerId), next);
  return next;
}

export function savePeerAgentProvider(peerId, provider) {
  return savePeerRuntime(peerId, { provider });
}

export function savePeerWorkspace(peerId, cwd) {
  return savePeerRuntime(peerId, { cwd });
}

export function savePeerAccessMode(peerId, accessMode) {
  return savePeerRuntime(peerId, { accessMode });
}

export function savePeerModel(peerId, provider, model) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!AGENT_PROVIDERS.includes(normalizedProvider)) throw new Error(`unsupported agent provider: ${normalizedProvider}`);
  return savePeerRuntime(peerId, { models: { [normalizedProvider]: String(model || "").trim() } });
}

export function savePeerReasoningEffort(peerId, provider, effort) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!AGENT_PROVIDERS.includes(normalizedProvider)) throw new Error(`unsupported agent provider: ${normalizedProvider}`);
  return savePeerRuntime(peerId, { efforts: { [normalizedProvider]: String(effort || "").trim().toLowerCase() } });
}

export function clearPeerRuntime(peerId) {
  fs.rmSync(peerRuntimePath(normalizePeerId(peerId)), { force: true });
}

export function agentLanesDir() {
  return path.join(stateDir(), "lanes");
}

function normalizeLaneIdentity(identity = {}) {
  const peerId = String(identity.peerId || "").trim();
  if (!peerId) {
    const error = new Error("agent lane peerId is required");
    error.code = "INVALID_AGENT_LANE";
    throw error;
  }
  const provider = String(identity.provider || "").trim().toLowerCase();
  if (!AGENT_PROVIDERS.includes(provider)) {
    const error = new Error(`unsupported agent provider: ${provider || "<empty>"}`);
    error.code = "UNSUPPORTED_AGENT_PROVIDER";
    throw error;
  }
  const cwd = resolveWorkspacePath(identity.cwd);
  const accessMode = normalizeAccessMode(identity.accessMode || identity.access, null);
  const key = createHash("sha256")
    .update(JSON.stringify([peerId, provider, cwd, accessMode]))
    .digest("hex");
  return { key, peerId, provider, cwd, accessMode };
}

export function agentLaneIdentity(identity) {
  return normalizeLaneIdentity(identity);
}

export function agentLaneKey(identity) {
  return normalizeLaneIdentity(identity).key;
}

export function agentLanePath(identityOrKey) {
  const key = typeof identityOrKey === "string" ? identityOrKey : agentLaneKey(identityOrKey);
  if (!/^[a-f0-9]{64}$/.test(key)) {
    const error = new Error("invalid agent lane key");
    error.code = "INVALID_AGENT_LANE";
    throw error;
  }
  return path.join(agentLanesDir(), `${key}.json`);
}

export function loadAgentLane(identity) {
  const descriptor = normalizeLaneIdentity(identity);
  const lane = readJson(agentLanePath(descriptor.key), null);
  if (!lane || lane.key !== descriptor.key || lane.provider !== descriptor.provider) return null;
  return lane;
}

function normalizeSessionId(value, label) {
  if (value === null) return undefined;
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${label} cannot be empty`);
    error.code = "INVALID_AGENT_SESSION";
    throw error;
  }
  return normalized;
}

export function saveAgentLane(identity, update = {}) {
  const descriptor = normalizeLaneIdentity(identity);
  const filePath = agentLanePath(descriptor.key);
  const existing = readJson(filePath, {});
  const now = new Date().toISOString();
  const next = {
    version: 1,
    ...descriptor,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: update.lastUsedAt || now,
    metadata: {
      ...(existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
      ...(update?.metadata && typeof update.metadata === "object" ? update.metadata : {}),
    },
  };

  if (descriptor.provider === "claude-code") {
    if (Object.hasOwn(update, "threadId")) {
      const error = new Error("Codex threadId cannot be stored in a Claude Code lane");
      error.code = "INVALID_AGENT_SESSION";
      throw error;
    }
    const sessionId = Object.hasOwn(update, "sessionId")
      ? normalizeSessionId(update.sessionId, "Claude sessionId")
      : existing?.sessionId;
    if (sessionId) next.sessionId = sessionId;
  } else {
    if (Object.hasOwn(update, "sessionId")) {
      const error = new Error("Claude sessionId cannot be stored in a Codex lane");
      error.code = "INVALID_AGENT_SESSION";
      throw error;
    }
    const threadId = Object.hasOwn(update, "threadId")
      ? normalizeSessionId(update.threadId, "Codex threadId")
      : existing?.threadId;
    if (threadId) next.threadId = threadId;
  }

  writeJson(filePath, next);
  return next;
}

export function saveAgentLaneSession(identity, sessionId, metadata) {
  const descriptor = normalizeLaneIdentity(identity);
  return descriptor.provider === "claude-code"
    ? saveAgentLane(descriptor, { sessionId, metadata })
    : saveAgentLane(descriptor, { threadId: sessionId, metadata });
}

export function listAgentLanes({ peerId, provider } = {}) {
  let names;
  try {
    names = fs.readdirSync(agentLanesDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => readJson(path.join(agentLanesDir(), name), null))
    .filter((lane) => lane && (!peerId || lane.peerId === peerId) && (!provider || lane.provider === provider));
}

export function clearAgentLane(identity, { archive = false, reason = "" } = {}) {
  const descriptor = normalizeLaneIdentity(identity);
  const filePath = agentLanePath(descriptor.key);
  const existing = readJson(filePath, null);
  if (!existing) return { cleared: false, archived: false, key: descriptor.key };

  let archivePath = "";
  if (archive) {
    const archivedAt = new Date().toISOString();
    const suffix = `${archivedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    archivePath = path.join(agentLanesDir(), "archive", `${descriptor.key}-${suffix}.json`);
    writeJson(archivePath, { ...existing, archivedAt, archiveReason: String(reason || "") });
  }
  fs.rmSync(filePath, { force: true });
  return { cleared: true, archived: archive, archivePath, key: descriptor.key };
}

export function currentAgentLaneIdentity(peerId, overrides = {}) {
  const peerRuntime = loadPeerRuntime(peerId);
  return normalizeLaneIdentity({
    peerId,
    provider: overrides.provider || peerRuntime.provider,
    cwd: overrides.cwd || peerRuntime.cwd,
    accessMode: overrides.accessMode || peerRuntime.accessMode,
  });
}

export function loadCurrentAgentLane(peerId, overrides) {
  return loadAgentLane(currentAgentLaneIdentity(peerId, overrides));
}

export function saveCurrentAgentSession(peerId, sessionId, overrides = {}) {
  const identity = currentAgentLaneIdentity(peerId, overrides);
  return saveAgentLaneSession(identity, sessionId, overrides.metadata);
}

export function clearCurrentAgentLane(peerId, options = {}) {
  const identity = currentAgentLaneIdentity(peerId, options);
  return clearAgentLane(identity, { archive: options.archive, reason: options.reason });
}

export function listCodexModels() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  const data = readJson(cachePath, {});
  const slugs = Array.isArray(data?.models)
    ? data.models
        .map((model) => model?.slug)
        .filter((slug) => typeof slug === "string" && slug.trim() && !slug.includes("auto-review"))
    : [];
  return slugs.length ? slugs : ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
}

function loadCodexModelCatalog() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  const data = readJson(cachePath, {});
  return Array.isArray(data?.models) ? data.models : [];
}

export function defaultCodexModel() {
  return process.env.WECHAT_BRIDGE_CODEX_DEFAULT_MODEL?.trim() ||
    process.env.WEIXIN_CODEX_DEFAULT_MODEL?.trim() ||
    listCodexModels()[0] ||
    "gpt-5.5";
}

export function loadCodexModel() {
  const configured = loadSettings().codexModel;
  return typeof configured === "string" && configured.trim() ? configured.trim() : defaultCodexModel();
}

export function saveCodexModel(model) {
  const normalized = String(model || "").trim();
  const available = listCodexModels();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Codex model: ${normalized || "<empty>"}`);
  }
  return saveSettings({ codexModel: normalized });
}

export function listCodexReasoningEfforts(model = loadCodexModel()) {
  const found = loadCodexModelCatalog().find((item) => item?.slug === model);
  const efforts = Array.isArray(found?.supported_reasoning_levels)
    ? found.supported_reasoning_levels
        .map((level) => level?.effort)
        .filter((effort) => typeof effort === "string" && effort.trim())
    : [];
  return efforts.length ? efforts : ["low", "medium", "high", "xhigh"];
}

export function defaultCodexReasoningEffort(model = loadCodexModel()) {
  const found = loadCodexModelCatalog().find((item) => item?.slug === model);
  return typeof found?.default_reasoning_level === "string" && found.default_reasoning_level.trim()
    ? found.default_reasoning_level.trim()
    : "medium";
}

export function loadCodexReasoningEffort() {
  const model = loadCodexModel();
  const configured = loadSettings().codexReasoningEffort;
  const available = listCodexReasoningEfforts(model);
  if (typeof configured === "string" && available.includes(configured.trim())) {
    return configured.trim();
  }
  return defaultCodexReasoningEffort(model);
}

export function saveCodexReasoningEffort(effort) {
  const normalized = String(effort || "").trim().toLowerCase();
  const available = listCodexReasoningEfforts();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Codex reasoning effort: ${normalized || "<empty>"}`);
  }
  return saveSettings({ codexReasoningEffort: normalized });
}

function loadClaudeSettings() {
  const userSettings = readJson(path.join(os.homedir(), ".claude", "settings.json"), {});
  const localSettings = readJson(path.join(os.homedir(), ".claude", "settings.local.json"), {});
  return { ...userSettings, ...localSettings };
}

export function listClaudeModels() {
  const models = new Set(["sonnet", "opus", "haiku"]);
  const configured = loadClaudeSettings().model;
  if (typeof configured === "string" && configured.trim()) models.add(configured.trim());
  try {
    const help = execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 5000 });
    const modelHelp = help.match(/--model <model>[\s\S]*?(?=\n\s{2}--|\nCommands:|$)/)?.[0] || "";
    for (const match of modelHelp.matchAll(/'([^']+)'/g)) {
      if (/^[a-z0-9._:[\]-]+$/i.test(match[1])) models.add(match[1]);
    }
  } catch {
    // Fall back to stable aliases when Claude is unavailable or help changes.
  }
  return [...models];
}

export function loadClaudeModel() {
  const configured = loadSettings().claudeModel;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const environmentModel = process.env.WECHAT_BRIDGE_CLAUDE_CODE_MODEL?.trim();
  if (environmentModel) return environmentModel;
  const settingsModel = loadClaudeSettings().model;
  return typeof settingsModel === "string" && settingsModel.trim() ? settingsModel.trim() : "sonnet";
}

export function saveClaudeModel(model) {
  const normalized = String(model || "").trim();
  if (!normalized) throw new Error("Claude Code model cannot be empty");
  return saveSettings({ claudeModel: normalized });
}

export function listClaudeReasoningEfforts() {
  return ["low", "medium", "high", "xhigh", "max"];
}

export function loadClaudeReasoningEffort() {
  const configured = loadSettings().claudeReasoningEffort;
  const available = listClaudeReasoningEfforts();
  if (typeof configured === "string" && available.includes(configured.trim())) return configured.trim();
  const environmentEffort = process.env.WECHAT_BRIDGE_CLAUDE_CODE_EFFORT?.trim().toLowerCase();
  return available.includes(environmentEffort) ? environmentEffort : "high";
}

export function saveClaudeReasoningEffort(effort) {
  const normalized = String(effort || "").trim().toLowerCase();
  const available = listClaudeReasoningEfforts();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Claude Code effort: ${normalized || "<empty>"}`);
  }
  return saveSettings({ claudeReasoningEffort: normalized });
}
