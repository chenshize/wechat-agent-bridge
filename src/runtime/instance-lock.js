import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function ownerIsAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (owner.hostname && owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Acquire a process lock using O_EXCL. A dead local owner's stale lock is
 * reclaimed once; a lock belonging to a live or remote process is preserved.
 */
export function acquireFileLock(lockPath, metadata = {}) {
  const absolutePath = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const owner = {
    ...metadata,
    pid: process.pid,
    hostname: os.hostname(),
    token,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(absolutePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      let released = false;
      return {
        path: absolutePath,
        owner: { ...owner },
        release() {
          if (released) return false;
          const current = readOwner(absolutePath);
          if (current?.token !== token) return false;
          fs.rmSync(absolutePath, { force: true });
          released = true;
          return true;
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the lock acquisition error.
        }
      }
      if (error?.code !== "EEXIST") throw error;

      const currentOwner = readOwner(absolutePath);
      if (attempt === 0 && !ownerIsAlive(currentOwner)) {
        fs.rmSync(absolutePath, { force: true });
        continue;
      }
      const runningError = new Error(
        `another bridge instance is already running${currentOwner?.pid ? ` (pid ${currentOwner.pid})` : ""}`,
      );
      runningError.code = "BRIDGE_ALREADY_RUNNING";
      runningError.owner = currentOwner;
      throw runningError;
    }
  }
  throw new Error("failed to acquire bridge instance lock");
}
