import path from "node:path";

export function laneSessionRef(lane) {
  return String(lane?.threadId || lane?.sessionId || "").trim();
}

export function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'"'"'`)}'`;
}

export function nativeResumeCommand(lane) {
  const ref = laneSessionRef(lane);
  if (!ref) return "";
  const cwd = shellQuote(lane.cwd);
  const session = shellQuote(ref);
  return lane.provider === "claude-code"
    ? `cd ${cwd} && claude --resume ${session}`
    : `cd ${cwd} && codex resume ${session}`;
}

export function formatSessionList(lanes, { limit = 10 } = {}) {
  const sessions = (lanes || [])
    .filter((lane) => laneSessionRef(lane))
    .sort((a, b) => String(b.lastUsedAt || b.updatedAt || "").localeCompare(String(a.lastUsedAt || a.updatedAt || "")))
    .slice(0, limit);
  if (!sessions.length) return "当前没有已保存的 Agent 会话。发送一个任务后会自动记录原生 session。";
  return [
    "已保存的 Agent 会话：",
    ...sessions.map((lane, index) => {
      const provider = lane.provider === "claude-code" ? "Claude Code" : "Codex";
      const ref = laneSessionRef(lane);
      const workspace = path.basename(lane.cwd) || lane.cwd;
      return `${index + 1}. ${provider} · ${workspace} · ${lane.accessMode} · ${ref.slice(0, 4)}…${ref.slice(-4)}`;
    }),
    "发送 /resume-command 获取当前 Lane 的终端恢复命令。",
  ].join("\n");
}
