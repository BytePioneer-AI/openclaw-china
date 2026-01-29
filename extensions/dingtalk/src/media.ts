/**
 * 钉钉媒体处理
 *
 * 提供:
 * - uploadMediaDingtalk: 上传媒体到钉钉存储
 * - sendMediaDingtalk: 发送媒体消息
 *
 * API 文档:
 * - 上传媒体: https://open.dingtalk.com/document/orgapp/upload-media-files
 * - 发送图片: https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches
 */

import { getAccessToken } from "./client.js";
import type { DingtalkConfig, DingtalkSendResult } from "./types.js";
import * as path from "path";
import * as fs from "fs";

/** 钉钉 API 基础 URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** 钉钉旧版 API 基础 URL (用于媒体上传) */
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/** HTTP 请求超时时间（毫秒） */
const REQUEST_TIMEOUT = 30000;

/** 媒体上传超时时间（毫秒） */
const UPLOAD_TIMEOUT = 60000;

/**
 * 媒体上传结果
 */
export interface UploadMediaResult {
  /** 媒体 ID */
  mediaId: string;
  /** 媒体类型 */
  type: "image" | "voice" | "video" | "file";
}

/**
 * 发送媒体参数
 */
export interface SendMediaParams {
  /** 钉钉配置 */
  cfg: DingtalkConfig;
  /** 目标 ID（用户 ID 或会话 ID） */
  to: string;
  /** 媒体 URL 或本地路径 */
  mediaUrl: string;
  /** 聊天类型 */
  chatType: "direct" | "group";
  /** 可选的媒体 Buffer */
  mediaBuffer?: Buffer;
  /** 可选的文件名 */
  fileName?: string;
}

/**
 * 检测媒体类型（基于文件名扩展名）
 *
 * @param fileName 文件名
 * @returns 媒体类型
 */
export function detectMediaType(
  fileName: string
): "image" | "voice" | "video" | "file" {
  const ext = path.extname(fileName).toLowerCase();

  // 图片类型
  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
    return "image";
  }

  // 音频类型
  if ([".mp3", ".wav", ".amr", ".opus", ".ogg"].includes(ext)) {
    return "voice";
  }

  // 视频类型
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
    return "video";
  }

  // 其他文件
  return "file";
}

/**
 * 从 Content-Type 检测媒体类型
 *
 * @param contentType HTTP Content-Type 头
 * @returns 媒体类型
 */
export function detectMediaTypeFromContentType(
  contentType: string | null
): "image" | "voice" | "video" | "file" {
  if (!contentType) return "file";

  const mime = contentType.split(";")[0].trim().toLowerCase();

  // 图片类型
  if (mime.startsWith("image/")) {
    return "image";
  }

  // 音频类型
  if (mime.startsWith("audio/")) {
    return "voice";
  }

  // 视频类型
  if (mime.startsWith("video/")) {
    return "video";
  }

  return "file";
}

/**
 * 从 Content-Type 推断文件扩展名
 *
 * @param contentType HTTP Content-Type 头
 * @returns 文件扩展名（含点号）或空字符串
 */
function getExtensionFromContentType(contentType: string | null): string {
  if (!contentType) return "";

  const mime = contentType.split(";")[0].trim().toLowerCase();

  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/amr": ".amr",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
  };

  return mimeToExt[mime] ?? "";
}


/**
 * 检查是否为本地文件路径
 *
 * @param urlOrPath URL 或路径
 * @returns 是否为本地路径
 */
function isLocalPath(urlOrPath: string): boolean {
  // 以 / 或 ~ 开头，或 Windows 盘符
  if (
    urlOrPath.startsWith("/") ||
    urlOrPath.startsWith("~") ||
    /^[a-zA-Z]:/.test(urlOrPath)
  ) {
    return true;
  }

  // 尝试解析为 URL
  try {
    const url = new URL(urlOrPath);
    return url.protocol === "file:";
  } catch {
    return true; // 不是有效 URL，视为本地路径
  }
}

/**
 * 上传媒体到钉钉存储
 *
 * 调用 /media/upload API
 *
 * @param params 上传参数
 * @returns 上传结果
 * @throws Error 如果上传失败
 */
