import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MEDIA_MAX_BYTES,
  detectMimeType,
  normalizeCdnBaseUrl,
  safeBasename,
} from "./wechat-media.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = DEFAULT_CDN_BASE_URL;
export const DEFAULT_BOT_TYPE = "3";
export const MAX_OUTBOUND_FILE_BYTES = DEFAULT_MEDIA_MAX_BYTES;
export const MESSAGE_TYPE = Object.freeze({ USER: 1, BOT: 2 });
export const MESSAGE_ITEM_TYPE = Object.freeze({ TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 });
export const UPLOAD_MEDIA_TYPE = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 });

const CLIENT_VERSION = buildClientVersion("2.4.6");
const BOT_AGENT = process.env.WECHAT_BRIDGE_BOT_AGENT || process.env.WEIXIN_CODEX_BOT_AGENT || "WechatAgentBridge/0.4.0";

export class WechatApiError extends Error {
  constructor(message, {
    code = "WECHAT_API_ERROR",
    kind = "api",
    endpoint,
    status,
    ret,
    errmsg,
    retryable = false,
    response,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WechatApiError";
    this.code = code;
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
    this.ret = ret;
    this.errmsg = errmsg;
    this.retryable = retryable;
    this.response = response;
  }
}

export function isWechatApiError(error) {
  return error instanceof WechatApiError || error?.name === "WechatApiError";
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo() {
  return { channel_version: "2.4.6", bot_agent: BOT_AGENT };
}

export function isOfficialWechatApiHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ["weixin.qq.com", "wechat.com"].some((root) => host === root || host.endsWith(`.${root}`));
}

export function normalizeOfficialBaseUrl(input = DEFAULT_BASE_URL) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch (cause) {
    throw new WechatApiError("Invalid WeChat API base URL", {
      code: "WECHAT_INVALID_BASE_URL",
      kind: "configuration",
      cause,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !isOfficialWechatApiHost(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new WechatApiError("WeChat API base URL must be an official HTTPS origin", {
      code: "WECHAT_UNTRUSTED_BASE_URL",
      kind: "configuration",
    });
  }
  return url.origin;
}

function buildApiUrl(baseUrl, endpoint) {
  const relative = String(endpoint || "");
  if (!relative || relative.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(relative)) {
    throw new WechatApiError("Invalid WeChat API endpoint", {
      code: "WECHAT_INVALID_ENDPOINT",
      kind: "configuration",
      endpoint: relative,
    });
  }
  return new URL(relative.replace(/^\/+/, ""), `${normalizeOfficialBaseUrl(baseUrl)}/`).toString();
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function commonHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function errorBodySnippet(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function fetchJsonWithTimeout(url, init, timeoutMs, endpoint) {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    } catch (cause) {
      if (cause?.name === "AbortError" && externalSignal?.aborted && !timedOut) {
        throw new WechatApiError("WeChat API request was cancelled", {
          code: "WECHAT_ABORTED",
          kind: "cancelled",
          endpoint,
          retryable: false,
          cause,
        });
      }
      if (cause?.name === "AbortError") {
        throw new WechatApiError(`WeChat API request timed out after ${timeoutMs}ms`, {
          code: "WECHAT_TIMEOUT",
          kind: "timeout",
          endpoint,
          retryable: true,
          cause,
        });
      }
      throw new WechatApiError(`WeChat API network error: ${cause?.message || String(cause)}`, {
        code: "WECHAT_NETWORK_ERROR",
        kind: "network",
        endpoint,
        retryable: true,
        cause,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new WechatApiError(
        `WeChat API HTTP ${response.status}${errorBodySnippet(text) ? `: ${errorBodySnippet(text)}` : ""}`,
        {
          code: "WECHAT_HTTP_ERROR",
          kind: "http",
          endpoint,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new WechatApiError("WeChat API returned invalid JSON", {
        code: "WECHAT_INVALID_JSON",
        kind: "protocol",
        endpoint,
        retryable: false,
        cause,
      });
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function assertApiSuccess(response, { endpoint = "unknown", allow = [] } = {}) {
  const ret = response?.ret;
  if (ret === undefined || ret === null || Number(ret) === 0 || allow.includes(Number(ret))) return response;
  const errmsg = String(response?.errmsg || response?.retmsg || "");
  throw new WechatApiError(`WeChat API ${endpoint} failed: ret=${ret}${errmsg ? ` ${errmsg}` : ""}`, {
    code: "WECHAT_API_RET",
    kind: "api",
    endpoint,
    ret: Number(ret),
    errmsg,
    retryable: Number(ret) === -2,
    response,
  });
}

export async function apiGet({ baseUrl = DEFAULT_BASE_URL, endpoint, timeoutMs = 15_000, signal }) {
  const url = buildApiUrl(baseUrl, endpoint);
  return fetchJsonWithTimeout(url, { method: "GET", headers: commonHeaders(), signal }, timeoutMs, endpoint);
}

export async function apiPost({
  baseUrl = DEFAULT_BASE_URL,
  endpoint,
  token,
  body = {},
  timeoutMs = 15_000,
  signal,
}) {
  const url = buildApiUrl(baseUrl, endpoint);
  return fetchJsonWithTimeout(
    url,
    { method: "POST", headers: commonHeaders(token), body: JSON.stringify(body), signal },
    timeoutMs,
    endpoint,
  );
}

export async function fetchQrCode({ botType = DEFAULT_BOT_TYPE, localTokenList = [] } = {}) {
  return apiPost({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
  });
}

export async function pollQrStatus({ qrcode, verifyCode, baseUrl = DEFAULT_BASE_URL }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  return apiGet({ baseUrl, endpoint, timeoutMs: 35_000 });
}

export async function getUpdates({ baseUrl, token, getUpdatesBuf, timeoutMs = 35_000, signal }) {
  try {
    return await apiPost({
      baseUrl,
      token,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf ?? "", base_info: baseInfo() },
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (isWechatApiError(error) && error.code === "WECHAT_TIMEOUT") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf ?? "" };
    }
    throw error;
  }
}

function messageClientId(prefix = "msg") {
  return `wechat-agent-${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendMessageItems({ baseUrl, token, to, items, contextToken, runId, clientId }) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError("items must be a non-empty array");
  const resolvedClientId = clientId || messageClientId();
  const response = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendmessage",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: resolvedClientId,
        message_type: MESSAGE_TYPE.BOT,
        message_state: 2,
        item_list: items,
        context_token: contextToken || undefined,
        run_id: runId || undefined,
      },
      base_info: baseInfo(),
    },
    timeoutMs: 15_000,
  });
  assertApiSuccess(response, { endpoint: "ilink/bot/sendmessage" });
  return { clientId: resolvedClientId, response };
}

export async function sendText({ baseUrl, token, to, text, contextToken, runId, clientId }) {
  if (typeof text !== "string" || !text) throw new TypeError("text must be a non-empty string");
  return sendMessageItems({
    baseUrl,
    token,
    to,
    contextToken,
    runId,
    clientId: clientId || messageClientId("text"),
    items: [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text } }],
  });
}

export async function getConfig({ baseUrl, token, to, contextToken, signal }) {
  return apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/getconfig",
    body: { ilink_user_id: to, context_token: contextToken || undefined, base_info: baseInfo() },
    timeoutMs: 10_000,
    signal,
  });
}

export async function sendTyping({ baseUrl, token, to, typingTicket, status = 1, signal }) {
  if (!typingTicket) return;
  const response = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendtyping",
    body: { ilink_user_id: to, typing_ticket: typingTicket, status, base_info: baseInfo() },
    timeoutMs: 10_000,
    signal,
  });
  assertApiSuccess(response, { endpoint: "ilink/bot/sendtyping" });
}

export function aesEcbPaddedSize(plaintextSize) {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) throw new TypeError("plaintextSize must be non-negative");
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(key) || key.length !== 16) {
    throw new TypeError("AES-128-ECB encryption requires Buffer plaintext and a 16-byte key");
  }
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function buildCdnUploadUrl({ cdnBaseUrl = CDN_BASE_URL, uploadParam, filekey }) {
  if (!uploadParam || !filekey) throw new Error("CDN upload requires uploadParam and filekey");
  return `${normalizeCdnBaseUrl(cdnBaseUrl)}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

function validateCdnUploadUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new WechatApiError("Invalid CDN upload URL", {
      code: "WECHAT_INVALID_CDN_URL",
      kind: "configuration",
      cause,
    });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(host === "cdn.weixin.qq.com" || host.endsWith(".cdn.weixin.qq.com"))
  ) {
    throw new WechatApiError("CDN upload URL must use an official WeChat HTTPS host", {
      code: "WECHAT_UNTRUSTED_CDN_URL",
      kind: "configuration",
    });
  }
  return url.toString();
}

async function uploadBufferToCdn({
  buffer,
  uploadFullUrl,
  uploadParam,
  filekey,
  cdnBaseUrl,
  aeskey,
  maxAttempts = 3,
  timeoutMs = 60_000,
}) {
  const ciphertext = encryptAesEcb(buffer, aeskey);
  const cdnUrl = validateCdnUploadUrl(
    uploadFullUrl?.trim() || buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }),
  );
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(cdnUrl, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = response.headers.get("x-error-message") || errorBodySnippet(await response.text());
        throw new WechatApiError(`CDN upload failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
          code: "WECHAT_CDN_HTTP_ERROR",
          kind: "cdn",
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      const downloadParam = response.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new WechatApiError("CDN upload response is missing x-encrypted-param", {
          code: "WECHAT_CDN_PROTOCOL_ERROR",
          kind: "cdn",
        });
      }
      return { downloadParam, ciphertextSize: ciphertext.length };
    } catch (cause) {
      lastError = cause?.name === "AbortError"
        ? new WechatApiError(`CDN upload timed out after ${timeoutMs}ms`, {
            code: "WECHAT_CDN_TIMEOUT",
            kind: "cdn",
            retryable: true,
            cause,
          })
        : isWechatApiError(cause)
          ? cause
          : new WechatApiError(`CDN upload network error: ${cause?.message || String(cause)}`, {
              code: "WECHAT_CDN_NETWORK_ERROR",
              kind: "cdn",
              retryable: true,
              cause,
            });
      if (attempt >= maxAttempts || (isWechatApiError(lastError) && !lastError.retryable)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function getUploadUrl({
  baseUrl,
  token,
  to,
  filekey,
  rawsize,
  rawfilemd5,
  filesize,
  aeskey,
  mediaType = UPLOAD_MEDIA_TYPE.FILE,
}) {
  if (!Object.values(UPLOAD_MEDIA_TYPE).includes(mediaType)) throw new TypeError("Unsupported upload media type");
  const response = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: baseInfo(),
    },
    timeoutMs: 15_000,
  });
  return assertApiSuccess(response, { endpoint: "ilink/bot/getuploadurl" });
}

function inferUploadMediaType(mimeType) {
  return mimeType.startsWith("image/") ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE;
}

export async function uploadFile({
  baseUrl,
  token,
  to,
  filePath,
  fileBuffer,
  fileName,
  cdnBaseUrl = CDN_BASE_URL,
  mediaType,
  maxBytes = MAX_OUTBOUND_FILE_BYTES,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_OUTBOUND_FILE_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${MAX_OUTBOUND_FILE_BYTES}`);
  }
  let plaintext;
  if (fileBuffer !== undefined) {
    if (!Buffer.isBuffer(fileBuffer) && !(fileBuffer instanceof Uint8Array)) {
      throw new TypeError("fileBuffer must be a Buffer or Uint8Array");
    }
    plaintext = Buffer.from(fileBuffer);
  } else {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    const handle = await fs.open(filePath, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Outbound media must be a regular file");
      if (stat.size > maxBytes) throw new Error(`Outbound file exceeds ${maxBytes} bytes`);
      plaintext = await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  if (plaintext.length > maxBytes) throw new Error(`Outbound file exceeds ${maxBytes} bytes`);
  const mimeType = detectMimeType(plaintext);
  const resolvedMediaType = mediaType ?? inferUploadMediaType(mimeType);
  if (![UPLOAD_MEDIA_TYPE.IMAGE, UPLOAD_MEDIA_TYPE.FILE].includes(resolvedMediaType)) {
    throw new TypeError("Generic outbound sending currently supports image or file media types");
  }
  if (resolvedMediaType === UPLOAD_MEDIA_TYPE.IMAGE && !mimeType.startsWith("image/")) {
    throw new Error(`Outbound image content has unsupported MIME type ${mimeType}`);
  }

  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const uploadUrl = await getUploadUrl({
    baseUrl,
    token,
    to,
    filekey,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
    mediaType: resolvedMediaType,
  });
  if (!uploadUrl.upload_full_url?.trim() && !uploadUrl.upload_param) {
    throw new WechatApiError("getuploadurl returned no upload URL", {
      code: "WECHAT_UPLOAD_URL_MISSING",
      kind: "protocol",
      response: uploadUrl,
    });
  }

  const uploaded = await uploadBufferToCdn({
    buffer: plaintext,
    uploadFullUrl: uploadUrl.upload_full_url,
    uploadParam: uploadUrl.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  });
  return {
    filekey,
    downloadEncryptedQueryParam: uploaded.downloadParam,
    aeskey: aeskey.toString("hex"),
    fileName: safeBasename(fileName || filePath, "attachment"),
    fileSize: rawsize,
    fileSizeCiphertext: uploaded.ciphertextSize,
    mediaType: resolvedMediaType,
    mimeType,
  };
}

export async function uploadImage(options) {
  return uploadFile({ ...options, mediaType: UPLOAD_MEDIA_TYPE.IMAGE });
}

function outboundMediaDescriptor(uploaded) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey, "utf8").toString("base64"),
    encrypt_type: 1,
  };
}

export async function sendFile({
  baseUrl,
  token,
  to,
  filePath,
  fileBuffer,
  fileName,
  text = "",
  contextToken,
  runId,
  clientId,
}) {
  const uploaded = await uploadFile({ baseUrl, token, to, filePath, fileBuffer, fileName });
  if (text) await sendText({ baseUrl, token, to, text, contextToken, runId, clientId: clientId ? `${clientId}-caption` : undefined });
  const item = uploaded.mediaType === UPLOAD_MEDIA_TYPE.IMAGE
    ? {
        type: MESSAGE_ITEM_TYPE.IMAGE,
        image_item: { media: outboundMediaDescriptor(uploaded), mid_size: uploaded.fileSizeCiphertext },
      }
    : {
        type: MESSAGE_ITEM_TYPE.FILE,
        file_item: {
          media: outboundMediaDescriptor(uploaded),
          file_name: uploaded.fileName,
          len: String(uploaded.fileSize),
        },
      };
  return sendMessageItems({
    baseUrl,
    token,
    to,
    items: [item],
    contextToken,
    runId,
    clientId: clientId || messageClientId(uploaded.mediaType === UPLOAD_MEDIA_TYPE.IMAGE ? "image" : "file"),
  });
}

export async function sendImage(options) {
  const uploaded = await uploadImage(options);
  if (options.text) {
    await sendText({
      baseUrl: options.baseUrl,
      token: options.token,
      to: options.to,
      text: options.text,
      contextToken: options.contextToken,
      runId: options.runId,
      clientId: options.clientId ? `${options.clientId}-caption` : undefined,
    });
  }
  return sendMessageItems({
    baseUrl: options.baseUrl,
    token: options.token,
    to: options.to,
    contextToken: options.contextToken,
    runId: options.runId,
    clientId: options.clientId || messageClientId("image"),
    items: [{
      type: MESSAGE_ITEM_TYPE.IMAGE,
      image_item: { media: outboundMediaDescriptor(uploaded), mid_size: uploaded.fileSizeCiphertext },
    }],
  });
}

export async function notifyStart({ baseUrl, token, signal }) {
  const response = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: baseInfo() },
    timeoutMs: 10_000,
    signal,
  });
  return assertApiSuccess(response, { endpoint: "ilink/bot/msg/notifystart" });
}

export function extractTextItems(message) {
  return (Array.isArray(message?.item_list) ? message.item_list : [])
    .filter((item) => Number(item?.type) === MESSAGE_ITEM_TYPE.TEXT && typeof item?.text_item?.text === "string")
    .map((item) => item.text_item.text)
    .filter(Boolean);
}
