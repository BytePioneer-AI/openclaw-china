import crypto from "node:crypto";
import path from "node:path";

import { readMediaFromLocal, type Logger } from "@openclaw-china/shared";
import type { ReplyMsgItem } from "@wecom/aibot-node-sdk";

const WECOM_NATIVE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const WECOM_NATIVE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const WECOM_NATIVE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export const WECOM_REPLY_MSG_ITEM_LIMIT = 10;

export type WecomReplyMsgItem = ReplyMsgItem;

export async function buildWecomNativeReplyImageItem(params: {
  source: string;
  log?: Logger;
}): Promise<WecomReplyMsgItem | null> {
  const source = String(params.source ?? "").trim();
  if (!source || /^https?:\/\//i.test(source)) return null;

  try {
    const media = await readMediaFromLocal(source, {
      maxSize: WECOM_NATIVE_IMAGE_MAX_BYTES,
    });
    const ext = path.extname(media.fileName ?? source).toLowerCase();
    if (!WECOM_NATIVE_IMAGE_EXTENSIONS.has(ext)) return null;

    const mime = String(media.mimeType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (mime && !WECOM_NATIVE_IMAGE_MIME_TYPES.has(mime)) return null;

    return {
      msgtype: "image",
      image: {
        base64: media.buffer.toString("base64"),
        md5: crypto.createHash("md5").update(media.buffer).digest("hex"),
      },
    };
  } catch (err) {
    params.log?.debug?.(`[wecom] native ws image unavailable for ${source}: ${String(err)}`);
    return null;
  }
}
