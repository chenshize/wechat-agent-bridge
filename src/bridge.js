import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { startClaudeCode } from "./claude-code.js";
import { startAgent, isAgentStoppedError } from "./codex.js";
import { clearRecentArtifacts, loadRecentArtifacts, saveRecentArtifacts } from "./artifact-store.js";
import { discoverArtifacts, resolveArtifactFile } from "./artifacts.js";
import { cleanupOutboundSnapshot, stageOutboundArtifact, verifyOutboundSnapshot } from "./outbound-spool.js";
import {
  accessModeLabel,
  commandHelpText,
  normalizeAccessMode as normalizeCommandAccessMode,
  parseBridgeCommand,
  splitCommandArguments,
} from "./command-parser.js";
import { PeerTaskQueue } from "./inbound-queue.js";
import { InboxStore } from "./inbox-store.js";
import { PollBackoff, delay, messageIdentity } from "./poll-runtime.js";
import { anonymousPeerId, appendRunLog } from "./run-log.js";
import { JsonPendingStore, SendScheduler } from "./send-scheduler.js";
import {
  completionReceipt,
  formatInteractionNotification,
  notificationModeLabel,
  normalizeNotificationMode,
  progressHeartbeatMs,
  shouldRelayToolProgress,
} from "./notifications.js";
import {
  acquireInstanceLock,
  agentLaneIdentity,
  clearAgentLane,
  clearHistory,
  hasSeenMessageId,
  listClaudeModels,
  listClaudeReasoningEfforts,
  listCodexModels,
  listCodexReasoningEfforts,
  listAgentLanes,
  listWorkspaces,
  loadAgentLane,
  loadClaudeModel,
  loadClaudeReasoningEffort,
  loadCodexModel,
  loadCodexReasoningEffort,
  loadPeerRuntime,
  rememberMessageId,
  releaseInstanceLock,
  resolveWorkspacePath,
  saveAgentLaneSession,
  savePeerAccessMode,
  savePeerAgentProvider,
  savePeerModel,
  savePeerNotificationMode,
  savePeerReasoningEffort,
  savePeerWorkspace,
  saveSyncBuf,
  saveWorkspace,
  secureStateDirectory,
  stateDir,
  loadSyncBuf,
  removeWorkspace,
} from "./state.js";
import { findTaskByPublicId, formatTaskDetail, formatTaskList, taskPublicId } from "./task-view.js";
import { formatSessionList, laneSessionRef as nativeLaneSessionRef, nativeResumeCommand } from "./session-view.js";
import { VERSION } from "./version.js";
import {
  DEFAULT_BASE_URL,
  MESSAGE_TYPE,
  getConfig,
  getUpdates,
  notifyStart,
  sendFile,
  sendImage,
  sendText,
  sendTyping,
} from "./wechat-api.js";
import { extractInboundContent, materializeInboundContent } from "./wechat-media.js";

const DEFAULT_REPLY_CHUNK_LENGTH = 1200;
const MAX_AGENT_REPLY_CHARS = 48 * 1024 + 256;

function envInteger(name, fallback, { min = 0 } = {}) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function maskValue(value) {
  const input = String(value || "");
  if (!input) return "<none>";
  if (input.length <= 8) return `${input.slice(0, 2)}…`;
  return `${input.slice(0, 4)}…${input.slice(-4)}`;
}

function safeLog(type, record) {
  try {
    appendRunLog(type, record);
  } catch (error) {
    console.warn(`[wechat-bridge] run log failed: ${error?.message || error}`);
  }
}

