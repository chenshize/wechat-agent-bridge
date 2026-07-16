import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const writeQueues = new Map();

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some filesystems do not expose POSIX permissions.
  }
}

function fsyncDirectory(directory) {
  let directoryFd;
  try {
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryFd);
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems.
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

/**
 * Durably replace a JSON file without ever exposing a partially written target.
 */
export function atomicWriteJsonSync(filePath, value, mode = 0o600) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  ensurePrivateDirectory(directory);

  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.${suffix}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let fd;

  try {
    fd = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // State files are private by default. A caller can deliberately request a
    // stricter/different mode, while the temporary file is always born 0600.
    if (mode !== 0o600) fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, absolutePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

/**
 * Queue asynchronous callers per target path. This is useful for event-driven
 * code that may attempt to persist successive snapshots without awaiting the
 * previous save.
 */
export function serializedWriteJson(filePath, value, mode = 0o600) {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => atomicWriteJsonSync(key, value, mode));

  writeQueues.set(key, current);
  current.then(
    () => {
      if (writeQueues.get(key) === current) writeQueues.delete(key);
    },
    () => {
      if (writeQueues.get(key) === current) writeQueues.delete(key);
    },
  );
  return current;
}

export async function flushSerializedWrites(filePath) {
  if (filePath) {
    await writeQueues.get(path.resolve(filePath));
    return;
  }
  await Promise.all([...writeQueues.values()]);
}
