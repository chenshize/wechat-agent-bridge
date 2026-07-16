#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

import qrcode from "qrcode-terminal";

import { runBridge } from "./bridge.js";
import { commandHelpText } from "./command-parser.js";
import {
  listAccountIds,
  loadAccessMode,
  loadAccount,
  loadActiveWorkspace,
  saveAccount,
  secureStateDirectory,
  stateDir,
} from "./state.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  fetchQrCode,
  normalizeOfficialBaseUrl,
  pollQrStatus,
  sendFile,
  sendImage,
} from "./wechat-api.js";

function usage() {
  console.log(`Claudex for WeChat 0.4.0

Usage:
  claudex login
  claudex run
  claudex doctor
  claudex send-image /absolute/path/to/image.png
  claudex send-file /absolute/path/to/file.pdf

Source checkout:
  npm run login
  npm run run
  npm run doctor
  node src/cli.js send-image /absolute/path/to/image.png
  node src/cli.js send-file /absolute/path/to/file.pdf

Compatibility:
  wechat-agent-bridge remains available as a legacy CLI alias

Environment:
  WECHAT_BRIDGE_STATE_DIR       State directory (default ~/.wechat-agent-bridge)
  WECHAT_BRIDGE_ACCOUNT_ID      Account to run (default latest login)
  WECHAT_BRIDGE_ALLOW_FROM      Comma-separated allowed WeChat user ids
  WECHAT_BRIDGE_ALLOW_ALL       Set 1 to accept any sender (not recommended)
  WECHAT_BRIDGE_CWD             Initial safe workspace
  WECHAT_BRIDGE_ACCESS_MODE     read-only, workspace, or full
  WECHAT_BRIDGE_DEFAULT_AGENT   codex or claude-code
  WECHAT_BRIDGE_TIMEOUT_MS      Per-agent timeout (default 600000)
  WECHAT_BRIDGE_CODEX_ARGS      Full custom Codex argv override
  WECHAT_BRIDGE_CLAUDE_CODE_ARGS Full custom Claude Code argv override

${commandHelpText()}
`);
}

function maskValue(value) {
  const input = String(value || "");
  if (!input) return "<none>";
  return input.length <= 8 ? `${input.slice(0, 2)}…` : `${input.slice(0, 4)}…${input.slice(-4)}`;
}

function localTokenList() {
  return listAccountIds()
    .map((id) => loadAccount(id)?.token)
    .filter((token) => typeof token === "string" && token.trim())
    .slice(-10)
    .reverse();
}

async function promptLine(label) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(label)).trim();
  } finally {
    terminal.close();
  }
}

async function login() {
  secureStateDirectory();
  console.log(`[wechat-bridge] state dir: ${stateDir()}`);
  console.log("[wechat-bridge] requesting QR code...");
  const qr = await fetchQrCode({
    botType: process.env.WECHAT_BRIDGE_BOT_TYPE || process.env.WEIXIN_CODEX_BOT_TYPE || DEFAULT_BOT_TYPE,
    localTokenList: localTokenList(),
  });
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error("QR response is missing required fields");
  }

  console.log("\n请使用微信 ClawBot 的“开始扫一扫”扫描二维码：\n");
  qrcode.generate(qr.qrcode_img_content, { small: true });
  console.log(`\n二维码备用链接：\n${qr.qrcode_img_content}\n`);

  let currentBaseUrl = DEFAULT_BASE_URL;
  let pendingVerifyCode = "";
  const deadline = Date.now() + Number.parseInt(
    process.env.WECHAT_BRIDGE_LOGIN_TIMEOUT_MS || process.env.WEIXIN_CODEX_LOGIN_TIMEOUT_MS || "480000",
    10,
  );

  while (Date.now() < deadline) {
    const status = await pollQrStatus({
      qrcode: qr.qrcode,
      verifyCode: pendingVerifyCode,
      baseUrl: currentBaseUrl,
    });
    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        pendingVerifyCode = "";
        process.stdout.write("\n已扫描，等待确认…\n");
        break;
      case "need_verifycode":
        pendingVerifyCode = await promptLine("\n请输入微信中显示的数字：");
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          currentBaseUrl = normalizeOfficialBaseUrl(`https://${status.redirect_host}`);
          process.stdout.write(`\n已切换微信接入节点：${currentBaseUrl}\n`);
        }
        break;
      case "binded_redirect":
        console.log("\n账号已连接，现有本地凭据仍可使用。");
        return;
      case "expired":
        throw new Error("二维码已过期，请重新运行 npm run login");
      case "verify_code_blocked":
        throw new Error("验证码多次失败被暂时限制，请稍后重试");
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) throw new Error("登录确认响应缺少账号或凭据");
        const account = saveAccount({
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          baseUrl: normalizeOfficialBaseUrl(status.baseurl || currentBaseUrl || DEFAULT_BASE_URL),
          userId: status.ilink_user_id || "",
        });
        console.log(`\n连接成功，账号已安全保存：${maskValue(account.accountId)}`);
        return;
      }
      default:
        process.stdout.write(`\n未识别的登录状态：${String(status.status || "unknown")}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("登录超时，请重新运行 npm run login");
}

function binaryVersion(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return "unavailable";
  return String(result.stdout || result.stderr || "available").trim();
}

async function doctor() {
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  let workspace;
  try {
    workspace = loadActiveWorkspace();
  } catch (error) {
    workspace = `invalid (${error.message})`;
  }
  console.log("claudex-for-wechat=0.4.0");
  console.log(`node=${process.version}`);
  console.log(`codex=${binaryVersion("codex")}`);
  console.log(`claude=${binaryVersion("claude")}`);
  console.log(`stateDir=${stateDir()}`);
  console.log(`savedAccounts=${listAccountIds().length}`);
  console.log(`selectedAccount=${maskValue(account?.accountId)}`);
  console.log(`hasToken=${Boolean(account?.token)}`);
  console.log(`workspace=${workspace}`);
  console.log(`defaultAccess=${loadAccessMode()}`);
}

async function sendMediaCommand(filePath, kind) {
  if (!filePath) throw new Error(`${kind} requires an absolute file path`);
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  if (!account?.token) throw new Error("No WeChat account found. Run npm run login first.");
  const to = process.env.WECHAT_BRIDGE_TO || process.env.WEIXIN_CODEX_TO || account.userId;
  if (!to) throw new Error("No recipient. Set WECHAT_BRIDGE_TO or log in again.");
  const args = {
    baseUrl: account.baseUrl || DEFAULT_BASE_URL,
    token: account.token,
    to,
    filePath,
  };
  const result = kind === "send-image" ? await sendImage(args) : await sendFile(args);
  console.log(`sent ${kind === "send-image" ? "image" : "file"} messageId=${result.clientId}`);
}

async function run() {
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  if (!account?.token) throw new Error("No WeChat account found. Run npm run login first.");
  await runBridge(account);
}

const command = process.argv[2];
try {
  if (command === "login") await login();
  else if (command === "run") await run();
  else if (command === "doctor") await doctor();
  else if (command === "send-image" || command === "send-file") await sendMediaCommand(process.argv[3], command);
  else {
    usage();
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`[wechat-bridge] ${error?.stack || error}`);
  process.exitCode = 1;
}
