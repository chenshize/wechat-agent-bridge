import crypto from "node:crypto";

function stableItem(value) {
  if (Array.isArray(value)) return value.map(stableItem);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableItem(value[key])]));
}

export function messageIdentity(message) {
  const direct = message?.message_id || message?.client_id || message?.id;
  if (direct !== undefined && direct !== null && String(direct)) return String(direct);
  const digestInput = {
    from: message?.from_user_id || "",
    createdAt: message?.create_time_ms || message?.create_time || message?.timestamp || "",
    runId: message?.run_id || "",
    contextToken: message?.context_token || "",
    sequence: message?.seq || message?.sequence || message?.server_seq || "",
    items: message?.item_list || [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(stableItem(digestInput))).digest("hex");
}

export class MessageDeduper {
  constructor({ entries = [], maxEntries = 2048, ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxEntries = Math.max(32, Number(maxEntries) || 2048);
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000);
    this.now = now;
    this.entries = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.id && Number.isFinite(entry.at)) this.entries.set(String(entry.id), entry.at);
    }
    this.prune();
  }

  checkAndRemember(messageOrId) {
    const id = typeof messageOrId === "string" ? messageOrId : messageIdentity(messageOrId);
    this.prune();
    if (this.entries.has(id)) return true;
    this.entries.set(id, this.now());
    this.prune();
    return false;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, at] of this.entries) {
      if (at < cutoff) this.entries.delete(id);
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  snapshot() {
    this.prune();
    return [...this.entries].map(([id, at]) => ({ id, at }));
  }
}

export class PollBackoff {
  constructor({ baseMs = 1000, maxMs = 30_000, jitter = 0.2, random = Math.random } = {}) {
    this.baseMs = Math.max(100, Number(baseMs) || 1000);
    this.maxMs = Math.max(this.baseMs, Number(maxMs) || 30_000);
    this.jitter = Math.max(0, Math.min(1, Number(jitter) || 0));
    this.random = random;
    this.failures = 0;
  }

  nextDelay() {
    const raw = Math.min(this.maxMs, this.baseMs * (2 ** this.failures));
    this.failures += 1;
    const spread = raw * this.jitter;
    return Math.max(0, Math.round(raw - spread + (this.random() * spread * 2)));
  }

  reset() {
    this.failures = 0;
  }
}

export function delay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    const onResolve = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(onResolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
    } else signal.addEventListener("abort", onAbort, { once: true });
  });
}
