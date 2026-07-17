import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir, writeJson } from "./state.js";

const VALID_STATUSES = new Set(["received", "queued", "running", "interrupted", "completed", "done", "cancelled", "failed"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const VALID_KINDS = new Set(["unknown", "work", "command"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function inboxPath(accountId) {
  const key = crypto.createHash("sha256").update(String(accountId || "")).digest("hex");
  return path.join(stateDir(), "inbox", `${key}.json`);
}

function corruptInboxError(filePath, message, cause) {
  try {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    fs.copyFileSync(filePath, quarantine, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(quarantine, 0o600);
  } catch {
    // Keep the original inbox in place; callers must not overwrite it.
  }
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "INBOX_CORRUPT";
  return error;
}

function normalizeRecord(record) {
  if (!record?.id || !record?.message || !VALID_STATUSES.has(record.status)) return null;
  const completion = record.completion && typeof record.completion === "object"
    ? clone(record.completion)
    : undefined;
  if (
    record.status === "completed" &&
    (
      !completion?.id ||
      !Array.isArray(completion.chunks) ||
      !completion.chunks.length ||
      completion.chunks.some((chunk) => typeof chunk !== "string") ||
      !Number.isSafeInteger(completion.nextChunkIndex) ||
      completion.nextChunkIndex < 0 ||
      completion.nextChunkIndex > completion.chunks.length
    )
  ) return null;
  return {
    id: String(record.id),
    message: clone(record.message),
    status: record.status,
    attempts: Number.isSafeInteger(record.attempts) ? record.attempts : 0,
    receivedAt: Number.isFinite(record.receivedAt) ? record.receivedAt : Date.now(),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    lastError: String(record.lastError || "").slice(0, 500),
    task: record.task && typeof record.task === "object" ? clone(record.task) : undefined,
    kind: VALID_KINDS.has(record.kind) ? record.kind : "unknown",
    runtimeSnapshot: record.runtimeSnapshot && typeof record.runtimeSnapshot === "object"
      ? clone(record.runtimeSnapshot)
      : undefined,
    statePeerId: record.statePeerId ? String(record.statePeerId) : undefined,
    completion,
  };
}

export class InboxStore {
  constructor(accountId, {
    maxRecords = 2000,
    doneTtlMs = 24 * 60 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    if (!accountId) throw new TypeError("InboxStore requires an account id");
    this.filePath = inboxPath(accountId);
    this.maxRecords = Math.max(100, Number(maxRecords) || 2000);
    this.doneTtlMs = Math.max(60_000, Number(doneTtlMs) || 24 * 60 * 60 * 1000);
    this.now = now;
  }

  #load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw corruptInboxError(
        this.filePath,
        `durable inbox is unreadable; refusing to overwrite it: ${error?.message || error}`,
        error,
      );
    }
    if (!data || data.version !== 1 || !Array.isArray(data.records)) {
      throw corruptInboxError(this.filePath, "durable inbox has an unsupported schema");
    }
    const records = data.records.map(normalizeRecord);
    if (records.some((record) => !record)) {
      throw corruptInboxError(this.filePath, "durable inbox contains an invalid record");
    }
    return records;
  }

  #prune(records) {
    const cutoff = this.now() - this.doneTtlMs;
    let next = records.filter((record) => !TERMINAL_STATUSES.has(record.status) || record.updatedAt >= cutoff);
    if (next.length <= this.maxRecords) return next;
    const pending = next.filter((record) => !TERMINAL_STATUSES.has(record.status));
    const done = next.filter((record) => TERMINAL_STATUSES.has(record.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, this.maxRecords - pending.length));
    next = [...pending, ...done].sort((a, b) => a.receivedAt - b.receivedAt);
    if (next.length > this.maxRecords) {
      const error = new Error(`durable inbox reached ${this.maxRecords} pending records`);
      error.code = "INBOX_FULL";
      throw error;
    }
    return next;
  }

  #save(records) {
    const next = this.#prune(records);
    writeJson(this.filePath, { version: 1, records: next, updatedAt: new Date(this.now()).toISOString() });
    return next;
  }

  receive(id, message) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) throw new TypeError("Inbox message id is required");
    const records = this.#load();
    const existing = records.find((record) => record.id === normalizedId);
    if (existing) return { record: existing, duplicate: true };
    const now = this.now();
    const record = {
      id: normalizedId,
      message: clone(message),
      status: "received",
      attempts: 0,
      receivedAt: now,
      updatedAt: now,
      lastError: "",
      kind: "unknown",
    };
    this.#save([...records, record]);
    return { record, duplicate: false };
  }

  mark(id, status, error = "") {
    try {
      return this.markMany([id], status, error)[0] || null;
    } catch (markError) {
      if (markError?.code === "INBOX_RECORD_MISSING") return null;
      throw markError;
    }
  }

  markMany(ids, status, error = "") {
    if (!VALID_STATUSES.has(status)) throw new TypeError(`invalid inbox status: ${status}`);
    const requested = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
    if (!requested.length) return [];
    const records = this.#load();
    const indexById = new Map(records.map((record, index) => [record.id, index]));
    const missing = requested.filter((id) => !indexById.has(id));
    if (missing.length) {
      const missingError = new Error(`durable inbox record is missing: ${missing[0]}`);
      missingError.code = "INBOX_RECORD_MISSING";
      throw missingError;
    }
    const now = this.now();
    const updated = [];
    for (const id of requested) {
      const index = indexById.get(id);
      const current = records[index];
      const next = {
        ...current,
        status,
        task: TERMINAL_STATUSES.has(status) ? undefined : current.task,
        completion: TERMINAL_STATUSES.has(status) ? undefined : current.completion,
        attempts: status === "running" ? current.attempts + 1 : current.attempts,
        updatedAt: now,
        lastError: String(error || "").slice(0, 500),
      };
      records[index] = next;
      updated.push(next);
    }
    this.#save(records);
    return updated;
  }

  setKind(id, kind) {
    return this.classify(id, kind);
  }

  classify(id, kind, { runtimeSnapshot, statePeerId } = {}) {
    if (!VALID_KINDS.has(kind) || kind === "unknown") throw new TypeError(`invalid inbox kind: ${kind}`);
    const records = this.#load();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    records[index] = {
      ...records[index],
      kind,
      runtimeSnapshot: runtimeSnapshot && typeof runtimeSnapshot === "object"
        ? clone(runtimeSnapshot)
        : records[index].runtimeSnapshot,
      statePeerId: statePeerId ? String(statePeerId) : records[index].statePeerId,
      updatedAt: this.now(),
    };
    this.#save(records);
    return records[index];
  }

  queue(id, task) {
    if (!task || typeof task !== "object") throw new TypeError("queued inbox task is required");
    const records = this.#load();
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    const next = {
      ...records[index],
      status: "queued",
      kind: "work",
      task: clone(task),
      completion: undefined,
      updatedAt: this.now(),
      lastError: "",
    };
    records[index] = next;
    this.#save(records);
    return next;
  }

  saveCompletion(ids, completion) {
    const requested = [...new Set((ids || []).map((id) => String(id || "")).filter(Boolean))];
    if (!requested.length) return null;
    if (
      !completion ||
      typeof completion !== "object" ||
      !completion.id ||
      !Array.isArray(completion.chunks) ||
      !completion.chunks.length ||
      completion.chunks.some((chunk) => typeof chunk !== "string")
    ) {
      throw new TypeError("valid completed agent reply is required");
    }
    const records = this.#load();
    const indexById = new Map(records.map((record, index) => [record.id, index]));
    const missing = requested.find((id) => !indexById.has(id));
    if (missing) {
      const error = new Error(`durable inbox record is missing: ${missing}`);
      error.code = "INBOX_RECORD_MISSING";
      throw error;
    }
    const now = this.now();
    const normalizedCompletion = {
      id: String(completion.id),
      chunks: completion.chunks.map(String),
      nextChunkIndex: 0,
      createdAt: Number.isFinite(completion.createdAt) ? completion.createdAt : now,
    };
    requested.forEach((id, offset) => {
      const index = indexById.get(id);
      records[index] = {
        ...records[index],
        status: offset === 0 ? "completed" : "done",
        task: undefined,
        completion: offset === 0 ? normalizedCompletion : undefined,
        updatedAt: now,
        lastError: "",
      };
    });
    this.#save(records);
    return records[indexById.get(requested[0])];
  }

  advanceCompletion(id, nextChunkIndex) {
    if (!Number.isSafeInteger(nextChunkIndex) || nextChunkIndex < 0) {
      throw new TypeError("next completion chunk index must be a non-negative integer");
    }
    const records = this.#load();
    const index = records.findIndex((record) => record.id === String(id));
    if (index === -1) return null;
    const record = records[index];
    if (record.status !== "completed" || !record.completion) return record;
    records[index] = {
      ...record,
      completion: {
        ...record.completion,
        nextChunkIndex: Math.min(nextChunkIndex, record.completion.chunks.length),
      },
      updatedAt: this.now(),
    };
    this.#save(records);
    return records[index];
  }

  cancelMany(ids, reason = "cancelled by user") {
    const requested = new Set((ids || []).map((id) => String(id || "")).filter(Boolean));
    if (!requested.size) return 0;
    const records = this.#load();
    const now = this.now();
    let changed = 0;
    for (let index = 0; index < records.length; index += 1) {
      if (!requested.has(records[index].id) || TERMINAL_STATUSES.has(records[index].status)) continue;
      records[index] = {
        ...records[index],
        status: "cancelled",
        task: undefined,
        completion: undefined,
        updatedAt: now,
        lastError: String(reason).slice(0, 500),
      };
      changed += 1;
    }
    if (changed !== requested.size) {
      const error = new Error("one or more durable inbox records could not be cancelled");
      error.code = "INBOX_CANCEL_INCOMPLETE";
      throw error;
    }
    this.#save(records);
    return changed;
  }

  pending() {
    return this.#load()
      .filter((record) => ["received", "queued", "completed"].includes(record.status))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  recoverable(peerId) {
    return this.#load()
      .filter((record) => ["failed", "interrupted"].includes(record.status))
      .filter((record) => record.kind !== "command")
      .filter((record) => !peerId || String(record.message?.from_user_id || "") === String(peerId))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  completed(peerId) {
    return this.#load()
      .filter((record) => record.status === "completed")
      .filter((record) => !peerId || String(record.message?.from_user_id || "") === String(peerId))
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  list(peerId) {
    return this.#load()
      .filter((record) => !peerId || String(record.message?.from_user_id || "") === String(peerId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  protectedAttachmentPaths() {
    const result = new Set();
    for (const record of this.#load()) {
      if (TERMINAL_STATUSES.has(record.status)) continue;
      for (const attachment of record.task?.attachments || []) {
        if (attachment?.path) result.add(String(attachment.path));
      }
    }
    return result;
  }

  interruptRunning(reason = "bridge process stopped while task was running") {
    const records = this.#load();
    let changed = 0;
    const now = this.now();
    for (let index = 0; index < records.length; index += 1) {
      if (records[index].status !== "running") continue;
      records[index] = {
        ...records[index],
        status: records[index].kind === "command" ? "cancelled" : "interrupted",
        task: records[index].kind === "command" ? undefined : records[index].task,
        updatedAt: now,
        lastError: String(reason).slice(0, 500),
      };
      changed += 1;
    }
    if (changed) this.#save(records);
    return changed;
  }

  get(id) {
    return this.#load().find((record) => record.id === id) || null;
  }
}
