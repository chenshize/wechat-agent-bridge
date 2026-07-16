import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { atomicWriteJsonSync } from "./runtime/atomic-json.js";
import { cleanupOutboundSnapshot, outboundSnapshotIdForPath } from "./outbound-spool.js";

const DEFAULT_MIN_INTERVAL_MS = 2_500;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PENDING = 200;
const DEFAULT_CRITICAL_RESERVE = 512;
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_KINDS = new Set(["text", "image", "file"]);
const VALID_STATUSES = new Set(["queued", "sending", "waiting-context", "waiting-circuit", "failed"]);

export class SendSchedulerError extends Error {
  constructor(message, { code = "WECHAT_SEND_ERROR", userId, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SendSchedulerError";
    this.code = code;
    this.userId = userId;
    this.retryable = retryable;
  }
}

export class StaleContextError extends SendSchedulerError {
  constructor(userId, cause) {
    super("WeChat context token is stale; wait for the user's next message", {
      code: "WECHAT_STALE_CONTEXT",
      userId,
      retryable: true,
      cause,
    });
    this.name = "StaleContextError";
  }
}

export class SendRateLimitError extends SendSchedulerError {
  constructor(userId, cause) {
    super("WeChat send rate limit persisted after bounded retries", {
      code: "WECHAT_SEND_RATE_LIMIT",
      userId,
      retryable: true,
      cause,
    });
    this.name = "SendRateLimitError";
  }
}

export class SendCircuitOpenError extends SendSchedulerError {
  constructor(userId, retryAfterMs) {
    super(`WeChat send circuit is open for another ${Math.max(0, retryAfterMs)}ms`, {
      code: "WECHAT_SEND_CIRCUIT_OPEN",
      userId,
      retryable: true,
    });
    this.name = "SendCircuitOpenError";
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

function responseFields(value) {
  const response = value?.response && typeof value.response === "object" ? value.response : value;
  const ret = response?.ret ?? value?.ret;
  const errmsg = response?.errmsg ?? response?.retmsg ?? value?.errmsg ?? value?.message ?? "";
  return { ret: ret === undefined ? undefined : Number(ret), errmsg: String(errmsg || "") };
}

export function classifySendOutcome(value, { threw = false } = {}) {
  const { ret, errmsg } = responseFields(value);
  const normalized = errmsg.toLowerCase();
  const stale = ret === -14 || (
    ret === -2 && (
      normalized.includes("unknown error") ||
      /(?:context|session).*(?:stale|expired|invalid)/.test(normalized) ||
      /(?:stale|expired|invalid).*(?:context|session)/.test(normalized)
    )
  );
  if (stale) return { kind: "stale-context", ret, errmsg };
  if (ret === -2) return { kind: "rate-limit", ret, errmsg };
  if (ret !== undefined && ret !== 0) return { kind: "fatal", ret, errmsg };
  if (threw) return { kind: value?.retryable ? "retryable" : "fatal", ret, errmsg };
  return { kind: "success", ret: ret ?? 0, errmsg };
}

export function retryDelayMs(attempt, { baseMs = 3_000, maxMs = 15_000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new TypeError("attempt must be a non-negative integer");
  return Math.min(maxMs, baseMs * (2 ** attempt));
}

function cloneSerializable(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoredRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !record.id ||
    !record.userId ||
    !VALID_KINDS.has(record.kind) ||
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload) ||
    !VALID_STATUSES.has(record.status || "queued") ||
    !Number.isSafeInteger(record.attempts ?? 0) ||
    (record.attempts ?? 0) < 0 ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.updatedAt)
  ) return null;
  if (record.kind === "text" && typeof record.payload.text !== "string") return null;
  if (["image", "file"].includes(record.kind) && typeof record.payload.filePath !== "string") return null;
  return {
    id: String(record.id),
    userId: String(record.userId),
    contextToken: String(record.contextToken || ""),
    kind: String(record.kind),
    payload: cloneSerializable(record.payload) || {},
    durable: true,
    critical: record.critical === true,
    status: String(record.status || "queued"),
    attempts: Number.isSafeInteger(record.attempts) ? record.attempts : 0,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    lastError: record.lastError ? String(record.lastError).slice(0, 500) : "",
  };
}

async function corruptOutboxError(filePath, message, cause) {
  try {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    await fs.copyFile(filePath, quarantine, fsConstants.COPYFILE_EXCL);
    await fs.chmod(quarantine, 0o600);
  } catch {
    // Preserve the original path and refuse to overwrite it even if a backup
    // cannot be created (for example because the directory is read-only).
  }
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "OUTBOX_CORRUPT";
  return error;
}

export class JsonPendingStore {
  constructor(filePath) {
    if (!filePath) throw new TypeError("JsonPendingStore requires a file path");
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw await corruptOutboxError(
        this.filePath,
        `durable outbox is unreadable; refusing to overwrite it: ${error?.message || error}`,
        error,
      );
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.pending)) {
      throw await corruptOutboxError(this.filePath, "durable outbox has an unsupported schema");
    }
    const records = parsed.pending.map(normalizeStoredRecord);
    if (records.some((record) => !record) || new Set(records.map((record) => record.id)).size !== records.length) {
      throw await corruptOutboxError(this.filePath, "durable outbox contains an invalid record");
    }
    return records;
  }

  async save(records) {
    atomicWriteJsonSync(this.filePath, { version: 1, pending: records }, 0o600);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SendScheduler {
  constructor({
    transport,
    send,
    pendingStore,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = 3_000,
    retryMaxMs = 15_000,
    circuitThreshold = 2,
    circuitWindowMs = 30_000,
    circuitOpenMs = 30_000,
    maxPending = DEFAULT_MAX_PENDING,
    criticalReserve = DEFAULT_CRITICAL_RESERVE,
    pendingTtlMs = DEFAULT_PENDING_TTL_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (!transport && typeof send !== "function") throw new TypeError("SendScheduler requires transport or send");
    this.transport = transport;
    this.send = send;
    this.pendingStore = pendingStore;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.circuitThreshold = circuitThreshold;
    this.circuitWindowMs = circuitWindowMs;
    this.circuitOpenMs = circuitOpenMs;
    this.maxPending = Math.max(1, Number(maxPending) || DEFAULT_MAX_PENDING);
    this.criticalReserve = Math.max(1, Number(criticalReserve) || DEFAULT_CRITICAL_RESERVE);
    this.pendingTtlMs = pendingTtlMs;
    this.now = now;
    this.sleep = sleep;
    this.pending = new Map();
    this.active = new Map();
    this.userTails = new Map();
    this.lastAttemptAt = new Map();
    this.circuits = new Map();
    this.criticalReservations = new Map();
    this.closed = false;
    this.cleanupTasks = new Set();
    this.persistTail = Promise.resolve();
    this.ready = this.#restore();
  }

  get pendingCount() {
    return [...this.pending.values()].filter((record) => record.durable !== false).length;
  }

  get regularPendingCount() {
    return [...this.pending.values()].filter((record) => record.durable !== false && record.critical !== true).length;
  }

  get criticalPendingCount() {
    return [...this.pending.values()].filter((record) => record.durable !== false && record.critical === true).length;
  }

  get criticalReservedCount() {
    return [...this.criticalReservations.values()].reduce((sum, reservation) => sum + reservation.remaining, 0);
  }

  async initialize() {
    await this.ready;
    return this;
  }

  async #restore() {
    if (!this.pendingStore) return;
    const records = await this.pendingStore.load();
    const cutoff = this.now() - this.pendingTtlMs;
    const expired = [];
    for (const raw of records) {
      const record = normalizeStoredRecord(raw);
      if (record && record.createdAt >= cutoff) {
        // A process can die after persisting "sending" but before recording the
        // outcome. There is no live delivery after restart, so make it eligible
        // for the next explicit flush instead of skipping it forever.
        if (record.status === "sending") record.status = "queued";
        this.pending.set(record.id, record);
      } else if (record) {
        expired.push(record);
      }
    }
    await this.#persist();
    for (const record of expired) this.#schedulePayloadCleanup(record);
  }

  #recordsForStorage() {
    return [...this.pending.values()]
      .filter((record) => record.durable !== false)
      .map((record) => cloneSerializable(record));
  }

  async #pruneExpiredPersisted() {
    const cutoff = this.now() - this.pendingTtlMs;
    const removed = [];
    for (const [id, record] of this.pending) {
      if (this.active.has(id) || record.createdAt >= cutoff) continue;
      this.pending.delete(id);
      removed.push(record);
    }
    if (!removed.length) return 0;
    try {
      await this.#persist();
    } catch (error) {
      for (const record of removed) this.pending.set(record.id, record);
      throw error;
    }
    for (const record of removed) this.#schedulePayloadCleanup(record);
    return removed.length;
  }

  #schedulePayloadCleanup(record) {
    const filePath = record?.payload?.filePath;
    if (!outboundSnapshotIdForPath(filePath)) return;
    const cleanup = cleanupOutboundSnapshot(filePath)
      .catch((error) => console.warn(`[wechat-bridge] outbound spool cleanup failed: ${error?.message || error}`));
    this.cleanupTasks.add(cleanup);
    cleanup.finally(() => this.cleanupTasks.delete(cleanup)).catch(() => {});
  }

  async #persist() {
    if (!this.pendingStore) return;
    const snapshot = this.#recordsForStorage();
    this.persistTail = this.persistTail.catch(() => {}).then(() => this.pendingStore.save(snapshot));
    await this.persistTail;
  }

  async reserveCritical(count) {
    await this.ready;
    await this.#pruneExpiredPersisted();
    if (this.closed) throw new SendSchedulerError("Send scheduler is closed", { code: "WECHAT_SEND_CLOSED" });
    if (!Number.isSafeInteger(count) || count <= 0) throw new TypeError("critical reservation count must be positive");
    if (this.criticalPendingCount + this.criticalReservedCount + count > this.criticalReserve) {
      throw new SendSchedulerError(`Critical send reserve cannot admit ${count} items`, {
        code: "WECHAT_SEND_QUEUE_FULL",
      });
    }
    const id = crypto.randomUUID();
    this.criticalReservations.set(id, { id, remaining: count });
    let released = false;
    return {
      id,
      count,
      release: () => {
        if (released) return;
        released = true;
        this.criticalReservations.delete(id);
      },
    };
  }

  #dispatch(record) {
    if (this.transport) {
      const method = this.transport[`send${record.kind[0].toUpperCase()}${record.kind.slice(1)}`];
      if (typeof method !== "function") throw new Error(`Transport does not support ${record.kind}`);
      return method.call(this.transport, record.payload);
    }
    return this.send(record);
  }

  async #waitForSlot(userId) {
    const waitMs = Math.max(0, (this.lastAttemptAt.get(userId) || 0) + this.minIntervalMs - this.now());
    if (waitMs) await this.sleep(waitMs);
    this.lastAttemptAt.set(userId, this.now());
  }

  #circuitState(userId) {
    const state = this.circuits.get(userId);
    if (!state) return { events: [], until: 0 };
    if (state.until && state.until <= this.now()) {
      this.circuits.delete(userId);
      return { events: [], until: 0 };
    }
    return state;
  }

  #recordRateLimit(userId) {
    const now = this.now();
    const state = this.#circuitState(userId);
    state.events = state.events.filter((timestamp) => timestamp >= now - this.circuitWindowMs);
    state.events.push(now);
    if (state.events.length >= this.circuitThreshold) state.until = now + this.circuitOpenMs;
    this.circuits.set(userId, state);
    return state;
  }

  #openCircuitRemaining(userId) {
    return Math.max(0, this.#circuitState(userId).until - this.now());
  }

  async #deferOrDrop(record, status) {
    record.status = status;
    record.updatedAt = this.now();
    if (record.durable === false) this.pending.delete(record.id);
    await this.#persist();
  }

  async #deliver(record) {
    if (!this.pending.has(record.id)) return { cancelled: true };
    const openFor = this.#openCircuitRemaining(record.userId);
    if (openFor) {
      await this.#deferOrDrop(record, "waiting-circuit");
      throw new SendCircuitOpenError(record.userId, openFor);
    }

    record.status = "sending";
    record.updatedAt = this.now();
    await this.#persist();
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (!this.pending.has(record.id)) return { cancelled: true };
      await this.#waitForSlot(record.userId);
      if (!this.pending.has(record.id)) return { cancelled: true };
      let result;
      let outcome;
      try {
        result = await this.#dispatch(record);
        outcome = classifySendOutcome(result);
      } catch (error) {
        lastError = error;
        outcome = classifySendOutcome(error, { threw: true });
      }
      record.attempts += 1;
      record.updatedAt = this.now();

      if (outcome.kind === "success") {
        this.pending.delete(record.id);
        try {
          await this.#persist();
        } catch (error) {
          record.status = "queued";
          this.pending.set(record.id, record);
          throw error;
        }
        this.#schedulePayloadCleanup(record);
        return result;
      }
      record.lastError = outcome.errmsg || lastError?.message || outcome.kind;
      if (outcome.kind === "stale-context") {
        await this.#deferOrDrop(record, "waiting-context");
        throw new StaleContextError(record.userId, lastError);
      }
      if (outcome.kind !== "rate-limit" && outcome.kind !== "retryable") {
        record.status = "failed";
        this.pending.delete(record.id);
        try {
          await this.#persist();
        } catch (error) {
          this.pending.set(record.id, record);
          throw error;
        }
        this.#schedulePayloadCleanup(record);
        throw new SendSchedulerError(`WeChat send failed: ${record.lastError}`, {
          code: "WECHAT_SEND_FATAL",
          userId: record.userId,
          cause: lastError,
        });
      }

      if (outcome.kind === "rate-limit") {
        const circuit = this.#recordRateLimit(record.userId);
        if (circuit.until > this.now()) {
          await this.#deferOrDrop(record, "waiting-circuit");
          throw new SendRateLimitError(record.userId, lastError);
        }
      }
      if (attempt >= this.maxRetries) {
        await this.#deferOrDrop(record, outcome.kind === "rate-limit" ? "waiting-circuit" : "failed");
        if (outcome.kind === "rate-limit") throw new SendRateLimitError(record.userId, lastError);
        throw lastError || new SendSchedulerError("WeChat send retries exhausted", {
          code: "WECHAT_SEND_RETRIES_EXHAUSTED",
          userId: record.userId,
          retryable: true,
        });
      }
      await this.sleep(retryDelayMs(attempt, { baseMs: this.retryBaseMs, maxMs: this.retryMaxMs }));
    }
  }

  #queue(record) {
    if (this.active.has(record.id)) return this.active.get(record.id);
    const previous = this.userTails.get(record.userId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#deliver(record));
    this.active.set(record.id, current);
    this.userTails.set(record.userId, current);
    current.finally(() => {
      this.active.delete(record.id);
      if (this.userTails.get(record.userId) === current) this.userTails.delete(record.userId);
    }).catch(() => {});
    return current;
  }

  async enqueue({
    userId,
    contextToken = "",
    kind,
    payload = {},
    durable = true,
    critical = false,
    reservationId = "",
  }) {
    await this.ready;
    await this.#pruneExpiredPersisted();
    if (this.closed) throw new SendSchedulerError("Send scheduler is closed", { code: "WECHAT_SEND_CLOSED" });
    if (!userId || !VALID_KINDS.has(String(kind))) throw new TypeError("enqueue requires a valid userId and kind");
    const serializedPayload = cloneSerializable(payload) || {};
    if (String(kind) === "text" && typeof serializedPayload.text !== "string") {
      throw new TypeError("text sends require a string payload");
    }
    if (["image", "file"].includes(String(kind)) && typeof serializedPayload.filePath !== "string") {
      throw new TypeError("media sends require a filePath");
    }
    const requestedClientId = String(serializedPayload.clientId || "").trim();
    if (durable && requestedClientId) {
      const existing = [...this.pending.values()].find((record) => (
        record.durable !== false &&
        record.userId === String(userId) &&
        record.payload?.clientId === requestedClientId
      ));
      if (existing) {
        const sameContent = existing.kind === String(kind) && (
          String(kind) === "text"
            ? existing.payload?.text === serializedPayload.text
            : existing.payload?.filePath === serializedPayload.filePath &&
              existing.payload?.snapshot?.sha256 === serializedPayload.snapshot?.sha256
        );
        if (!sameContent) {
          throw new SendSchedulerError("Stable WeChat client id was reused for different content", {
            code: "WECHAT_SEND_CLIENT_ID_CONFLICT",
            userId,
          });
        }
        return { queued: true, deduplicated: true, id: existing.id };
      }
    }
    let reservation;
    if (durable && critical && reservationId) {
      reservation = this.criticalReservations.get(reservationId);
      if (!reservation || reservation.remaining <= 0) {
        throw new SendSchedulerError("Critical send reservation is unavailable", {
          code: "WECHAT_SEND_RESERVATION_INVALID",
          userId,
        });
      }
    }
    if (durable && !critical && this.regularPendingCount >= this.maxPending) {
      throw new SendSchedulerError(`Pending send queue reached ${this.maxPending} items`, {
        code: "WECHAT_SEND_QUEUE_FULL",
        userId,
      });
    }
    if (
      durable &&
      critical &&
      !reservation &&
      this.criticalPendingCount + this.criticalReservedCount >= this.criticalReserve
    ) {
      throw new SendSchedulerError(`Critical send queue reached ${this.criticalReserve} items`, {
        code: "WECHAT_SEND_QUEUE_FULL",
        userId,
      });
    }
    const now = this.now();
    const id = crypto.randomUUID();
    if (!serializedPayload.clientId) serializedPayload.clientId = `wechat-agent-${String(kind)}-${id}`;
    const record = {
      id,
      userId: String(userId),
      contextToken: String(contextToken || ""),
      kind: String(kind),
      payload: serializedPayload,
      durable: durable !== false,
      critical: durable !== false && critical === true,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      lastError: "",
    };
    if (reservation) reservation.remaining -= 1;
    this.pending.set(record.id, record);
    try {
      await this.#persist();
    } catch (error) {
      this.pending.delete(record.id);
      if (reservation) reservation.remaining += 1;
      throw error;
    }
    return this.#queue(record);
  }

  sendText(args) {
    const to = args?.to || args?.userId;
    return this.enqueue({
      userId: to,
      contextToken: args?.contextToken,
      kind: "text",
      durable: args?.durable !== false,
      critical: args?.critical === true,
      reservationId: args?.reservationId,
      payload: {
        to,
        text: args?.text,
        contextToken: args?.contextToken,
        runId: args?.runId,
        clientId: args?.clientId,
      },
    });
  }

  sendImage(args) {
    const to = args?.to || args?.userId;
    return this.enqueue({
      userId: to,
      contextToken: args?.contextToken,
      kind: "image",
      durable: args?.durable !== false,
      critical: args?.critical === true,
      reservationId: args?.reservationId,
      payload: {
        to,
        filePath: args?.filePath,
        text: args?.text,
        contextToken: args?.contextToken,
        runId: args?.runId,
        snapshot: cloneSerializable(args?.snapshot),
        clientId: args?.clientId,
      },
    });
  }

  sendFile(args) {
    const to = args?.to || args?.userId;
    return this.enqueue({
      userId: to,
      contextToken: args?.contextToken,
      kind: "file",
      durable: args?.durable !== false,
      critical: args?.critical === true,
      reservationId: args?.reservationId,
      payload: {
        to,
        filePath: args?.filePath,
        text: args?.text,
        contextToken: args?.contextToken,
        runId: args?.runId,
        snapshot: cloneSerializable(args?.snapshot),
        clientId: args?.clientId,
      },
    });
  }

  listPending({ userId } = {}) {
    return [...this.pending.values()]
      .filter((record) => record.durable !== false && (!userId || record.userId === userId))
      .map((record) => cloneSerializable(record));
  }

  async clear({ userId } = {}) {
    await this.ready;
    const removed = [];
    for (const [id, record] of this.pending) {
      if (!userId || record.userId === userId) {
        this.pending.delete(id);
        removed.push(record);
      }
    }
    try {
      await this.#persist();
    } catch (error) {
      for (const record of removed) this.pending.set(record.id, record);
      throw error;
    }
    for (const record of removed) this.#schedulePayloadCleanup(record);
  }

  async flush(options = {}) {
    await this.ready;
    await this.#pruneExpiredPersisted();
    const { userId, contextToken, runId } = options;
    const hasFreshContext = Object.hasOwn(options, "contextToken") && Boolean(contextToken);
    const hasFreshRunId = Object.hasOwn(options, "runId");
    const tasks = [];
    for (const record of this.pending.values()) {
      if (record.durable === false) continue;
      if (userId && record.userId !== userId) continue;
      // Only an in-process delivery promise proves a record is still sending.
      // A persistence failure can otherwise strand the in-memory record in the
      // "sending" state until the whole bridge is restarted.
      if (this.active.has(record.id)) continue;
      if (record.status === "sending") record.status = "queued";
      if (hasFreshContext && record.userId === userId) {
        record.contextToken = String(contextToken);
        record.payload.contextToken = String(contextToken);
      }
      if (hasFreshContext && hasFreshRunId && record.userId === userId) {
        record.payload.runId = String(runId || "");
      }
      if (record.status === "waiting-context" && !hasFreshContext) continue;
      if (record.status === "waiting-circuit" && this.#openCircuitRemaining(record.userId)) continue;
      record.status = "queued";
      tasks.push(this.#queue(record));
    }
    await this.#persist();
    const settled = await Promise.allSettled(tasks);
    return {
      attempted: settled.length,
      sent: settled.filter((result) => result.status === "fulfilled").length,
      failed: settled.filter((result) => result.status === "rejected").length,
      pending: this.pendingCount,
    };
  }

  async close() {
    this.closed = true;
    this.criticalReservations.clear();
    await this.ready;
    await Promise.allSettled([...this.active.values()]);
    await this.#persist();
    await Promise.allSettled([...this.cleanupTasks]);
  }
}
