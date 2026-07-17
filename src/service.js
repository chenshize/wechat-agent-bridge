import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadActiveWorkspace, secureStateDirectory, setActiveWorkspace, stateDir } from "./state.js";

export const SERVICE_ID = "io.weclaudex.bridge";

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function servicePaths({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "darwin") {
    return { definition: path.join(home, "Library", "LaunchAgents", `${SERVICE_ID}.plist`) };
  }
  if (platform === "linux") {
    return { definition: path.join(home, ".config", "systemd", "user", "weclaudex.service") };
  }
  return { definition: "" };
}

export function launchAgentPlist({ nodePath, cliPath, stateDirectory, workspace, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>WECHAT_BRIDGE_STATE_DIR</key><string>${xmlEscape(stateDirectory)}</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(workspace)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ nodePath, cliPath, stateDirectory, workspace }) {
  return `[Unit]
Description=WeClaudex WeChat bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${systemdEscape(nodePath)}" "${systemdEscape(cliPath)}" run
Environment="WECHAT_BRIDGE_STATE_DIR=${systemdEscape(stateDirectory)}"
WorkingDirectory="${systemdEscape(workspace)}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function run(command, args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function platformSupported(platform = process.platform) {
  if (!["darwin", "linux"].includes(platform)) {
    const error = new Error("Service management currently supports macOS launchd and Linux systemd user services.");
    error.code = "SERVICE_PLATFORM_UNSUPPORTED";
    throw error;
  }
}

function serviceContext() {
  platformSupported();
  const root = secureStateDirectory();
  const workspace = setActiveWorkspace(loadActiveWorkspace());
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  return {
    root,
    cliPath,
    nodePath: process.execPath,
    logPath: path.join(root, "service.log"),
    workspace,
    definition: servicePaths().definition,
  };
}

export function installService() {
  const context = serviceContext();
  fs.mkdirSync(path.dirname(context.definition), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    fs.writeFileSync(context.definition, launchAgentPlist({
      nodePath: context.nodePath,
      cliPath: context.cliPath,
      stateDirectory: context.root,
      workspace: context.workspace,
      logPath: context.logPath,
    }), { mode: 0o600 });
    const domain = `gui/${process.getuid()}`;
    run("launchctl", ["bootout", domain, context.definition], { allowFailure: true });
    run("launchctl", ["bootstrap", domain, context.definition]);
  } else {
    fs.writeFileSync(context.definition, systemdUnit({
      nodePath: context.nodePath,
      cliPath: context.cliPath,
      stateDirectory: context.root,
      workspace: context.workspace,
    }), { mode: 0o600 });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "weclaudex.service"]);
  }
  return context;
}

export function controlService(action) {
  const context = serviceContext();
  const allowed = new Set(["start", "stop", "restart", "status"]);
  if (!allowed.has(action)) throw new Error(`Unsupported service action: ${action}`);
  if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${SERVICE_ID}`;
    const domain = `gui/${process.getuid()}`;
    if (action === "start") {
      const loaded = run("launchctl", ["print", target], { allowFailure: true }).status === 0;
      if (loaded) run("launchctl", ["kickstart", "-k", target]);
      else run("launchctl", ["bootstrap", domain, context.definition]);
    } else if (action === "restart") {
      run("launchctl", ["bootout", domain, context.definition], { allowFailure: true });
      run("launchctl", ["bootstrap", domain, context.definition]);
    } else if (action === "stop") run("launchctl", ["bootout", domain, context.definition], { allowFailure: true });
    else {
      const result = run("launchctl", ["print", target], { allowFailure: true });
      return { ...context, active: result.status === 0, detail: String(result.stdout || result.stderr || "").trim() };
    }
  } else {
    const command = action === "status" ? "is-active" : action;
    const result = run("systemctl", ["--user", command, "weclaudex.service"], { allowFailure: action === "status" });
    if (action === "status") return { ...context, active: result.status === 0, detail: String(result.stdout || result.stderr || "").trim() };
  }
  return { ...context, active: action !== "stop" };
}

export function uninstallService() {
  const context = serviceContext();
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${process.getuid()}`, context.definition], { allowFailure: true });
  } else {
    run("systemctl", ["--user", "disable", "--now", "weclaudex.service"], { allowFailure: true });
    run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  }
  fs.rmSync(context.definition, { force: true });
  return context;
}

export function showServiceLogs({ follow = false, lines = 80 } = {}) {
  platformSupported();
  if (process.platform === "linux") {
    const args = ["--user-unit", "weclaudex.service", "-n", String(lines), ...(follow ? ["-f"] : []), "--no-pager"];
    run("journalctl", args, { inherit: true, allowFailure: true });
    return;
  }
  const logPath = path.join(stateDir(), "service.log");
  if (!fs.existsSync(logPath)) {
    console.log(`No service log yet: ${logPath}`);
    return;
  }
  run("tail", ["-n", String(lines), ...(follow ? ["-f"] : []), logPath], { inherit: true });
}
