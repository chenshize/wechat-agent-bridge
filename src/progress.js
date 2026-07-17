const MAX_DETAIL_LENGTH = 280;

function compact(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r?\n\s*/g, " ↵ ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function redactCommand(value) {
  return compact(value)
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1<redacted>")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1<redacted>@")
    .replace(
      /\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:^|\s)--?(?:token|secret|password|passwd|api-key|private-key|access-key|client-secret|user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1<redacted>",
    );
}

function bounded(value, maxLength = MAX_DETAIL_LENGTH) {
  const text = compact(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function inputValue(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") return input[key];
  }
  return "";
}

function commandDetail(event) {
  const input = event?.input;
  let command = "";
  if (typeof input === "string") command = input;
  else if (Array.isArray(input)) command = input.join(" ");
  else command = inputValue(input, ["command", "cmd", "script"]);
  if (Array.isArray(command)) command = command.join(" ");
  return bounded(redactCommand(command));
}

function contextualDetail(event) {
  const input = event?.input;
  if (typeof input === "string") return bounded(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const detail = inputValue(input, [
    "file_path",
    "path",
    "query",
    "pattern",
    "url",
    "description",
  ]);
  return bounded(redactCommand(Array.isArray(detail) ? detail.join(", ") : detail));
}

function toolCategory(name) {
  const value = String(name || "").toLowerCase();
  if (/bash|command|shell/.test(value)) return "command";
  if (/edit|write|patch|file_change/.test(value)) return "write";
  if (/grep|glob|find|search/.test(value)) return "search";
  if (/read|list/.test(value)) return "read";
  if (/web|http|fetch/.test(value)) return "web";
  return "other";
}

function commandFingerprint(command) {
  const parts = compact(command).split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ").toLowerCase();
}

function significantCommand(command) {
  const value = compact(command).toLowerCase();
  if (/^(?:pwd|ls|find|rg|grep|cat|head|tail|wc|which)(?:\s|$)/.test(value)) return false;
  if (/^git\s+(?:status|diff|log|show)(?:\s|$)/.test(value)) return false;
  return Boolean(value);
}

function progressIcon(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("search")) return "🔎";
  if (value.includes("web") || value.includes("http")) return "🌐";
  if (/read|grep|glob|find|list/.test(value)) return "📖";
  if (/edit|write|patch|file_change/.test(value)) return "🛠️";
  if (/bash|command|shell/.test(value)) return "💻";
  return "⚙️";
}

export function formatToolProgress(event) {
  const { name, isCommand, detail } = describeToolProgress(event);
  if (isCommand && detail) {
    return `${progressIcon(name)} 正在执行命令：\n${detail}\n请稍等…`;
  }
  if (detail) {
    return `${progressIcon(name)} 正在执行：${name}\n目标：${detail}\n请稍等…`;
  }
  return `${progressIcon(name)} 正在执行：${name}\n请稍等…`;
}

export function describeToolProgress(event) {
  const name = bounded(event?.name || "tool", 120);
  const category = toolCategory(name);
  const isCommand = category === "command";
  const detail = isCommand ? commandDetail(event) : contextualDetail(event);
  const fingerprint = isCommand
    ? `${category}:${commandFingerprint(detail) || name.toLowerCase()}`
    : `${category}:${name.toLowerCase()}`;
  return {
    name,
    category,
    isCommand,
    detail,
    fingerprint,
    significant: category === "command"
      ? significantCommand(detail)
      : ["write", "web", "other"].includes(category),
  };
}

export function formatToolFailure(startEvent, resultEvent) {
  const descriptor = describeToolProgress(startEvent || resultEvent);
  const exitCode = resultEvent?.exitCode ?? resultEvent?.exit_code ??
    resultEvent?.raw?.item?.exit_code ?? resultEvent?.raw?.exit_code;
  const title = descriptor.isCommand ? "⚠️ 命令执行失败" : `⚠️ 工具执行失败：${descriptor.name}`;
  const lines = [title];
  if (descriptor.detail) lines.push(`${descriptor.isCommand ? "命令" : "目标"}：${descriptor.detail}`);
  if (exitCode !== undefined && exitCode !== null && exitCode !== "") lines.push(`退出码：${exitCode}`);
  lines.push("Agent 正在继续处理。 ");
  return lines.join("\n").trim();
}
