import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WechatApiError,
  aesEcbPaddedSize,
  assertApiSuccess,
  buildCdnUploadUrl,
  extractTextItems,
  isOfficialWechatApiHost,
  normalizeOfficialBaseUrl,
  uploadFile,
} from "../src/wechat-api.js";

test("official WeChat API URL validation rejects lookalikes and unsafe URL features", () => {
  assert.equal(isOfficialWechatApiHost("ilinkai.weixin.qq.com"), true);
  assert.equal(isOfficialWechatApiHost("api.wechat.com"), true);
  assert.equal(isOfficialWechatApiHost("weixin.qq.com.evil.test"), false);
  assert.equal(normalizeOfficialBaseUrl("https://ilinkai.weixin.qq.com/"), "https://ilinkai.weixin.qq.com");

  for (const value of [
    "http://ilinkai.weixin.qq.com",
    "https://weixin.qq.com.evil.test",
    "https://user:pass@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com/api",
    "not a url",
  ]) {
    assert.throws(() => normalizeOfficialBaseUrl(value), WechatApiError);
  }
});

test("API ret errors retain machine-readable details", () => {
  assert.equal(assertApiSuccess({ ret: 0, value: 1 }).value, 1);
  assert.throws(
    () => assertApiSuccess({ ret: -2, errmsg: "busy" }, { endpoint: "sendmessage" }),
    (error) => error instanceof WechatApiError
      && error.code === "WECHAT_API_RET"
      && error.ret === -2
      && error.errmsg === "busy"
      && error.retryable,
  );
});

test("AES padded sizes reserve a full PKCS#7 block", () => {
  assert.equal(aesEcbPaddedSize(0), 16);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(25 * 1024 * 1024), 25 * 1024 * 1024 + 16);
});

test("CDN upload URL encodes opaque parameters", () => {
  const url = buildCdnUploadUrl({ uploadParam: "a+b/c=", filekey: "key & value" });
  assert.match(url, /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/upload\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("encrypted_query_param"), "a+b/c=");
  assert.equal(parsed.searchParams.get("filekey"), "key & value");
});

test("extractTextItems only returns non-empty TEXT items", () => {
  assert.deepEqual(extractTextItems({
    item_list: [
      { type: 1, text_item: { text: "hello" } },
      { type: 3, voice_item: { text: "voice" } },
      { type: 1, text_item: { text: "" } },
    ],
  }), ["hello"]);
});

test("generic file upload requests FILE media and encrypts CDN bytes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-upload-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "notes.txt");
  await fs.writeFile(filePath, "hello");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("getuploadurl")) {
      return new Response(JSON.stringify({
        ret: 0,
        upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=one",
      }), { status: 200 });
    }
    return new Response("", { status: 200, headers: { "x-encrypted-param": "download-ticket" } });
  };

  const result = await uploadFile({
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "token",
    to: "user",
    filePath,
  });
  const requestBody = JSON.parse(calls[0].init.body);
  assert.equal(requestBody.media_type, 3);
  assert.equal(requestBody.rawsize, 5);
  assert.equal(Buffer.from(calls[1].init.body).length, 16);
  assert.equal(result.downloadEncryptedQueryParam, "download-ticket");
  assert.equal(result.fileName, "notes.txt");
});
