import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveArtifactFile } from "../src/artifacts.js";
import {
  OutboundSpoolError,
  cleanupOutboundSnapshot,
  outboundSnapshotIdForPath,
  stageOutboundArtifact,
  verifyOutboundSnapshot,
} from "../src/outbound-spool.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-outbound-spool-test-"));
  const workspace = path.join(root, "workspace");
  const spoolDir = path.join(root, "state", "outbound-spool");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace, spoolDir };
}

test("stages a private content snapshot with durable metadata", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "final report.txt");
  const contents = Buffer.from("authorized contents\n");
  await fs.writeFile(source, contents);
  const artifact = resolveArtifactFile(workspace, "final report.txt");

  const snapshot = await stageOutboundArtifact(artifact, { workspace, spoolDir, now: () => 1234 });
  assert.equal(snapshot.originalName, "final report.txt");
  assert.equal(snapshot.size, contents.length);
  assert.equal(snapshot.sha256, crypto.createHash("sha256").update(contents).digest("hex"));
  assert.equal(snapshot.createdAt, new Date(1234).toISOString());
  assert.equal(snapshot.kind, "file");
  assert.deepEqual(await fs.readFile(snapshot.path), contents);

  await fs.writeFile(source, "changed after authorization");
  assert.deepEqual(await fs.readFile(snapshot.path), contents);

  assert.equal((await fs.stat(spoolDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(snapshot.path))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(snapshot.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(snapshot.manifestPath)).mode & 0o777, 0o600);
  const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, "utf8"));
  assert.deepEqual(
    { originalName: manifest.originalName, size: manifest.size, sha256: manifest.sha256 },
    { originalName: snapshot.originalName, size: snapshot.size, sha256: snapshot.sha256 },
  );

  const verified = await verifyOutboundSnapshot(snapshot, { spoolDir });
  assert.deepEqual(
    {
      id: verified.id,
      path: verified.path,
      originalName: verified.originalName,
      size: verified.size,
      sha256: verified.sha256,
    },
    {
      id: snapshot.id,
      path: snapshot.path,
      originalName: snapshot.originalName,
      size: snapshot.size,
      sha256: snapshot.sha256,
    },
  );
});

test("verification rejects a payload overwritten after staging", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "answer.txt");
  await fs.writeFile(source, "trusted");
  const snapshot = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });

  // Keep the same length so verification cannot rely on size alone.
  await fs.writeFile(snapshot.path, "changed");
  await assert.rejects(
    verifyOutboundSnapshot(snapshot, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_PAYLOAD_CORRUPT",
  );
});

test("verification rejects corrupt and mismatched manifests", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "answer.txt");
  await fs.writeFile(source, "trusted");
  const corrupt = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });
  await fs.writeFile(corrupt.manifestPath, "{not-json\n");
  await assert.rejects(
    verifyOutboundSnapshot(corrupt, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
  );

  const invalidSchema = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });
  const schemaManifest = JSON.parse(await fs.readFile(invalidSchema.manifestPath, "utf8"));
  schemaManifest.unexpected = true;
  await fs.writeFile(invalidSchema.manifestPath, `${JSON.stringify(schemaManifest)}\n`);
  await assert.rejects(
    verifyOutboundSnapshot(invalidSchema, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_MANIFEST_CORRUPT",
  );

  const mismatched = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });
  const manifest = JSON.parse(await fs.readFile(mismatched.manifestPath, "utf8"));
  manifest.sha256 = "0".repeat(64);
  await fs.writeFile(mismatched.manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    verifyOutboundSnapshot(mismatched, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_MANIFEST_MISMATCH",
  );

  const metadataMismatch = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });
  await assert.rejects(
    verifyOutboundSnapshot({ ...metadataMismatch, size: metadataMismatch.size + 1 }, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_MANIFEST_MISMATCH",
  );
});

test("verification rejects caller paths outside the snapshot UUID directory", async (t) => {
  const { root, workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "answer.txt");
  const escaped = path.join(root, "escaped.txt");
  await fs.writeFile(source, "trusted");
  await fs.writeFile(escaped, "trusted");
  const snapshot = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });

  await assert.rejects(
    verifyOutboundSnapshot({ ...snapshot, path: escaped, filePath: escaped }, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_PATH_MISMATCH",
  );
});

