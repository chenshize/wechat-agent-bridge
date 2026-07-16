import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRecentArtifacts, saveRecentArtifacts } from "../src/artifact-store.js";

test("persists only still-safe artifacts for a peer and workspace", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-artifact-state-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-artifact-workspace-"));
  const previous = process.env.WECHAT_BRIDGE_STATE_DIR;
  process.env.WECHAT_BRIDGE_STATE_DIR = state;
  test.after(() => {
    if (previous === undefined) delete process.env.WECHAT_BRIDGE_STATE_DIR;
    else process.env.WECHAT_BRIDGE_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const filePath = path.join(workspace, "result.txt");
  fs.writeFileSync(filePath, "ok");
  saveRecentArtifacts("alice", workspace, [{
    relativePath: "result.txt",
    name: "result.txt",
    size: 2,
    mtimeMs: fs.statSync(filePath).mtimeMs,
    kind: "file",
  }]);
  assert.equal(loadRecentArtifacts("alice", workspace)[0].relativePath, "result.txt");
  fs.rmSync(filePath);
  assert.deepEqual(loadRecentArtifacts("alice", workspace), []);
});
