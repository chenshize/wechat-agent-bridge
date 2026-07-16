import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package metadata exposes WeClaudex as the only CLI", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "weclaudex");
  assert.match(manifest.repository.url, /\/weclaudex\.git$/);
  assert.deepEqual(manifest.bin, { weclaudex: "./src/cli.js" });
});

test("CLI help presents WeClaudex", () => {
  const result = spawnSync(process.execPath, ["src/cli.js"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^WeClaudex 0\.4\.1/m);
  assert.match(result.stdout, /^  weclaudex login$/m);
  assert.doesNotMatch(result.stdout, /legacy CLI alias/);
});

test("new installs use .weclaudex while an existing local state directory is reused", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "weclaudex-home-"));
  const stateModuleUrl = pathToFileURL(path.join(projectRoot, "src/state.js")).href;
  const script = `const { stateDir } = await import(${JSON.stringify(stateModuleUrl)}); process.stdout.write(stateDir());`;
  const env = { ...process.env, HOME: home };
  delete env.WECHAT_BRIDGE_STATE_DIR;
  delete env.WEIXIN_CODEX_STATE_DIR;
  delete env.OPENCLAW_STATE_DIR;

  try {
    const fresh = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, path.join(home, ".weclaudex"));

    const existing = path.join(home, ".weixin-codex-bridge");
    fs.mkdirSync(existing);
    const reused = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(reused.stdout, existing);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
