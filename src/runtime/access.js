export const ACCESS_MODES = Object.freeze(["read-only", "workspace", "full"]);

const CODEX_ACCESS = Object.freeze({
  "read-only": Object.freeze({
    sandbox: "read-only",
    approvalPolicy: "never",
    args: Object.freeze(["--sandbox", "read-only", "-c", "approval_policy=\"never\""]),
  }),
  workspace: Object.freeze({
    sandbox: "workspace-write",
    approvalPolicy: "never",
    args: Object.freeze(["--sandbox", "workspace-write", "-c", "approval_policy=\"never\""]),
  }),
  full: Object.freeze({
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    args: Object.freeze(["--dangerously-bypass-approvals-and-sandbox"]),
  }),
});

const CLAUDE_ACCESS = Object.freeze({
  "read-only": Object.freeze({
    permissionMode: "plan",
    args: Object.freeze(["--permission-mode", "plan"]),
  }),
  workspace: Object.freeze({
    permissionMode: "acceptEdits",
    args: Object.freeze(["--permission-mode", "acceptEdits"]),
  }),
  full: Object.freeze({
    permissionMode: "bypassPermissions",
    args: Object.freeze(["--dangerously-skip-permissions"]),
  }),
});

export const AGENT_ACCESS = Object.freeze({
  codex: CODEX_ACCESS,
  "claude-code": CLAUDE_ACCESS,
});

export function normalizeAccessMode(mode, fallback = "workspace") {
  const normalized = String(mode || "").trim().toLowerCase();
  if (ACCESS_MODES.includes(normalized)) return normalized;
  if (fallback === null) {
    const error = new Error(`unsupported access mode: ${normalized || "<empty>"}`);
    error.code = "UNSUPPORTED_ACCESS_MODE";
    throw error;
  }
  return ACCESS_MODES.includes(fallback) ? fallback : "workspace";
}

export function accessConfig(provider, mode) {
  const providerConfig = AGENT_ACCESS[provider];
  if (!providerConfig) {
    const error = new Error(`unsupported agent provider: ${provider || "<empty>"}`);
    error.code = "UNSUPPORTED_AGENT_PROVIDER";
    throw error;
  }
  return providerConfig[normalizeAccessMode(mode, null)];
}

export function accessArgs(provider, mode) {
  return [...accessConfig(provider, mode).args];
}

export function codexAccessArgs(mode) {
  return accessArgs("codex", mode);
}

export function claudeAccessArgs(mode) {
  return accessArgs("claude-code", mode);
}
