/**
 * QQ Bot 发送消息（文件）
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
  getAccessToken,
  sendC2CMediaMessage,
  sendGroupMediaMessage,
  uploadC2CMedia,
  uploadGroupMedia,
  MediaFileType,
} from "./client.js";
import type { QQBotConfig } from "./types.js";
import { detectMediaType, isHttpUrl, normalizeLocalPath, stripTitleFromUrl } from "@openclaw-china/shared";

const FILE_UPLOAD_TIMEOUT_MS = 30000;

export type QQBotFileTarget = {
  kind: "c2c" | "group";
  id: string;
};

export interface SendFileQQBotParams {
  cfg: QQBotConfig;
  target: QQBotFileTarget;
  mediaUrl: string;
  messageId?: string;
}

function resolveQQBotMediaFileType(fileName: string): MediaFileType {
  const mediaType = detectMediaType(fileName);
  switch (mediaType) {
    case "image":
      return MediaFileType.IMAGE;
    case "video":
      return MediaFileType.VIDEO;
    case "audio":
      return MediaFileType.VOICE;
    default:
      return MediaFileType.FILE;
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

async function readLocalFileBuffer(localPath: string): Promise<{ buffer: Buffer; fileName: string }> {
  const buffer = await fsPromises.readFile(localPath);
  const fileName = path.basename(localPath) || "file";
  return { buffer, fileName };
}

async function uploadQQBotFile(params: {
  accessToken: string;
  target: QQBotFileTarget;
  fileType: MediaFileType;
  fileData: string;
}): Promise<string> {
  const { accessToken, target, fileType, fileData } = params;
  const upload =
    target.kind === "group"
      ? await uploadGroupMedia({
          accessToken,
          groupOpenid: target.id,
          fileType,
          fileData,
        })
      : await uploadC2CMedia({
          accessToken,
          openid: target.id,
          fileType,
          fileData,
        });

  if (!upload.file_info) {
    throw new Error("QQBot file upload failed: no file_info returned");
  }
  return upload.file_info;
}

export async function sendFileQQBot(params: SendFileQQBotParams): Promise<{ id: string; timestamp: number | string }> {
  const { cfg, target, mediaUrl, messageId } = params;
  if (!cfg.appId || !cfg.clientSecret) {
    throw new Error("QQBot not configured (missing appId/clientSecret)");
  }

  const src = stripTitleFromUrl(mediaUrl);
  const resolvedLocalPath = normalizeLocalPath(src);
  const { buffer, fileName } = isHttpUrl(src)
    ? await fetchFileBuffer(src)
    : await readLocalFileBuffer(resolvedLocalPath);
  const fileType = resolveQQBotMediaFileType(fileName || src);
  const accessToken = await getAccessToken(cfg.appId, cfg.clientSecret);
  const fileInfo = await uploadQQBotFile({
    accessToken,
    target,
    fileType,
    fileData: buffer.toString("base64"),
  });

  if (target.kind === "group") {
    return sendGroupMediaMessage({
      accessToken,
      groupOpenid: target.id,
      fileInfo,
      messageId,
    });
  }

  return sendC2CMediaMessage({
    accessToken,
    openid: target.id,
    fileInfo,
    messageId,
  });
}
