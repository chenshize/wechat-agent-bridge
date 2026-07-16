import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package metadata exposes the Claudex name and legacy CLI alias", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "wechat-codex-claude-code");
  assert.match(manifest.repository.url, /wechat-codex-claude-code/);
  assert.equal(manifest.bin.claudex, "./src/cli.js");
  assert.equal(manifest.bin["wechat-codex-claude-code"], "./src/cli.js");
  assert.equal(manifest.bin["wechat-agent-bridge"], "./src/cli.js");
});

test("CLI help presents Claudex for WeChat and documents compatibility", () => {
  const result = spawnSync(process.execPath, ["src/cli.js"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Claudex for WeChat 0\.4\.0/m);
  assert.match(result.stdout, /wechat-agent-bridge remains available as a legacy CLI alias/);
});
