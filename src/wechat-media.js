import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const PROCESS_UID = typeof process.getuid === "function" ? process.getuid() : "user";
export const DEFAULT_MEDIA_CACHE_DIR = path.join(os.tmpdir(), `wechat-agent-bridge-media-${PROCESS_UID}`);
export const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MEDIA_MAX_FILES = 100;
export const DEFAULT_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const DEFAULT_MEDIA_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const INBOUND_ITEM_TYPE = Object.freeze({
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
});

const ITEM_NAMES = new Map([
  [INBOUND_ITEM_TYPE.TEXT, "text"],
  [INBOUND_ITEM_TYPE.IMAGE, "image"],
  [INBOUND_ITEM_TYPE.VOICE, "voice"],
  [INBOUND_ITEM_TYPE.FILE, "file"],
  [INBOUND_ITEM_TYPE.VIDEO, "video"],
]);

const MIME_EXTENSIONS = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/json": ".json",
  "text/plain": ".txt",
});

const PRESERVE_ORIGINAL_EXTENSION_MIMES = new Set([
  "application/octet-stream",
  "application/zip",
  "text/plain",
]);

function hasBytes(buffer, offset, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function hasAscii(buffer, offset, text) {
  return hasBytes(buffer, offset, [...Buffer.from(text, "ascii")]);
}

function looksLikeUtf8Text(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
  }
  if (controls / sample.length > 0.02) return false;
  const decoded = sample.toString("utf8");
  return !decoded.includes("\ufffd");
}

export function detectMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("detectMimeType expects a Buffer");
  if (hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(buffer, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAscii(buffer, 0, "GIF87a") || hasAscii(buffer, 0, "GIF89a")) return "image/gif";
  if (hasAscii(buffer, 0, "RIFF") && hasAscii(buffer, 8, "WEBP")) return "image/webp";
  if (hasAscii(buffer, 0, "BM")) return "image/bmp";
  if (hasAscii(buffer, 0, "%PDF-")) return "application/pdf";
  if (hasBytes(buffer, 0, [0x50, 0x4b, 0x03, 0x04]) || hasBytes(buffer, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return "application/zip";
  }
  if (hasBytes(buffer, 0, [0x1f, 0x8b])) return "application/gzip";
  if (hasAscii(buffer, 0, "OggS")) return "audio/ogg";
  if (hasAscii(buffer, 0, "RIFF") && hasAscii(buffer, 8, "WAVE")) return "audio/wav";
  if (hasAscii(buffer, 0, "ID3") || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (buffer.length >= 12 && hasAscii(buffer, 4, "ftyp")) return "video/mp4";
  if (hasBytes(buffer, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (looksLikeUtf8Text(buffer)) {
    const text = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8").trim();
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        JSON.parse(text);
        return "application/json";
      } catch {
        // It is still safe to treat malformed JSON-looking data as plain text.
      }
    }
    return "text/plain";
  }
  return "application/octet-stream";
}

export function safeBasename(input, fallback = "attachment") {
  const leaf = path.basename(String(input || ""))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const safe = leaf || fallback;
  const chars = [...safe];
  return chars.length <= 120 ? safe : chars.slice(chars.length - 120).join("");
}

function safeExtension(fileName) {
  const extension = path.extname(safeBasename(fileName, ""));
  return /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : "";
}

export function decodeWechatAesKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length === 16) return Buffer.from(value);
    value = value.toString("utf8");
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing media AES key");
  const trimmed = value.trim();
  if (/^[a-f0-9]{32}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");

  const canonical = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[a-z0-9+/]+={0,2}$/i.test(canonical)) throw new Error("Invalid media AES key encoding");
  const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length === 16) return decoded;
  const decodedText = decoded.toString("ascii");
  if (/^[a-f0-9]{32}$/i.test(decodedText)) return Buffer.from(decodedText, "hex");
  throw new Error("Media AES key must decode to 16 bytes");
}

function itemPayload(item) {
  switch (Number(item?.type)) {
    case INBOUND_ITEM_TYPE.IMAGE:
      return item?.image_item;
    case INBOUND_ITEM_TYPE.VOICE:
      return item?.voice_item;
    case INBOUND_ITEM_TYPE.FILE:
      return item?.file_item;
    case INBOUND_ITEM_TYPE.VIDEO:
      return item?.video_item;
    default:
      return undefined;
  }
}

