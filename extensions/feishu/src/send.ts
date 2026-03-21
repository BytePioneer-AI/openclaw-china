/**
 * 飞书发送消息
 */

import type { FeishuConfig } from "./config.js";
import type { FeishuSendResult } from "./types.js";
import { createFeishuClientFromConfig } from "./client.js";
import * as fsPromises from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "node:stream";
import {
  normalizeLocalPath as sharedNormalizeLocalPath,
  isHttpUrl as sharedIsHttpUrl,
  stripTitleFromUrl as sharedStripTitleFromUrl,
  getExtension,
  IMAGE_EXTENSIONS,
  extractImagesFromText,
} from "@xuanyue202/shared";

export interface SendMessageParams {
  cfg: FeishuConfig;
  to: string;
  text: string;
  receiveIdType?: "chat_id" | "open_id";
}

export interface SendMediaParams {
  cfg: FeishuConfig;
  to: string;
  mediaUrl: string;
  receiveIdType?: "chat_id" | "open_id";
}

export interface SendFileParams {
  cfg: FeishuConfig;
  to: string;
  mediaUrl: string;
  receiveIdType?: "chat_id" | "open_id";
}

export async function sendMessageFeishu(params: SendMessageParams): Promise<FeishuSendResult> {
  const { cfg, to, text, receiveIdType = "chat_id" } = params;

  const client = createFeishuClientFromConfig(cfg);

  try {
    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: to,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    const messageId = (result as { data?: { message_id?: string } })?.data?.message_id ?? "";

    return {
      messageId,
      chatId: to,
    };
  } catch (err) {
    throw new Error(`Feishu send message failed: ${String(err)}`);
  }
}

export interface SendCardParams {
  cfg: FeishuConfig;
  to: string;
  card: Record<string, unknown>;
  receiveIdType?: "chat_id" | "open_id";
}

export async function sendCardFeishu(params: SendCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, receiveIdType = "chat_id" } = params;
  const client = createFeishuClientFromConfig(cfg);

  try {
    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: to,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    const messageId = (result as { data?: { message_id?: string } })?.data?.message_id ?? "";

    return {
      messageId,
      chatId: to,
    };
  } catch (err) {
    throw new Error(`Feishu send card failed: ${String(err)}`);
  }
}

export async function sendImageFeishu(params: SendMediaParams): Promise<FeishuSendResult> {
  const { cfg, to, mediaUrl, receiveIdType = "chat_id" } = params;
  const client = createFeishuClientFromConfig(cfg);

  try {
    const src = stripTitleFromUrl(mediaUrl);
    const { buffer, fileName } = isHttpUrl(src)
      ? await fetchImageBuffer(src)
      : await readLocalImageBuffer(resolveLocalPath(src));
    const imageKey = await uploadFeishuImage({ cfg, buffer, fileName });

    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: to,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    const messageId = (result as { data?: { message_id?: string } })?.data?.message_id ?? "";

    return {
      messageId,
      chatId: to,
    };
  } catch (err) {
    throw new Error(`Feishu send image failed: ${String(err)}`);
  }
}

export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: "markdown",
        content: text,
      },
    ],
  };
}

export async function sendMarkdownCardFeishu(params: SendMessageParams): Promise<FeishuSendResult> {
  const { cfg, to, text, receiveIdType = "chat_id" } = params;
  const card = await buildMarkdownCardWithImages({ cfg, text });
  return sendCardFeishu({ cfg, to, card, receiveIdType });
}

// Standalone markdown image, and image wrapped in a link: [![alt](img)](link)
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARKDOWN_LINKED_IMAGE_RE = /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g;
const HTML_IMAGE_RE =
  /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
const IMAGE_UPLOAD_TIMEOUT_MS = 30000;
const FILE_UPLOAD_TIMEOUT_MS = 30000;

function isFeishuImageKey(value: string): boolean {
  return /^img_v\d+_/i.test(value.trim());
}

function isFeishuFileKey(value: string): boolean {
  return /^file_/i.test(value.trim());
}

// 裸本地路径正则：匹配 Unix 和 Windows 风格的图片路径
// 支持可选的反引号包装，如 `C:\path\to\image.png`
function createBareImagePathRegex(): RegExp {
  const extPattern = [...IMAGE_EXTENSIONS].map((e) => e.replace(".", "")).join("|");
  // Unix: /tmp, /var, /private, /Users, /home, /root, ~/
  // Windows: C:\, D:\, etc.
  return new RegExp(
    "`?(?:" +
      "(?:/(?:tmp|var|private|Users|home|root)[^\\s<>\"'`\\[\\]()]*)" + // Unix absolute
      "|(?:~/[^\\s<>\"'`\\[\\]()]*)" + // Unix home
      "|(?:[A-Za-z]:\\\\[^\\s<>\"'`\\[\\]()]*)" + // Windows absolute
    ")\\.(?:" + extPattern + ")`?",
    "gi"
  );
}

