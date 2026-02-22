/**
 * 企业微信自建应用 API
 * 
 * 提供 Access Token 缓存和主动发送消息能力
 */
import type { ResolvedWecomAppAccount, WecomAppSendTarget, AccessTokenCacheEntry } from "./types.js";
import {
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
  resolveApiBaseUrl,
} from "./config.js";
import { mkdir, writeFile, unlink, rename, readdir, stat } from "node:fs/promises";
import { basename, join, extname } from "node:path";
import { tmpdir } from "node:os";

/** 下载超时时间（毫秒） */
const DOWNLOAD_TIMEOUT = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体：产品级存储策略
// - 第一步：下载到 tmpdir()/wecom-app-media（快速、安全）
// - 第二步：处理结束后“归档”到 inbound/YYYY-MM-DD，并延迟清理（keepDays）
// - 关键：不再在 reply 后立刻删除，避免 OCR/MCP/回发等二次处理失败
// ─────────────────────────────────────────────────────────────────────────────

function formatDateDir(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isProbablyInWecomTmpDir(p: string): boolean {
  try {
    const base = join(tmpdir(), "wecom-app-media");
    // Windows 路径大小写与分隔符差异：做一次归一化比较
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    return norm(p).includes(norm(base));
  } catch {
    return false;
  }
}

/**
 * 将临时媒体文件归档到 inbound/YYYY-MM-DD（尽力而为）
 * - 仅对 tmpdir()/wecom-app-media 下的文件执行移动
 * - 移动成功后，返回新路径；失败则返回原路径
 */
export async function finalizeInboundMedia(account: ResolvedWecomAppAccount, filePath: string): Promise<string> {
  const p = String(filePath ?? "").trim();
  if (!p) return p;

  // 非临时目录文件，不动（比如用户指定了自定义 dir 或已经是 inbound）
  if (!isProbablyInWecomTmpDir(p)) return p;

  const baseDir = resolveInboundMediaDir(account.config ?? {});
  const datedDir = join(baseDir, formatDateDir());
  await mkdir(datedDir, { recursive: true });

  const name = basename(p);
  const dest = join(datedDir, name);

  try {
    await rename(p, dest);
    return dest;
  } catch {
    // 移动失败就退化为“尽力删除”（避免 tmp 爆炸），但不抛出
    try {
      await unlink(p);
    } catch {
      // ignore
    }
    return p;
  }
}

/**
 * 清理 inbound 目录中过期文件（keepDays）
 * - keepDays=0 表示不保留：仅清理“今天以前”的（仍给当日留缓冲）
 * - 默认 keepDays 来自 config（默认 7 天）
 */
export async function pruneInboundMediaDir(account: ResolvedWecomAppAccount): Promise<void> {
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
    // 只处理 YYYY-MM-DD 目录
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const dirPath = join(baseDir, entry);

    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const dirTime = st.mtimeMs || st.ctimeMs || 0;
    if (dirTime >= cutoff) continue;

    // 删除目录内文件（不递归子目录：保持安全可控）
    let files: string[] = [];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const f of files) {
      const fp = join(dirPath, f);
      try {
        const fst = await stat(fp);
        if (fst.isFile() && (fst.mtimeMs || fst.ctimeMs || 0) < cutoff) {
          await unlink(fp);
        }
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 文件大小超过限制时抛出的错误
 */
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

/**
 * 下载超时时抛出的错误
 */
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

/** Access Token 缓存 (key: corpId:agentId) */
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

/** Access Token 有效期: 2小时减去5分钟缓冲 */
const ACCESS_TOKEN_TTL_MS = 7200 * 1000 - 5 * 60 * 1000;

function buildWecomApiUrl(account: ResolvedWecomAppAccount, pathWithQuery: string): string {
  const normalizedPath = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  return `${resolveApiBaseUrl(account.config)}${normalizedPath}`;
}

/**
 * 移除 Markdown 格式，转换为纯文本
 * 方案 C: 代码块缩进，标题用【】标记，表格简化
 * 企业微信文本消息不支持 Markdown
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // 1. 代码块：提取内容并缩进（保留语言标识）
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

  // 3. 粗体/斜体：保留文字（排除 URL 中的下划线）
  result = result
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    // 只替换独立的斜体标记（前后有空格或标点），避免匹配 URL 中的下划线
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
      
      // 计算每列最大宽度
      const colWidths = headerCells.map((h: string, i: number) => {
        const maxRowWidth = Math.max(...rows.map((r: string[]) => (r[i] || "").length));
        return Math.max(h.length, maxRowWidth);
      });
      
      // 格式化表头
      const formattedHeader = headerCells
        .map((h: string, i: number) => h.padEnd(colWidths[i]))
        .join("  ");
      
      // 格式化数据行
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
 * 获取 Access Token（带缓存）
 */
export async function getAccessToken(account: ResolvedWecomAppAccount): Promise<string> {
  if (!account.corpId || !account.corpSecret) {
    throw new Error("corpId or corpSecret not configured");
  }

  const key = `${account.corpId}:${account.agentId ?? "default"}`;
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
export function clearAccessTokenCache(account: ResolvedWecomAppAccount): void {
  const key = `${account.corpId}:${account.agentId ?? "default"}`;
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
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
  msgid?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体下载 (media_id -> 本地文件)
// ─────────────────────────────────────────────────────────────────────────────

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
};

function pickExtFromMime(mimeType?: string): string {
  const t = (mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return (t && MIME_EXT_MAP[t]) || "";
}

function parseContentDispositionFilename(headerValue?: string | null): string | undefined {
  const v = String(headerValue ?? "");
  if (!v) return undefined;

  // filename*=UTF-8''xxx
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

function todayDirName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 清理临时文件（尽力而为，从不抛出错误）
 */
export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore cleanup errors
  }
}

/**
 * 获取企业微信媒体文件的临时目录
 */
function getWecomTempDir(): string {
  return join(tmpdir(), "wecom-app-media");
}

/**
 * 下载企业微信 media_id 到本地文件
 * - 优先用于入站 image/file 的落盘
 * - 支持 120 秒超时
 * - 支持 Content-Length 预检和流式下载实时监控
 * - 默认保存到系统临时目录，需手动调用 cleanupFile() 清理
 */
export async function downloadWecomMediaToFile(
  account: ResolvedWecomAppAccount,
  mediaId: string,
  opts: { dir?: string; maxBytes: number; prefix?: string }
): Promise<SavedInboundMedia> {
  const raw = String(mediaId ?? "").trim();
  if (!raw) return { ok: false, error: "mediaId/url is empty" };

  // 支持企业微信 media_id 和直接的 http(s) URL
  const isHttp = raw.startsWith("http://") || raw.startsWith("https://");

  // 设置超时中止控制器
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
      // media_id 下载需要 corpId/corpSecret（用于获取 access_token），但不需要 agentId
      if (!account.corpId || !account.corpSecret) {
        return { ok: false, error: "Account not configured for media download (missing corpId/corpSecret)" };
      }
      const safeMediaId = raw;
      const token = await getAccessToken(account);
      const url = buildWecomApiUrl(
        account,
        `/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(safeMediaId)}`
      );

      resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        return { ok: false, error: `media/get failed: HTTP ${resp.status}` };
      }

      contentType = resp.headers.get("content-type") || undefined;
      const cd = resp.headers.get("content-disposition");
      filenameFromHeader = parseContentDispositionFilename(cd);

      // 企业微信失败时可能返回 JSON（errcode/errmsg）
      if ((contentType ?? "").includes("application/json")) {
        try {
          const j = (await resp.json()) as { errcode?: number; errmsg?: string };
          return { ok: false, error: `media/get returned json: errcode=${j?.errcode} errmsg=${j?.errmsg}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    // 预检查 Content-Length（如果可用）
    const contentLength = resp.headers.get("content-length");
    if (contentLength && opts.maxBytes > 0) {
      const declaredSize = parseInt(contentLength, 10);
      if (!Number.isNaN(declaredSize) && declaredSize > opts.maxBytes) {
        throw new FileSizeLimitError(declaredSize, opts.maxBytes, "media");
      }
    }

    // 流式下载并监控大小
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

    // 默认使用临时目录
    const baseDir = (opts.dir ?? "").trim() || getWecomTempDir();
    await mkdir(baseDir, { recursive: true });

    const prefix = (opts.prefix ?? "media").trim() || "media";
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    const extFromMime = pickExtFromMime(contentType);
    const extFromName = filenameFromHeader ? extname(filenameFromHeader) : (isHttp ? extname(raw.split("?")[0] || "") : "");
    const ext = extFromName || extFromMime || ".bin";

    // 简单的临时文件名，不包含子目录，便于清理
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
 * 发送企业微信应用消息
 * 
 * @param account - 已解析的账户配置
 * @param target - 发送目标 (userId)
 * @param message - 消息内容 (会自动移除 Markdown 格式)
 */
export async function sendWecomAppMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  message: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);
  const text = stripMarkdown(message);

  const payload: Record<string, unknown> = {
    msgtype: "text",
    agentid: account.agentId,
    text: { content: text },
    touser: target.userId,
  };

  // 注意：企业微信 API 要求 access_token 作为查询参数传递。
  // 这可能会在服务器日志、浏览器历史和引用头中暴露令牌。
  // 确保任何记录此 URL 的日志都隐藏 access_token 参数。
  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 发送 Markdown 格式消息 (仅企业微信客户端支持)
 */
export async function sendWecomAppMarkdownMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  markdownContent: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "markdown",
    agentid: account.agentId,
    markdown: { content: markdownContent },
    touser: target.userId,
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片消息支持
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MIME 类型映射表
 */
const MIME_TYPE_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
} as const;

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(filename: string, contentType?: string): string {
  // 优先使用响应头的 Content-Type
  if (contentType) {
    return contentType.split(';')[0].trim();
  }

  // 回退到文件扩展名推断
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return MIME_TYPE_MAP[ext || ''] || 'image/jpeg';
}

/**
 * 下载图片（支持网络 URL 和本地文件路径）
 * @param imageUrl 图片 URL 或本地文件路径
 * @returns 图片 Buffer
 */
export async function downloadImage(imageUrl: string): Promise<{ buffer: Buffer; contentType?: string }> {
  // 判断是网络 URL 还是本地路径
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    // 网络下载
    console.log(`[wecom-app] 使用 HTTP fetch 下载: ${imageUrl}`);
    const resp = await fetch(imageUrl);
    if (!resp.ok) {
      throw new Error(`Download image failed: HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || undefined,
    };
  } else {
    // 本地文件读取
    console.log(`[wecom-app] 使用 fs 读取本地文件: ${imageUrl}`);
    const fs = await import('fs');
    const buffer = await fs.promises.readFile(imageUrl);
    return {
      buffer,
      contentType: undefined, // 本地文件不提供 Content-Type，依赖扩展名推断
    };
  }
}

/**
 * 上传图片素材获取 media_id
 * @param account 账户配置
 * @param imageBuffer 图片数据
 * @param filename 文件名
 * @param contentType MIME 类型（可选）
 * @returns media_id
 */
export async function uploadImageMedia(
  account: ResolvedWecomAppAccount,
  imageBuffer: Buffer,
  filename = "image.jpg",
  contentType?: string
): Promise<string> {
  if (!account.canSendActive) {
    throw new Error("Account not configured for active sending");
  }

  const token = await getAccessToken(account);
  const mimeType = getMimeType(filename, contentType);
  const boundary = `----FormBoundary${Date.now()}`;

  // 构造 multipart/form-data
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=image`),
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
    throw new Error(`Upload image failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error("Upload image returned empty media_id");
  }

  return data.media_id;
}

/**
 * 发送图片消息
 * @param account 账户配置
 * @param target 发送目标
 * @param mediaId 图片 media_id
 */
export async function sendWecomAppImageMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  mediaId: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "image",
    agentid: account.agentId,
    image: { media_id: mediaId },
    touser: target.userId,
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 下载并发送图片（完整流程）
 * @param account 账户配置
 * @param target 发送目标
 * @param imageUrl 图片 URL
 */
export async function downloadAndSendImage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  imageUrl: string
): Promise<SendMessageResult> {
  try {
    console.log(`[wecom-app] Downloading image from: ${imageUrl}`);

    // 1. 下载图片
    const { buffer: imageBuffer, contentType } = await downloadImage(imageUrl);
    console.log(`[wecom-app] Image downloaded, size: ${imageBuffer.length} bytes, contentType: ${contentType || 'unknown'}`);

    // 2. 提取文件扩展名
    const extMatch = imageUrl.match(/\.([^.]+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : '.jpg';
    const filename = `image${ext}`;

    // 3. 上传获取 media_id
    console.log(`[wecom-app] Uploading image to WeCom media API, filename: ${filename}`);
    const mediaId = await uploadImageMedia(account, imageBuffer, filename, contentType);
    console.log(`[wecom-app] Image uploaded, media_id: ${mediaId}`);

    // 4. 发送图片消息
    console.log(`[wecom-app] Sending image to target:`, target);
    const result = await sendWecomAppImageMessage(account, target, mediaId);
    console.log(`[wecom-app] Image sent, ok: ${result.ok}, msgid: ${result.msgid}, errcode: ${result.errcode}, errmsg: ${result.errmsg}`);

    return result;
  } catch (err) {
    console.error(`[wecom-app] downloadAndSendImage error:`, err);
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 语音消息支持
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 语音 MIME 类型映射表
 */
const VOICE_MIME_TYPE_MAP: Record<string, string> = {
  '.amr': 'audio/amr',
  '.speex': 'audio/speex',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
} as const;

/**
 * 根据文件扩展名获取语音 MIME 类型
 */
function getVoiceMimeType(filename: string, contentType?: string): string {
  // 优先使用响应头的 Content-Type
  if (contentType) {
    return contentType.split(';')[0].trim();
  }

  // 回退到文件扩展名推断
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return VOICE_MIME_TYPE_MAP[ext || ''] || 'audio/amr';
}

/**
 * 上传语音素材获取 media_id
 * @param account 账户配置
 * @param voiceBuffer 语音数据
 * @param filename 文件名
 * @param contentType MIME 类型（可选）
 * @returns media_id
 */
export async function uploadVoiceMedia(
  account: ResolvedWecomAppAccount,
  voiceBuffer: Buffer,
  filename = "voice.amr",
  contentType?: string
): Promise<string> {
  if (!account.canSendActive) {
    throw new Error("Account not configured for active sending");
  }

  const token = await getAccessToken(account);
  const mimeType = getVoiceMimeType(filename, contentType);
  const boundary = `----FormBoundary${Date.now()}`;

  // 构造 multipart/form-data
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, voiceBuffer, footer]);

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=voice`),
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
    throw new Error(`Upload voice failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error("Upload voice returned empty media_id");
  }

  return data.media_id;
}

/**
 * 发送语音消息
 * @param account 账户配置
 * @param target 发送目标
 * @param mediaId 语音 media_id
 */
export async function sendWecomAppVoiceMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  mediaId: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "voice",
    agentid: account.agentId,
    voice: { media_id: mediaId },
    touser: target.userId,
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 下载语音文件（支持网络 URL 和本地文件路径）
 * @param voiceUrl 语音 URL 或本地文件路径
 * @returns 语音 Buffer
 */
export async function downloadVoice(voiceUrl: string): Promise<{ buffer: Buffer; contentType?: string }> {
  // 判断是网络 URL 还是本地路径
  if (voiceUrl.startsWith('http://') || voiceUrl.startsWith('https://')) {
    // 网络下载
    console.log(`[wecom-app] 使用 HTTP fetch 下载语音: ${voiceUrl}`);
    const resp = await fetch(voiceUrl);
    if (!resp.ok) {
      throw new Error(`Download voice failed: HTTP ${resp.status}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get('content-type') || undefined,
    };
  } else {
    // 本地文件读取
    console.log(`[wecom-app] 使用 fs 读取本地语音文件: ${voiceUrl}`);
    const fs = await import('fs');
    const buffer = await fs.promises.readFile(voiceUrl);
    return {
      buffer,
      contentType: undefined, // 本地文件不提供 Content-Type，依赖扩展名推断
    };
  }
}

/**
 * 下载并发送语音（完整流程）
 * @param account 账户配置
 * @param target 发送目标
 * @param voiceUrl 语音 URL 或本地文件路径
 */
export async function downloadAndSendVoice(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  voiceUrl: string
): Promise<SendMessageResult> {
  try {
    console.log(`[wecom-app] Downloading voice from: ${voiceUrl}`);

    // 企业微信语音消息通常要求 AMR/Speex 等格式。
    // WAV 往往会导致上传/发送失败（ok=false）。这里提前做提示，方便用户定位。
    const voiceExt = (voiceUrl.split("?")[0].match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    if (voiceExt === "wav") {
      console.warn(`[wecom-app] Voice format is .wav; WeCom usually expects .amr/.speex. Consider converting to .amr before sending.`);
    }

    // 1. 下载语音
    const { buffer: voiceBuffer, contentType } = await downloadVoice(voiceUrl);
    console.log(`[wecom-app] Voice downloaded, size: ${voiceBuffer.length} bytes, contentType: ${contentType || 'unknown'}`);

    // 2. 提取文件扩展名
    const extMatch = voiceUrl.match(/\.([^.]+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : '.amr';
    const filename = `voice${ext}`;

    // 3. 上传获取 media_id
    console.log(`[wecom-app] Uploading voice to WeCom media API, filename: ${filename}`);
    const mediaId = await uploadVoiceMedia(account, voiceBuffer, filename, contentType);
    console.log(`[wecom-app] Voice uploaded, media_id: ${mediaId}`);

    // 4. 发送语音消息
    console.log(`[wecom-app] Sending voice to target:`, target);
    const result = await sendWecomAppVoiceMessage(account, target, mediaId);
    console.log(`[wecom-app] Voice sent, ok: ${result.ok}, msgid: ${result.msgid}, errcode: ${result.errcode}, errmsg: ${result.errmsg}`);

    return result;
  } catch (err) {
    console.error(`[wecom-app] downloadAndSendVoice error:`, err);

    const rawMsg = err instanceof Error ? err.message : String(err);
    const voiceExt = (voiceUrl.split("?")[0].match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

    // 给用户更可操作的提示：wav 常见不兼容
    const hint = voiceExt === "wav"
      ? "WeCom voice usually requires .amr/.speex. Your file is .wav; please convert to .amr and retry. (e.g., ffmpeg -i in.wav -ar 8000 -ac 1 -c:a amr_nb out.amr)"
      : "";

    return {
      ok: false,
      errcode: -1,
      errmsg: hint ? `${rawMsg} | hint: ${hint}` : rawMsg,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件消息支持
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通用上传媒体素材
 * @param account 账户配置
 * @param buffer 媒体数据
 * @param filename 文件名
 * @param contentType MIME 类型（可选）
 * @param type 媒体类型: image | voice | video | file
 * @returns media_id
 */
export async function uploadMedia(
  account: ResolvedWecomAppAccount,
  buffer: Buffer,
  filename = "file.bin",
  contentType?: string,
  type: "image" | "voice" | "video" | "file" = "file"
): Promise<string> {
  if (!account.canSendActive) {
    throw new Error("Account not configured for active sending");
  }

  const token = await getAccessToken(account);
  const boundary = `----FormBoundary${Date.now()}`;

  // 构造 multipart/form-data
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType || "application/octet-stream"}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`),
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
    throw new Error(`Upload ${type} failed: ${data.errmsg ?? "unknown error"} (errcode=${data.errcode})`);
  }

  if (!data.media_id) {
    throw new Error(`Upload ${type} returned empty media_id`);
  }

  return data.media_id;
}

/**
 * 发送文件消息
 * @param account 账户配置
 * @param target 发送目标
 * @param mediaId 文件 media_id
 */
export async function sendWecomAppFileMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  mediaId: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "file",
    agentid: account.agentId,
    file: { media_id: mediaId },
    safe: 0,
    touser: target.userId,
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 发送视频消息
 * @param account 账户配置
 * @param target 发送目标
 * @param mediaId 视频 media_id
 */
export async function sendWecomAppVideoMessage(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  mediaId: string
): Promise<SendMessageResult> {
  if (!account.canSendActive) {
    return {
      ok: false,
      errcode: -1,
      errmsg: "Account not configured for active sending (missing corpId, corpSecret, or agentId)",
    };
  }

  const token = await getAccessToken(account);

  const payload: Record<string, unknown> = {
    msgtype: "video",
    agentid: account.agentId,
    video: { media_id: mediaId },
    touser: target.userId,
  };

  const resp = await fetch(
    buildWecomApiUrl(account, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`),
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    }
  );

  const data = (await resp.json()) as SendMessageResult & { errcode?: number };

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg,
    invaliduser: data.invaliduser,
    invalidparty: data.invalidparty,
    invalidtag: data.invalidtag,
    msgid: data.msgid,
  };
}

/**
 * 下载文件（支持网络 URL 和本地文件路径）
 * @param fileUrl 文件 URL 或本地文件路径
 * @returns 文件 Buffer
 */
export async function downloadFile(fileUrl: string): Promise<{ buffer: Buffer; contentType?: string }> {
  // 判断是网络 URL 还是本地路径
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    // 网络下载
    console.log(`[wecom-app] 使用 HTTP fetch 下载文件: ${fileUrl}`);
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
    // 本地文件读取
    console.log(`[wecom-app] 使用 fs 读取本地文件: ${fileUrl}`);
    const fs = await import('fs');
    const buffer = await fs.promises.readFile(fileUrl);
    return {
      buffer,
      contentType: undefined, // 本地文件不提供 Content-Type，依赖扩展名推断
    };
  }
}

/**
 * 下载并发送文件（完整流程）
 * @param account 账户配置
 * @param target 发送目标
 * @param fileUrl 文件 URL 或本地文件路径
 */
export async function downloadAndSendFile(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  fileUrl: string
): Promise<SendMessageResult> {
  try {
    console.log(`[wecom-app] Downloading file from: ${fileUrl}`);

    // 1. 下载文件
    const { buffer: fileBuffer, contentType } = await downloadFile(fileUrl);
    console.log(`[wecom-app] File downloaded, size: ${fileBuffer.length} bytes, contentType: ${contentType || 'unknown'}`);

    // 2. 尽量保留原始文件名（本地路径 / URL path），否则回退为 file.<ext>
    //    注意：企业微信这里更关注 media_id，但保留文件名能提升用户体验。
    let filename = "file.bin";

    try {
      // 本地路径：取 basename
      if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
        const path = await import('path');
        const base = path.basename(fileUrl);
        if (base && base !== '.' && base !== '/') {
          filename = base;
        }
      } else {
        // URL：取 pathname 的 basename
        const u = new URL(fileUrl);
        const base = u.pathname.split('/').filter(Boolean).pop();
        if (base) filename = base;
      }
    } catch {
      // ignore and fallback
    }

    // 如果没拿到扩展名，按 url/path 推断一个
    if (!/\.[A-Za-z0-9]{1,10}$/.test(filename)) {
      const extMatch = fileUrl.split('?')[0].match(/\.([^.]+)$/);
      const ext = extMatch ? `.${extMatch[1]}` : '.bin';
      filename = `file${ext}`;
    }

    // 3. 上传获取 media_id
    console.log(`[wecom-app] Uploading file to WeCom media API, filename: ${filename}`);
    const mediaId = await uploadMedia(account, fileBuffer, filename, contentType, "file");
    console.log(`[wecom-app] File uploaded, media_id: ${mediaId}`);

    // 4. 发送文件消息
    console.log(`[wecom-app] Sending file to target:`, target);
    const result = await sendWecomAppFileMessage(account, target, mediaId);
    console.log(`[wecom-app] File sent, ok: ${result.ok}, msgid: ${result.msgid}, errcode: ${result.errcode}, errmsg: ${result.errmsg}`);

    return result;
  } catch (err) {
    console.error(`[wecom-app] downloadAndSendFile error:`, err);
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 下载并发送视频（完整流程）
 * @param account 账户配置
 * @param target 发送目标
 * @param videoUrl 视频 URL 或本地文件路径
 */
export async function downloadAndSendVideo(
  account: ResolvedWecomAppAccount,
  target: WecomAppSendTarget,
  videoUrl: string
): Promise<SendMessageResult> {
  try {
    console.log(`[wecom-app] Downloading video from: ${videoUrl}`);

    // 1. 下载视频
    const { buffer: videoBuffer, contentType } = await downloadFile(videoUrl);
    console.log(`[wecom-app] Video downloaded, size: ${videoBuffer.length} bytes, contentType: ${contentType || 'unknown'}`);

    // 2. 提取文件扩展名
    let filename = "video.mp4";

    try {
      // 本地路径：取 basename
      if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
        const path = await import('path');
        const base = path.basename(videoUrl);
        if (base && base !== '.' && base !== '/') {
          filename = base;
        }
      } else {
        // URL：取 pathname 的 basename
        const u = new URL(videoUrl);
        const base = u.pathname.split('/').filter(Boolean).pop();
        if (base) filename = base;
      }
    } catch {
      // ignore and fallback
    }

    // 如果没拿到扩展名，按 url/path 推断一个
    if (!/\.[A-Za-z0-9]{1,10}$/.test(filename)) {
      const extMatch = videoUrl.split('?')[0].match(/\.([^.]+)$/);
      const ext = extMatch ? `.${extMatch[1]}` : '.mp4';
      filename = `video${ext}`;
    }

    // 3. 上传获取 media_id
    console.log(`[wecom-app] Uploading video to WeCom media API, filename: ${filename}`);
    const mediaId = await uploadMedia(account, videoBuffer, filename, contentType, "video");
    console.log(`[wecom-app] Video uploaded, media_id: ${mediaId}`);

    // 4. 发送视频消息
    console.log(`[wecom-app] Sending video to target:`, target);
    const result = await sendWecomAppVideoMessage(account, target, mediaId);
    console.log(`[wecom-app] Video sent, ok: ${result.ok}, msgid: ${result.msgid}, errcode: ${result.errcode}, errmsg: ${result.errmsg}`);

    return result;
  } catch (err) {
    console.error(`[wecom-app] downloadAndSendVideo error:`, err);
    return {
      ok: false,
      errcode: -1,
      errmsg: err instanceof Error ? err.message : String(err),
    };
  }
}
