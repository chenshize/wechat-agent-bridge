import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { isSensitiveArtifactPath } from "./artifacts.js";
import { stateDir } from "./state.js";
import { safeBasename } from "./wechat-media.js";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = Object.freeze([
  "createdAt",
  "id",
  "kind",
  "originalName",
  "payload",
  "sha256",
  "size",
  "version",
]);

export class OutboundSpoolError extends Error {
  constructor(message, { code = "OUTBOUND_SPOOL_ERROR", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OutboundSpoolError";
    this.code = code;
  }
}

export function outboundSpoolDirectory() {
  return path.join(stateDir(), "outbound-spool");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function snapshotError(message, code, cause) {
  return new OutboundSpoolError(message, { code, cause });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
  );
}

function sameResolvedPath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function isSafeSnapshotName(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    path.basename(value) === value &&
    safeBasename(value, "") === value;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isValidManifestSchema(manifest) {
  if (!isPlainObject(manifest)) return false;
  const keys = Object.keys(manifest).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
    return false;
  }
  return manifest.version === 1 &&
    typeof manifest.id === "string" && SNAPSHOT_ID_PATTERN.test(manifest.id) &&
    isSafeSnapshotName(manifest.originalName) &&
    Number.isSafeInteger(manifest.size) && manifest.size >= 0 && manifest.size <= DEFAULT_MAX_BYTES &&
    typeof manifest.sha256 === "string" && SHA256_PATTERN.test(manifest.sha256) &&
    (manifest.kind === "file" || manifest.kind === "image") &&
    isIsoTimestamp(manifest.createdAt) &&
    typeof manifest.payload === "string" &&
    manifest.payload === path.join("payload", manifest.originalName);
}

function normalizeExpectedSnapshot(snapshot, spoolDir) {
  if (!isPlainObject(snapshot)) {
    throw snapshotError(
      "Outbound snapshot descriptor must be an object",
      "OUTBOUND_SNAPSHOT_INVALID",
    );
  }
  if (typeof snapshot.id !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshot.id)) {
    throw snapshotError("Outbound snapshot id is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }

  const candidatePaths = [snapshot.filePath, snapshot.path].filter((value) => value !== undefined);
  if (
    candidatePaths.length === 0 ||
    candidatePaths.some((value) => typeof value !== "string" || !path.isAbsolute(value)) ||
    candidatePaths.some((value) => !sameResolvedPath(value, candidatePaths[0]))
  ) {
    throw snapshotError("Outbound snapshot path metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }

  const candidateNames = [snapshot.originalName, snapshot.name].filter((value) => value !== undefined);
  if (
    candidateNames.length === 0 ||
    candidateNames.some((value) => !isSafeSnapshotName(value)) ||
    candidateNames.some((value) => value !== candidateNames[0])
  ) {
    throw snapshotError("Outbound snapshot name metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > DEFAULT_MAX_BYTES) {
    throw snapshotError("Outbound snapshot size metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }
  if (typeof snapshot.sha256 !== "string" || !SHA256_PATTERN.test(snapshot.sha256)) {
    throw snapshotError("Outbound snapshot digest metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }
  if (snapshot.kind !== undefined && snapshot.kind !== "file" && snapshot.kind !== "image") {
    throw snapshotError("Outbound snapshot kind metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }
  if (snapshot.version !== undefined && snapshot.version !== 1) {
    throw snapshotError("Outbound snapshot version metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }
  if (snapshot.createdAt !== undefined && !isIsoTimestamp(snapshot.createdAt)) {
    throw snapshotError("Outbound snapshot timestamp metadata is invalid", "OUTBOUND_SNAPSHOT_INVALID");
  }

  const root = path.resolve(spoolDir);
  const snapshotDirectory = path.join(root, snapshot.id);
  const payloadDirectory = path.join(snapshotDirectory, "payload");
  const filePath = path.join(payloadDirectory, candidateNames[0]);
  const manifestPath = path.join(snapshotDirectory, "manifest.json");
  if (!sameResolvedPath(candidatePaths[0], filePath)) {
    throw snapshotError(
      "Outbound snapshot payload path does not match its id and name",
      "OUTBOUND_SNAPSHOT_PATH_MISMATCH",
    );
  }
  if (snapshot.manifestPath !== undefined && (
    typeof snapshot.manifestPath !== "string" ||
    !path.isAbsolute(snapshot.manifestPath) ||
    !sameResolvedPath(snapshot.manifestPath, manifestPath)
  )) {
    throw snapshotError(
      "Outbound snapshot manifest path does not match its id",
      "OUTBOUND_SNAPSHOT_PATH_MISMATCH",
    );
  }

  return {
    id: snapshot.id,
    originalName: candidateNames[0],
    size: snapshot.size,
    sha256: snapshot.sha256,
    kind: snapshot.kind,
    version: snapshot.version,
    createdAt: snapshot.createdAt,
    payload: snapshot.payload,
    root,
    snapshotDirectory,
    payloadDirectory,
    filePath,
    manifestPath,
  };
}

async function assertSafeSnapshotDirectory(directory, code = "OUTBOUND_SNAPSHOT_UNSAFE_PATH") {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw snapshotError("Outbound snapshot is missing", "OUTBOUND_SNAPSHOT_MISSING", cause);
    }
    throw snapshotError("Cannot inspect outbound snapshot directory", code, cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw snapshotError("Outbound snapshot contains an unsafe directory", code);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw snapshotError("Outbound snapshot directory is owned by another user", code);
  }
  return stat;
}

async function assertCanonicalSnapshotTree(expected) {
  await assertSafeSnapshotDirectory(expected.root);
  await assertSafeSnapshotDirectory(expected.snapshotDirectory);
  await assertSafeSnapshotDirectory(expected.payloadDirectory);

  let canonicalRoot;
  let canonicalSnapshot;
  let canonicalPayload;
  try {
    [canonicalRoot, canonicalSnapshot, canonicalPayload] = await Promise.all([
      fs.realpath(expected.root),
      fs.realpath(expected.snapshotDirectory),
      fs.realpath(expected.payloadDirectory),
    ]);
  } catch (cause) {
    throw snapshotError("Cannot resolve outbound snapshot directories", "OUTBOUND_SNAPSHOT_UNSAFE_PATH", cause);
  }
  if (
    canonicalSnapshot !== path.join(canonicalRoot, expected.id) ||
    canonicalPayload !== path.join(canonicalSnapshot, "payload")
  ) {
    throw snapshotError("Outbound snapshot directory escaped its spool", "OUTBOUND_SNAPSHOT_UNSAFE_PATH");
  }
  return { canonicalRoot, canonicalSnapshot, canonicalPayload };
}

function assertSameOpenedFile(opened, current, code) {
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw snapshotError("Outbound snapshot path changed during verification", code);
  }
}

async function readRegularFileNoFollow(filePath, {
  maxBytes,
  missingMessage,
  missingCode,
  unsafeMessage,
  unsafeCode,
}) {
  let leaf;
  try {
    leaf = await fs.lstat(filePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") throw snapshotError(missingMessage, missingCode, cause);
    throw snapshotError(unsafeMessage, unsafeCode, cause);
  }
  if (!leaf.isFile() || leaf.isSymbolicLink()) throw snapshotError(unsafeMessage, unsafeCode);

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    try {
      handle = await fs.open(filePath, flags);
    } catch (cause) {
      if (cause?.code === "ENOENT") throw snapshotError(missingMessage, missingCode, cause);
      throw snapshotError(unsafeMessage, unsafeCode, cause);
    }
    const before = await handle.stat();
    if (!before.isFile()) throw snapshotError(unsafeMessage, unsafeCode);
    assertSameOpenedFile(before, leaf, unsafeCode);
    if (before.size > maxBytes) {
      throw snapshotError("Outbound snapshot file exceeds its verification limit", unsafeCode);
    }
    const contents = await handle.readFile();
    if (contents.length > maxBytes) {
      throw snapshotError("Outbound snapshot file exceeds its verification limit", unsafeCode);
    }
    const after = await handle.stat();
    assertSameOpenedFile(before, after, unsafeCode);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      contents.length !== after.size
    ) {
      throw snapshotError("Outbound snapshot file changed during verification", unsafeCode);
    }

    let currentLeaf;
    try {
      currentLeaf = await fs.lstat(filePath);
    } catch (cause) {
      throw snapshotError("Outbound snapshot path changed during verification", unsafeCode, cause);
    }
    if (!currentLeaf.isFile() || currentLeaf.isSymbolicLink()) {
      throw snapshotError("Outbound snapshot path changed during verification", unsafeCode);
    }
    assertSameOpenedFile(after, currentLeaf, unsafeCode);
    return { contents, stat: after };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sourceChanged(message = "Outbound source changed after it was authorized") {
  return new OutboundSpoolError(message, { code: "OUTBOUND_SOURCE_CHANGED" });
}

function assertSameFile(left, right) {
  if (left.dev !== right.dev || left.ino !== right.ino) throw sourceChanged();
}

function assertStableFile(before, after) {
  assertSameFile(before, after);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw sourceChanged("Outbound source was modified while it was being copied");
  }
}

async function enforceMode(target, mode) {
  try {
    await fs.chmod(target, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OutboundSpoolError("Outbound spool directory is unsafe", {
      code: "OUTBOUND_SPOOL_UNSAFE_DIRECTORY",
    });
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new OutboundSpoolError("Outbound spool directory is owned by another user", {
      code: "OUTBOUND_SPOOL_WRONG_OWNER",
    });
  }
  await enforceMode(directory, 0o700);
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writePrivateFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await enforceMode(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
    await enforceMode(filePath, 0o600);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeArtifact(artifact) {
  const input = typeof artifact === "string" ? { path: artifact } : artifact;
  const sourcePath = input?.path || input?.filePath;
  if (!sourcePath || typeof sourcePath !== "string") {
    throw new TypeError("stageOutboundArtifact requires an artifact path");
  }
  return {
    sourcePath: path.resolve(sourcePath),
    originalName: safeBasename(input.name || input.originalName || path.basename(sourcePath), "attachment"),
    kind: input.kind === "image" ? "image" : "file",
    expectedSize: Number.isSafeInteger(input.size) ? input.size : undefined,
    expectedMtimeMs: Number.isFinite(input.mtimeMs) ? input.mtimeMs : undefined,
    expectedCtimeMs: Number.isFinite(input.ctimeMs) ? input.ctimeMs : undefined,
    expectedDev: Number.isFinite(input.dev) ? input.dev : undefined,
    expectedIno: Number.isFinite(input.ino) ? input.ino : undefined,
  };
}

async function canonicalFileAtPath(sourcePath, workspaceRoot) {
  let canonical;
  try {
    canonical = await fs.realpath(sourcePath);
  } catch (cause) {
    throw new OutboundSpoolError("Outbound source no longer exists", {
      code: "OUTBOUND_SOURCE_MISSING",
      cause,
    });
  }
  if (workspaceRoot && !isInside(workspaceRoot, canonical)) {
    throw new OutboundSpoolError("Outbound source escaped the authorized workspace", {
      code: "OUTBOUND_SOURCE_OUTSIDE_WORKSPACE",
    });
  }
  return canonical;
}

async function readAuthorizedSource(artifact, { workspace, maxBytes }) {
  const workspaceRoot = workspace ? await fs.realpath(workspace) : undefined;
  const canonicalBefore = await canonicalFileAtPath(artifact.sourcePath, workspaceRoot);
  if (
    workspaceRoot &&
    process.env.WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS !== "1" &&
    isSensitiveArtifactPath(path.relative(workspaceRoot, canonicalBefore))
  ) {
    throw new OutboundSpoolError("Outbound source resolves to a sensitive path", {
      code: "OUTBOUND_SOURCE_SENSITIVE",
    });
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(canonicalBefore, flags);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new OutboundSpoolError("Outbound source must be a regular file", {
        code: "OUTBOUND_SOURCE_NOT_FILE",
      });
    }
    if (before.size > maxBytes) {
      throw new OutboundSpoolError(`Outbound source exceeds ${maxBytes} bytes`, {
        code: "OUTBOUND_SOURCE_TOO_LARGE",
      });
    }
    if (
      (artifact.expectedSize !== undefined && before.size !== artifact.expectedSize) ||
      (artifact.expectedMtimeMs !== undefined && before.mtimeMs !== artifact.expectedMtimeMs) ||
      (artifact.expectedCtimeMs !== undefined && before.ctimeMs !== artifact.expectedCtimeMs) ||
      (artifact.expectedDev !== undefined && before.dev !== artifact.expectedDev) ||
      (artifact.expectedIno !== undefined && before.ino !== artifact.expectedIno)
    ) {
      throw sourceChanged();
    }

    const canonicalDuring = await canonicalFileAtPath(artifact.sourcePath, workspaceRoot);
    const pathStatDuring = await fs.stat(canonicalDuring);
    assertSameFile(before, pathStatDuring);

    const contents = await handle.readFile();
    if (contents.length > maxBytes) {
      throw new OutboundSpoolError(`Outbound source exceeds ${maxBytes} bytes`, {
        code: "OUTBOUND_SOURCE_TOO_LARGE",
      });
    }
    const after = await handle.stat();
    assertStableFile(before, after);

    const canonicalAfter = await canonicalFileAtPath(artifact.sourcePath, workspaceRoot);
    const pathStatAfter = await fs.stat(canonicalAfter);
    assertSameFile(after, pathStatAfter);
    return contents;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Copy an already-authorized workspace artifact into a private, immutable-by-
 * convention spool entry. The returned `path` is stable across source edits
 * and may be persisted by the durable outbox.
 */
export async function stageOutboundArtifact(artifactInput, {
  workspace,
  spoolDir = outboundSpoolDirectory(),
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new TypeError(`maxBytes must be between 1 and ${DEFAULT_MAX_BYTES}`);
  }
  const artifact = normalizeArtifact(artifactInput);
  const contents = await readAuthorizedSource(artifact, { workspace, maxBytes });
  const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
  const size = contents.length;
  const createdAt = new Date(now()).toISOString();
  const id = crypto.randomUUID();
  const root = path.resolve(spoolDir);
  const snapshotDirectory = path.join(root, id);
  const payloadDirectory = path.join(snapshotDirectory, "payload");
  const filePath = path.join(payloadDirectory, artifact.originalName);
  const manifestPath = path.join(snapshotDirectory, "manifest.json");

  await ensurePrivateDirectory(root);
  try {
    await fs.mkdir(snapshotDirectory, { mode: 0o700 });
    await enforceMode(snapshotDirectory, 0o700);
    await fs.mkdir(payloadDirectory, { mode: 0o700 });
    await enforceMode(payloadDirectory, 0o700);
    await writePrivateFileAtomic(filePath, contents);
    const manifest = {
      version: 1,
      id,
      originalName: artifact.originalName,
      size,
      sha256,
      kind: artifact.kind,
      createdAt,
      payload: path.join("payload", artifact.originalName),
    };
    await writePrivateFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fsyncDirectory(snapshotDirectory);
    await fsyncDirectory(root);
    return {
      ...manifest,
      path: filePath,
      filePath,
      manifestPath,
    };
  } catch (error) {
    await fs.rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Verify a staged outbound payload immediately before it is consumed.
 *
 * The caller-provided descriptor is treated as the authorization record, not
 * as a hint: id, absolute payload path, original name, size, and digest are
 * required and must all agree with the on-disk manifest and payload. This
 * lets a durable outbox detect local edits instead of uploading whatever now
 * happens to exist at a previously authorized path.
 */
export async function verifyOutboundSnapshot(snapshot, {
  spoolDir = outboundSpoolDirectory(),
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new TypeError(`maxBytes must be between 1 and ${DEFAULT_MAX_BYTES}`);
  }
  const expected = normalizeExpectedSnapshot(snapshot, spoolDir);
  if (expected.size > maxBytes) {
    throw snapshotError(
      "Outbound snapshot exceeds the configured verification limit",
      "OUTBOUND_SNAPSHOT_TOO_LARGE",
    );
  }

  const canonical = await assertCanonicalSnapshotTree(expected);
  const manifestRead = await readRegularFileNoFollow(expected.manifestPath, {
    maxBytes: MAX_MANIFEST_BYTES,
    missingMessage: "Outbound snapshot manifest is missing",
    missingCode: "OUTBOUND_SNAPSHOT_MANIFEST_MISSING",
    unsafeMessage: "Outbound snapshot manifest is unsafe or corrupt",
    unsafeCode: "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
  });

  let canonicalManifest;
  try {
    canonicalManifest = await fs.realpath(expected.manifestPath);
  } catch (cause) {
    throw snapshotError(
      "Cannot resolve outbound snapshot manifest",
      "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
      cause,
    );
  }
  if (canonicalManifest !== path.join(canonical.canonicalSnapshot, "manifest.json")) {
    throw snapshotError(
      "Outbound snapshot manifest escaped its snapshot directory",
      "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRead.contents.toString("utf8"));
  } catch (cause) {
    throw snapshotError(
      "Outbound snapshot manifest is not valid JSON",
      "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
      cause,
    );
  }
  if (!isValidManifestSchema(manifest)) {
    throw snapshotError(
      "Outbound snapshot manifest schema is invalid",
      "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
    );
  }

  const expectedPayload = path.join("payload", expected.originalName);
  if (
    manifest.id !== expected.id ||
    manifest.originalName !== expected.originalName ||
    manifest.size !== expected.size ||
    manifest.sha256 !== expected.sha256 ||
    (expected.kind !== undefined && manifest.kind !== expected.kind) ||
    (expected.version !== undefined && manifest.version !== expected.version) ||
    (expected.createdAt !== undefined && manifest.createdAt !== expected.createdAt) ||
    (expected.payload !== undefined && manifest.payload !== expected.payload) ||
    manifest.payload !== expectedPayload
  ) {
    throw snapshotError(
      "Outbound snapshot manifest does not match its authorized metadata",
      "OUTBOUND_SNAPSHOT_MANIFEST_MISMATCH",
    );
  }

  const payloadRead = await readRegularFileNoFollow(expected.filePath, {
    maxBytes,
    missingMessage: "Outbound snapshot payload is missing",
    missingCode: "OUTBOUND_SNAPSHOT_PAYLOAD_MISSING",
    unsafeMessage: "Outbound snapshot payload is unsafe",
    unsafeCode: "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
  });
  let canonicalPayload;
  try {
    canonicalPayload = await fs.realpath(expected.filePath);
  } catch (cause) {
    throw snapshotError(
      "Cannot resolve outbound snapshot payload",
      "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
      cause,
    );
  }
  if (canonicalPayload !== path.join(canonical.canonicalPayload, expected.originalName)) {
    throw snapshotError(
      "Outbound snapshot payload escaped its snapshot directory",
      "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
    );
  }

  const actualHash = crypto.createHash("sha256").update(payloadRead.contents).digest("hex");
  if (
    payloadRead.stat.size !== expected.size ||
    payloadRead.contents.length !== expected.size ||
    actualHash !== expected.sha256 ||
    actualHash !== manifest.sha256
  ) {
    throw snapshotError(
      "Outbound snapshot payload no longer matches its authorized content",
      "OUTBOUND_SNAPSHOT_PAYLOAD_CORRUPT",
    );
  }

  // Rechecking the tree closes the common intermediate-directory swap race:
  // if a payload directory was replaced during verification, its canonical
  // identity can no longer agree with the one checked before the reads.
  const canonicalAfter = await assertCanonicalSnapshotTree(expected);
  if (
    canonicalAfter.canonicalRoot !== canonical.canonicalRoot ||
    canonicalAfter.canonicalSnapshot !== canonical.canonicalSnapshot ||
    canonicalAfter.canonicalPayload !== canonical.canonicalPayload
  ) {
    throw snapshotError(
      "Outbound snapshot directories changed during verification",
      "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
    );
  }

  return {
    ...manifest,
    path: expected.filePath,
    filePath: expected.filePath,
    manifestPath: expected.manifestPath,
    contents: payloadRead.contents,
  };
}

export function outboundSnapshotIdForPath(filePath, {
  spoolDir = outboundSpoolDirectory(),
} = {}) {
  if (typeof filePath !== "string" || !filePath) return null;
  const root = path.resolve(spoolDir);
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const [id, directory, ...leaf] = relative.split(path.sep);
  return SNAPSHOT_ID_PATTERN.test(id) && directory === "payload" && leaf.length > 0 ? id : null;
}

function snapshotId(value, options) {
  const directId = typeof value === "string" ? value : value?.id;
  if (SNAPSHOT_ID_PATTERN.test(String(directId || ""))) return String(directId);
  const filePath = typeof value === "string" ? value : value?.filePath || value?.path;
  const id = outboundSnapshotIdForPath(filePath, options);
  if (id) return id;
  throw new TypeError("cleanupOutboundSnapshot requires a valid snapshot id, descriptor, or spool path");
}

export async function cleanupOutboundSnapshot(snapshot, {
  spoolDir = outboundSpoolDirectory(),
} = {}) {
  const id = snapshotId(snapshot, { spoolDir });
  const root = path.resolve(spoolDir);
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new OutboundSpoolError("Outbound spool directory is unsafe", {
      code: "OUTBOUND_SPOOL_UNSAFE_DIRECTORY",
    });
  }
  if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
    throw new OutboundSpoolError("Outbound spool directory is owned by another user", {
      code: "OUTBOUND_SPOOL_WRONG_OWNER",
    });
  }
  const target = path.join(root, id);
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await fs.rm(target, { recursive: true, force: true });
  await fsyncDirectory(root);
  return true;
}
