import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "./state.js";

function compactDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function anonymousPeerId(peerId) {
  if (!peerId) return "";
  return crypto.createHash("sha256").update(String(peerId)).digest("hex").slice(0, 12);
}

function safeRecord(record) {
  const output = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (/token|secret|password|authorization|aes.?key/i.test(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string") output[key] = value.slice(0, 2000);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 50);
    else if (typeof value === "object") output[key] = safeRecord(value);
  }
  return output;
}

export function appendRunLog(type, record = {}) {
  const logsDir = path.join(stateDir(), "runs");
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    type: String(type || "event"),
    ...safeRecord(record),
  });
  const filePath = path.join(logsDir, `${compactDate()}.jsonl`);
  fs.appendFileSync(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Permissions are best effort on filesystems without POSIX modes.
  }
}
