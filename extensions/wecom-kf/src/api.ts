/**
 * 微信客服渠道 API
 *
 * 提供 access_token 缓存、消息拉取和发送、媒体下载/上传/归档能力
 */
import type { ResolvedWecomKfAccount, WecomKfSendTarget, AccessTokenCacheEntry, SyncMsgResponse } from "./types.js";
import {
  resolveApiBaseUrl,
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
} from "./config.js";
import { mkdir, writeFile, unlink, rename, copyFile, readdir, stat, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { hasFfmpeg, transcodeToAmr } from "./ffmpeg.js";
import { resolveWecomVoiceSourceExtension, shouldTranscodeWecomVoice } from "./voice.js";

/** Access Token 缓存 (key: corpId:kf) */
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

/** Access Token 有效期: 2小时减去5分钟缓冲 */
const ACCESS_TOKEN_TTL_MS = 7200 * 1000 - 5 * 60 * 1000;

function buildWecomApiUrl(account: ResolvedWecomKfAccount, pathWithQuery: string): string {
  const normalizedPath = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  return `${resolveApiBaseUrl(account.config)}${normalizedPath}`;
}

function resolveOpenKfId(account: ResolvedWecomKfAccount, override?: string): string | undefined {
  const candidate = override?.trim() || account.openKfid?.trim();
  return candidate || undefined;
}

/**
 * 移除 Markdown 格式，转换为纯文本
 * 微信客服文本消息不支持 Markdown
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // 1. 代码块：提取内容并缩进
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = code.trim();
    if (!trimmedCode) return "";
    const langLabel = lang ? `[${lang}]\n` : "";
    const indentedCode = trimmedCode
      .split("\n")
      .map((line: string) => `    ${line}`)
      .join("\n");
    return `\n${langLabel}${indentedCode}\n`;
  });

  // 2. 标题：用【】标记
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "【$1】");

  // 3. 粗体/斜体：保留文字
  result = result
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/(?<![\w/])_(.+?)_(?![\w/])/g, "$1");

  // 4. 列表项转为点号
  result = result.replace(/^[-*]\s+/gm, "· ");

  // 5. 有序列表保持编号
  result = result.replace(/^(\d+)\.\s+/gm, "$1. ");

  // 6. 行内代码保留内容
  result = result.replace(/`([^`]+)`/g, "$1");

  // 7. 删除线
  result = result.replace(/~~(.*?)~~/g, "$1");

  // 8. 链接：保留文字和 URL
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // 9. 图片：显示 alt 文字
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");

  // 10. 表格：简化为对齐文本
  result = result.replace(
    /\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)*)/g,
    (_match, header, body) => {
      const headerCells = header.split("|").map((c: string) => c.trim()).filter(Boolean);
      const rows = body.trim().split("\n").map((row: string) =>
        row.split("|").map((c: string) => c.trim()).filter(Boolean)
      );

      const colWidths = headerCells.map((h: string, i: number) => {
        const maxRowWidth = Math.max(...rows.map((r: string[]) => (r[i] || "").length));
        return Math.max(h.length, maxRowWidth);
      });

      const formattedHeader = headerCells
        .map((h: string, i: number) => h.padEnd(colWidths[i]))
        .join("  ");

      const formattedRows = rows
        .map((row: string[]) =>
          headerCells.map((_: string, i: number) =>
            (row[i] || "").padEnd(colWidths[i])
          ).join("  ")
        )
        .join("\n");

      return `${formattedHeader}\n${formattedRows}\n`;
    }
  );

  // 11. 引用块：去掉 > 前缀
  result = result.replace(/^>\s?/gm, "");

  // 12. 水平线
  result = result.replace(/^[-*_]{3,}$/gm, "────────────");

  // 13. 多个换行合并
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * 获取 access_token（带缓存）
 * 使用 corpId + corpSecret 获取，专用于微信客服接口
 */
export async function getAccessToken(account: ResolvedWecomKfAccount): Promise<string> {
  if (!account.corpId || !account.corpSecret) {
    throw new Error("corpId or corpSecret not configured");
  }

  const key = `${account.corpId}:kf`;
  const cached = accessTokenCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const url = buildWecomApiUrl(
    account,
    `/cgi-bin/gettoken?corpid=${encodeURIComponent(account.corpId)}&corpsecret=${encodeURIComponent(account.corpSecret)}`
  );
  const resp = await fetch(url);
  const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };

  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`gettoken failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.access_token) {
    throw new Error("gettoken returned empty access_token");
  }

  accessTokenCache.set(key, {
    token: data.access_token,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });

  return data.access_token;
}

/**
 * 清除指定账户的 Access Token 缓存
 */
export function clearAccessTokenCache(account: ResolvedWecomKfAccount): void {
  const key = `${account.corpId}:kf`;
  accessTokenCache.delete(key);
}

/**
 * 清除所有 Access Token 缓存
 */
export function clearAllAccessTokenCache(): void {
  accessTokenCache.clear();
}

/** 发送消息结果 */
export type SendMessageResult = {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  msgid?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// sync_msg: 拉取客服消息
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 拉取微信客服消息
 *
 * 收到回调通知后，调用此接口主动拉取消息内容
 */
export async function syncMessages(
  account: ResolvedWecomKfAccount,
  cursor?: string,
  callbackToken?: string,
  limit = 1000,
  openKfIdOverride?: string,
): Promise<SyncMsgResponse> {
  const openKfId = resolveOpenKfId(account, openKfIdOverride);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return { errcode: -1, errmsg: "Account not configured for sync_msg (missing corpId, corpSecret, or openKfid)" };
  }

  const accessToken = await getAccessToken(account);
  const url = buildWecomApiUrl(
    account,
    `/cgi-bin/kf/sync_msg?access_token=${encodeURIComponent(accessToken)}`
  );

  const payload: Record<string, unknown> = {
    open_kfid: openKfId,
    limit,
  };

  if (cursor) {
    payload.cursor = cursor;
  }
  if (callbackToken) {
    payload.token = callbackToken;
  }

  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

  const data = (await resp.json()) as SyncMsgResponse;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// send_msg: 发送客服消息
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发送文本消息给微信客户
 *
 * 注意：仅在用户主动发消息后 48 小时内可发送，最多 5 条
 */
export async function sendKfMessage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  message: string,
): Promise<SendMessageResult> {
  const openKfId = resolveOpenKfId(account, target.openKfId);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for sending (missing corpId, corpSecret, or openKfid)",
    };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    touser: target.externalUserId,
    open_kfid: openKfId,
    msgtype: "text",
    text: { content: message },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

/**
 * 发送图片消息给微信客户
 */
export async function sendKfImageMessage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  mediaId: string,
): Promise<SendMessageResult> {
  const openKfId = resolveOpenKfId(account, target.openKfId);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return { ok: false, errcode: -1, errmsg: "Account not configured for sending" };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    touser: target.externalUserId,
    open_kfid: openKfId,
    msgtype: "image",
    image: { media_id: mediaId },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

/**
 * 发送文件消息给微信客户
 */
export async function sendKfFileMessage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  mediaId: string,
): Promise<SendMessageResult> {
  const openKfId = resolveOpenKfId(account, target.openKfId);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return { ok: false, errcode: -1, errmsg: "Account not configured for sending" };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    touser: target.externalUserId,
    open_kfid: openKfId,
    msgtype: "file",
    file: { media_id: mediaId },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// send_msg_on_event: 事件响应消息（欢迎语等）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通过事件响应接口发送消息（欢迎语、进入会话等场景）
 *
 * 使用回调事件中的 welcome_code，不受 48 小时窗口和条数限制
 * 官方文档: https://developer.work.weixin.qq.com/document/path/95122
 */
export async function sendKfEventMessage(
  account: ResolvedWecomKfAccount,
  code: string,
  message: string,
  msgtype: "text" = "text",
): Promise<SendMessageResult> {
  if (!account.corpId || !account.corpSecret) {
    return { ok: false, errcode: -1, errmsg: "Account not configured for sending (missing corpId or corpSecret)" };
  }

  if (!code.trim()) {
    return { ok: false, errcode: -1, errmsg: "welcome_code is empty" };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    code,
    msgtype,
    text: { content: message },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg_on_event?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 素材上传
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 上传临时素材获取 media_id
 */
export async function uploadMedia(
  account: ResolvedWecomKfAccount,
  buffer: Buffer,
  filename: string,
  type: "image" | "voice" | "video" | "file" = "image",
): Promise<string> {
  if (!account.canSend) {
    throw new Error("Account not configured for media upload");
  }

  const accessToken = await getAccessToken(account);
  const boundary = `----FormBoundary${Date.now()}`;

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${type}`),
    {
      method: "POST",
      body: body,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; media_id?: string };

  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`Upload media failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error("Upload media returned empty media_id");
  }

  return data.media_id;
}

/**
 * 下载图片并发送
 */
export async function downloadAndSendKfImage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  imageUrl: string,
): Promise<SendMessageResult> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) {
      return { ok: false, errcode: -1, errmsg: `Download image failed: HTTP ${resp.status}` };
    }
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const urlPath = imageUrl.split("?")[0] ?? "";
    const ext = urlPath.split(".").pop() ?? "jpg";
    const filename = `image_${Date.now()}.${ext}`;

    const mediaId = await uploadMedia(account, buffer, filename, "image");
    return await sendKfImageMessage(account, target, mediaId);
  } catch (err) {
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 将长文本按字节长度分割成多个片段
 * 企业微信限制：每条消息最长 2048 字节
 */
export function splitMessageByBytes(text: string, maxBytes = 2048): string[] {
  const result: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");

    if (currentBytes + charBytes > maxBytes && current.length > 0) {
      result.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * 将文本拆分成可发送的片段（去除 Markdown + 按字节切分）
 */
export function splitActiveTextChunks(text: string): string[] {
  const formatted = stripMarkdown(text).trim();
  if (!formatted) return [];
  return splitMessageByBytes(formatted, 2048).filter((chunk) => chunk.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体：下载 → 临时存储 → 归档
// ─────────────────────────────────────────────────────────────────────────────

/** 下载超时时间（毫秒） */
const DOWNLOAD_TIMEOUT = 120_000;

export type SavedInboundMedia = {
  ok: boolean;
  path?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
  error?: string;
};

const MIME_EXT_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "audio/amr": ".amr",
  "audio/speex": ".speex",
  "audio/x-speex": ".speex",
  "audio/silk": ".silk",
  "audio/x-silk": ".silk",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/flac": ".flac",
};

function pickExtFromMime(mimeType?: string): string {
  const t = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return (t && MIME_EXT_MAP[t]) || "";
}

function parseContentDispositionFilename(headerValue?: string | null): string | undefined {
  const v = String(headerValue ?? "");
  if (!v) return undefined;

  const m1 = v.match(/filename\*=UTF-8''([^;]+)/i);
  if (m1?.[1]) {
    try {
      return decodeURIComponent(m1[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return m1[1].trim().replace(/^"|"$/g, "");
    }
  }

  const m2 = v.match(/filename=([^;]+)/i);
  if (m2?.[1]) return m2[1].trim().replace(/^"|"$/g, "");

  return undefined;
}

function formatDateDir(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getWecomKfTempDir(): string {
  return join(tmpdir(), "wecom-kf-media");
}

function isProbablyInWecomKfTmpDir(p: string): boolean {
  try {
    const base = getWecomKfTempDir();
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    return norm(p).includes(norm(base));
  } catch {
    return false;
  }
}

export class FileSizeLimitError extends Error {
  public readonly actualSize: number;
  public readonly limitSize: number;
  public readonly msgType: string;

  constructor(actualSize: number, limitSize: number, msgType: string) {
    super(`File size ${actualSize} bytes exceeds limit ${limitSize} bytes for ${msgType}`);
    this.name = "FileSizeLimitError";
    this.actualSize = actualSize;
    this.limitSize = limitSize;
    this.msgType = msgType;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileSizeLimitError);
    }
  }
}

export class TimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Download timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * 下载企业微信 media_id 到本地文件
 * 支持 media_id 和 http(s) URL
 */
export async function downloadWecomMediaToFile(
  account: ResolvedWecomKfAccount,
  mediaId: string,
  opts: { dir?: string; maxBytes: number; prefix?: string }
): Promise<SavedInboundMedia> {
  const raw = String(mediaId ?? "").trim();
  if (!raw) return { ok: false, error: "mediaId/url is empty" };

  const isHttp = raw.startsWith("http://") || raw.startsWith("https://");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  let resp: Response;
  let contentType: string | undefined;
  let filenameFromHeader: string | undefined;

  try {
    if (isHttp) {
      resp = await fetch(raw, { signal: controller.signal });
      if (!resp.ok) {
        return { ok: false, error: `download failed: HTTP ${resp.status}` };
      }
      contentType = resp.headers.get("content-type") || undefined;
      filenameFromHeader = undefined;
    } else {
      if (!account.corpId || !account.corpSecret) {
        return { ok: false, error: "Account not configured for media download (missing corpId/corpSecret)" };
      }
      const token = await getAccessToken(account);
      const url = buildWecomApiUrl(
        account,
        `/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(raw)}`
      );

      resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        return { ok: false, error: `media/get failed: HTTP ${resp.status}` };
      }

      contentType = resp.headers.get("content-type") || undefined;
      const cd = resp.headers.get("content-disposition");
      filenameFromHeader = parseContentDispositionFilename(cd);

      if ((contentType ?? "").includes("application/json")) {
        try {
          const j = (await resp.json()) as { errcode?: number; errmsg?: string };
          return { ok: false, error: `media/get returned json: errcode=${j?.errcode} errmsg=${j?.errmsg}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    const contentLength = resp.headers.get("content-length");
    if (contentLength && opts.maxBytes > 0) {
      const declaredSize = parseInt(contentLength, 10);
      if (!Number.isNaN(declaredSize) && declaredSize > opts.maxBytes) {
        throw new FileSizeLimitError(declaredSize, opts.maxBytes, "media");
      }
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      return { ok: false, error: "Response body is not readable" };
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (opts.maxBytes > 0 && totalSize > opts.maxBytes) {
        reader.cancel();
        throw new FileSizeLimitError(totalSize, opts.maxBytes, "media");
      }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));

    const baseDir = (opts.dir ?? "").trim() || getWecomKfTempDir();
    await mkdir(baseDir, { recursive: true });

    const prefix = (opts.prefix ?? "media").trim() || "media";
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    const extFromMime = pickExtFromMime(contentType);
    const extFromName = filenameFromHeader ? extname(filenameFromHeader) : (isHttp ? extname(raw.split("?")[0] || "") : "");
    const ext = extFromName || extFromMime || ".bin";

    const filename = `${prefix}_${timestamp}_${randomSuffix}${ext}`;
    const outPath = join(baseDir, filename);

    await writeFile(outPath, buf);

    return {
      ok: true,
      path: outPath,
      mimeType: contentType,
      size: buf.length,
      filename,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(DOWNLOAD_TIMEOUT);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 将临时媒体文件归档到 inbound/YYYY-MM-DD
 */
export async function finalizeInboundMedia(account: ResolvedWecomKfAccount, filePath: string): Promise<string> {
  const p = String(filePath ?? "").trim();
  if (!p) return p;

  if (!isProbablyInWecomKfTmpDir(p)) return p;

  const baseDir = resolveInboundMediaDir(account.config ?? {});
  const datedDir = join(baseDir, formatDateDir());
  await mkdir(datedDir, { recursive: true });

  const name = basename(p);
  const dest = join(datedDir, name);

  try {
    await rename(p, dest);
    return dest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
    if (code === "EXDEV") {
      try {
        await copyFile(p, dest);
        try { await unlink(p); } catch { /* ignore */ }
        return dest;
      } catch { /* fall through */ }
    }
    try { await unlink(p); } catch { /* ignore */ }
    return p;
  }
}

/**
 * 清理 inbound 目录中过期文件
 */
export async function pruneInboundMediaDir(account: ResolvedWecomKfAccount): Promise<void> {
  const baseDir = resolveInboundMediaDir(account.config ?? {});
  const keepDays = resolveInboundMediaKeepDays(account.config ?? {});
  if (keepDays < 0) return;

  const now = Date.now();
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const dirPath = join(baseDir, entry);

    let st;
    try { st = await stat(dirPath); } catch { continue; }
    if (!st.isDirectory()) continue;

    const dirTime = st.mtimeMs || st.ctimeMs || 0;
    if (dirTime >= cutoff) continue;

    let files: string[] = [];
    try { files = await readdir(dirPath); } catch { continue; }

    for (const f of files) {
      const fp = join(dirPath, f);
      try {
        const fst = await stat(fp);
        if (fst.isFile() && (fst.mtimeMs || fst.ctimeMs || 0) < cutoff) {
          await unlink(fp);
        }
      } catch { /* ignore */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 语音消息发送
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发送语音消息给微信客户
 */
export async function sendKfVoiceMessage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  mediaId: string,
): Promise<SendMessageResult> {
  const openKfId = resolveOpenKfId(account, target.openKfId);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return { ok: false, errcode: -1, errmsg: "Account not configured for sending" };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    touser: target.externalUserId,
    open_kfid: openKfId,
    msgtype: "voice",
    voice: { media_id: mediaId },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

/**
 * 发送视频消息给微信客户
 */
export async function sendKfVideoMessage(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  mediaId: string,
): Promise<SendMessageResult> {
  const openKfId = resolveOpenKfId(account, target.openKfId);

  if (!account.corpId || !account.corpSecret || !openKfId) {
    return { ok: false, errcode: -1, errmsg: "Account not configured for sending" };
  }

  const accessToken = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    touser: target.externalUserId,
    open_kfid: openKfId,
    msgtype: "video",
    video: { media_id: mediaId },
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as { errcode?: number; errmsg?: string; msgid?: string };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    msgid: data.msgid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 语音转码 + 下载发送
// ─────────────────────────────────────────────────────────────────────────────

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveVoiceSourceName(voiceUrl: string): string {
  if (isHttpUrl(voiceUrl)) {
    try {
      const pathname = new URL(voiceUrl).pathname;
      return basename(pathname) || "voice";
    } catch {
      return "voice";
    }
  }
  return basename(voiceUrl) || "voice";
}

type DownloadVoiceResult = {
  buffer: Buffer;
  contentType?: string;
  sourceName: string;
};

type PreparedVoiceUpload = {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  transcoded: boolean;
  cleanup: () => Promise<void>;
};

export async function downloadVoice(voiceUrl: string): Promise<DownloadVoiceResult> {
  const sourceName = resolveVoiceSourceName(voiceUrl);

  if (isHttpUrl(voiceUrl)) {
    const resp = await fetch(voiceUrl);
    if (!resp.ok) {
      throw new Error(`Download voice failed: HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || undefined,
      sourceName,
    };
  } else {
    const buffer = await readFile(voiceUrl);
    return { buffer, contentType: undefined, sourceName };
  }
}

async function cleanupVoiceTempDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

async function prepareVoiceUpload(params: {
  voiceUrl: string;
  contentType?: string;
  transcode?: boolean;
}): Promise<PreparedVoiceUpload> {
  const requestedContentType = params.contentType;
  const shouldTranscode = params.transcode !== false && shouldTranscodeWecomVoice(params.voiceUrl, requestedContentType);

  if (!shouldTranscode) {
    const voice = await downloadVoice(params.voiceUrl);
    const effectiveContentType = voice.contentType ?? requestedContentType;
    const sourceName = voice.sourceName || params.voiceUrl;
    const extension = resolveWecomVoiceSourceExtension(sourceName, effectiveContentType);
    return {
      buffer: voice.buffer,
      filename: `voice${extension}`,
      contentType: effectiveContentType,
      transcoded: false,
      cleanup: async () => {},
    };
  }

  const canTranscode = await hasFfmpeg();
  if (!canTranscode) {
    throw new Error("ffmpeg is unavailable for voice transcode");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "wecom-kf-voice-"));
  const outputPath = join(tempDir, "voice.amr");

  try {
    if (isHttpUrl(params.voiceUrl)) {
      const voice = await downloadVoice(params.voiceUrl);
      const effectiveContentType = voice.contentType ?? requestedContentType;
      const extension = resolveWecomVoiceSourceExtension(voice.sourceName || params.voiceUrl, effectiveContentType);
      const inputPath = join(tempDir, `input${extension}`);
      await writeFile(inputPath, voice.buffer);
      await transcodeToAmr({ inputPath, outputPath });
    } else {
      await transcodeToAmr({ inputPath: params.voiceUrl, outputPath });
    }

    const buffer = await readFile(outputPath);
    return {
      buffer,
      filename: "voice.amr",
      contentType: "audio/amr",
      transcoded: true,
      cleanup: async () => cleanupVoiceTempDir(tempDir),
    };
  } catch (err) {
    await cleanupVoiceTempDir(tempDir);
    throw err;
  }
}

/**
 * 下载并发送语音
 */
export async function downloadAndSendKfVoice(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  voiceUrl: string,
  options?: { contentType?: string; transcode?: boolean },
): Promise<SendMessageResult> {
  const requestedContentType = options?.contentType;
  const transcodeRequested = options?.transcode !== false;
  const transcodeExpected = transcodeRequested && shouldTranscodeWecomVoice(voiceUrl, requestedContentType);

  try {
    const prepared = await prepareVoiceUpload({
      voiceUrl,
      contentType: requestedContentType,
      transcode: transcodeRequested,
    });

    try {
      const mediaId = await uploadMedia(account, prepared.buffer, prepared.filename, "voice");
      return await sendKfVoiceMessage(account, target, mediaId);
    } finally {
      await prepared.cleanup();
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const hint = transcodeExpected
      ? "WeCom voice requires .amr/.speex. The plugin tried to transcode this audio to .amr before sending, but the transcode/upload step failed."
      : "";

    return {
      ok: false,
      errcode: -1,
      errmsg: hint ? `${rawMsg} | hint: ${hint}` : rawMsg,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件/视频下载发送
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadFile(fileUrl: string): Promise<{ buffer: Buffer; contentType?: string }> {
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      throw new Error(`Download file failed: HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || undefined,
    };
  } else {
    const buffer = await readFile(fileUrl);
    return { buffer, contentType: undefined };
  }
}

function resolveFilename(fileUrl: string, defaultName: string, defaultExt: string): string {
  let filename = defaultName;

  try {
    if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
      const base = basename(fileUrl);
      if (base && base !== '.' && base !== '/') filename = base;
    } else {
      const u = new URL(fileUrl);
      const base = u.pathname.split('/').filter(Boolean).pop();
      if (base) filename = base;
    }
  } catch { /* ignore */ }

  if (!/\.[A-Za-z0-9]{1,10}$/.test(filename)) {
    const extMatch = fileUrl.split('?')[0].match(/\.([^.]+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : defaultExt;
    filename = `${defaultName.replace(/\.[^.]+$/, '')}${ext}`;
  }

  return filename;
}

/**
 * 下载并发送文件
 */
export async function downloadAndSendKfFile(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  fileUrl: string,
): Promise<SendMessageResult> {
  try {
    const { buffer: fileBuffer, contentType } = await downloadFile(fileUrl);
    const filename = resolveFilename(fileUrl, "file.bin", ".bin");
    const mediaId = await uploadMedia(account, fileBuffer, filename, "file");
    return await sendKfFileMessage(account, target, mediaId);
  } catch (err) {
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 下载并发送视频
 */
export async function downloadAndSendKfVideo(
  account: ResolvedWecomKfAccount,
  target: WecomKfSendTarget,
  videoUrl: string,
): Promise<SendMessageResult> {
  try {
    const { buffer: videoBuffer, contentType } = await downloadFile(videoUrl);
    const filename = resolveFilename(videoUrl, "video.mp4", ".mp4");
    const mediaId = await uploadMedia(account, videoBuffer, filename, "video");
    return await sendKfVideoMessage(account, target, mediaId);
  } catch (err) {
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}