// 使用 shared 模块的函数
const isHttpUrl = sharedIsHttpUrl;
const stripTitleFromUrl = sharedStripTitleFromUrl;

function resolveLocalPath(raw: string): string {
  return sharedNormalizeLocalPath(raw);
}

async function fetchImageBuffer(url: string): Promise<{ buffer: Buffer; fileName: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to download image: HTTP ${response.status} - ${errorText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const urlPath = new URL(url).pathname;
    const fileName = path.basename(urlPath) || "image";
    return { buffer, fileName };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchFileBuffer(url: string): Promise<{ buffer: Buffer; fileName: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FILE_UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to download file: HTTP ${response.status} - ${errorText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const urlPath = new URL(url).pathname;
    const fileName = path.basename(urlPath) || "file";
    return { buffer, fileName };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readLocalImageBuffer(localPath: string): Promise<{ buffer: Buffer; fileName: string }> {
  const buffer = await fsPromises.readFile(localPath);
  const fileName = path.basename(localPath) || "image";
  return { buffer, fileName };
}

function readLocalFileStream(localPath: string): { stream: fs.ReadStream; fileName: string } {
  const fileName = path.basename(localPath) || "file";
  return { stream: fs.createReadStream(localPath), fileName };
}

async function uploadFeishuImage(params: {
  cfg: FeishuConfig;
  buffer: Buffer;
  fileName: string;
}): Promise<string> {
  const { cfg, buffer, fileName } = params;
  const client = createFeishuClientFromConfig(cfg) as unknown as {
    domain?: string;
    tokenManager?: { getTenantAccessToken: () => Promise<string> };
  };

  const tokenManager = client.tokenManager;
  if (!tokenManager?.getTenantAccessToken) {
    throw new Error("Feishu token manager not available for image upload");
  }

  const token = await tokenManager.getTenantAccessToken();
  const domain = client.domain ?? "https://open.feishu.cn";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_UPLOAD_TIMEOUT_MS);

  try {
    const formData = new FormData();
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    formData.append("image", blob, fileName);
    formData.append("image_type", "message");

    const response = await fetch(`${domain}/open-apis/im/v1/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Feishu image upload failed: HTTP ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: { image_key?: string };
    };

    if (data.code && data.code !== 0) {
      throw new Error(`Feishu image upload failed: ${data.msg ?? "unknown error"} (code: ${data.code})`);
    }

    const imageKey = data.data?.image_key;
    if (!imageKey) {
      throw new Error("Feishu image upload failed: no image_key returned");
    }

    return imageKey;
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveFeishuFileType(fileName: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = getExtension(fileName).toLowerCase();
  if (!ext) return "stream";
  if (ext === "opus") return "opus";
  if (["mp4", "mov", "m4v", "avi", "mkv", "webm"].includes(ext)) return "mp4";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "xls";
  if (["ppt", "pptx"].includes(ext)) return "ppt";
  return "stream";
}

async function uploadFeishuFile(params: {
  cfg: FeishuConfig;
  file: Buffer | fs.ReadStream | Readable;
  fileName: string;
}): Promise<string> {
  const { cfg, file, fileName } = params;
  const client = createFeishuClientFromConfig(cfg) as unknown as {
    im?: { v1?: { file?: { create: (payload: { data: { file_type: string; file_name: string; file: Buffer | fs.ReadStream | Readable } }) => Promise<{ file_key?: string } | null> } } };
  };

  const fileType = resolveFeishuFileType(fileName);
  const result = await client?.im?.v1?.file?.create?.({
    data: {
      file_type: fileType,
      file_name: fileName,
      file,
    },
  });

  const fileKey = result?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload failed: no file_key returned");
  }

  return fileKey;
}

type ImageMatch = {
  index: number;
  length: number;
  alt: string;
  src: string;
};

function nextImageMatch(text: string, fromIndex: number): ImageMatch | null {
  MARKDOWN_LINKED_IMAGE_RE.lastIndex = fromIndex;
  MARKDOWN_IMAGE_RE.lastIndex = fromIndex;
  HTML_IMAGE_RE.lastIndex = fromIndex;

  const linkedMatch = MARKDOWN_LINKED_IMAGE_RE.exec(text);
  const mdMatch = MARKDOWN_IMAGE_RE.exec(text);
  const htmlMatch = HTML_IMAGE_RE.exec(text);

  if (!linkedMatch && !mdMatch && !htmlMatch) return null;

  const candidates = [
    linkedMatch
      ? { kind: "linked", index: linkedMatch.index, match: linkedMatch }
      : null,
    mdMatch ? { kind: "md", index: mdMatch.index, match: mdMatch } : null,
    htmlMatch ? { kind: "html", index: htmlMatch.index, match: htmlMatch } : null,
  ].filter(Boolean) as Array<{ kind: "linked" | "md" | "html"; index: number; match: RegExpExecArray }>;

  candidates.sort((a, b) => a.index - b.index);
  const winner = candidates[0];

  if (winner.kind === "linked") {
    return {
      index: winner.match.index,
      length: winner.match[0].length,
      alt: winner.match[1] ?? "",
      src: winner.match[2] ?? "",
    };
  }

  if (winner.kind === "md") {
    return {
      index: winner.match.index,
      length: winner.match[0].length,
      alt: winner.match[1] ?? "",
      src: winner.match[2] ?? "",
    };
  }

  const src = winner.match?.[1] ?? winner.match?.[2] ?? winner.match?.[3] ?? "";
  const altMatch = winner.match?.[0].match(/\balt\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const alt = altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "";
  return {
    index: winner.match?.index ?? 0,
    length: winner.match?.[0].length ?? 0,
    alt,
    src,
  };
}

async function buildMarkdownCardWithImages(params: {
  cfg: FeishuConfig;
  text: string;
}): Promise<Record<string, unknown>> {
  const { cfg, text } = params;

  const elements: Array<Record<string, unknown>> = [];
  let lastIndex = 0;
  let match: ImageMatch | null;

  while ((match = nextImageMatch(text, lastIndex)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      elements.push({ tag: "markdown", content: before });
    }

    const src = stripTitleFromUrl(match.src);
    try {
      const imageKey = isFeishuImageKey(src)
        ? src
        : await (async () => {
            const { buffer, fileName } = isHttpUrl(src)
              ? await fetchImageBuffer(src)
              : await readLocalImageBuffer(resolveLocalPath(src));
            return uploadFeishuImage({ cfg, buffer, fileName });
          })();
      elements.push({
        tag: "img",
        img_key: imageKey,
        alt: {
          tag: "plain_text",
          content: match.alt || "image",
        },
      });
    } catch (err) {
      // Fallback: keep a safe link instead of breaking the card
      console.error(`[feishu] Failed to upload image: ${src}`, err);
      const fallback = match.alt ? `[${match.alt}](${src})` : src;
      elements.push({ tag: "markdown", content: fallback });
    }

    lastIndex = match.index + match.length;
  }

  const remaining = text.slice(lastIndex);
  if (remaining.trim()) {
    elements.push({ tag: "markdown", content: remaining });
  }

  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: text });
  }

  // 第二阶段：处理 markdown 元素中的裸本地路径
  const bareImageRe = createBareImagePathRegex();
  const processedElements: Array<Record<string, unknown>> = [];

  for (const el of elements) {
    if (el.tag !== "markdown" || typeof el.content !== "string") {
      processedElements.push(el);
      continue;
    }

    let content = el.content as string;
    let lastIdx = 0;
    const subElements: Array<Record<string, unknown>> = [];

    // 重置正则状态
    bareImageRe.lastIndex = 0;
    let bareMatch: RegExpExecArray | null;

    while ((bareMatch = bareImageRe.exec(content)) !== null) {
      const before = content.slice(lastIdx, bareMatch.index);
      if (before.trim()) {
        subElements.push({ tag: "markdown", content: before });
      }

      // 去除可能的反引号包装
      let barePath = bareMatch[0];
      if (barePath.startsWith("`") && barePath.endsWith("`")) {
        barePath = barePath.slice(1, -1);
      }

      try {
        let imageKey: string;
        let altText = "image";
        if (isFeishuImageKey(barePath)) {
          imageKey = barePath;
        } else {
          const { buffer, fileName } = await readLocalImageBuffer(resolveLocalPath(barePath));
          altText = fileName || "image";
          imageKey = await uploadFeishuImage({ cfg, buffer, fileName });
        }
        subElements.push({
          tag: "img",
          img_key: imageKey,
          alt: {
            tag: "plain_text",
            content: altText,
          },
        });
      } catch (err) {
        console.error(`[feishu] Failed to upload bare path image: ${barePath}`, err);
        // 保留原始路径作为 fallback
        subElements.push({ tag: "markdown", content: barePath });
      }

      lastIdx = bareMatch.index + bareMatch[0].length;
    }

    // 添加剩余文本
    const remaining = content.slice(lastIdx);
    if (remaining.trim()) {
      subElements.push({ tag: "markdown", content: remaining });
    }

    // 如果没有找到裸路径，保留原始元素
    if (subElements.length === 0) {
      processedElements.push(el);
    } else {
      processedElements.push(...subElements);
    }
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    elements: processedElements,
  };
}

/**
 * 预处理 Markdown 文本中的本地图片
 * 将本地图片路径上传到飞书，并替换为飞书图片格式
 * 参考钉钉的 processLocalImagesInMarkdown 实现
 */
export async function processLocalImagesInMarkdown(
  cfg: FeishuConfig,
  text: string
): Promise<string> {
  // 提取所有图片（包括 Markdown、HTML 和裸本地路径）
  const { images } = extractImagesFromText(text, {
    removeFromText: false, // 保留原文本，我们手动替换
    parseMarkdownImages: true,
    parseHtmlImages: true,
    parseBarePaths: true,
  });

  // 过滤出本地图片
  const localImages = images.filter((img) => img.isLocal && img.localPath);

  if (localImages.length === 0) {
    return text;
  }

  let result = text;

  // 逐个处理本地图片
  for (const img of localImages) {
    const localPath = img.localPath!;
    const resolvedPath = resolveLocalPath(localPath);

    try {
      if (isFeishuImageKey(localPath)) {
        continue;
      }
      const { buffer, fileName } = await readLocalImageBuffer(resolvedPath);
      if (!buffer) {
        console.error(`[feishu] processLocalImages: failed to read ${localPath}`);
        continue;
      }

      const imageKey = await uploadFeishuImage({ cfg, buffer, fileName });

      // 根据来源类型决定如何替换
      if (img.sourceKind === "bare") {
        // 裸路径：直接替换为 Markdown 图片格式
        // 需要处理可能被反引号包裹的情况
        const escapedPath = localPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const barePathRegex = new RegExp(`\`?${escapedPath}\`?`, "g");
        result = result.replace(barePathRegex, `![image](${imageKey})`);
      } else {
        // Markdown/HTML 格式：替换 src 部分为 imageKey
        // 对于 ![alt](path) 格式，替换 path 为 imageKey
        const escapedSource = img.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sourceRegex = new RegExp(escapedSource, "g");

        if (img.sourceKind === "markdown" || img.sourceKind === "markdown-linked") {
          // 保持 Markdown 格式，只替换路径
          const newSource = img.source.replace(localPath, imageKey);
          result = result.replace(sourceRegex, newSource);
        } else if (img.sourceKind === "html") {
          // HTML img 标签：替换 src 属性值
          const newSource = img.source.replace(localPath, imageKey);
          result = result.replace(sourceRegex, newSource);
        }
      }

      console.log(`[feishu] processLocalImages: uploaded ${localPath} -> ${imageKey}`);
    } catch (error) {
      console.error(`[feishu] processLocalImages: failed to upload ${localPath}:`, error);
      // 上传失败时保留原始路径
    }
  }

  return result;
}

export async function sendFileFeishu(params: SendFileParams): Promise<FeishuSendResult> {
  const { cfg, to, mediaUrl, receiveIdType = "chat_id" } = params;
  const client = createFeishuClientFromConfig(cfg);

  try {
    const src = stripTitleFromUrl(mediaUrl);
    const fileKey = isFeishuFileKey(src)
      ? src
      : await (async () => {
          if (isHttpUrl(src)) {
            const { buffer, fileName } = await fetchFileBuffer(src);
            const stream = Readable.from(buffer);
            return uploadFeishuFile({ cfg, file: stream, fileName });
          }
          const { stream, fileName } = readLocalFileStream(resolveLocalPath(src));
          return uploadFeishuFile({ cfg, file: stream, fileName });
        })();

    const result = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: to,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    const messageId = (result as { data?: { message_id?: string } })?.data?.message_id ?? "";

    return {
      messageId,
      chatId: to,
    };
  } catch (err) {
    throw new Error(`Feishu send file failed: ${String(err)}`);
  }
}
