import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WechatAgentBridge } from "../src/bridge.js";
import { InboxStore } from "../src/inbox-store.js";
import {
  agentLaneIdentity,
  loadAgentLane,
  loadSyncBuf,
  savePeerRuntime,
  secureStateDirectory,
} from "../src/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function installFakeAgentCli(directory, name) {
  const target = path.join(directory, name);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const provider = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(provider === "claude" ? "  --model <model>  Use 'sonnet', 'opus', or 'haiku'\\n" : "");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumed = provider === "codex" ? args.includes("resume") : args.includes("--resume");
  fs.appendFileSync(
    process.env.WECLAUDEX_FAKE_AGENT_LOG,
    JSON.stringify({ provider, args, prompt, resumed }) + "\\n",
  );

  if (provider === "codex") {
    const session = "thread-integration";
    console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
    console.log(JSON.stringify({
      type: "item.completed",
      item: {
        id: resumed ? "codex-resumed" : "codex-new",
        type: "agent_message",
        text: resumed ? "Codex resumed reply" : "Codex first reply",
      },
    }));
    return;
  }

  const session = "session-integration";
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: session,
    model: "sonnet",
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: session,
    result: resumed ? "Claude resumed reply" : "Claude first reply",
  }));
});
`;
  fs.writeFileSync(target, source, { mode: 0o755 });
  return target;
}

function capturedSender(delivered) {
  return {
    ready: Promise.resolve(),
    pendingCount: 0,
    listPending: () => [],
    reserveCritical: async () => ({ id: "integration-reservation", release() {} }),
    flush: async () => ({ attempted: 0, delivered: 0, pending: 0 }),
    sendText: async (payload) => {
      delivered.push(payload);
      return { ok: true };
    },
    sendFile: async () => ({ ok: true }),
    sendImage: async () => ({ ok: true }),
    close: async () => {},
  };
}

async function createBridge(account, delivered) {
  const bridge = new WechatAgentBridge({ account });
  await bridge.sender.close();
  bridge.sender = capturedSender(delivered);
  bridge.startFeedback = async () => async () => {};
  return bridge;
}

function inboundMessage(provider, sequence, text) {
  return {
    message_id: `${provider}-${sequence}`,
    message_type: 1,
    from_user_id: "owner",
    context_token: `context-${sequence}`,
    run_id: `run-${sequence}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

test("the bridge runs and resumes native Codex and Claude sessions across restart", async (t) => {
  if (process.platform === "win32") {
    return t.skip("the fake executable harness uses POSIX executable files");
  }

  for (const provider of ["codex", "claude-code"]) {
    await t.test(provider, async (subtest) => {
      const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `weclaudex-${provider}-integration-`));
      const binDirectory = path.join(stateDirectory, "bin");
      const invocationLog = path.join(stateDirectory, "agent-invocations.jsonl");
      fs.mkdirSync(binDirectory, { recursive: true });
      installFakeAgentCli(binDirectory, "codex");
      installFakeAgentCli(binDirectory, "claude");

      const environmentNames = [
        "PATH",
        "WECHAT_BRIDGE_STATE_DIR",
        "WECHAT_BRIDGE_CWD",
        "WECHAT_BRIDGE_ACCESS_MODE",
        "WECHAT_BRIDGE_INPUT_DEBOUNCE_MS",
        "WECHAT_BRIDGE_PROGRESS_INTERVAL_MS",
        "WECHAT_BRIDGE_CODEX_DEFAULT_MODEL",
        "WECHAT_BRIDGE_CLAUDE_CODE_MODEL",
        "WECHAT_BRIDGE_CLAUDE_CODE_EFFORT",
        "WECLAUDEX_FAKE_AGENT_LOG",
      ];
      const originalEnvironment = Object.fromEntries(
        environmentNames.map((name) => [name, process.env[name]]),
      );
      process.env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH || ""}`;
      process.env.WECHAT_BRIDGE_STATE_DIR = stateDirectory;
      process.env.WECHAT_BRIDGE_CWD = projectRoot;
      process.env.WECHAT_BRIDGE_ACCESS_MODE = "workspace";
      process.env.WECHAT_BRIDGE_INPUT_DEBOUNCE_MS = "0";
      process.env.WECHAT_BRIDGE_PROGRESS_INTERVAL_MS = "0";
      process.env.WECHAT_BRIDGE_CODEX_DEFAULT_MODEL = "gpt-5.5";
      process.env.WECHAT_BRIDGE_CLAUDE_CODE_MODEL = "sonnet";
      process.env.WECHAT_BRIDGE_CLAUDE_CODE_EFFORT = "high";
      process.env.WECLAUDEX_FAKE_AGENT_LOG = invocationLog;
      secureStateDirectory();

      let bridge;
      subtest.after(async () => {
        await bridge?.close().catch(() => {});
        for (const [name, value] of Object.entries(originalEnvironment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        fs.rmSync(stateDirectory, { recursive: true, force: true });
      });

      const account = {
        accountId: `integration-${provider}`,
        token: "test-token",
        userId: "owner",
      };
      const delivered = [];
      bridge = await createBridge(account, delivered);
      const statePeerId = bridge.statePeerId("owner");
      savePeerRuntime(statePeerId, {
        provider,
        cwd: projectRoot,
        accessMode: "workspace",
      });

      await bridge.processUpdateResponse({
        msgs: [inboundMessage(provider, "first", "first integration task")],
        get_updates_buf: "cursor-first",
      });
      await bridge.taskQueue.waitForIdle("owner");

      assert.equal(new InboxStore(account.accountId).get(`${provider}-first`).status, "done");
      assert.equal(loadSyncBuf(account.accountId), "cursor-first");
      const firstReply = delivered.find((payload) => payload.text.startsWith(
        provider === "codex" ? "Codex first reply" : "Claude first reply",
      ));
      assert.ok(firstReply);
      assert.match(firstReply.text, /✅ (Codex|Claude Code) 已完成/);
      assert.match(firstReply.text, /任务 [a-f0-9]{8}/);

      const identity = agentLaneIdentity({
        peerId: statePeerId,
        provider,
        cwd: projectRoot,
        accessMode: "workspace",
      });
      const firstLane = loadAgentLane(identity);
      assert.equal(
        firstLane?.threadId || firstLane?.sessionId,
        provider === "codex" ? "thread-integration" : "session-integration",
      );

      await bridge.close();
      bridge = await createBridge(account, delivered);
      await bridge.processUpdateResponse({
        msgs: [inboundMessage(provider, "second", "second integration task")],
        get_updates_buf: "cursor-second",
      });
      await bridge.taskQueue.waitForIdle("owner");

      assert.equal(new InboxStore(account.accountId).get(`${provider}-second`).status, "done");
      assert.equal(loadSyncBuf(account.accountId), "cursor-second");
      const resumedReply = delivered.find((payload) => payload.text.startsWith(
        provider === "codex" ? "Codex resumed reply" : "Claude resumed reply",
      ));
      assert.ok(resumedReply);
      assert.match(resumedReply.text, /✅ (Codex|Claude Code) 已完成/);
      assert.match(resumedReply.text, /任务 [a-f0-9]{8}/);

      const invocations = fs.readFileSync(invocationLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.provider === (provider === "codex" ? "codex" : "claude"));
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0].resumed, false);
      assert.equal(invocations[1].resumed, true);
      assert.match(invocations[0].prompt, /first integration task/);
      assert.match(invocations[1].prompt, /second integration task/);
      assert.doesNotMatch(invocations[1].prompt, /first integration task/);
    });
  }
});