test("verification rejects a symlinked payload leaf", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation may require elevated privileges");
  const { root, workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "answer.txt");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(source, "trusted");
  await fs.writeFile(outside, "trusted");
  const snapshot = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });

  await fs.unlink(snapshot.path);
  await fs.symlink(outside, snapshot.path);
  await assert.rejects(
    verifyOutboundSnapshot(snapshot, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
  );
});

test("verification rejects a symlinked payload directory", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation may require elevated privileges");
  const { root, workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "answer.txt");
  const outsideDirectory = path.join(root, "outside-payload");
  await fs.writeFile(source, "trusted");
  const snapshot = await stageOutboundArtifact({ path: source }, { workspace, spoolDir });
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, snapshot.originalName), "trusted");

  const payloadDirectory = path.dirname(snapshot.path);
  await fs.rm(payloadDirectory, { recursive: true });
  await fs.symlink(outsideDirectory, payloadDirectory, "dir");
  await assert.rejects(
    verifyOutboundSnapshot(snapshot, { spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SNAPSHOT_UNSAFE_PATH",
  );
});

test("rejects a source changed after artifact validation", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "result.txt");
  await fs.writeFile(source, "safe");
  const artifact = resolveArtifactFile(workspace, "result.txt");
  await fs.writeFile(source, "different and larger");

  await assert.rejects(
    stageOutboundArtifact(artifact, { workspace, spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SOURCE_CHANGED",
  );
  await assert.rejects(fs.stat(spoolDir), { code: "ENOENT" });
});

test("rejects an intermediate symlink that escapes the workspace", async (t) => {
  const { root, workspace, spoolDir } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(workspace, "slot"));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, "slot", "target.txt"), "safe");
  await fs.writeFile(path.join(outside, "target.txt"), "outside secret");
  const artifact = resolveArtifactFile(workspace, "slot/target.txt");

  await fs.rename(path.join(workspace, "slot"), path.join(workspace, "old-slot"));
  await fs.symlink(outside, path.join(workspace, "slot"));
  await assert.rejects(
    stageOutboundArtifact(artifact, { workspace, spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SOURCE_OUTSIDE_WORKSPACE",
  );
});

test("rechecks sensitive canonical paths after authorization", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  const source = path.join(workspace, "report.txt");
  const secret = path.join(workspace, ".env");
  await fs.writeFile(source, "safe");
  await fs.writeFile(secret, "KEY=secret");
  const artifact = resolveArtifactFile(workspace, "report.txt");
  await fs.unlink(source);
  await fs.symlink(secret, source);
  await assert.rejects(
    stageOutboundArtifact(artifact, { workspace, spoolDir }),
    (error) => error instanceof OutboundSpoolError && error.code === "OUTBOUND_SOURCE_SENSITIVE",
  );
});

test("cleanup removes only the selected snapshot", async (t) => {
  const { workspace, spoolDir } = await fixture(t);
  await fs.writeFile(path.join(workspace, "one.txt"), "one");
  await fs.writeFile(path.join(workspace, "two.txt"), "two");
  const first = await stageOutboundArtifact(resolveArtifactFile(workspace, "one.txt"), { workspace, spoolDir });
  const second = await stageOutboundArtifact(resolveArtifactFile(workspace, "two.txt"), { workspace, spoolDir });

  assert.equal(await cleanupOutboundSnapshot(first, { spoolDir }), true);
  await assert.rejects(fs.stat(first.path), { code: "ENOENT" });
  assert.equal(await fs.readFile(second.path, "utf8"), "two");
  assert.equal(await cleanupOutboundSnapshot(first, { spoolDir }), false);
  assert.equal(outboundSnapshotIdForPath(second.path, { spoolDir }), second.id);
  assert.equal(outboundSnapshotIdForPath(path.join(workspace, "one.txt"), { spoolDir }), null);
  assert.equal(await cleanupOutboundSnapshot(second.path, { spoolDir }), true);
  assert.equal(await fs.readFile(path.join(workspace, "one.txt"), "utf8"), "one");
});