export function extractCdnDescriptor(item) {
  const payload = itemPayload(item);
  if (!payload || typeof payload !== "object") return null;
  const media = payload.media && typeof payload.media === "object" ? payload.media : null;
  const legacy = payload.cdn_media && typeof payload.cdn_media === "object" ? payload.cdn_media : null;
  const queryParam = media?.encrypt_query_param || legacy?.encrypt_query_param;
  const aesKey = media?.aes_key || payload.aeskey || payload.aes_key || legacy?.aes_key;
  if (!queryParam || !aesKey) return null;
  return {
    encryptQueryParam: String(queryParam),
    aesKey: String(aesKey),
    cdnUrl: legacy?.cdn_url ? String(legacy.cdn_url) : undefined,
  };
}

function parseDeclaredSize(value) {
  const size = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

export function extractInboundItems(message) {
  const output = [];
  for (const item of Array.isArray(message?.item_list) ? message.item_list : []) {
    const type = ITEM_NAMES.get(Number(item?.type));
    if (!type) continue;
    if (type === "text") {
      const text = item?.text_item?.text;
      if (typeof text === "string" && text) output.push({ type, text, raw: item });
      continue;
    }
    const payload = itemPayload(item) || {};
    output.push({
      type,
      text: type === "voice" && typeof payload.text === "string" ? payload.text : undefined,
      name: type === "file" ? safeBasename(payload.file_name, "attachment") : undefined,
      declaredSize: parseDeclaredSize(payload.len ?? payload.file_size ?? payload.size),
      media: extractCdnDescriptor(item),
      raw: item,
    });
  }
  return output;
}

export function extractInboundContent(message) {
  const text = [];
  const attachments = [];
  for (const item of extractInboundItems(message)) {
    if (item.type === "text" && item.text) {
      text.push(item.text);
      continue;
    }
    if (item.type === "voice" && item.text) text.push(item.text);
    if (item.media) {
      attachments.push({
        type: item.type,
        name: item.name,
        declaredSize: item.declaredSize,
        media: item.media,
        item: item.raw,
      });
    }
  }
  return { text: text.join("\n").trim(), attachments };
}

function isOfficialCdnHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "cdn.weixin.qq.com" || host.endsWith(".cdn.weixin.qq.com");
}

export function normalizeCdnBaseUrl(input = DEFAULT_CDN_BASE_URL) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid WeChat CDN URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !isOfficialCdnHost(parsed.hostname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("WeChat CDN URL must use an official HTTPS host");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl = DEFAULT_CDN_BASE_URL) {
  const value = String(encryptQueryParam || "");
  if (!value || value.length > 16_384 || value.includes("\0")) throw new Error("Invalid encrypted CDN query parameter");
  return `${normalizeCdnBaseUrl(cdnBaseUrl)}/download?encrypted_query_param=${encodeURIComponent(value)}`;
}

