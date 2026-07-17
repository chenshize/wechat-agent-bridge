import { spawn } from "node:child_process";

export const AGENT_EVENT_TYPES = Object.freeze([
  "system",
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "question",
  "approval_request",
  "diff",
  "test_result",
  "usage",
  "done",
  "error",
]);

const EVENT_TYPE_SET = new Set(AGENT_EVENT_TYPES);

export function splitCommandArgs(value) {
  return String(value || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^(["'])(.*)\1$/, "$2")
  ) || [];
}

export function normalizeAccessMode(value, fallback = "full") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (["read-only", "readonly", "read_only", "plan"].includes(normalized)) return "read-only";
  if (["workspace", "workspace-write", "workspace_write", "acceptedits"].includes(normalized)) {
    return "workspace";
  }
  if (["full", "danger-full-access", "bypasspermissions"].includes(normalized)) return "full";
  throw new Error(`unsupported access mode: ${value || "<empty>"}`);
}

export function agentTimeoutMs(value) {
  const parsed = Number.parseInt(
    String(value ?? process.env.WECHAT_BRIDGE_TIMEOUT_MS ?? process.env.WEIXIN_CODEX_TIMEOUT_MS ?? "600000"),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600000;
}

function stoppedError(provider) {
  const err = new Error(`${provider} stopped`);
  err.code = "AGENT_STOPPED";
  return err;
}

function timeoutError(provider, timeoutMs) {
  const err = new Error(`${provider} timed out after ${timeoutMs}ms`);
  err.code = "AGENT_TIMEOUT";
  return err;
}

function exitError(provider, code, signal, stderr, stdout) {
  const detail = String(stderr || stdout || "").trim();
  const suffix = signal ? ` (signal ${signal})` : "";
  const err = new Error(`${provider} exited ${code ?? "without a code"}${suffix}${detail ? `: ${detail}` : ""}`);
  err.code = "AGENT_EXITED";
  err.exitCode = code;
  err.signal = signal;
  return err;
}

/**
 * Run an NDJSON-emitting coding-agent process.
 *
 * `parseLine` is deliberately adapter-owned: it returns normalized events plus
 * optional `sessionRef`, `finalText`, and `usage` discoveries. Raw stdout/stderr
 * remains available through the legacy `onOutput` callback.
 */
export function startJsonLineAgent({
  provider,
  bin,
  args,
  cwd,
  env = process.env,
  prompt = "",
  onOutput,
  onEvent,
  parseLine,
  finalize,
  cleanup,
  initialSessionRef = "",
  timeoutMs: requestedTimeoutMs,
  killGraceMs = 5000,
  maxCaptureChars = 512 * 1024,
  maxLineChars = 1024 * 1024,
  maxReplyChars = 48 * 1024,
} = {}) {
  if (!provider) throw new Error("provider is required");
  if (!bin) throw new Error("agent binary is required");
  if (!Array.isArray(args)) throw new Error("agent args must be an array");

  const timeoutMs = agentTimeoutMs(requestedTimeoutMs);
  const usesProcessGroup = process.platform !== "win32";
  const child = spawn(bin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    // A coding agent can launch shells, build tools, and other descendants.
    // Give the lane its own POSIX process group so /stop can terminate the
    // whole tree instead of only the CLI leader.
    detached: usesProcessGroup,
    windowsHide: true,
  });

  const state = {
    provider,
    sessionRef: String(initialSessionRef || ""),
    finalText: "",
    usage: null,
    fatalError: null,
    stdout: "",
    stderr: "",
  };
  let stdoutBuffer = "";
  let discardingOversizedLine = false;
  let stopReason = "";
  let killTimer;
  let settled = false;
  let cleanedUp = false;

  function appendTail(current, text, limit) {
    const combined = `${current}${text}`;
    return combined.length <= limit ? combined : combined.slice(-limit);
  }

  function boundedReply(value) {
    const text = String(value || "").trim();
    if (text.length <= maxReplyChars) return text;
    return `${text.slice(0, maxReplyChars)}\n\n[回复过长，已在微信桥截断；请让 Agent 将完整内容写入工作区文件后用 /send 发送。]`;
  }

  function runCleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      cleanup?.();
    } catch {
      // Temporary-file cleanup is best effort and must not mask the task result.
    }
  }

  function emit(event) {
    if (!event || !EVENT_TYPE_SET.has(event.type)) return;
    const normalized = event.provider ? event : { ...event, provider };
    if (normalized.type === "error" && normalized.fatal) {
      const fatal = new Error(String(normalized.message || `${provider} reported a fatal error`));
      fatal.code = normalized.code || "AGENT_REPORTED_ERROR";
      state.fatalError = fatal;
    }
    if (normalized.sessionRef) state.sessionRef = String(normalized.sessionRef);
    if (normalized.type === "usage" && normalized.usage) state.usage = normalized.usage;
    try {
      onEvent?.(normalized);
    } catch {
      // A UI/progress callback must never terminate the underlying coding task.
    }
  }

  function consumeLine(line) {
    if (!line.trim() || typeof parseLine !== "function") return;
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (err) {
      emit({
        type: "system",
        name: "unparsed_output",
        message: `Ignored malformed agent output: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!parsed) return;
    if (parsed.sessionRef) state.sessionRef = String(parsed.sessionRef);
    if (typeof parsed.finalText === "string" && parsed.finalText.trim()) {
      state.finalText = boundedReply(parsed.finalText);
    }
    if (parsed.usage) state.usage = parsed.usage;
    for (const event of parsed.events || []) emit(event);
  }

  function consumeStdoutChunk(text) {
    state.stdout = appendTail(state.stdout, text, maxCaptureChars);
    let remaining = text;
    if (discardingOversizedLine) {
      const newline = remaining.indexOf("\n");
      if (newline === -1) return;
      remaining = remaining.slice(newline + 1);
      discardingOversizedLine = false;
    }
    stdoutBuffer += remaining;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      let line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > maxLineChars) {
        emit({ type: "system", name: "oversized_output", message: "Ignored an oversized agent event" });
      } else {
        consumeLine(line);
      }
    }
    if (stdoutBuffer.length > maxLineChars) {
      stdoutBuffer = "";
      discardingOversizedLine = true;
      emit({ type: "system", name: "oversized_output", message: "Ignored an oversized agent event" });
    }
  }

  function signalProcessTree(signal) {
    if (child.pid && usesProcessGroup) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {
            // The process may already have exited between checks.
          }
          return;
        }
      }
    }
    if (child.pid && process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("error", () => {
        try {
          child.kill(signal);
        } catch {
          // Best effort fallback when taskkill is unavailable.
        }
      });
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited between checks.
    }
  }

  function terminate(reason) {
    if (!stopReason) stopReason = reason;
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessTree("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => {
        // The leader can exit before one of its tools. Always signal the group
        // after the grace period; ESRCH is harmless when it is already gone.
        signalProcessTree("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    }
  }

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    timer.unref?.();

    function cleanupTimers() {
      clearTimeout(timer);
      // After cancellation the CLI leader may exit before a descendant that
      // ignored SIGTERM. Keep the unref'ed group SIGKILL timer alive.
      if (killTimer && !stopReason) clearTimeout(killTimer);
    }

    function rejectOnce(err) {
      if (settled) return;
      settled = true;
      cleanupTimers();
      runCleanup();
      emit({ type: "error", message: err.message, code: err.code || "AGENT_ERROR", fatal: true });
      reject(err);
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      onOutput?.({ stream: "stdout", text });
      consumeStdoutChunk(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      state.stderr = appendTail(state.stderr, text, maxCaptureChars);
      onOutput?.({ stream: "stderr", text });
    });
    child.stdin.on("error", () => {
      // EPIPE is expected if an agent exits before consuming the full prompt.
    });
    child.on("error", rejectOnce);
    child.on("close", (code, signal) => {
      cleanupTimers();
      if (settled) return;
      if (!discardingOversizedLine && stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      stdoutBuffer = "";

      if (stopReason === "stopped") {
        rejectOnce(stoppedError(provider));
        return;
      }
      if (stopReason === "timeout") {
        rejectOnce(timeoutError(provider, timeoutMs));
        return;
      }
      if (code !== 0) {
        rejectOnce(exitError(provider, code, signal, state.stderr, state.stdout));
        return;
      }
      if (state.fatalError) {
        rejectOnce(state.fatalError);
        return;
      }

      let finalText = state.finalText;
      try {
        const finalized = finalize?.({ ...state });
        if (typeof finalized === "string" && finalized.trim()) finalText = boundedReply(finalized);
        if (finalized && typeof finalized === "object") {
          if (typeof finalized.reply === "string" && finalized.reply.trim()) finalText = boundedReply(finalized.reply);
          if (finalized.sessionRef) state.sessionRef = String(finalized.sessionRef);
          if (finalized.usage) state.usage = finalized.usage;
        }
      } catch (err) {
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const reply = boundedReply(finalText);
      if (!reply) {
        const error = new Error(`${provider} exited successfully without a final response`);
        error.code = "AGENT_EMPTY_RESPONSE";
        rejectOnce(error);
        return;
      }
      const result = {
        provider,
        reply,
        sessionRef: state.sessionRef || "",
        usage: state.usage,
      };
      settled = true;
      runCleanup();
      emit({ type: "done", reply, sessionRef: result.sessionRef, usage: result.usage });
      resolve(result);
    });

    child.stdin.end(prompt);
  });

  return {
    provider,
    get promise() {
      return completion.then((result) => result.reply);
    },
    get resultPromise() {
      return completion;
    },
    get final() {
      return completion;
    },
    get sessionRef() {
      return state.sessionRef || "";
    },
    cancel() {
      terminate("stopped");
    },
  };
}
