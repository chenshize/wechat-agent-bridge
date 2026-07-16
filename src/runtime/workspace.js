import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isAtOrBelow(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return input;
}

function unsafeWorkspaceReason(realPath) {
  const filesystemRoot = path.parse(realPath).root;
  const home = fs.realpathSync.native(os.homedir());
  const broadRoots = [
    filesystemRoot,
    home,
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
  ];
  if (broadRoots.some((root) => realPath === root)) return "workspace is too broad";

  const platformRoots = process.platform === "win32"
    ? [path.join(filesystemRoot, "Windows"), path.join(filesystemRoot, "Program Files")]
    : process.platform === "darwin"
      ? ["/System", "/Library", "/bin", "/sbin", "/usr", "/etc", "/var", "/private"]
      : ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];
  const temporaryRoots = [...new Set([os.tmpdir(), "/tmp", "/var/tmp", "/private/tmp"])]
    .map((entry) => {
      try {
        return fs.realpathSync.native(entry);
      } catch {
        return path.resolve(entry);
      }
    });

  if ([...platformRoots, ...temporaryRoots].some((root) => isAtOrBelow(realPath, root))) {
    return "system and temporary directories cannot be workspaces";
  }
  return "";
}

export function resolveWorkspacePath(input, { baseDir = process.cwd() } = {}) {
  const requested = String(input || "").trim();
  if (!requested) {
    const error = new Error("workspace path cannot be empty");
    error.code = "INVALID_WORKSPACE";
    throw error;
  }

  const expanded = expandHome(requested);
  const absolutePath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
  let realPath;
  try {
    realPath = fs.realpathSync.native(absolutePath);
  } catch (cause) {
    const error = new Error(`workspace does not exist: ${absolutePath}`, { cause });
    error.code = "WORKSPACE_NOT_FOUND";
    throw error;
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (cause) {
    const error = new Error(`cannot inspect workspace: ${realPath}`, { cause });
    error.code = "WORKSPACE_NOT_FOUND";
    throw error;
  }
  if (!stat.isDirectory()) {
    const error = new Error(`workspace is not a directory: ${realPath}`);
    error.code = "WORKSPACE_NOT_DIRECTORY";
    throw error;
  }

  const reason = unsafeWorkspaceReason(realPath);
  if (reason) {
    const error = new Error(`unsafe workspace ${realPath}: ${reason}`);
    error.code = "UNSAFE_WORKSPACE";
    throw error;
  }
  return realPath;
}

export function checkWorkspacePath(input, options) {
  try {
    return { ok: true, path: resolveWorkspacePath(input, options), reason: "" };
  } catch (error) {
    return { ok: false, path: "", reason: error.message, code: error.code || "INVALID_WORKSPACE" };
  }
}