export function decryptWechatMedia(ciphertext, aesKey) {
  if (!Buffer.isBuffer(ciphertext)) throw new TypeError("ciphertext must be a Buffer");
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("Invalid encrypted media length");
  const decipher = crypto.createDecipheriv("aes-128-ecb", decodeWechatAesKey(aesKey), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function responseBufferWithLimit(response, maxBytes) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Encrypted media exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error(`Encrypted media exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export async function pruneMediaCache({
  cacheDir = DEFAULT_MEDIA_CACHE_DIR,
  maxFiles = DEFAULT_MEDIA_MAX_FILES,
  ttlMs = DEFAULT_MEDIA_TTL_MS,
  now = Date.now(),
  protectedPaths = [],
} = {}) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(cacheDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Unsafe media cache directory");
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error("Media cache directory is owned by another user");
  }
  await fs.chmod(cacheDir, 0o700);
  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const protectedSet = new Set([...protectedPaths].map((entry) => path.resolve(String(entry))));
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(cacheDir, entry.name);
    if (entry.isSymbolicLink()) {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) {
      const temporaryStat = await fs.stat(filePath);
      if (now - temporaryStat.mtimeMs > 5 * 60 * 1000) await fs.unlink(filePath).catch(() => {});
      continue;
    }
    const stat = await fs.stat(filePath);
    const isProtected = protectedSet.has(path.resolve(filePath));
    if (!isProtected && ttlMs >= 0 && now - stat.mtimeMs > ttlMs) {
      await fs.unlink(filePath).catch(() => {});
    } else {
      files.push({ path: filePath, mtimeMs: stat.mtimeMs, isProtected });
    }
  }
  const removable = files.filter((entry) => !entry.isProtected).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const protectedCount = files.length - removable.length;
  for (const entry of removable.slice(Math.max(0, maxFiles - protectedCount))) {
    await fs.unlink(entry.path).catch(() => {});
  }
}

export async function downloadAndCacheMedia({
  item,
  cacheDir = DEFAULT_MEDIA_CACHE_DIR,
  cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
  maxFiles = DEFAULT_MEDIA_MAX_FILES,
  ttlMs = DEFAULT_MEDIA_TTL_MS,
  protectedPaths = [],
  timeoutMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  const descriptor = extractCdnDescriptor(item);
  if (!descriptor) throw new Error("Message item has no encrypted CDN media descriptor");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error("maxFiles must be a positive integer");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(buildCdnDownloadUrl(descriptor.encryptQueryParam, cdnBaseUrl), {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`CDN download failed with HTTP ${response.status}`);
    const ciphertext = await responseBufferWithLimit(response, maxBytes + 16);
    const plaintext = decryptWechatMedia(ciphertext, descriptor.aesKey);
    if (plaintext.length > maxBytes) throw new Error(`Decrypted media exceeds ${maxBytes} bytes`);

    const mimeType = detectMimeType(plaintext);
    const payload = itemPayload(item) || {};
    const originalName = safeBasename(payload.file_name, `${ITEM_NAMES.get(Number(item?.type)) || "media"}`);
    const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
    const originalExtension = safeExtension(originalName);
    const extension = (
      PRESERVE_ORIGINAL_EXTENSION_MIMES.has(mimeType) && originalExtension
        ? originalExtension
        : MIME_EXTENSIONS[mimeType]
    ) || originalExtension || ".bin";
    const fileName = `${hash}${extension}`;
    const filePath = path.join(cacheDir, fileName);

    await pruneMediaCache({ cacheDir, maxFiles: Math.max(0, maxFiles - 1), ttlMs, protectedPaths });
    const temporaryPath = path.join(cacheDir, `.${hash}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(plaintext);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      let reuseExisting = false;
      try {
        const existing = await fs.lstat(filePath);
        if (existing.isFile() && !existing.isSymbolicLink() && existing.size === plaintext.length) {
          const existingBytes = await fs.readFile(filePath);
          reuseExisting = crypto.createHash("sha256").update(existingBytes).digest("hex") === hash;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (reuseExisting) {
        await fs.unlink(temporaryPath);
        await fs.utimes(filePath, new Date(), new Date()).catch(() => {});
      } else {
        await fs.rename(temporaryPath, filePath);
        await fs.chmod(filePath, 0o600);
      }
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
    await pruneMediaCache({ cacheDir, maxFiles, ttlMs, protectedPaths });
    const type = ITEM_NAMES.get(Number(item?.type)) || "media";
    return {
      path: filePath,
      hash,
      size: plaintext.length,
      mimeType,
      mime: mimeType,
      originalName,
      type,
      kind: type,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`CDN download timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function materializeInboundContent(message, {
  maxAttachments = DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
  maxTotalBytes = DEFAULT_MEDIA_MAX_TOTAL_BYTES,
  ...downloadOptions
} = {}) {
  const content = extractInboundContent(message);
  if (content.attachments.length > maxAttachments) {
    throw new Error(`Message contains ${content.attachments.length} attachments; maximum is ${maxAttachments}`);
  }
  const attachments = [];
  let totalBytes = 0;
  const protectedPaths = new Set(downloadOptions.protectedPaths || []);
  const perAttachmentMax = downloadOptions.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  for (const attachment of content.attachments) {
    const remainingBytes = maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) throw new Error(`Message attachments exceed ${maxTotalBytes} total bytes`);
    const payload = itemPayload(attachment.item) || {};
    const declaredBytes = Number.parseInt(payload.len || payload.file_size || payload.size || "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > remainingBytes) {
      throw new Error(`Message attachments exceed ${maxTotalBytes} total bytes`);
    }
    const downloaded = await downloadAndCacheMedia({
      item: attachment.item,
      ...downloadOptions,
      protectedPaths,
      maxBytes: Math.min(perAttachmentMax, remainingBytes),
    });
    totalBytes += downloaded.size;
    if (totalBytes > maxTotalBytes) throw new Error(`Message attachments exceed ${maxTotalBytes} total bytes`);
    protectedPaths.add(downloaded.path);
    attachments.push({ ...downloaded, name: attachment.name || downloaded.originalName });
  }
  return { text: content.text, attachments };
}
