/**
 * QQ Bot 出站适配器
 */

import { QQBotConfigSchema } from "./config.js";
import { getAccessToken, sendC2CMessage, sendGroupMessage, sendChannelMessage } from "./client.js";
import { sendFileQQBot } from "./send.js";
import type { QQBotConfig, QQBotSendResult } from "./types.js";

export interface OutboundConfig {
  channels?: {
    qqbot?: QQBotConfig;
  };
}

type TargetKind = "c2c" | "group" | "channel";

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseTarget(to: string): { kind: TargetKind; id: string } {
  let raw = to.trim();
  raw = stripPrefix(raw, "qqbot:");

  if (raw.startsWith("group:")) {
    return { kind: "group", id: raw.slice("group:".length) };
  }
  if (raw.startsWith("channel:")) {
    return { kind: "channel", id: raw.slice("channel:".length) };
  }
  if (raw.startsWith("user:")) {
    return { kind: "c2c", id: raw.slice("user:".length) };
  }
  if (raw.startsWith("c2c:")) {
    return { kind: "c2c", id: raw.slice("c2c:".length) };
  }

  return { kind: "c2c", id: raw };
}

export const qqbotOutbound = {
  deliveryMode: "direct" as const,
  textChunkLimit: 1500,
  chunkerMode: "markdown" as const,

  sendText: async (params: {
    cfg: OutboundConfig;
    to: string;
    text: string;
    replyToId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, text, replyToId } = params;
    const rawCfg = cfg.channels?.qqbot;
    const parsed = rawCfg ? QQBotConfigSchema.safeParse(rawCfg) : null;
    const qqCfg = parsed?.success ? parsed.data : rawCfg;
    if (!qqCfg) {
      return { channel: "qqbot", error: "QQBot channel not configured" };
    }
    if (!qqCfg.appId || !qqCfg.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    const accessToken = await getAccessToken(qqCfg.appId, qqCfg.clientSecret);
    const markdown = qqCfg.markdownSupport ?? false;

    try {
      if (target.kind === "group") {
        const result = await sendGroupMessage({
          accessToken,
          groupOpenid: target.id,
          content: text,
          messageId: replyToId,
          markdown,
        });
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }
      if (target.kind === "channel") {
        const result = await sendChannelMessage({
          accessToken,
          channelId: target.id,
          content: text,
          messageId: replyToId,
        });
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }

      const result = await sendC2CMessage({
        accessToken,
        openid: target.id,
        content: text,
        messageId: replyToId,
        markdown,
      });
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { channel: "qqbot", error: message };
    }
  },

  sendMedia: async (params: {
    cfg: OutboundConfig;
    to: string;
    text?: string;
    mediaUrl?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, mediaUrl, text } = params;
    if (!mediaUrl) {
      const fallbackText = text?.trim() ?? "";
      if (!fallbackText) {
        return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
      }
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText });
    }

    const rawCfg = cfg.channels?.qqbot;
    const parsed = rawCfg ? QQBotConfigSchema.safeParse(rawCfg) : null;
    const qqCfg = parsed?.success ? parsed.data : rawCfg;
    if (!qqCfg) {
      return { channel: "qqbot", error: "QQBot channel not configured" };
    }
    if (!qqCfg.appId || !qqCfg.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    if (target.kind === "channel") {
      const fallbackText = text?.trim() ? `${text}\n${mediaUrl}` : mediaUrl;
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText });
    }

    try {
      const result = await sendFileQQBot({
        cfg: qqCfg,
        target: { kind: target.kind, id: target.id },
        mediaUrl,
      });
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { channel: "qqbot", error: message };
    }
  },
};
