import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startJsonLineAgent, normalizeAccessMode, splitCommandArgs } from "./agent-runtime.js";
import { loadCodexModel, loadCodexReasoningEffort, loadHistory } from "./state.js";

function imagePathsFrom({ imagePaths = [], attachments = [] } = {}) {
  const paths = [...imagePaths];
  for (const attachment of attachments || []) {
    if (typeof attachment === "string") {
      paths.push(attachment);
      continue;
    }
    if (attachment?.path && (attachment.kind === "image" || String(attachment.mime || "").startsWith("image/"))) {
      paths.push(attachment.path);
    }
  }
  return [...new Set(paths.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function codexAccessArgs(accessMode = "full") {
  switch (normalizeAccessMode(accessMode)) {
    case "read-only":
      return { global: ["--ask-for-approval", "never"], exec: ["--sandbox", "read-only"] };
    case "workspace":
      return { global: ["--ask-for-approval", "never"], exec: ["--sandbox", "workspace-write"] };
    case "full":
      return { global: [], exec: ["--dangerously-bypass-approvals-and-sandbox"] };
    default:
      return { global: [], exec: [] };
  }
}

/** Build argv without invoking Codex. Exported for diagnostics and tests. */
export function buildCodexArgs({
  outputFile,
  cwd = process.cwd(),
  threadId = "",
  sessionRef = "",
  model = loadCodexModel(),
  effort = loadCodexReasoningEffort(),
  accessMode = "full",
  imagePaths = [],
  attachments = [],
  extraArgs,
} = {}) {
  if (extraArgs !== undefined) {
    return Array.isArray(extraArgs) ? [...extraArgs] : splitCommandArgs(extraArgs);
  }

  const priorThread = String(threadId || sessionRef || "").trim();
  const accessArgs = codexAccessArgs(accessMode);
  const common = [
    ...accessArgs.global,
    "exec",
    "--model",
    String(model),
    "-c",
    `model_reasoning_effort=${JSON.stringify(String(effort))}`,
    ...accessArgs.exec,
    "--skip-git-repo-check",
    "-C",
    path.resolve(cwd),
  ];
  const outputArgs = outputFile ? ["--output-last-message", outputFile] : [];
  const images = imagePathsFrom({ imagePaths, attachments }).flatMap((imagePath) => ["--image", imagePath]);

  // `-C` is an exec-level option and must precede the resume subcommand. JSON,
  // output, model and image flags are accepted by the resume subcommand itself.
  if (priorThread) {
    return [...common, "resume", "--json", ...outputArgs, ...images, priorThread, "-"];
  }
  return [...common, "--json", ...outputArgs, ...images, "-"];
}

export function buildCodexPrompt({ text, history = [], resumed = false, attachments = [] } = {}) {
  const nonImagePaths = [];
  for (const attachment of attachments) {
    if (typeof attachment === "string") {
      nonImagePaths.push(attachment);
      continue;
    }
    const isImage = attachment?.kind === "image" || String(attachment?.mime || attachment?.mimeType || "").startsWith("image/");
    if (attachment?.path && !isImage) nonImagePaths.push(attachment.path);
  }
  const attachmentText = nonImagePaths.length
    ? [
        "",
        "本轮微信消息还包含以下已安全缓存的本地文件。仅在完成请求所必需时读取；格式支持取决于可用工具：",
        ...[...new Set(nonImagePaths)].map((filePath, index) => `${index + 1}. ${path.resolve(filePath)}`),
      ].join("\n")
    : "";
  if (resumed) return `${String(text || "")}${attachmentText}`;
  const historyText = history
    .slice(-12)
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  return [
    "你是通过个人微信接入的本地 Codex 助手。用中文简洁回答，除非用户要求其它语言。",
    "不要提及内部桥接实现，除非用户询问。",
    "如果用户要求执行本机操作，先判断风险；默认只做必要、可解释的操作。",
    "",
    historyText ? `最近对话:\n${historyText}\n` : "",
    `当前用户消息:\n${String(text || "")}${attachmentText}`,
  ].join("\n");
}

function itemText(item) {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.content === "string") return item.content;
  if (typeof item?.message === "string") return item.message;
  return "";
}

function toolName(item) {
  return item?.name || item?.tool_name || item?.type || "tool";
}

function toolOutput(item) {
  return item?.aggregated_output ?? item?.output ?? item?.result ?? item?.error ?? "";
}

function isToolItem(item) {
  const type = String(item?.type || "");
  return type === "command_execution" || type === "tool_call" || type === "mcp_tool_call" ||
    type === "web_search" || type === "file_change" || type.endsWith("_tool_call");
}

/** Normalize one already-parsed Codex JSONL record. */
export function normalizeCodexEvent(raw) {
  if (!raw || typeof raw !== "object") return { events: [] };
  const events = [];
  const sessionRef = raw.thread_id || raw.thread?.id || "";
  let finalText = "";
  let usage = null;

  if (raw.type === "thread.started") {
    events.push({ type: "system", name: "session_started", sessionRef, raw });
  } else if (raw.type === "turn.started") {
    events.push({ type: "system", name: "turn_started", raw });
  } else if (raw.type === "turn.completed") {
    usage = raw.usage || raw.turn?.usage || null;
    if (usage) events.push({ type: "usage", usage, raw });
  } else if (raw.type === "turn.failed" || raw.type === "error") {
    const message = raw.message || raw.error?.message || raw.error || "Codex reported an error";
    events.push({ type: "error", message: String(message), fatal: raw.type === "turn.failed", raw });
  } else if (raw.type === "item.completed" || raw.type === "item.started" || raw.type === "item.updated") {
    const item = raw.item || {};
    const phase = raw.type.split(".")[1];
    const type = String(item.type || "");
    if (["request_user_input", "user_input_request", "question"].includes(type) && phase === "started") {
      events.push({
        type: "question",
        id: item.id || "",
        question: item.question || item.prompt || item.message || itemText(item) || "Codex needs input",
        raw,
      });
    } else if (["approval_request", "command_approval", "file_change_approval"].includes(type) && phase === "started") {
      events.push({
        type: "approval_request",
        id: item.id || "",
        message: item.reason || item.command || itemText(item) || "Codex requests approval",
        raw,
      });
    } else if (type === "file_change" && phase === "completed") {
      events.push({ type: "diff", id: item.id || "", output: toolOutput(item), status: item.status || "completed", raw });
    } else if (type === "agent_message" && phase === "completed") {
      finalText = itemText(item).trim();
      if (finalText) events.push({ type: "text", text: finalText, final: true, raw });
    } else if (type === "reasoning" && phase === "completed") {
      const text = itemText(item).trim();
      if (text) events.push({ type: "thinking", text, raw });
    } else if (isToolItem(item) && phase === "started") {
      events.push({
        type: "tool_use",
        id: item.id || "",
        name: toolName(item),
        input: item.command ?? item.arguments ?? item.input ?? item.query ?? null,
        raw,
      });
    } else if (isToolItem(item) && phase === "completed") {
      events.push({
        type: "tool_result",
        id: item.id || "",
        name: toolName(item),
        output: toolOutput(item),
        status: item.status || (item.exit_code === 0 ? "completed" : "failed"),
        raw,
      });
    }
  } else if (raw.type === "agent_message.delta" || raw.type === "item.agent_message.delta") {
    const text = String(raw.delta || raw.text || "");
    if (text) events.push({ type: "text", text, delta: true, raw });
  } else if (raw.type === "reasoning.delta" || raw.type === "item.reasoning.delta") {
    const text = String(raw.delta || raw.text || "");
    if (text) events.push({ type: "thinking", text, delta: true, raw });
  }

  return { events, sessionRef, finalText, usage };
}

export function parseCodexJsonLine(line) {
  return normalizeCodexEvent(JSON.parse(line));
}

export function isAgentStoppedError(err) {
  return err?.code === "AGENT_STOPPED";
}

export function startAgent({
  peerId,
  text,
  onOutput,
  onEvent,
  cwd = process.env.WECHAT_BRIDGE_CWD || process.env.WEIXIN_CODEX_CWD || process.cwd(),
  accessMode = "full",
  threadId = "",
  sessionRef = "",
  model = loadCodexModel(),
  effort = loadCodexReasoningEffort(),
  imagePaths = [],
  attachments = [],
  timeoutMs,
  extraArgs,
} = {}) {
  const provider = "codex";
  const priorThread = String(threadId || sessionRef || "").trim();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-codex-"));
  const outputFile = path.join(tmpDir, "last-message.txt");
  const envArgs = process.env.WECHAT_BRIDGE_CODEX_ARGS?.trim() || process.env.WEIXIN_CODEX_ARGS?.trim();
  const args = buildCodexArgs({
    outputFile,
    cwd,
    threadId: priorThread,
    model,
    effort,
    accessMode,
    imagePaths,
    attachments,
    extraArgs: extraArgs ?? (envArgs || undefined),
  });
  const prompt = buildCodexPrompt({
    text,
    history: priorThread ? [] : loadHistory(peerId || ""),
    resumed: Boolean(priorThread),
    attachments,
  });

  const task = startJsonLineAgent({
    provider,
    bin: "codex",
    args,
    cwd,
    prompt,
    onOutput,
    onEvent,
    parseLine: parseCodexJsonLine,
    initialSessionRef: priorThread,
    timeoutMs,
    finalize({ finalText }) {
      if (fs.existsSync(outputFile)) {
        const fromFile = fs.readFileSync(outputFile, "utf8").trim();
        if (fromFile) return fromFile;
      }
      return finalText;
    },
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  });

  return {
    provider,
    get promise() {
      return task.promise;
    },
    get resultPromise() {
      return task.resultPromise.then((result) => ({ ...result, threadId: result.sessionRef }));
    },
    get final() {
      return task.final;
    },
    get sessionRef() {
      return task.sessionRef;
    },
    get threadId() {
      return task.sessionRef;
    },
    cancel: task.cancel,
  };
}

export async function askAgent(args) {
  const task = startAgent(args);
  return await task.promise;
}

export const askCodex = askAgent;
