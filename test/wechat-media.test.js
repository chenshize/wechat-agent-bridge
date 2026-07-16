import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCdnDownloadUrl,
  decodeWechatAesKey,
  decryptWechatMedia,
  detectMimeType,
  downloadAndCacheMedia,
  extractCdnDescriptor,
  extractInboundContent,
  extractInboundItems,
  materializeInboundContent,
  pruneMediaCache,
  safeBasename,
} from "../src/wechat-media.js";

function encrypt(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

test("safeBasename removes traversal and control characters", () => {
  assert.equal(safeBasename("../../secret\u0000.txt"), "secret.txt");
  assert.equal(safeBasename(".."), "attachment");
  assert.equal(safeBasename("folder/name:bad?.pdf"), "name_bad_.pdf");
});

test("detectMimeType uses file signatures instead of extensions", () => {
  assert.equal(detectMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectMimeType(Buffer.from("%PDF-1.7\n")), "application/pdf");
  assert.equal(detectMimeType(Buffer.from("hello world\n")), "text/plain");
  assert.equal(detectMimeType(Buffer.from([0, 1, 2, 3, 4])), "application/octet-stream");
});

test("AES keys accept hex, raw-base64, and base64-of-hex protocol shapes", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  assert.deepEqual(decodeWechatAesKey(key.toString("hex")), key);
  assert.deepEqual(decodeWechatAesKey(key.toString("base64")), key);
  assert.deepEqual(decodeWechatAesKey(Buffer.from(key.toString("hex")).toString("base64")), key);
  assert.throws(() => decodeWechatAesKey("too-short"), /AES key/);

  const plaintext = Buffer.from("encrypted WeChat attachment");
  assert.deepEqual(decryptWechatMedia(encrypt(plaintext, key), key.toString("base64")), plaintext);
});

test("old cdn_media and newer media/aeskey descriptors normalize identically", () => {
  const legacy = { type: 2, image_item: { cdn_media: { aes_key: "key", encrypt_query_param: "legacy" } } };
  const modern = { type: 2, image_item: { aeskey: "key", media: { encrypt_query_param: "modern" } } };
  assert.deepEqual(extractCdnDescriptor(legacy), { aesKey: "key", encryptQueryParam: "legacy", cdnUrl: undefined });
  assert.deepEqual(extractCdnDescriptor(modern), { aesKey: "key", encryptQueryParam: "modern", cdnUrl: undefined });
});

test("inbound helpers normalize text, image, voice, file, and video", () => {
  const message = {
    item_list: [
      { type: 1, text_item: { text: "question" } },
      { type: 2, image_item: { aeskey: "a", media: { encrypt_query_param: "img" } } },
      { type: 3, voice_item: { text: "voice transcript", media: { aes_key: "a", encrypt_query_param: "voice" } } },
      { type: 4, file_item: { file_name: "../notes.txt", len: "12", media: { aes_key: "a", encrypt_query_param: "file" } } },
      { type: 5, video_item: { cdn_media: { aes_key: "a", encrypt_query_param: "video" } } },
    ],
  };
  assert.deepEqual(extractInboundItems(message).map((item) => item.type), ["text", "image", "voice", "file", "video"]);
  const content = extractInboundContent(message);
  assert.equal(content.text, "question\nvoice transcript");
  assert.equal(content.attachments.length, 4);
  assert.equal(content.attachments[2].name, "notes.txt");
});

test("CDN URLs remain pinned to an official HTTPS host", () => {
  const url = new URL(buildCdnDownloadUrl("opaque+a/b="));
  assert.equal(url.hostname, "novac2c.cdn.weixin.qq.com");
  assert.equal(url.searchParams.get("encrypted_query_param"), "opaque+a/b=");
  assert.throws(() => buildCdnDownloadUrl("x", "https://cdn.weixin.qq.com.evil.test"), /official HTTPS host/);
});

test("downloadAndCacheMedia decrypts, hashes, and stores a bounded attachment", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-media-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("fake png body"),
  ]);
  const ciphertext = encrypt(plaintext, key);
  let requestedUrl;
  const item = {
    type: 2,
    image_item: {
      cdn_media: { aes_key: key.toString("base64"), encrypt_query_param: "opaque" },
    },
  };
  const result = await downloadAndCacheMedia({
    item,
    cacheDir,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(ciphertext, { status: 200, headers: { "content-length": String(ciphertext.length) } });
    },
  });

  assert.match(requestedUrl, /encrypted_query_param=opaque/);
  assert.equal(result.mimeType, "image/png");
  assert.equal(path.basename(result.path), `${crypto.createHash("sha256").update(plaintext).digest("hex")}.png`);
  assert.deepEqual(await fs.readFile(result.path), plaintext);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});

test("downloadAndCacheMedia rejects declared oversized data before reading it", async () => {
  const key = crypto.randomBytes(16);
  const item = {
    type: 4,
    file_item: { media: { aes_key: key.toString("base64"), encrypt_query_param: "opaque" } },
  };
  await assert.rejects(
    downloadAndCacheMedia({
      item,
      maxBytes: 32,
      fetchImpl: async () => new Response(Buffer.alloc(16), { headers: { "content-length": "1024" } }),
    }),
    /exceeds/,
  );
});

test("pruneMediaCache enforces TTL and maximum count", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-prune-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const now = Date.now();
  for (const [name, age] of [["old.bin", 10_000], ["middle.bin", 2_000], ["new.bin", 1_000]]) {
    const filePath = path.join(cacheDir, name);
    await fs.writeFile(filePath, name);
    await fs.utimes(filePath, new Date(now - age), new Date(now - age));
  }
  await pruneMediaCache({ cacheDir, ttlMs: 5_000, maxFiles: 1, now });
  assert.deepEqual(await fs.readdir(cacheDir), ["new.bin"]);
});

test("a corrupt content-addressed cache entry is atomically replaced", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-media-corrupt-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from("correct payload");
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.txt`);
  await fs.writeFile(cachePath, Buffer.alloc(plaintext.length, 0x78));
  const item = {
    type: 4,
    file_item: { file_name: "note.txt", len: String(plaintext.length), media: { aes_key: key.toString("base64"), encrypt_query_param: "opaque" } },
  };
  const result = await downloadAndCacheMedia({
    item,
    cacheDir,
    fetchImpl: async () => new Response(encrypt(plaintext, key), { status: 200 }),
  });
  assert.equal(result.path, cachePath);
  assert.deepEqual(await fs.readFile(cachePath), plaintext);
});

test("message total size rejects the next declared attachment before downloading it", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-media-total-test-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from("123456");
  let calls = 0;
  const fileItem = (query) => ({
    type: 4,
    file_item: { file_name: `${query}.txt`, len: "6", media: { aes_key: key.toString("base64"), encrypt_query_param: query } },
  });
  await assert.rejects(
    materializeInboundContent({ item_list: [fileItem("one"), fileItem("two")] }, {
      cacheDir,
      maxTotalBytes: 10,
      fetchImpl: async () => {
        calls += 1;
        return new Response(encrypt(plaintext, key), { status: 200 });
      },
    }),
    /total bytes/,
  );
  assert.equal(calls, 1);
});
