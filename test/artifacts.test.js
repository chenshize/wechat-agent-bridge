import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverArtifacts, resolveArtifactFile } from "../src/artifacts.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-artifact-test-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("resolves a regular file contained by the workspace", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "result.txt"), "ok");
  const artifact = resolveArtifactFile(root, "result.txt");
  assert.equal(artifact.relativePath, "result.txt");
  assert.equal(artifact.kind, "file");
});

test("rejects traversal, symlink escape and likely credentials", () => {
  const root = fixture();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(root, "link.txt"));
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret");
  test.after(() => fs.rmSync(outside, { force: true }));
  assert.throws(() => resolveArtifactFile(root, "link.txt"), /工作区/);
  assert.throws(() => resolveArtifactFile(root, ".env"), /密钥或凭据/);
});

test("discovers recently modified artifacts but skips dependencies", () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "out"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "out", "chart.png"), "image");
  fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored");
  const found = discoverArtifacts(root, { sinceMs: Date.now() - 1000 });
  assert.deepEqual(found.map((item) => item.relativePath), [path.join("out", "chart.png")]);
});
