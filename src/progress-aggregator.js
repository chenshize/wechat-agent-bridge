import { describeToolProgress, formatToolFailure, formatToolProgress } from "./progress.js";

const CATEGORY_LABELS = Object.freeze({
  command: "命令",
  read: "读取",
  search: "搜索",
  write: "修改",
  web: "联网",
  other: "其他",
});

function emptyCounts() {
  return { command: 0, read: 0, search: 0, write: 0, web: 0, other: 0 };
}

function failedResult(event) {
  if (String(event?.status || "").toLowerCase() === "failed") return true;
  if (event?.raw?.item?.exit_code !== undefined) return event.raw.item.exit_code !== 0;
  if (event?.raw?.exit_code !== undefined) return event.raw.exit_code !== 0;
  return Boolean(event?.is_error || event?.raw?.is_error);
}

export class ProgressAggregator {
  constructor({ maxTrackedSamples = 50, maxTrackedStarts = 200, maxImmediateFailures = 5 } = {}) {
    this.maxTrackedSamples = Math.max(5, maxTrackedSamples);
    this.maxTrackedStarts = Math.max(10, maxTrackedStarts);
    this.maxImmediateFailures = Math.max(1, maxImmediateFailures);
    this.windowCounts = emptyCounts();
    this.totalCounts = emptyCounts();
    this.samples = new Map();
    this.started = new Map();
    this.seenFailures = new Set();
    this.immediateFailures = 0;
    this.pendingTotal = 0;
  }

  record(event) {
    if (event?.type === "tool_use") return this.#recordStart(event);
    if (event?.type === "tool_result") return this.#recordResult(event);
    return {};
  }

  #recordStart(event) {
    const descriptor = describeToolProgress(event);
    this.windowCounts[descriptor.category] += 1;
    this.totalCounts[descriptor.category] += 1;
    this.pendingTotal += 1;
    if (event.id) {
      if (this.started.size >= this.maxTrackedStarts) this.started.delete(this.started.keys().next().value);
      this.started.set(String(event.id), { event, descriptor, startedAt: Date.now() });
    }
    const existing = this.samples.get(descriptor.fingerprint);
    if (existing) {
      existing.count += 1;
      existing.event = event;
      existing.descriptor = descriptor;
    } else {
      if (this.samples.size >= this.maxTrackedSamples) this.samples.delete(this.samples.keys().next().value);
      this.samples.set(descriptor.fingerprint, { count: 1, event, descriptor });
    }
    return { descriptor, significant: descriptor.significant, hasPending: true };
  }

  #recordResult(event) {
    const started = event.id ? this.started.get(String(event.id)) : undefined;
    if (event.id) this.started.delete(String(event.id));
    if (!failedResult(event)) return {};
    const descriptor = started?.descriptor || describeToolProgress(event);
    const failureKey = descriptor.fingerprint;
    if (this.seenFailures.has(failureKey) || this.immediateFailures >= this.maxImmediateFailures) {
      return { duplicateFailure: true };
    }
    this.seenFailures.add(failureKey);
    this.immediateFailures += 1;
    return {
      failure: true,
      immediate: formatToolFailure(started?.event, event),
      descriptor,
    };
  }

  hasPending() {
    return this.pendingTotal > 0;
  }

  suppressSample(fingerprint) {
    if (fingerprint) this.samples.delete(fingerprint);
  }

  discardPending() {
    this.windowCounts = emptyCounts();
    this.samples.clear();
    this.pendingTotal = 0;
  }

  takeSummary(mode = "normal", { maxExamples = 4 } = {}) {
    if (!this.pendingTotal) return "";
    const counts = Object.entries(this.windowCounts)
      .filter(([, count]) => count > 0)
      .map(([category, count]) => `${CATEGORY_LABELS[category]} ${count}`)
      .join(" · ");
    const allSamples = [...this.samples.values()];
    const preferred = mode === "verbose"
      ? allSamples
      : allSamples.filter(({ descriptor }) => descriptor.significant);
    const examples = preferred
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, maxExamples));
    const shownCount = examples.reduce((sum, item) => sum + item.count, 0);
    const lines = [mode === "verbose" ? "🔎 执行明细" : "🛠️ 执行进展", counts];
    if (examples.length) {
      lines.push("关键操作：");
      for (const sample of examples) {
        const descriptor = sample.descriptor;
        const label = descriptor.detail
          ? descriptor.isCommand ? descriptor.detail : `${descriptor.name}：${descriptor.detail}`
          : descriptor.name;
        lines.push(`- ${label}${sample.count > 1 ? ` ×${sample.count}` : ""}`);
      }
    }
    if (this.pendingTotal > shownCount) lines.push(`另有 ${this.pendingTotal - shownCount} 项已折叠`);
    this.windowCounts = emptyCounts();
    this.samples.clear();
    this.pendingTotal = 0;
    return lines.filter(Boolean).join("\n");
  }

  immediateFirstMessage(event) {
    return formatToolProgress(event);
  }
}
