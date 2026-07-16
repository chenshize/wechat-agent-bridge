import path from "node:path";

import { normalizeAccessMode, splitCommandArgs, startJsonLineAgent } from "./agent-runtime.js";
import { loadClaudeModel, loadClaudeReasoningEffort, loadHistory } from "./state.js";

export function claudeAccessArgs(accessMode = "full") {
  switch (normalizeAccessMode(accessMode)) {
    case "read-only":
      return ["--permission-mode", "plan"];
    case "workspace":
      return ["--permission-mode", "acceptEdits"];
    case "full":
      return ["--dangerously-skip-permissions"];
    default:
      return [];
  }
}

/** Build argv without invoking Claude Code. Exported for diagnostics and tests. */
export function buildClaudeArgs({
  sessionId = "",
  sessionRef = "",
  model = loadClaudeModel(),
  effort = loadClaudeReasoningEffort(),
  accessMode = "full",
  extraArgs,
} = {}) {
  if (extraArgs !== undefined) {
    return Array.isArray(extraArgs) ? [...extraArgs] : splitCommandArgs(extraArgs);
  }
  const priorSession = String(sessionId || sessionRef || "").trim();
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    ...claudeAccessArgs(accessMode),
    "--model",
    String(model),
    "--effort",
    String(effort),
    ...(priorSession ? ["--resume", priorSession] : []),
  ];
}

function attachmentPaths({ attachmentPaths = [], imagePaths = [], attachments = [] } = {}) {
  const paths = [...attachmentPaths, ...imagePaths];
  for (const attachment of attachments || []) {
    if (typeof attachment === "string") paths.push(attachment);
    else if (attachment?.path) paths.push(attachment.path);
  }
  return [...new Set(paths.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function buildClaudePrompt({ text, history = [], resumed = false, attachments = [] } = {}) {
  const attachmentText = attachments.length
    ? [
        "",
        "本轮微信消息包含以下已下载的本地附件。仅在完成请求所必需时读取它们：",
        ...attachments.map((filePath, index) => `${index + 1}. ${path.resolve(filePath)}`),
      ].join("\n")
    : "";
  if (resumed) return `${String(text || "")}${attachmentText}`;
  const historyText = history
    .slice(-12)
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  return [
    "你是通过个人微信接入的本地 Claude Code 助手。用中文简洁回答，除非用户要求其它语言。",
    "不要提及内部桥接实现，除非用户询问。",
    "如果用户要求执行本机操作，先判断风险；默认只做必要、可解释的操作。",
    "",
    historyText ? `最近对话:\n${historyText}\n` : "",
    `当前用户消息:\n${String(text || "")}${attachmentText}`,
  ].join("\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function normalizeContentBlocks(content, raw) {
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      events.push({ type: "text", text: block.text, raw });
    } else if (block.type === "thinking") {
      const text = String(block.thinking || block.text || "");
      if (text) events.push({ type: "thinking", text, raw });
    } else if (block.type === "tool_use") {
      events.push({
        type: "tool_use",
        id: block.id || "",
        name: block.name || "tool",
        input: block.input ?? null,
        raw,
      });
    } else if (block.type === "tool_result") {
      events.push({
        type: "tool_result",
        id: block.tool_use_id || block.id || "",
        name: block.name || "tool",
        output: block.content ?? block.output ?? "",
        status: block.is_error ? "failed" : "completed",
        raw,
      });
    }
  }
  return events;
}

/** Normalize one already-parsed Claude Code stream-json record. */
export function normalizeClaudeEvent(raw) {
  if (!raw || typeof raw !== "object") return { events: [] };
  const events = [];
  const sessionRef = raw.session_id || raw.sessionId || "";
  let finalText = "";
  let usage = null;

  if (raw.type === "system") {
    events.push({
      type: "system",
      name: raw.subtype || "system",
      message: raw.message || "",
      sessionRef,
      model: raw.model || "",
      cwd: raw.cwd || "",
      raw,
    });
  } else if (raw.type === "assistant") {
    const content = raw.message?.content;
    events.push(...normalizeContentBlocks(content, raw));
    finalText = contentText(content).trim();
    usage = raw.message?.usage || raw.usage || null;
    if (usage) events.push({ type: "usage", usage, raw });
  } else if (raw.type === "user") {
    events.push(...normalizeContentBlocks(raw.message?.content, raw));
  } else if (raw.type === "content_block_start") {
    events.push(...normalizeContentBlocks([raw.content_block], raw));
  } else if (raw.type === "content_block_delta") {
    const delta = raw.delta || {};
    if (delta.type === "text_delta" && delta.text) {
      events.push({ type: "text", text: delta.text, delta: true, raw });
    } else if (delta.type === "thinking_delta" && delta.thinking) {
      events.push({ type: "thinking", text: delta.thinking, delta: true, raw });
    } else if (delta.type === "input_json_delta") {
      events.push({
        type: "system",
        name: "tool_input_delta",
        message: delta.partial_json || "",
        raw,
      });
    }
  } else if (raw.type === "result") {
    finalText = typeof raw.result === "string" ? raw.result.trim() : "";
    usage = raw.usage || null;
    if (usage) events.push({ type: "usage", usage, raw });
    if (raw.is_error || raw.subtype === "error") {
      events.push({
        type: "error",
        message: finalText || raw.error || "Claude Code reported an error",
        fatal: true,
        raw,
      });
    }
  } else if (raw.type === "error") {
    events.push({
      type: "error",
      message: String(raw.message || raw.error?.message || raw.error || "Claude Code reported an error"),
      fatal: true,
      raw,
    });
  }

  return { events, sessionRef, finalText, usage };
}

export function parseClaudeJsonLine(line) {
  return normalizeClaudeEvent(JSON.parse(line));
}

export function startClaudeCode({
  peerId,
  text,
  onOutput,
  onEvent,
  cwd = process.env.WECHAT_BRIDGE_CWD || process.env.WEIXIN_CODEX_CWD || process.cwd(),
  accessMode = "full",
  sessionId = "",
  sessionRef = "",
  model = loadClaudeModel(),
  effort = loadClaudeReasoningEffort(),
  attachmentPaths: files = [],
  imagePaths = [],
  attachments = [],
  timeoutMs,
  extraArgs,
} = {}) {
  const provider = "claude-code";
  const priorSession = String(sessionId || sessionRef || "").trim();
  const envArgs = process.env.WECHAT_BRIDGE_CLAUDE_CODE_ARGS?.trim();
  const args = buildClaudeArgs({
    sessionId: priorSession,
    model,
    effort,
    accessMode,
    extraArgs: extraArgs ?? (envArgs || undefined),
  });
  const localAttachments = attachmentPaths({
    attachmentPaths: files,
    imagePaths,
    attachments,
  });
  const prompt = buildClaudePrompt({
    text,
    history: priorSession ? [] : loadHistory(peerId || ""),
    resumed: Boolean(priorSession),
    attachments: localAttachments,
  });
  const task = startJsonLineAgent({
    provider,
    bin: "claude",
    args,
    cwd,
    prompt,
    onOutput,
    onEvent,
    parseLine: parseClaudeJsonLine,
    initialSessionRef: priorSession,
    timeoutMs,
  });

  return {
    provider,
    get promise() {
      return task.promise;
    },
    get resultPromise() {
      return task.resultPromise.then((result) => ({ ...result, sessionId: result.sessionRef }));
    },
    get final() {
      return task.final;
    },
    get sessionRef() {
      return task.sessionRef;
    },
    get sessionId() {
      return task.sessionRef;
    },
    cancel: task.cancel,
  };
}