export async function uploadMediaDingtalk(params: {
  cfg: DingtalkConfig;
  media: Buffer;
  fileName: string;
  mediaType: "image" | "voice" | "video" | "file";
}): Promise<UploadMediaResult> {
  const { cfg, media, fileName, mediaType } = params;

  // 验证凭证
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "DingTalk credentials not configured (clientId, clientSecret required)"
    );
  }

  // 获取 Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);

  try {
    // 构建 FormData
    const formData = new FormData();
    const blob = new Blob([media], { type: "application/octet-stream" });
    formData.append("media", blob, fileName);
    formData.append("type", mediaType);

    const response = await fetch(
      `${DINGTALK_OAPI_BASE}/media/upload?access_token=${accessToken}&type=${mediaType}`,
      {
        method: "POST",
        body: formData,
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `DingTalk media upload failed: HTTP ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
      type?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(
        `DingTalk media upload failed: ${data.errmsg ?? "unknown error"} (code: ${data.errcode})`
      );
    }

    if (!data.media_id) {
      throw new Error("DingTalk media upload failed: no media_id returned");
    }

    return {
      mediaId: data.media_id,
      type: mediaType,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `DingTalk media upload timed out after ${UPLOAD_TIMEOUT}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}


/**
 * 发送媒体消息到钉钉
 *
 * 流程:
 * 1. 从 URL 或 Buffer 获取媒体数据
 * 2. 上传到钉钉媒体存储获取 media_id
 * 3. 使用 media_id 发送消息
 *
 * @param params 发送参数
 * @returns 发送结果
 * @throws Error 如果发送失败
 */
export async function sendMediaDingtalk(
  params: SendMediaParams
): Promise<DingtalkSendResult> {
  const { cfg, to, mediaUrl, chatType, mediaBuffer, fileName } = params;

  // 验证凭证
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "DingTalk credentials not configured (clientId, clientSecret required)"
    );
  }

  let buffer: Buffer;
  let name: string;
  let detectedMediaType: "image" | "voice" | "video" | "file" | undefined;

  if (mediaBuffer) {
    // 使用提供的 Buffer
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    if (isLocalPath(mediaUrl)) {
      // 本地文件路径
      const filePath = mediaUrl.startsWith("~")
        ? mediaUrl.replace("~", process.env.HOME ?? "")
        : mediaUrl.replace("file://", "");

      if (!fs.existsSync(filePath)) {
        throw new Error(`Local file not found: ${filePath}`);
      }
      buffer = fs.readFileSync(filePath);
      name = fileName ?? path.basename(filePath);
    } else {
      // 远程 URL - 下载
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const response = await fetch(mediaUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(
            `Failed to fetch media from URL: HTTP ${response.status}`
          );
        }

        // 从 Content-Type 检测媒体类型
        const contentType = response.headers.get("content-type");
        detectedMediaType = detectMediaTypeFromContentType(contentType);

        buffer = Buffer.from(await response.arrayBuffer());

        // 构建文件名：优先使用提供的 fileName，否则从 URL 提取
        let baseName = fileName ?? (path.basename(new URL(mediaUrl).pathname) || "file");

        // 如果文件名没有扩展名，根据 Content-Type 添加
        if (!path.extname(baseName) && contentType) {
          const ext = getExtensionFromContentType(contentType);
          if (ext) {
            baseName = baseName + ext;
          }
        }
        name = baseName;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(
            `Media download timed out after ${REQUEST_TIMEOUT}ms`
          );
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // 检测媒体类型：优先使用从 Content-Type 检测到的类型，否则从文件名推断
  const mediaType = detectedMediaType ?? detectMediaType(name);

  // 上传媒体
  const uploadResult = await uploadMediaDingtalk({
    cfg,
    media: buffer,
    fileName: name,
    mediaType,
  });

  // 获取 Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  // 发送媒体消息
  if (chatType === "direct") {
    return sendDirectMediaMessage({
      cfg,
      to,
      mediaId: uploadResult.mediaId,
      mediaType,
      accessToken,
    });
  } else {
    return sendGroupMediaMessage({
      cfg,
      to,
      mediaId: uploadResult.mediaId,
      mediaType,
      accessToken,
    });
  }
}


/**
 * 获取媒体消息的 msgKey
 *
 * @param mediaType 媒体类型
 * @returns msgKey
 */
function getMsgKeyForMediaType(
  mediaType: "image" | "voice" | "video" | "file"
): string {
  switch (mediaType) {
    case "image":
      return "sampleImageMsg";
    case "voice":
      return "sampleAudio";
    case "video":
      return "sampleVideo";
    case "file":
      return "sampleFile";
    default:
      return "sampleFile";
  }
}

/**
 * 构建媒体消息参数
 *
 * @param mediaId 媒体 ID
 * @param mediaType 媒体类型
 * @returns msgParam JSON 字符串
 */
function buildMediaMsgParam(
  mediaId: string,
  mediaType: "image" | "voice" | "video" | "file"
): string {
  switch (mediaType) {
    case "image":
      return JSON.stringify({ photoURL: mediaId });
    case "voice":
      return JSON.stringify({ mediaId, duration: "1000" });
    case "video":
      return JSON.stringify({
        videoMediaId: mediaId,
        videoType: "mp4",
        duration: "1000",
      });
    case "file":
      return JSON.stringify({ mediaId, fileName: "file", fileType: "file" });
    default:
      return JSON.stringify({ mediaId });
  }
}

/**
 * 发送单聊媒体消息
 *
 * @internal
 */
async function sendDirectMediaMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  accessToken: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, mediaId, mediaType, accessToken } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify({
          robotCode: cfg.clientId,
          userIds: [to],
          msgKey: getMsgKeyForMediaType(mediaType),
          msgParam: buildMediaMsgParam(mediaId, mediaType),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `DingTalk direct media send failed: HTTP ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `dm_media_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `DingTalk direct media send timed out after ${REQUEST_TIMEOUT}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 发送群聊媒体消息
 *
 * @internal
 */
async function sendGroupMediaMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  accessToken: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, mediaId, mediaType, accessToken } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify({
          robotCode: cfg.clientId,
          openConversationId: to,
          msgKey: getMsgKeyForMediaType(mediaType),
          msgParam: buildMediaMsgParam(mediaId, mediaType),
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `DingTalk group media send failed: HTTP ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `gm_media_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `DingTalk group media send timed out after ${REQUEST_TIMEOUT}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
