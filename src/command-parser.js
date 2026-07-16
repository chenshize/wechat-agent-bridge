const ALIASES = new Map([
  ["models", "model"],
  ["reasoning", "think"],
  ["claude", "claude-code"],
  ["workspace", "ws"],
]);

export const BRIDGE_COMMANDS = new Set([
  "help",
  "status",
  "codex",
  "claude-code",
  "model",
  "think",
  "new",
  "reset",
  "stop",
  "queue",
  "retry",
  "pwd",
  "cd",
  "ws",
  "access",
  "artifacts",
  "send",
  "doctor",
]);

export function parseBridgeCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const rawName = match[1].toLowerCase();
  const name = ALIASES.get(rawName) || rawName;
  if (!BRIDGE_COMMANDS.has(name)) return null;
  return { name, argument: (match[2] || "").trim(), raw: trimmed };
}

export function splitCommandArguments(value) {
  const parts = [];
  const source = String(value || "");
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("参数中的引号没有闭合");
  if (current) parts.push(current);
  return parts;
}

export function normalizeAccessMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["read-only", "readonly", "read", "只读"].includes(normalized)) return "read-only";
  if (["workspace", "workspace-write", "write", "工作区"].includes(normalized)) return "workspace";
  if (["full", "danger-full-access", "完全", "完全权限"].includes(normalized)) return "full";
  return "";
}

export function accessModeLabel(mode) {
  if (mode === "read-only") return "只读";
  if (mode === "workspace") return "工作区写入";
  if (mode === "full") return "完全权限";
  return mode || "未知";
}

export function commandHelpText() {
  return [
    "微信桥指令：",
    "/codex · /claude-code  切换 Agent",
    "/status  查看 Lane、模型、思考级别、工作区与权限",
    "/model [name]  查看或切换当前 Agent 模型",
    "/think [level]  查看或切换思考级别",
    "/new  为当前 Agent Lane 开启新会话",
    "/reset  等同于 /new",
    "/stop  停止当前任务",
    "/queue  查看等待中的消息",
    "/retry  重新执行上次异常中断的任务",
    "/pwd · /cd <path>  查看或切换安全工作区",
    "/ws list|save|use|remove  管理命名工作区",
    "/access [read-only|workspace|full]  查看或切换权限",
    "/artifacts  查看最近生成的文件",
    "/send <编号|相对路径>  手动发送工作区文件",
    "/doctor  查看桥接健康状态",
    "/help  查看本帮助",
  ].join("\n");
}
