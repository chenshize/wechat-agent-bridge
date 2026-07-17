export const NOTIFICATION_MODES = Object.freeze(["quiet", "normal", "verbose"]);

export function normalizeNotificationMode(value, fallback = "normal") {
  const normalized = String(value || "").trim().toLowerCase();
  if (NOTIFICATION_MODES.includes(normalized)) return normalized;
  return NOTIFICATION_MODES.includes(fallback) ? fallback : "normal";
}

export function notificationModeLabel(mode) {
  if (mode === "quiet") return "安静（只发关键结果）";
  if (mode === "verbose") return "详细（5 秒执行摘要）";
  return "标准（30 秒阶段摘要）";
}

export function shouldRelayToolProgress(mode) {
  return normalizeNotificationMode(mode) !== "quiet";
}

export function progressHeartbeatMs(mode, configuredValue) {
  if (configuredValue !== undefined && configuredValue !== "") {
    const parsed = Number.parseInt(String(configuredValue), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  if (mode === "quiet") return 0;
  return mode === "verbose" ? 45_000 : 180_000;
}

function safeText(value, maxLength = 600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function formatInteractionNotification(event, providerLabel = "Agent") {
  if (event?.type === "question") {
    const question = safeText(event.question || event.message || event.prompt || "Agent 需要补充信息");
    return `❓ ${providerLabel} 请求输入\n${question}\n\n直接回复这条微信即可通过原生 Session 继续。`;
  }
  if (event?.type === "approval_request") {
    const request = safeText(event.message || event.reason || event.command || "Agent 请求确认下一步");
    return `⚠️ ${providerLabel} 请求确认\n${request}\n\n当前桥不会替 Agent 决定权限；请直接回复你的决定。`;
  }
  return "";
}

function usageText(usage) {
  if (!usage || typeof usage !== "object") return "";
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  const parts = [];
  if (Number.isFinite(input)) parts.push(`输入 ${input}`);
  if (Number.isFinite(output)) parts.push(`输出 ${output}`);
  return parts.length ? `${parts.join(" / ")} tokens` : "";
}

function durationText(milliseconds) {
  const seconds = Math.max(1, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function completionReceipt({ taskId, provider, durationMs, usage, artifactCount = 0 } = {}) {
  const parts = [
    `✅ ${provider || "Agent"} 已完成`,
    taskId ? `任务 ${taskId}` : "",
    durationText(durationMs),
    usageText(usage),
    artifactCount ? `产物 ${artifactCount} 个` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
