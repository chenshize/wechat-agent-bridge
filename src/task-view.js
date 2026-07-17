import { createHash } from "node:crypto";
import path from "node:path";

const STATUS_LABELS = Object.freeze({
  received: "已接收",
  queued: "排队中",
  running: "执行中",
  interrupted: "已中断",
  failed: "失败",
  completed: "结果待发送",
  done: "已完成",
  cancelled: "已取消",
});

export function taskPublicId(recordOrId) {
  const id = typeof recordOrId === "object" ? recordOrId?.id : recordOrId;
  return createHash("sha256").update(String(id || "")).digest("hex").slice(0, 8);
}

export function taskStatusLabel(status) {
  return STATUS_LABELS[status] || String(status || "未知");
}

function taskRuntime(record) {
  return record?.runtimeSnapshot || record?.task?.runtimeSnapshot || {};
}

function timestamp(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "未知";
  return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
}

export function findTaskByPublicId(records, publicId) {
  const normalized = String(publicId || "").trim().toLowerCase();
  if (!/^[a-f0-9]{4,64}$/.test(normalized)) return null;
  const matches = (records || []).filter((record) => taskPublicId(record).startsWith(normalized));
  return matches.length === 1 ? matches[0] : null;
}

export function formatTaskList(records, { limit = 8 } = {}) {
  const tasks = (records || [])
    .filter((record) => record?.kind === "work")
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit);
  if (!tasks.length) return "当前没有可显示的任务记录。";
  return [
    "最近任务：",
    ...tasks.map((record) => {
      const runtime = taskRuntime(record);
      const provider = runtime.provider === "claude-code" ? "Claude Code" : runtime.provider === "codex" ? "Codex" : "Agent";
      const workspace = runtime.cwd ? path.basename(runtime.cwd) || runtime.cwd : "未知项目";
      return `${taskPublicId(record)} · ${taskStatusLabel(record.status)} · ${provider} · ${workspace}`;
    }),
    "发送 /task <编号> 查看详情。",
  ].join("\n");
}

export function formatTaskDetail(record) {
  if (!record) return "没有找到唯一匹配的任务。请先发送 /tasks 查看编号。";
  const runtime = taskRuntime(record);
  const lines = [
    `任务：${taskPublicId(record)}`,
    `状态：${taskStatusLabel(record.status)}`,
    `Agent：${runtime.provider === "claude-code" ? "Claude Code" : runtime.provider === "codex" ? "Codex" : "未知"}`,
    `工作区：${runtime.cwd || "未知"}`,
    `权限：${runtime.accessMode || "未知"}`,
    `模型：${runtime.model || "未知"}`,
    `思考级别：${runtime.effort || "未知"}`,
    `接收时间：${timestamp(record.receivedAt)}`,
    `更新时间：${timestamp(record.updatedAt)}`,
  ];
  if (record.lastError) lines.push(`最近错误：${String(record.lastError).slice(0, 300)}`);
  if (["failed", "interrupted"].includes(record.status)) lines.push("下一步：检查项目状态后发送 /retry。 ");
  return lines.join("\n").trimEnd();
}