export function allowedSender(account, fromUserId) {
  if ((process.env.WECHAT_BRIDGE_ALLOW_ALL || process.env.WEIXIN_CODEX_ALLOW_ALL) === "1") return true;
  const configured = (process.env.WECHAT_BRIDGE_ALLOW_FROM || process.env.WEIXIN_CODEX_ALLOW_FROM || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set(configured);
  if (account?.userId) allowed.add(account.userId);
  return allowed.has(fromUserId);
}

export function normalizeReplyText(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .trim();
}

export function splitReplyText(text, maxLength = DEFAULT_REPLY_CHUNK_LENGTH) {
  const normalized = normalizeReplyText(text);
  if (normalized.length <= maxLength) return [normalized || "我这边没有生成可发送的回复。"];
  const chunks = [];
  let current = "";
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxLength) {
      current = paragraph;
      continue;
    }
    for (let offset = 0; offset < paragraph.length; offset += maxLength) {
      chunks.push(paragraph.slice(offset, offset + maxLength));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

function numberedReplyChunks(text, maxLength) {
  const chunks = splitReplyText(text, maxLength);
  return chunks.map((chunk, index) => `${chunks.length > 1 ? `(${index + 1}/${chunks.length}) ` : ""}${chunk}`);
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(1, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressIcon(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("search")) return "🔎";
  if (value.includes("web") || value.includes("http")) return "🌐";
  if (/read|grep|glob|find|list/.test(value)) return "📖";
  if (/edit|write|patch|file_change/.test(value)) return "🛠️";
  if (/bash|command|shell/.test(value)) return "💻";
  return "⚙️";
}

function toolProgressText(name) {
  const label = String(name || "tool").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${progressIcon(label)} 正在执行：${label}\n请稍等…`;
}

function providerModel(provider) {
  return provider === "codex" ? loadCodexModel() : loadClaudeModel();
}

function providerEffort(provider) {
  return provider === "codex" ? loadCodexReasoningEffort() : loadClaudeReasoningEffort();
}

function providerModels(provider) {
  return provider === "codex" ? listCodexModels() : listClaudeModels();
}

function providerEfforts(provider, model) {
  return provider === "codex" ? listCodexReasoningEfforts(model) : listClaudeReasoningEfforts();
}

function runtimeModel(runtime, provider = runtime.provider) {
  return runtime?.models?.[provider] || providerModel(provider);
}

function runtimeEffort(runtime, provider = runtime.provider) {
  return runtime?.efforts?.[provider] || providerEffort(provider);
}

function providerLabel(provider) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function laneSessionRef(lane) {
  return lane?.threadId || lane?.sessionId || "";
}

export function isMissingSessionError(error, provider) {
  if (error?.code === "AGENT_SESSION_NOT_FOUND") return true;
  const message = String(error?.message || error);
  if (provider === "codex") {
    return /(?:thread(?: id)?[^\n]{0,160}(?:not found|does not exist)|(?:failed|unable) to find (?:the )?(?:saved )?thread|no (?:saved )?thread (?:found|exists)|invalid thread id|rollout[^\n]{0,160}not found[^\n]{0,80}thread)/i.test(message);
  }
  if (provider === "claude-code") {
    return /(?:no conversation found with session id|session id[^\n]{0,160}(?:not found|does not exist)|invalid session id)/i.test(message);
  }
  return false;
}

export function isMeaningfulAgentEvent(event) {
  return ["text", "thinking", "tool_use", "tool_result", "question", "approval_request", "diff", "test_result"]
    .includes(event?.type);
}

function friendlyError(error) {
  const code = error?.code || "";
  if (code === "UNSAFE_WORKSPACE") return "这个目录范围过大或属于系统目录，不能作为工作区。";
  if (code === "WORKSPACE_NOT_FOUND") return "工作区目录不存在。";
  if (code === "WORKSPACE_NOT_DIRECTORY") return "该路径不是目录。";
  if (code === "WORKSPACE_NOT_SAVED") return "没有找到这个命名工作区。";
  if (code === "INVALID_WORKSPACE_NAME") return "工作区名称无效。";
  return String(error?.message || error).slice(0, 800);
}

function isPermanentInboundMediaError(error) {
  return /(?:maximum is|exceeds? \d+.*bytes|total bytes|unsupported|no encrypted CDN media descriptor|invalid encrypted media|AES key)/i
    .test(String(error?.message || error));
}

function commandVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return "未安装或不可用";
  return String(result.stdout || result.stderr || "可用").trim().slice(0, 120);
}

function pendingStorePath(accountId) {
  const key = crypto.createHash("sha256").update(String(accountId)).digest("hex").slice(0, 24);
  return path.join(stateDir(), "outbox", `${key}.json`);
}

function durableMessageIdentity(message) {
  const id = String(messageIdentity(message) || "").trim();
  if (id.length <= 256) return id;
  return `sha256:${crypto.createHash("sha256").update(id).digest("hex")}`;
}

function snapshotRuntime(peerId) {
  const runtime = loadPeerRuntime(peerId);
  const snapshot = {
    provider: runtime.provider,
    cwd: runtime.cwd,
    accessMode: runtime.accessMode,
    model: runtimeModel(runtime),
    effort: runtimeEffort(runtime),
  };
  return {
    ...snapshot,
    key: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
}

function createTransport({ baseUrl, token }) {
  return {
    sendText: (args) => sendText({ baseUrl, token, ...args }),
    sendImage: async (args) => {
      const verified = args?.snapshot ? await verifyOutboundSnapshot(args.snapshot) : undefined;
      return sendImage({
        baseUrl,
        token,
        ...args,
        fileBuffer: verified?.contents,
        fileName: verified?.originalName,
      });
    },
    sendFile: async (args) => {
      const verified = args?.snapshot ? await verifyOutboundSnapshot(args.snapshot) : undefined;
      return sendFile({
        baseUrl,
        token,
        ...args,
        fileBuffer: verified?.contents,
        fileName: verified?.originalName,
      });
    },
  };
}

export class WechatAgentBridge {
  constructor({ account, baseUrl = account?.baseUrl || DEFAULT_BASE_URL } = {}) {
    if (!account?.accountId || !account?.token) throw new Error("A logged-in WeChat account is required");
    this.account = account;
    this.baseUrl = baseUrl;
    this.peerScope = crypto.createHash("sha256").update(String(account.accountId)).digest("hex").slice(0, 16);
    this.syncBuf = loadSyncBuf(account.accountId);
    this.stopping = false;
    this.pollAbort = new AbortController();
    this.activeAgents = new Map();
    this.latestContext = new Map();
    this.claimedInbox = new Set();
    this.inbox = new InboxStore(account.accountId);
    this.backoff = new PollBackoff({
      baseMs: envInteger("WECHAT_BRIDGE_POLL_BACKOFF_BASE_MS", 1000, { min: 100 }),
      maxMs: envInteger("WECHAT_BRIDGE_POLL_BACKOFF_MAX_MS", 30_000, { min: 1000 }),
      jitter: 0.2,
    });
    this.sender = new SendScheduler({
      transport: createTransport({ baseUrl, token: account.token }),
      pendingStore: new JsonPendingStore(pendingStorePath(account.accountId)),
      minIntervalMs: envInteger("WECHAT_BRIDGE_SEND_INTERVAL_MS", 2500, { min: 0 }),
      maxRetries: envInteger("WECHAT_BRIDGE_SEND_MAX_RETRIES", 2, { min: 0 }),
      maxPending: envInteger("WECHAT_BRIDGE_SEND_MAX_PENDING", 200, { min: 1 }),
      criticalReserve: envInteger("WECHAT_BRIDGE_SEND_CRITICAL_RESERVE", 512, { min: 1 }),
    });
    this.taskQueue = new PeerTaskQueue({
      debounceMs: envInteger("WECHAT_BRIDGE_INPUT_DEBOUNCE_MS", 650, { min: 0 }),
      maxPendingPerPeer: envInteger("WECHAT_BRIDGE_MAX_PENDING_MESSAGES", 20, { min: 1 }),
      maxConcurrent: envInteger("WECHAT_BRIDGE_MAX_CONCURRENT_AGENTS", 2, { min: 1 }),
      batchKey: (item) => item?.runtimeSnapshot?.key || "legacy",
      handler: (peerId, batch) => this.executeBatch(peerId, batch),
      onError: (error, context) => this.handleQueueError(error, context),
    });
  }

  context(peerId, fallback = {}) {
    return this.latestContext.get(peerId) || fallback;
  }

  statePeerId(peerId) {
    return `${this.peerScope}:${String(peerId || "").trim()}`;
  }

  completeInboxItem(inboxId) {
    if (!inboxId) return true;
    let completed = false;
    try {
      completed = Boolean(this.inbox.mark(inboxId, "done"));
      if (completed) {
        try {
          rememberMessageId(this.account.accountId, inboxId, { maxEntries: 2000 });
        } catch (error) {
          console.warn(`[wechat-bridge] dedupe update failed: ${error?.message || error}`);
        }
      }
      return completed;
    } catch (error) {
      console.error(`[wechat-bridge] durable inbox completion failed: ${error?.message || error}`);
      return false;
    } finally {
      this.claimedInbox.delete(inboxId);
    }
  }

  failInboxItem(inboxId, error) {
    if (!inboxId) return;
    try {
      this.inbox.mark(inboxId, "failed", error?.message || error);
    } catch (markError) {
      console.error(`[wechat-bridge] durable inbox failure update failed: ${markError?.message || markError}`);
    } finally {
      this.claimedInbox.delete(inboxId);
    }
  }

  completeInboxBatch(batch) {
    const inboxIds = (batch || []).map((item) => item?.inboxId).filter(Boolean);
    if (!inboxIds.length) return true;
    let completed = false;
    try {
      this.inbox.markMany(inboxIds, "done");
      completed = true;
      for (const inboxId of inboxIds) {
        try {
          rememberMessageId(this.account.accountId, inboxId, { maxEntries: 2000 });
        } catch {
          // The atomic inbox terminal state remains authoritative.
        }
      }
    } catch (error) {
      console.error(`[wechat-bridge] durable inbox batch completion failed: ${error?.message || error}`);
    } finally {
      for (const inboxId of inboxIds) this.claimedInbox.delete(inboxId);
    }
    return completed;
  }

  failInboxBatch(batch, error) {
    const inboxIds = (batch || []).map((item) => item?.inboxId).filter(Boolean);
    if (!inboxIds.length) return;
    try {
      this.inbox.markMany(inboxIds, "failed", error?.message || error);
    } catch (markError) {
      console.error(`[wechat-bridge] durable inbox batch failure update failed: ${markError?.message || markError}`);
    } finally {
      for (const inboxId of inboxIds) this.claimedInbox.delete(inboxId);
    }
  }

  interruptInboxBatch(batch, reason = "bridge stopped while task was running") {
    const inboxIds = (batch || []).map((item) => item?.inboxId).filter(Boolean);
    try {
      if (inboxIds.length) this.inbox.markMany(inboxIds, "interrupted", reason);
    } catch (error) {
      console.error(`[wechat-bridge] durable inbox interrupt update failed: ${error?.message || error}`);
    } finally {
      for (const inboxId of inboxIds) this.claimedInbox.delete(inboxId);
    }
  }

  takePendingTasks(peerId) {
    const pending = this.taskQueue.pendingItems(peerId);
    const inboxIds = pending.map((item) => item?.inboxId).filter(Boolean);
    try {
      this.inbox.cancelMany(inboxIds);
    } catch (error) {
      // Never allow an explicitly cancelled task to start later in the same
      // process merely because durable state could not be updated.
      const removed = this.taskQueue.takePending(peerId);
      for (const item of removed) this.claimedInbox.delete(item?.inboxId);
      throw error;
    }
    const items = this.taskQueue.takePending(peerId);
    for (const item of items) {
      if (item?.inboxId) {
        this.claimedInbox.delete(item.inboxId);
        try {
          rememberMessageId(this.account.accountId, item.inboxId, { maxEntries: 2000 });
        } catch {
          // The durable cancelled status remains authoritative.
        }
      }
    }
    return items;
  }

  cancelCompletedReplies(peerId, reason = "completed reply cancelled by user") {
    const ids = this.inbox.completed(peerId).map((record) => record.id);
    if (!ids.length) return 0;
    this.inbox.cancelMany(ids, reason);
    for (const inboxId of ids) {
      this.claimedInbox.delete(inboxId);
      try {
        rememberMessageId(this.account.accountId, inboxId, { maxEntries: 2000 });
      } catch {
        // The durable cancelled state is authoritative.
      }
    }
    return ids.length;
  }

  async executeQueuedBatches(peerId, batch) {
    let start = 0;
    while (start < batch.length) {
      const snapshotKey = batch[start]?.runtimeSnapshot?.key || "legacy";
      let end = start + 1;
      while (end < batch.length && (batch[end]?.runtimeSnapshot?.key || "legacy") === snapshotKey) end += 1;
      await this.executeBatch(peerId, batch.slice(start, end));
      start = end;
    }
  }

  async safeSendText(peerId, context, text, {
    durable = true,
    critical = false,
    reservationId = "",
    clientId = "",
    requireAccepted = false,
  } = {}) {
    const effectiveContext = this.context(peerId, context);
    try {
      const result = await this.sender.sendText({
        to: peerId,
        contextToken: effectiveContext?.contextToken,
        runId: effectiveContext?.runId,
        text,
        durable,
        critical,
        reservationId,
        clientId: clientId || undefined,
      });
      return { accepted: true, delivered: true, result };
    } catch (error) {
      const durablyPending = Boolean(
        durable &&
        clientId &&
        this.sender.listPending?.({ userId: peerId })
          .some((record) => record?.payload?.clientId === clientId),
      );
      console.warn(`[wechat-bridge] text queued/not delivered peer=${anonymousPeerId(peerId)}: ${error?.message || error}`);
      safeLog("outbound_deferred", { peer: anonymousPeerId(peerId), kind: "text", code: error?.code || "SEND_ERROR" });
      if (durablyPending) return { accepted: true, delivered: false, error };
      if (requireAccepted) throw error;
      return { accepted: false, delivered: false, error };
    }
  }

  flushOutbox(peerId, context, { replayCompleted = true } = {}) {
    void this.sender.flush({ userId: peerId, contextToken: context.contextToken, runId: context.runId })
      .then(async (result) => {
        if (result.attempted) safeLog("outbox_flushed", { peer: anonymousPeerId(peerId), ...result });
        if (replayCompleted && !this.stopping) {
          for (const record of this.inbox.completed(peerId)) {
            if (this.claimedInbox.has(record.id)) continue;
            await this.handleMessage(record.message, {
              replay: true,
              deliveryContext: context,
            });
          }
        }
      })
      .catch((error) => console.warn(`[wechat-bridge] pending flush failed: ${error?.message || error}`));
  }

  async sendReplyChunks(peerId, context, text, {
    shouldStop,
    critical = false,
    reservationId = "",
    clientIdPrefix = "",
    requireAccepted = false,
  } = {}) {
    const chunks = numberedReplyChunks(
      text,
      envInteger("WECHAT_BRIDGE_REPLY_CHUNK_LENGTH", DEFAULT_REPLY_CHUNK_LENGTH, { min: 200 }),
    );
    for (let index = 0; index < chunks.length; index += 1) {
      if (shouldStop?.()) return;
      await this.safeSendText(peerId, context, chunks[index], {
        critical,
        reservationId,
        clientId: clientIdPrefix ? `${clientIdPrefix}-${index}` : "",
        requireAccepted,
      });
    }
  }

  async deliverStoredCompletion(peerId, inboxId, context, completion, {
    reservationId = "",
    shouldStop,
  } = {}) {
    if (!completion?.id || !Array.isArray(completion.chunks)) {
      const error = new Error("durable completed reply is invalid");
      error.code = "INBOX_COMPLETION_INVALID";
      throw error;
    }
    let next = Number.isSafeInteger(completion.nextChunkIndex) ? completion.nextChunkIndex : 0;
    for (; next < completion.chunks.length; next += 1) {
      if (shouldStop?.()) return false;
      await this.safeSendText(peerId, context, completion.chunks[next], {
        durable: true,
        critical: true,
        reservationId,
        clientId: `wechat-agent-result-${completion.id}-${next}`,
        requireAccepted: true,
      });
      this.inbox.advanceCompletion(inboxId, next + 1);
    }
    return this.completeInboxItem(inboxId);
  }

  async safeSendArtifact(peerId, context, artifact) {
    const effectiveContext = this.context(peerId, context);
    const clientId = `wechat-agent-artifact-${artifact.id}`;
    try {
      const sendArgs = {
        to: peerId,
        contextToken: effectiveContext?.contextToken,
        runId: effectiveContext?.runId,
        filePath: artifact.path,
        clientId,
        snapshot: {
          version: artifact.version,
          id: artifact.id,
          path: artifact.path,
          filePath: artifact.filePath || artifact.path,
          manifestPath: artifact.manifestPath,
          originalName: artifact.originalName,
          name: artifact.originalName,
          size: artifact.size,
          sha256: artifact.sha256,
          kind: artifact.kind,
          createdAt: artifact.createdAt,
          payload: artifact.payload,
        },
      };
      return artifact.kind === "image"
        ? await this.sender.sendImage(sendArgs)
        : await this.sender.sendFile(sendArgs);
    } catch (error) {
      const durablyPending = this.sender.listPending?.({ userId: peerId })
        .some((record) => record?.payload?.clientId === clientId);
      if (!durablyPending) {
        await cleanupOutboundSnapshot(artifact.path).catch(() => {});
      }
      console.warn(`[wechat-bridge] artifact queued/not delivered peer=${anonymousPeerId(peerId)}: ${error?.message || error}`);
      safeLog("outbound_deferred", { peer: anonymousPeerId(peerId), kind: artifact.kind, code: error?.code || "SEND_ERROR" });
      if (durablyPending) return { queued: true, delivered: false };
      throw error;
    }
  }

  async startFeedback(peerId, context) {
    let typingTicket = "";
    try {
      const config = await getConfig({
        baseUrl: this.baseUrl,
        token: this.account.token,
        to: peerId,
        contextToken: context?.contextToken,
        signal: this.pollAbort.signal,
      });
      typingTicket = config.typing_ticket || "";
      await sendTyping({ baseUrl: this.baseUrl, token: this.account.token, to: peerId, typingTicket, status: 1, signal: this.pollAbort.signal });
    } catch (error) {
      console.warn(`[wechat-bridge] typing start failed: ${error?.message || error}`);
    }

    const heartbeatMs = envInteger("WECHAT_BRIDGE_TYPING_HEARTBEAT_MS", 15_000, { min: 0 });
    const heartbeat = typingTicket && heartbeatMs
      ? setInterval(() => {
          sendTyping({
            baseUrl: this.baseUrl,
            token: this.account.token,
            to: peerId,
            typingTicket,
            status: 1,
            signal: this.pollAbort.signal,
          }).catch((error) => console.warn(`[wechat-bridge] typing heartbeat failed: ${error?.message || error}`));
        }, heartbeatMs)
      : undefined;

    return async () => {
      if (heartbeat) clearInterval(heartbeat);
      try {
        await sendTyping({
          baseUrl: this.baseUrl,
          token: this.account.token,
          to: peerId,
          typingTicket,
          status: 2,
          signal: this.pollAbort.signal,
        });
      } catch (error) {
        console.warn(`[wechat-bridge] typing stop failed: ${error?.message || error}`);
      }
    };
  }

  createProgressRelay({
    peerId,
    context,
    provider,
    identity,
    runKey,
    taskId,
    notificationMode = "normal",
    markOutput,
    markMeaningfulActivity,
    shouldSaveSession,
  }) {
    const pending = [];
    const minIntervalMs = envInteger(
      "WECHAT_BRIDGE_STREAM_PROGRESS_MIN_INTERVAL_MS",
      notificationMode === "verbose" ? 5000 : 15_000,
      { min: 500 },
    );
    const maxItems = envInteger("WECHAT_BRIDGE_STREAM_PROGRESS_MAX_ITEMS", 3, { min: 1 });
    const seenInteractions = new Set();
    let lastSentAt = 0;
    let timer;
    let closed = false;
    let savedSessionRef = laneSessionRef(loadAgentLane(identity));

    const flush = async () => {
      timer = undefined;
      if (closed || !pending.length) return;
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastSentAt));
      if (waitMs) {
        timer = setTimeout(() => void flush(), waitMs);
        return;
      }
      const unique = [...new Set(pending.splice(0))].slice(-maxItems);
      if (!unique.length) return;
      lastSentAt = Date.now();
      await this.safeSendText(peerId, context, unique.join("\n"), { durable: false });
    };

    const onEvent = (event) => {
      if (closed) return;
      markOutput?.();
      if (isMeaningfulAgentEvent(event)) markMeaningfulActivity?.(event);
      safeLog("agent_event", {
        peer: anonymousPeerId(peerId),
        provider,
        runKey,
        eventType: event?.type || "unknown",
        name: event?.name || "",
        status: event?.status || "",
      });
      const sessionRef = String(event?.sessionRef || "").trim();
      if (sessionRef && sessionRef !== savedSessionRef && shouldSaveSession?.() !== false) {
        saveAgentLaneSession(identity, sessionRef, { source: "stream", runKey });
        savedSessionRef = sessionRef;
      }
      if (["question", "approval_request"].includes(event?.type)) {
        const interactionKey = `${event.type}:${event.id || event.question || event.message || "unknown"}`;
        if (!seenInteractions.has(interactionKey)) {
          seenInteractions.add(interactionKey);
          const message = formatInteractionNotification(event, providerLabel(provider));
          if (message) {
            void this.safeSendText(
              peerId,
              context,
              `${taskId ? `任务 ${taskId}\n` : ""}${message}`,
              { durable: true },
            );
          }
        }
      }
      if (event?.type === "tool_use" && shouldRelayToolProgress(notificationMode)) {
        pending.push(toolProgressText(event.name));
        if (!timer) timer = setTimeout(() => void flush(), 0);
      }
    };

    return {
      onEvent,
      onOutput: () => markOutput?.(),
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        pending.length = 0;
      },
    };
  }

  async executeBatch(peerId, batch) {
    const context = batch.at(-1)?.context || this.context(peerId);
    const text = batch.map((item) => item.text).filter(Boolean).join("\n\n").trim() || "请查看我发送的附件。";
    const attachments = batch.flatMap((item) => item.attachments || []);
    const statePeerId = batch[0]?.statePeerId || this.statePeerId(peerId);
    const runtime = batch[0]?.runtimeSnapshot || snapshotRuntime(statePeerId);
    const identity = agentLaneIdentity({
      peerId: statePeerId,
      provider: runtime.provider,
      cwd: runtime.cwd,
      accessMode: runtime.accessMode,
    });
    let lane = loadAgentLane(identity);
    let sessionRef = laneSessionRef(lane);
    const provider = runtime.provider;
    const runKey = crypto.randomUUID();
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const taskState = {
      task: null,
      relay: null,
      identity,
      provider,
      stopRequested: false,
      shutdownRequested: false,
      suppressSessionSave: false,
    };
    const batchInboxIds = batch.map((item) => item?.inboxId).filter(Boolean);
    const taskId = taskPublicId(batchInboxIds[0] || runKey);
    const notificationMode = normalizeNotificationMode(loadPeerRuntime(statePeerId).notificationMode);
    if (batchInboxIds.length) this.inbox.markMany(batchInboxIds, "running");
    this.activeAgents.set(peerId, taskState);
    let stopFeedback;
    let relay;
    let progressTimer;
    let inboxFailure;
    let agentCompleted = false;
    let meaningfulAgentActivity = false;
    let completionPersisted = false;
    let completionDelivered = false;
    let completionInboxId = "";
    let finalReplyReservation;
    const replyChunkLength = envInteger(
      "WECHAT_BRIDGE_REPLY_CHUNK_LENGTH",
      DEFAULT_REPLY_CHUNK_LENGTH,
      { min: 200 },
    );
    try {
      if (typeof this.sender.reserveCritical === "function") {
        const maximumReplyChunks = Math.ceil(MAX_AGENT_REPLY_CHARS / replyChunkLength) + 1;
        finalReplyReservation = await this.sender.reserveCritical(maximumReplyChunks);
      }
      stopFeedback = await this.startFeedback(peerId, context);
      if (taskState.stopRequested || this.stopping) return;

      relay = this.createProgressRelay({
        peerId,
        context,
        provider,
        identity,
        runKey,
        taskId,
        notificationMode,
        markOutput: () => { lastOutputAt = Date.now(); },
        markMeaningfulActivity: () => { meaningfulAgentActivity = true; },
        shouldSaveSession: () => !taskState.suppressSessionSave,
      });
      taskState.relay = relay;
      const progressIntervalMs = progressHeartbeatMs(
        notificationMode,
        process.env.WECHAT_BRIDGE_PROGRESS_INTERVAL_MS,
      );
      progressTimer = progressIntervalMs
        ? setInterval(() => {
            const elapsed = formatElapsed(Date.now() - startedAt);
            const idle = formatElapsed(Date.now() - lastOutputAt);
            void this.safeSendText(
              peerId,
              context,
              `任务 ${taskId} 进行中，已运行 ${elapsed}。最近 ${idle} 内有执行活动。发送 /stop 可以结束当前任务。`,
              { durable: false },
            );
          }, progressIntervalMs)
        : undefined;

      safeLog("run_started", {
        peer: anonymousPeerId(peerId),
        provider,
        runKey,
        laneKey: identity.key,
        resumed: Boolean(sessionRef),
        accessMode: runtime.accessMode,
        cwd: runtime.cwd,
        attachmentCount: attachments.length,
      });

      const startTask = (ref = "") => (provider === "claude-code" ? startClaudeCode : startAgent)({
        peerId: statePeerId,
        text,
        cwd: runtime.cwd,
        accessMode: runtime.accessMode,
        model: runtime.model,
        effort: runtime.effort,
        sessionRef: ref,
        attachments,
        onEvent: relay.onEvent,
        onOutput: relay.onOutput,
      });

      let task = startTask(sessionRef);
      taskState.task = task;
      let result;
      try {
        result = await task.resultPromise;
      } catch (error) {
        if (
          sessionRef &&
          !meaningfulAgentActivity &&
          isMissingSessionError(error, provider) &&
          !taskState.stopRequested &&
          !taskState.shutdownRequested &&
          !taskState.suppressSessionSave
        ) {
          clearAgentLane(identity, { archive: true, reason: "resume failed" });
          sessionRef = "";
          lane = null;
          task = startTask("");
          taskState.task = task;
          result = await task.resultPromise;
        } else {
          throw error;
        }
      }

      let artifacts = [];
      try {
        artifacts = discoverArtifacts(runtime.cwd, { sinceMs: startedAt - 250 });
        saveRecentArtifacts(statePeerId, runtime.cwd, artifacts, {
          provider,
          laneKey: identity.key,
          runStartedAt: new Date(startedAt).toISOString(),
        });
      } catch (artifactError) {
        console.warn(`[wechat-bridge] artifact discovery failed: ${artifactError?.message || artifactError}`);
      }
      const receipt = completionReceipt({
        taskId,
        provider: providerLabel(provider),
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        artifactCount: artifacts.length,
      });
      const replyWithReceipt = notificationMode === "quiet"
        ? result.reply
        : `${result.reply}\n\n${receipt}`;
      const completedChunks = numberedReplyChunks(replyWithReceipt, replyChunkLength);
      if (batchInboxIds.length) {
        const completedRecord = this.inbox.saveCompletion(batchInboxIds, {
          id: runKey,
          chunks: completedChunks,
          createdAt: Date.now(),
        });
        completionPersisted = true;
        completionInboxId = completedRecord.id;
        // saveCompletion atomically makes the merged follower records terminal;
        // only the first record owns the pending reply.
        for (const inboxId of batchInboxIds.slice(1)) {
          this.claimedInbox.delete(inboxId);
          try {
            rememberMessageId(this.account.accountId, inboxId, { maxEntries: 2000 });
          } catch {
            // The durable done state is authoritative.
          }
        }
      }
      agentCompleted = true;
      if (result.sessionRef && !taskState.suppressSessionSave) {
        saveAgentLaneSession(identity, result.sessionRef, {
          model: runtime.model,
          effort: runtime.effort,
          runKey,
        });
      }
      if (!lane) clearHistory(statePeerId);
      if (completionPersisted) {
        completionDelivered = await this.deliverStoredCompletion(
          peerId,
          completionInboxId,
          context,
          this.inbox.get(completionInboxId).completion,
          {
            reservationId: finalReplyReservation?.id || "",
            // A process shutdown must first admit the completed result to the
            // durable outbox. Only an explicit user stop suppresses it.
            shouldStop: () => taskState.stopRequested,
          },
        );
      } else {
        await this.sendReplyChunks(peerId, context, replyWithReceipt, {
          shouldStop: () => taskState.stopRequested,
          critical: true,
          reservationId: finalReplyReservation?.id || "",
          clientIdPrefix: `wechat-agent-result-${runKey}`,
          requireAccepted: true,
        });
        completionDelivered = true;
      }
      safeLog("run_completed", {
        peer: anonymousPeerId(peerId),
        provider,
        runKey,
        laneKey: identity.key,
        durationMs: Date.now() - startedAt,
        artifactCount: artifacts.length,
        usage: result.usage || undefined,
      });
    } catch (error) {
      if (isAgentStoppedError(error) || taskState.stopRequested) {
        safeLog("run_stopped", { peer: anonymousPeerId(peerId), provider, runKey, durationMs: Date.now() - startedAt });
      } else if (agentCompleted) {
        console.error(`[wechat-bridge] post-processing failed after ${provider} completed: ${error?.stack || error}`);
        safeLog("run_postprocess_failed", {
          peer: anonymousPeerId(peerId),
          provider,
          runKey,
          code: error?.code || "POSTPROCESS_ERROR",
        });
        await this.safeSendText(peerId, context, `Agent 已完成，但结果整理或发送阶段遇到问题：${friendlyError(error)}`);
      } else {
        inboxFailure = error;
        console.error(`[wechat-bridge] ${provider} failed peer=${anonymousPeerId(peerId)}: ${error?.stack || error}`);
        safeLog("run_failed", {
          peer: anonymousPeerId(peerId),
          provider,
          runKey,
          durationMs: Date.now() - startedAt,
          code: error?.code || "AGENT_ERROR",
          message: String(error?.message || error).slice(0, 500),
        });
        await this.sendReplyChunks(peerId, context, `${providerLabel(provider)} 调用失败：${friendlyError(error)}`);
      }
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      relay?.close();
      finalReplyReservation?.release();
      if (this.activeAgents.get(peerId) === taskState) this.activeAgents.delete(peerId);
      if (stopFeedback) await stopFeedback();
      if (completionPersisted) {
        // The owner stays `completed` until every reply chunk has either been
        // delivered or durably accepted by the outbox. Never rerun its Agent.
        if (taskState.stopRequested && this.inbox.get(completionInboxId)?.status === "completed") {
          try {
            this.inbox.cancelMany([completionInboxId], "completed reply cancelled by user stop/reset");
            rememberMessageId(this.account.accountId, completionInboxId, { maxEntries: 2000 });
          } catch (error) {
            console.error(`[wechat-bridge] completed reply cancellation failed: ${error?.message || error}`);
          }
        }
        for (const inboxId of batchInboxIds) this.claimedInbox.delete(inboxId);
      }
      else if (agentCompleted && completionDelivered) this.completeInboxBatch(batch);
      else if (this.stopping) this.interruptInboxBatch(batch);
      else if (inboxFailure) {
        this.failInboxBatch(batch, inboxFailure);
      }
      else this.completeInboxBatch(batch);
    }
  }

  async handleQueueError(error, { peerId, batch }) {
    console.error(`[wechat-bridge] queue failed peer=${anonymousPeerId(peerId)}: ${error?.stack || error}`);
    safeLog("queue_failed", { peer: anonymousPeerId(peerId), code: error?.code || "QUEUE_ERROR" });
    await this.sendReplyChunks(peerId, batch.at(-1)?.context || this.context(peerId), `任务队列执行失败，已保留任务；发送 /retry 可重试：${friendlyError(error)}`);
    this.failInboxBatch(batch, error);
  }

  async resetCurrentLane(peerId, context, { message = "已开启新会话。" } = {}) {
    const active = this.activeAgents.get(peerId);
    if (active) {
      active.stopRequested = true;
      active.suppressSessionSave = true;
      active.relay?.close();
      active.task?.cancel();
    }
    this.takePendingTasks(peerId);
    const cancelledReplies = this.cancelCompletedReplies(peerId, "completed reply cancelled by /new");
    const statePeerId = this.statePeerId(peerId);
    const runtime = loadPeerRuntime(statePeerId);
    const currentIdentity = agentLaneIdentity({ peerId: statePeerId, ...runtime });
    clearAgentLane(currentIdentity, { archive: true, reason: "user started a new session" });
    clearHistory(statePeerId);
    clearRecentArtifacts(statePeerId);
    const suffix = cancelledReplies ? ` 已取消 ${cancelledReplies} 条尚未接纳的完成回复。` : "";
    await this.safeSendText(peerId, context, `${active ? `已中止当前任务，${message}` : message}${suffix}`);
  }

  async handleCommand(peerId, context, command) {
    const statePeerId = this.statePeerId(peerId);
    if (command.name === "help") {
      await this.sendReplyChunks(peerId, context, commandHelpText());
      return;
    }

    if (command.name === "stop") {
      const active = this.activeAgents.get(peerId);
      if (active) {
        active.stopRequested = true;
        active.task?.cancel();
      }
      const cleared = this.takePendingTasks(peerId).length;
      const cancelledReplies = this.cancelCompletedReplies(peerId, "completed reply cancelled by /stop");
      if (active) {
        await this.safeSendText(
          peerId,
          context,
          `${cleared ? `已停止当前任务，并清除 ${cleared} 条排队消息。` : "已停止当前任务。"}${cancelledReplies ? ` 已取消 ${cancelledReplies} 条尚未接纳的完成回复。` : ""}`,
        );
      } else if (cleared) {
        await this.safeSendText(peerId, context, `已清除 ${cleared} 条排队消息。${cancelledReplies ? ` 已取消 ${cancelledReplies} 条尚未接纳的完成回复。` : ""}`);
      } else if (cancelledReplies) {
        await this.safeSendText(peerId, context, `已取消 ${cancelledReplies} 条尚未接纳的完成回复。`);
      } else {
        await this.safeSendText(peerId, context, "当前没有正在执行或排队的任务。");
      }
      return;
    }

    if (command.name === "new" || command.name === "reset") {
      await this.resetCurrentLane(peerId, context);
      return;
    }

    if (command.name === "codex" || command.name === "claude-code") {
      savePeerAgentProvider(statePeerId, command.name);
      const runtime = loadPeerRuntime(statePeerId);
      const lane = loadAgentLane(agentLaneIdentity({ peerId: statePeerId, ...runtime }));
      await this.safeSendText(
        peerId,
        context,
        `已切换到 ${providerLabel(command.name)}。${laneSessionRef(lane) ? "将继续这个 Agent 的原会话。" : "下一条消息会创建新会话。"}`,
      );
      return;
    }

    const runtime = loadPeerRuntime(statePeerId);
    if (command.name === "status") {
      const identity = agentLaneIdentity({ peerId: statePeerId, ...runtime });
      const lane = loadAgentLane(identity);
      const queueStatus = this.taskQueue.status(peerId);
      const artifacts = loadRecentArtifacts(statePeerId, runtime.cwd);
      await this.sendReplyChunks(peerId, context, [
        `当前后端：${providerLabel(runtime.provider)}`,
        `当前模型：${runtimeModel(runtime)}`,
        `思考级别：${runtimeEffort(runtime)}`,
        `当前权限：${accessModeLabel(runtime.accessMode)}`,
        `通知模式：${notificationModeLabel(runtime.notificationMode)}`,
        `工作区：${runtime.cwd}`,
        `Agent Lane：${laneSessionRef(lane) ? `已连接（${maskValue(laneSessionRef(lane))}）` : "待创建"}`,
        `任务队列：${queueStatus.active ? "执行中" : "空闲"}，等待 ${queueStatus.pending} 条`,
        `可重试中断：${this.inbox.recoverable(peerId).length} 条`,
        `待接纳完成回复：${this.inbox.completed(peerId).length} 条`,
        `待补发消息：${this.sender.listPending({ userId: peerId }).length}`,
        `最近产物：${artifacts.length} 个`,
      ].join("\n"));
      return;
    }

    if (command.name === "model") {
      const current = runtimeModel(runtime);
      const available = providerModels(runtime.provider);
      if (!command.argument) {
        await this.sendReplyChunks(
          peerId,
          context,
          `当前模型：${current}\n可选模型：${available.join("、")}\n切换示例：/model ${available[0] || current}`,
        );
        return;
      }
      if (runtime.provider === "codex" && !available.includes(command.argument)) {
        await this.sendReplyChunks(peerId, context, `不支持的模型：${command.argument}\n可选模型：${available.join("、")}`);
        return;
      }
      savePeerModel(statePeerId, runtime.provider, command.argument);
      await this.safeSendText(peerId, context, `已切换 ${providerLabel(runtime.provider)} 模型：${command.argument}`);
      return;
    }

    if (command.name === "think") {
      const current = runtimeEffort(runtime);
      const available = providerEfforts(runtime.provider, runtimeModel(runtime));
      const effort = command.argument.toLowerCase();
      if (!effort) {
        await this.safeSendText(
          peerId,
          context,
          `当前思考级别：${current}\n可选级别：${available.join("、")}\n切换示例：/think high`,
        );
        return;
      }
      if (!available.includes(effort)) {
        await this.safeSendText(peerId, context, `不支持的思考级别：${effort}\n可选级别：${available.join("、")}`);
        return;
      }
      savePeerReasoningEffort(statePeerId, runtime.provider, effort);
      await this.safeSendText(peerId, context, `已切换 ${providerLabel(runtime.provider)} 思考级别：${effort}`);
      return;
    }

    if (["notify", "watch", "mute"].includes(command.name)) {
      const requested = command.name === "watch" ? "verbose" : command.name === "mute" ? "quiet" : command.argument;
      if (!requested) {
        await this.safeSendText(
          peerId,
          context,
          `当前通知：${notificationModeLabel(runtime.notificationMode)}\n可选：quiet、normal、verbose\n示例：/notify normal`,
        );
        return;
      }
      if (!["quiet", "normal", "verbose"].includes(requested.toLowerCase())) {
        await this.safeSendText(peerId, context, "不支持的通知模式。可选：quiet、normal、verbose");
        return;
      }
      const saved = savePeerNotificationMode(statePeerId, requested);
      await this.safeSendText(peerId, context, `已切换通知模式：${notificationModeLabel(saved.notificationMode)}`);
      return;
    }

    if (command.name === "queue") {
      const status = this.taskQueue.status(peerId);
      const outbound = this.sender.listPending({ userId: peerId });
      const recoverable = this.inbox.recoverable(peerId);
      const completed = this.inbox.completed(peerId);
      await this.safeSendText(
        peerId,
        context,
        `任务：${status.active ? "执行中" : "空闲"}\n等待消息：${status.pending} 条\n异常中断：${recoverable.length} 条\n待接纳完成回复：${completed.length} 条\n待补发消息：${outbound.length} 条`,
      );
      return;
    }

    if (command.name === "tasks") {
      await this.sendReplyChunks(peerId, context, formatTaskList(this.inbox.list(peerId)));
      return;
    }

    if (command.name === "task") {
      if (!command.argument) {
        await this.sendReplyChunks(peerId, context, "用法：/task <编号>\n先发送 /tasks 查看最近任务编号。");
        return;
      }
      const record = findTaskByPublicId(this.inbox.list(peerId), command.argument);
      await this.sendReplyChunks(peerId, context, formatTaskDetail(record));
      return;
    }

    if (command.name === "sessions") {
      await this.sendReplyChunks(
        peerId,
        context,
        formatSessionList(listAgentLanes({ peerId: statePeerId })),
      );
      return;
    }

    if (command.name === "resume-command") {
      const identity = agentLaneIdentity({ peerId: statePeerId, ...runtime });
      const lane = loadAgentLane(identity);
      const commandText = nativeResumeCommand(lane);
      if (!nativeLaneSessionRef(lane) || !commandText) {
        await this.safeSendText(peerId, context, "当前 Lane 还没有可恢复的原生会话。先发送一个任务，Agent 返回 session 后再试。");
        return;
      }
      await this.sendReplyChunks(
        peerId,
        context,
        `在当前项目的终端执行：\n\n${commandText}\n\n该命令会直接连接原生 Agent 会话；终端和微信不要同时向同一会话发送任务。`,
      );
      return;
    }

    if (command.name === "retry") {
      // v0.3 inbox records did not persist whether a message was a control
      // command. Classify those legacy records before offering retries so a
      // crashed /stop or /new can never be replayed as an action.
      for (const record of this.inbox.recoverable(peerId)) {
        if (record.kind !== "unknown") continue;
        const preview = extractInboundContent(record.message);
        const legacyCommand = preview.attachments.length === 0 ? parseBridgeCommand(preview.text) : null;
        if (legacyCommand) {
          this.inbox.classify(record.id, "command");
          this.inbox.mark(record.id, "cancelled", "legacy control command requires explicit resend");
        } else {
          const legacyStatePeerId = this.statePeerId(peerId);
          this.inbox.classify(record.id, "work", {
            runtimeSnapshot: record.runtimeSnapshot || snapshotRuntime(legacyStatePeerId),
            statePeerId: record.statePeerId || legacyStatePeerId,
          });
        }
      }
      const recoverable = this.inbox.recoverable(peerId);
      if (!recoverable.length) {
        await this.safeSendText(peerId, context, "没有需要重试的异常中断任务。");
        return;
      }
      let accepted = 0;
      for (const record of recoverable) {
        try {
          await this.handleMessage(record.message, {
            replay: true,
            explicitRetry: true,
            retryStatus: record.status,
            deliveryContext: context,
          });
          accepted += 1;
        } catch (error) {
          if (error?.code === "INBOUND_QUEUE_FULL") break;
          console.warn(`[wechat-bridge] explicit retry failed: ${error?.message || error}`);
        }
      }
      await this.safeSendText(peerId, context, `已重新提交 ${accepted} 条任务。${accepted < recoverable.length ? "其余任务仍保留，可稍后再次 /retry。" : ""}`);
      return;
    }

    if (command.name === "pwd") {
      await this.safeSendText(peerId, context, `当前工作区：\n${runtime.cwd}`);
      return;
    }

    if (command.name === "cd") {
      if (!command.argument) {
        await this.safeSendText(peerId, context, `当前工作区：\n${runtime.cwd}\n切换示例：/cd /path/to/project`);
        return;
      }
      try {
        const args = splitCommandArguments(command.argument);
        const requested = args.join(" ");
        const cwd = resolveWorkspacePath(requested, { baseDir: runtime.cwd });
        savePeerWorkspace(statePeerId, cwd);
        await this.safeSendText(peerId, context, `已切换工作区：\n${cwd}\n下一条消息会使用对应的 Agent Lane。`);
      } catch (error) {
        await this.safeSendText(peerId, context, `切换失败：${friendlyError(error)}`);
      }
      return;
    }

    if (command.name === "ws") {
      let args;
      try {
        args = splitCommandArguments(command.argument);
      } catch (error) {
        await this.safeSendText(peerId, context, friendlyError(error));
        return;
      }
      const action = (args.shift() || "list").toLowerCase();
      if (action === "list") {
        const entries = listWorkspaces();
        const lines = entries.map((entry, index) => `${index + 1}. ${entry.name}\n   ${entry.path}`);
        await this.sendReplyChunks(
          peerId,
          context,
          lines.length ? `命名工作区：\n${lines.join("\n")}` : "还没有命名工作区。使用 /ws save <name> [path] 保存。",
        );
        return;
      }
      if (action === "save") {
        const name = args.shift();
        if (!name) {
          await this.safeSendText(peerId, context, "用法：/ws save <name> [path]");
          return;
        }
        try {
          const cwd = args.length ? resolveWorkspacePath(args.join(" "), { baseDir: runtime.cwd }) : runtime.cwd;
          const entry = saveWorkspace(name, cwd);
          await this.safeSendText(peerId, context, `已保存工作区 ${entry.name}：\n${entry.path}`);
        } catch (error) {
          await this.safeSendText(peerId, context, `保存失败：${friendlyError(error)}`);
        }
        return;
      }
      if (action === "use") {
        const name = args.join(" ");
        const entry = listWorkspaces().find((item) => item.name === name);
        if (!entry) {
          await this.safeSendText(peerId, context, `没有找到工作区：${name || "<空>"}`);
          return;
        }
        try {
          const cwd = resolveWorkspacePath(entry.path);
          savePeerWorkspace(statePeerId, cwd);
          await this.safeSendText(peerId, context, `已使用工作区 ${entry.name}：\n${cwd}`);
        } catch (error) {
          await this.safeSendText(peerId, context, `使用失败：${friendlyError(error)}`);
        }
        return;
      }
      if (action === "remove" || action === "delete") {
        const name = args.join(" ");
        const removed = name ? removeWorkspace(name) : false;
        await this.safeSendText(peerId, context, removed ? `已移除命名工作区：${name}` : `没有找到工作区：${name || "<空>"}`);
        return;
      }
      await this.safeSendText(peerId, context, "用法：/ws list | /ws save <name> [path] | /ws use <name> | /ws remove <name>");
      return;
    }

    if (command.name === "access") {
      if (!command.argument) {
        await this.safeSendText(
          peerId,
          context,
          `当前权限：${accessModeLabel(runtime.accessMode)}\n可选：read-only、workspace、full\n切换示例：/access workspace\n提示：Claude Code 的 workspace 模式使用 acceptEdits，并不是操作系统级沙箱。`,
        );
        return;
      }
      const mode = normalizeCommandAccessMode(command.argument);
      if (!mode) {
        await this.safeSendText(peerId, context, "不支持的权限。可选：read-only、workspace、full");
        return;
      }
      savePeerAccessMode(statePeerId, mode);
      await this.safeSendText(
        peerId,
        context,
        `已切换权限：${accessModeLabel(mode)}。下一条消息会进入对应的 Agent Lane。${mode === "full" ? "\n⚠️ 完全权限允许 Agent 访问工作区之外的本机资源。" : ""}`,
      );
      return;
    }

    if (command.name === "artifacts") {
      const artifacts = loadRecentArtifacts(statePeerId, runtime.cwd);
      if (!artifacts.length) {
        await this.safeSendText(peerId, context, "当前工作区没有记录到最近产物。Agent 完成任务后可再次查看。");
        return;
      }
      await this.sendReplyChunks(
        peerId,
        context,
        ["最近产物（使用 /send 编号发送）：", ...artifacts.map((item, index) => `${index + 1}. ${item.relativePath} (${formatBytes(item.size)})`)].join("\n"),
      );
      return;
    }

    if (command.name === "send") {
      if (!command.argument) {
        await this.safeSendText(peerId, context, "用法：/send <产物编号|工作区内相对路径>");
        return;
      }
      try {
        const artifacts = loadRecentArtifacts(statePeerId, runtime.cwd);
        const index = /^\d+$/.test(command.argument) ? Number.parseInt(command.argument, 10) - 1 : -1;
        const requested = index >= 0
          ? artifacts[index]
          : resolveArtifactFile(runtime.cwd, splitCommandArguments(command.argument).join(" "));
        if (!requested) throw new Error("没有这个产物编号");
        const staged = await stageOutboundArtifact(requested, { workspace: runtime.cwd });
        await this.safeSendArtifact(peerId, context, staged);
      } catch (error) {
        await this.safeSendText(peerId, context, `发送失败：${friendlyError(error)}`, { critical: true });
      }
      return;
    }

    if (command.name === "doctor") {
      const lane = loadAgentLane(agentLaneIdentity({ peerId: statePeerId, ...runtime }));
      await this.sendReplyChunks(peerId, context, [
        `微信桥 ${VERSION} 诊断：`,
        `Codex：${commandVersion("codex")}`,
        `Claude Code：${commandVersion("claude")}`,
        `账号：${maskValue(this.account.accountId)}`,
        `状态目录：${stateDir()}`,
        `当前 Lane：${laneSessionRef(lane) ? "可恢复" : "待创建"}`,
        `待补发：${this.sender.pendingCount} 条`,
      ].join("\n"));
    }
  }

  async handleMessage(message, {
    replay = false,
    explicitRetry = false,
    retryStatus = "",
    deliveryContext,
  } = {}) {
    if (message?.message_type !== MESSAGE_TYPE.USER) return;
    const peerId = String(message.from_user_id || "").trim();
    if (!peerId || !allowedSender(this.account, peerId)) {
      console.log(`[wechat-bridge] ignored unauthorized sender=${anonymousPeerId(peerId)}`);
      if (replay) this.completeInboxItem(durableMessageIdentity(message));
      return;
    }

    const id = durableMessageIdentity(message);
    let inboxRecord = this.inbox.get(id);
    if (["done", "cancelled"].includes(inboxRecord?.status) || hasSeenMessageId(this.account.accountId, id)) {
      if (inboxRecord && !["done", "cancelled"].includes(inboxRecord.status)) this.completeInboxItem(id);
      console.log(`[wechat-bridge] ignored duplicate message=${id.slice(0, 12)}`);
      return;
    }
    if (["failed", "interrupted"].includes(inboxRecord?.status) && !explicitRetry) {
      console.log(`[wechat-bridge] retained recoverable message=${id.slice(0, 12)} for explicit /retry`);
      return;
    }
    if (this.claimedInbox.has(id)) return;
    if (!inboxRecord) inboxRecord = this.inbox.receive(id, message).record;
    this.claimedInbox.add(id);
    let commandMessage = false;
    let completedReplyMessage = inboxRecord.status === "completed";

    try {
      const persistedTask = inboxRecord?.task;
      const context = deliveryContext || persistedTask?.context || {
        contextToken: message.context_token || "",
        runId: message.run_id || "",
      };
      this.latestContext.set(peerId, context);

      if (inboxRecord.status === "completed" && inboxRecord.completion) {
        this.flushOutbox(peerId, context, { replayCompleted: false });
        const remaining = Math.max(
          1,
          inboxRecord.completion.chunks.length - (inboxRecord.completion.nextChunkIndex || 0),
        );
        const reservation = typeof this.sender.reserveCritical === "function"
          ? await this.sender.reserveCritical(remaining)
          : undefined;
        try {
          await this.deliverStoredCompletion(peerId, id, context, inboxRecord.completion, {
            reservationId: reservation?.id || "",
          });
        } finally {
          reservation?.release();
        }
        return;
      }

      if (persistedTask) {
        this.flushOutbox(peerId, context);
        const before = this.taskQueue.status(peerId);
        const replayTask = { ...persistedTask, context, inboxId: id };
        this.inbox.queue(id, replayTask);
        const queued = this.taskQueue.enqueue(peerId, replayTask);
        if (!queued.accepted) {
          const error = new Error("inbound task queue is full during durable replay");
          error.code = "INBOUND_QUEUE_FULL";
          if (replay) throw error;
          await this.safeSendText(peerId, context, "等待消息已经达到上限，请发送 /stop 清理队列后再试。");
          this.failInboxItem(id, error);
          return;
        }
        safeLog("message_replayed", {
          peer: anonymousPeerId(peerId),
          pending: queued.pending,
          active: queued.active,
        });
        if (before.active && !replay) {
          await this.safeSendText(
            peerId,
            context,
            `已加入下一轮，当前等待 ${queued.pending} 条消息。发送 /queue 可查看队列。`,
            { durable: false },
          );
        }
        return;
      }

      const preview = extractInboundContent(message);
      const command = preview.attachments.length === 0 ? parseBridgeCommand(preview.text) : null;
      if (command) {
        commandMessage = true;
        inboxRecord = this.inbox.classify(id, "command") || inboxRecord;
        if (!["stop", "new", "reset"].includes(command.name)) this.flushOutbox(peerId, context);
        this.inbox.mark(id, "running");
        safeLog("command", { peer: anonymousPeerId(peerId), name: command.name });
        await this.handleCommand(peerId, context, command);
        this.completeInboxItem(id);
        return;
      }

      const frozenStatePeerId = inboxRecord?.statePeerId || this.statePeerId(peerId);
      inboxRecord = this.inbox.classify(id, "work", {
        runtimeSnapshot: inboxRecord?.runtimeSnapshot || snapshotRuntime(frozenStatePeerId),
        statePeerId: frozenStatePeerId,
      }) || inboxRecord;
      this.flushOutbox(peerId, context);

      let content;
      try {
        content = await materializeInboundContent(message, {
          cacheDir: path.join(stateDir(), "media-cache"),
          protectedPaths: this.inbox.protectedAttachmentPaths(),
        });
      } catch (error) {
        if (!isPermanentInboundMediaError(error)) throw error;
        await this.safeSendText(peerId, context, `附件无法处理：${friendlyError(error)}。请缩小、转换或重新发送该附件。`);
        this.completeInboxItem(id);
        return;
      }

      if (!content.text && !content.attachments.length) {
        await this.safeSendText(peerId, context, "目前支持文本、图片、语音、文件和视频消息。这个消息类型暂时无法处理。");
        this.completeInboxItem(id);
        return;
      }

      const task = {
        ...content,
        context,
        receivedAt: Date.now(),
        runtimeSnapshot: inboxRecord.runtimeSnapshot,
        statePeerId: inboxRecord.statePeerId,
        inboxId: id,
      };
      this.inbox.queue(id, task);
      const before = this.taskQueue.status(peerId);
      const queued = this.taskQueue.enqueue(peerId, task);
      if (!queued.accepted) {
        if (replay) {
          const error = new Error("inbound task queue is full during durable replay");
          error.code = "INBOUND_QUEUE_FULL";
          throw error;
        }
        await this.safeSendText(peerId, context, "等待消息已经达到上限，请发送 /stop 清理队列后再试。");
        this.failInboxItem(id, new Error("inbound task queue is full"));
        return;
      }
      safeLog("message_queued", {
        peer: anonymousPeerId(peerId),
        pending: queued.pending,
        active: queued.active,
        attachmentCount: content.attachments.length,
      });
      if (before.active) {
        await this.safeSendText(
          peerId,
          context,
          `已加入下一轮，当前等待 ${queued.pending} 条消息。发送 /queue 可查看队列。`,
          { durable: false },
        );
      }
    } catch (error) {
      if (error?.code === "INBOUND_QUEUE_FULL" && replay) {
        try {
          this.inbox.mark(id, retryStatus || "queued", error.message);
        } finally {
          this.claimedInbox.delete(id);
        }
        throw error;
      }
      if (completedReplyMessage || this.inbox.get(id)?.status === "completed") {
        this.claimedInbox.delete(id);
        console.warn(`[wechat-bridge] completed reply remains pending peer=${anonymousPeerId(peerId)}: ${error?.message || error}`);
        safeLog("completed_reply_deferred", {
          peer: anonymousPeerId(peerId),
          code: error?.code || "SEND_ERROR",
        });
        return;
      }
      if (commandMessage) {
        try {
          this.inbox.mark(id, "cancelled", `command failed; resend explicitly: ${error?.message || error}`);
        } finally {
          this.claimedInbox.delete(id);
        }
      } else {
        this.failInboxItem(id, error);
      }
      console.error(`[wechat-bridge] inbound message retained for /retry: ${error?.stack || error}`);
      await this.safeSendText(peerId, this.context(peerId), `消息处理失败，已安全保留。发送 /retry 可显式重试：${friendlyError(error)}`);
    }
  }

  async replayInbox() {
    const pending = this.inbox.pending();
    if (pending.length) console.log(`[wechat-bridge] replaying ${pending.length} durable inbound message(s)`);
    for (const record of pending) {
      while (!this.stopping) {
        try {
          await this.handleMessage(record.message, { replay: true });
          break;
        } catch (error) {
          if (error?.code !== "INBOUND_QUEUE_FULL") {
            console.error(`[wechat-bridge] inbox replay failed: ${error?.stack || error}`);
            safeLog("inbox_replay_failed", { code: error?.code || "INBOX_REPLAY_ERROR" });
            break;
          }
          const peerId = String(record.message?.from_user_id || "").trim();
          if (!peerId) break;
          await this.taskQueue.waitForIdle(peerId);
        }
      }
    }
  }

  async processUpdateResponse(response) {
    // Persist the complete server batch before advancing its cursor. If the
    // process stops while dispatching one message, every later message is
    // replayable from the local inbox and cannot be skipped by the server.
    for (const message of response.msgs || []) {
      if (message?.message_type !== MESSAGE_TYPE.USER) continue;
      const peerId = String(message.from_user_id || "").trim();
      if (!peerId || !allowedSender(this.account, peerId)) continue;
      const id = durableMessageIdentity(message);
      if (hasSeenMessageId(this.account.accountId, id)) continue;
      const existing = this.inbox.get(id);
      if (!existing) this.inbox.receive(id, message);
    }
    if (Object.hasOwn(response, "get_updates_buf")) {
      this.syncBuf = response.get_updates_buf;
      saveSyncBuf(this.account.accountId, this.syncBuf);
    }

    for (const message of response.msgs || []) {
      if (this.stopping) break;
      try {
        await this.handleMessage(message);
      } catch (error) {
        console.error(`[wechat-bridge] inbound handling failed: ${error?.stack || error}`);
        safeLog("inbound_failed", { code: error?.code || "INBOUND_ERROR", message: String(error?.message || error).slice(0, 500) });
      }
    }
    return true;
  }

  async run() {
    await this.sender.ready;
    const interrupted = this.inbox.interruptRunning();
    if (interrupted) {
      console.warn(`[wechat-bridge] ${interrupted} interrupted task(s) require explicit /retry`);
      safeLog("inbox_interrupted", { count: interrupted });
    }
    await this.replayInbox();
    try {
      await notifyStart({ baseUrl: this.baseUrl, token: this.account.token, signal: this.pollAbort.signal });
    } catch (error) {
      console.warn(`[wechat-bridge] notifystart failed, continuing: ${error?.message || error}`);
    }

    while (!this.stopping) {
      let response;
      try {
        response = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.account.token,
          getUpdatesBuf: this.syncBuf,
          signal: this.pollAbort.signal,
        });
      } catch (error) {
        if (this.stopping || error?.code === "WECHAT_ABORTED" || error?.name === "AbortError") break;
        const waitMs = this.backoff.nextDelay();
        console.warn(`[wechat-bridge] getUpdates failed; retry in ${waitMs}ms: ${error?.message || error}`);
        safeLog("poll_failed", { code: error?.code || "POLL_ERROR", waitMs });
        await delay(waitMs, this.pollAbort.signal).catch(() => {});
        continue;
      }

      if (response.ret && Number(response.ret) !== 0) {
        const waitMs = this.backoff.nextDelay();
        console.warn(`[wechat-bridge] getUpdates ret=${response.ret}; retry in ${waitMs}ms`);
        safeLog("poll_failed", { ret: Number(response.ret), waitMs });
        await delay(waitMs, this.pollAbort.signal).catch(() => {});
        continue;
      }
      this.backoff.reset();
      await this.processUpdateResponse(response);
    }
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.pollAbort.abort();
    this.taskQueue.close();
    for (const state of this.activeAgents.values()) {
      state.shutdownRequested = true;
      state.task?.cancel();
    }
  }

  async close() {
    this.stop();
    await this.taskQueue.waitForAllIdle();
    await this.sender.close();
  }
}

export async function runBridge(account) {
  secureStateDirectory();
  const lock = acquireInstanceLock("bridge-global", {
    version: VERSION,
    accountScope: crypto.createHash("sha256").update(String(account.accountId)).digest("hex").slice(0, 12),
  });
  let bridge;
  try {
    bridge = new WechatAgentBridge({ account });
  } catch (error) {
    releaseInstanceLock(lock);
    throw error;
  }
  const onSignal = () => bridge.stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.log(`[wechat-bridge] ${VERSION} running account=${maskValue(account.accountId)} baseUrl=${bridge.baseUrl}`);
  console.log(`[wechat-bridge] state dir: ${stateDir()}`);
  safeLog("bridge_started", { account: maskValue(account.accountId), version: VERSION });
  try {
    await bridge.run();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await bridge.close().catch((error) => console.warn(`[wechat-bridge] close failed: ${error?.message || error}`));
    releaseInstanceLock(lock);
    safeLog("bridge_stopped", { account: maskValue(account.accountId), version: VERSION });
  }
}
