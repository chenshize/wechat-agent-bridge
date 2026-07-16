import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readJson, stateDir, writeJson } from "./state.js";
import { resolveArtifactFile } from "./artifacts.js";

function peerArtifactPath(peerId) {
  const key = crypto.createHash("sha256").update(String(peerId || "")).digest("hex");
  return path.join(stateDir(), "artifacts", `${key}.json`);
}

export function saveRecentArtifacts(peerId, workspace, artifacts, metadata = {}) {
  const items = (Array.isArray(artifacts) ? artifacts : []).map((item) => ({
    relativePath: item.relativePath,
    name: item.name,
    size: item.size,
    mtimeMs: item.mtimeMs,
    kind: item.kind,
  }));
  const value = {
    version: 1,
    peerId: String(peerId),
    workspace: fs.realpathSync(workspace),
    items,
    provider: metadata.provider || "",
    laneKey: metadata.laneKey || "",
    runStartedAt: metadata.runStartedAt || "",
    savedAt: new Date().toISOString(),
  };
  writeJson(peerArtifactPath(peerId), value);
  return value;
}

export function loadRecentArtifacts(peerId, workspace) {
  const value = readJson(peerArtifactPath(peerId), null);
  if (!value || value.version !== 1 || !Array.isArray(value.items)) return [];
  let root;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    return [];
  }
  if (value.workspace !== root) return [];
  const valid = [];
  for (const item of value.items) {
    try {
      const resolved = resolveArtifactFile(root, item.relativePath);
      valid.push({ ...resolved, discoveredAt: value.savedAt });
    } catch {
      // Do not retain deleted, moved, escaped or newly-sensitive files.
    }
  }
  return valid;
}

export function clearRecentArtifacts(peerId) {
  fs.rmSync(peerArtifactPath(peerId), { force: true });
}
