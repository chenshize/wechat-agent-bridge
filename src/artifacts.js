import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const BLOCKED_BASENAMES = [
  /^\.env(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /^(?:credentials|secrets?|tokens?)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key|keystore)$/i,
];

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isBlockedPath(relativePath) {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => segment === ".ssh" || segment === ".gnupg")) return true;
  return BLOCKED_BASENAMES.some((pattern) => pattern.test(path.basename(relativePath)));
}

export function isSensitiveArtifactPath(relativePath) {
  return isBlockedPath(String(relativePath || ""));
}

export function artifactKind(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "image" : "file";
}

export function resolveArtifactFile(workspace, requestedPath, {
  maxBytes = Number.parseInt(process.env.WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES || "", 10) || DEFAULT_MAX_BYTES,
  allowSensitive = process.env.WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS === "1",
} = {}) {
  if (!workspace) throw new Error("当前没有工作区，请先使用 /cd 或 /ws use 选择工作区");
  if (!requestedPath?.trim()) throw new Error("请提供工作区内的相对文件路径");

  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, requestedPath.trim());
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`文件不存在：${requestedPath}`);
  }
  if (!isInside(root, resolved)) throw new Error("只能发送当前工作区内的文件");

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("只能发送普通文件");
  const relativePath = path.relative(root, resolved);
  if (!allowSensitive && isBlockedPath(relativePath)) {
    throw new Error("该路径看起来包含密钥或凭据，默认禁止发送");
  }
  if (stat.size > maxBytes) {
    throw new Error(`文件过大（${stat.size} bytes），当前上限为 ${maxBytes} bytes`);
  }
  return {
    path: resolved,
    relativePath,
    name: path.basename(resolved),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    kind: artifactKind(resolved),
  };
}

export function discoverArtifacts(workspace, {
  sinceMs = 0,
  limit = 12,
  maxDepth = 5,
  maxEntries = 3000,
} = {}) {
  if (!workspace || !fs.existsSync(workspace)) return [];
  const root = fs.realpathSync(workspace);
  const found = [];
  let visited = 0;

  function visit(directory, depth) {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, fullPath);
      if (isBlockedPath(relativePath)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= sinceMs) {
          found.push({
            path: fullPath,
            relativePath,
            name: entry.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            dev: stat.dev,
            ino: stat.ino,
            kind: artifactKind(fullPath),
          });
        }
      } catch {
        // A file may disappear while an agent is writing; ignore that race.
      }
    }
  }

  visit(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, limit));
}
