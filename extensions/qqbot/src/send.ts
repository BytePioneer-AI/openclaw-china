/**
 * QQ Bot 发送消息（文件）
 */

import {
  getAccessToken,
  sendC2CMediaMessage,
  sendGroupMediaMessage,
  uploadC2CMedia,
  uploadGroupMedia,
  MediaFileType,
} from "./client.js";
import type { QQBotAccountConfig } from "./types.js";
import { resolveQQBotCredentials } from "./config.js";
import {
  detectMediaType,
  FileSizeLimitError,
  HttpError,
  MediaTimeoutError,
  isHttpUrl,
  readMedia,
  stripTitleFromUrl,
} from "@xuanyue202/shared";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type QQBotFileTarget = {
  kind: "c2c" | "group";
  id: string;
};

export interface SendFileQQBotParams {
  cfg: QQBotAccountConfig;
  target: QQBotFileTarget;
  mediaUrl: string;
  text?: string;
  messageId?: string;
  eventId?: string;
}

const require = createRequire(import.meta.url);

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

async function uploadQQBotFile(params: {
  accessToken: string;
  target: QQBotFileTarget;
  fileType: MediaFileType;
  url?: string;
  fileData?: string;
  fileName?: string;
}): Promise<string> {
  const { accessToken, target, fileType, url, fileData, fileName } = params;
  if (!url && !fileData) {
    throw new Error("QQBot file upload requires url or fileData");
  }
  const upload =
    target.kind === "group"
      ? await uploadGroupMedia({
          accessToken,
          groupOpenid: target.id,
          fileType,
          srvSendMsg: false,
          ...(fileName ? { fileName } : {}),
          ...(url ? { url } : { fileData }),
        })
      : await uploadC2CMedia({
          accessToken,
          openid: target.id,
          fileType,
          srvSendMsg: false,
          ...(fileName ? { fileName } : {}),
          ...(url ? { url } : { fileData }),
        });

  if (!upload.file_info) {
    throw new Error("QQBot file upload failed: no file_info returned");
  }
  return upload.file_info;
}

function deriveUploadFileName(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;

  if (isHttpUrl(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname;
      const base = path.posix.basename(pathname);
      return base && base !== "/" ? base : undefined;
    } catch {
      return undefined;
    }
  }

  const base = path.basename(trimmed);
  return base || undefined;
}

async function convertAudioToSilk(audioPath: string): Promise<Uint8Array> {
  const ffmpegPath = require("ffmpeg-static") as string | null;
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static not found");
  }
  const silkWasm = require("silk-wasm") as {
    encode: (pcmBuffer: Buffer, sampleRate: number) => Promise<{ data: Uint8Array }>;
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-silk-"));
  const pcmPath = path.join(tmpDir, "audio.pcm");
  try {
    execFileSync(
      ffmpegPath,
      ["-y", "-i", audioPath, "-f", "s16le", "-ar", "24000", "-ac", "1", pcmPath],
      { timeout: 30000, stdio: "pipe" }
    );
    const pcmBuffer = fs.readFileSync(pcmPath);
    const result = await silkWasm.encode(pcmBuffer, 24000);
    return result.data;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

export async function sendFileQQBot(
  params: SendFileQQBotParams
): Promise<{ id: string; timestamp: number | string; refIdx?: string }> {
  const { cfg, target, mediaUrl, text, messageId, eventId } = params;
  const credentials = resolveQQBotCredentials(cfg);
  if (!credentials) {
    throw new Error("QQBot not configured (missing appId/clientSecret)");
  }

  const src = stripTitleFromUrl(mediaUrl);
  const fileType = resolveQQBotMediaFileType(src);

  const sourceIsHttp = isHttpUrl(src);
  const maxFileSizeMB = cfg.maxFileSizeMB ?? 100;
  const mediaTimeoutMs = cfg.mediaTimeoutMs ?? 30000;
  const maxSizeBytes = Math.floor(maxFileSizeMB * 1024 * 1024);
  const messageText = text?.trim() ? text.trim() : undefined;

  const accessToken = await getAccessToken(credentials.appId, credentials.clientSecret);
  let fileInfo: string;
  try {
    if (sourceIsHttp) {
      const fileName = fileType === MediaFileType.FILE ? deriveUploadFileName(src) : undefined;
      fileInfo = await uploadQQBotFile({
        accessToken,
        target,
        fileType,
        url: src,
        ...(fileName ? { fileName } : {}),
      });
    } else {
      let buffer: Buffer;
      let fileName = fileType === MediaFileType.FILE ? deriveUploadFileName(src) : undefined;
      if (fileType === MediaFileType.VOICE) {
        try {
          const silkData = await convertAudioToSilk(src);
          buffer = Buffer.from(silkData);
        } catch {
          const local = await readMediaWithConfig(src, {
            timeout: mediaTimeoutMs,
            maxSize: maxSizeBytes,
          });
          buffer = local.buffer;
        }
      } else {
        const local = await readMediaWithConfig(src, {
          timeout: mediaTimeoutMs,
          maxSize: maxSizeBytes,
        });
        buffer = local.buffer;
        if (fileType === MediaFileType.FILE) {
          fileName = local.fileName || fileName;
        }
      }
      fileInfo = await uploadQQBotFile({
        accessToken,
        target,
        fileType,
        fileData: buffer.toString("base64"),
        ...(fileName ? { fileName } : {}),
      });
    }
  } catch (err) {
    const message = formatQQBotError(err);
    throw new Error(`QQBot media upload failed: ${message}`);
  }

  if (target.kind === "group") {
    try {
      return await sendGroupMediaMessage({
        accessToken,
        groupOpenid: target.id,
        fileInfo,
        ...(messageText ? { content: messageText } : {}),
        ...(messageId ? { messageId } : {}),
        ...(eventId ? { eventId } : {}),
      });
    } catch (err) {
      const message = formatQQBotError(err);
      throw new Error(`QQBot group media send failed: ${message}`);
    }
  }

  try {
    const result = await sendC2CMediaMessage({
      accessToken,
      openid: target.id,
      fileInfo,
      ...(messageText ? { content: messageText } : {}),
      ...(messageId ? { messageId } : {}),
      ...(eventId ? { eventId } : {}),
    });
    const refIdx = result.ext_info?.ref_idx?.trim();
    return {
      id: result.id,
      timestamp: result.timestamp,
      ...(refIdx ? { refIdx } : {}),
    };
  } catch (err) {
    const message = formatQQBotError(err);
    throw new Error(`QQBot C2C media send failed: ${message}`);
  }
}

function formatQQBotError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = normalizeHttpErrorBody(err.body);
    return body ? `${err.message} - ${body}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function normalizeHttpErrorBody(body?: string): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const code = parsed.code;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.msg === "string"
          ? parsed.msg
          : undefined;
    if (code !== undefined || message) {
      return `code=${String(code ?? "unknown")}, message=${message ?? "unknown"}`;
    }
  } catch {
    // keep raw response body
  }

  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

async function readMediaWithConfig(
  source: string,
  options: { timeout: number; maxSize: number }
): Promise<{ buffer: Buffer; fileName: string }> {
  try {
    return await readMedia(source, options);
  } catch (err) {
    if (err instanceof FileSizeLimitError) {
      const limitMB = (err.limitSize / (1024 * 1024)).toFixed(2);
      throw new Error(`QQBot media exceeds limit (${limitMB}MB)`);
    }
    if (err instanceof MediaTimeoutError) {
      throw new Error(`QQBot media read timed out after ${err.timeoutMs}ms`);
    }
    throw err;
  }
}
