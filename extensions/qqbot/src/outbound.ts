/**
 * QQ Bot 出站适配器
 */

import * as path from "node:path";
import { detectMediaType, HttpError, stripTitleFromUrl } from "@xuanyue202/shared";
import {
  mergeQQBotAccountConfig,
  resolveQQBotCredentials,
  DEFAULT_ACCOUNT_ID,
  type PluginConfig,
} from "./config.js";
import {
  getAccessToken,
  sendC2CInputNotify,
  sendC2CMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendGroupMessage,
  sendChannelMessage,
} from "./client.js";
import { setRefIndex, type RefAttachmentSummary } from "./ref-index-store.js";
import { sendFileQQBot } from "./send.js";
import type { QQBotSendResult } from "./types.js";


type TargetKind = "c2c" | "group" | "channel";

type QQBotResponseWithExtInfo = {
  id: string;
  timestamp: number | string;
  ext_info?: {
    ref_idx?: string;
  };
};

function stripPrefix(value: string, prefix: string): string {
  return value.slice(0, prefix.length).toLowerCase() === prefix ? value.slice(prefix.length) : value;
}

function parseTarget(to: string): { kind: TargetKind; id: string } {
  let raw = to.trim();
  raw = stripPrefix(raw, "qqbot:");
  const normalizedRaw = raw.toLowerCase();

  if (normalizedRaw.startsWith("group:")) {
    return { kind: "group", id: raw.slice("group:".length) };
  }
  if (normalizedRaw.startsWith("channel:")) {
    return { kind: "channel", id: raw.slice("channel:".length) };
  }
  if (normalizedRaw.startsWith("user:")) {
    return { kind: "c2c", id: raw.slice("user:".length) };
  }
  if (normalizedRaw.startsWith("c2c:")) {
    return { kind: "c2c", id: raw.slice("c2c:".length) };
  }

  return { kind: "c2c", id: raw };
}

function shortId(value?: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function summarizeError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body?.trim();
    return body ? `${err.message} - ${body}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function logEventIdFallback(params: {
  phase: "start" | "success" | "failed";
  action: "text" | "media" | "typing";
  accountId?: string;
  targetKind: TargetKind;
  targetId: string;
  messageId?: string;
  eventId?: string;
  reason?: string;
}): void {
  const accountLabel = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const detail =
    `[qqbot] event_id-fallback phase=${params.phase} action=${params.action} accountId=${accountLabel} ` +
    `target=${params.targetKind}:${shortId(params.targetId)} msg_id=${shortId(params.messageId)} event_id=${shortId(params.eventId)}` +
    (params.reason ? ` reason=${params.reason}` : "");

  if (params.phase === "failed") {
    console.error(detail);
    return;
  }
  if (params.phase === "start") {
    console.warn(detail);
    return;
  }
  console.info(detail);
}

function logQQBotOutboundDispatch(params: {
  action: "text" | "media";
  api:
    | "sendProactiveC2CMessage"
    | "sendC2CMessage"
    | "sendProactiveGroupMessage"
    | "sendGroupMessage"
    | "sendChannelMessage"
    | "sendFileQQBot";
  accountId?: string;
  targetKind: TargetKind;
  targetId: string;
  markdown?: boolean;
  replyToId?: string;
  replyEventId?: string;
  text?: string;
  mediaUrl?: string;
}): void {
  const accountLabel = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const textLength = typeof params.text === "string" ? params.text.length : 0;
  const mediaLabel = params.mediaUrl ? ` media=${shortId(params.mediaUrl)}` : "";
  console.info(
    `[qqbot] outbound action=${params.action} api=${params.api} accountId=${accountLabel} ` +
      `target=${params.targetKind}:${shortId(params.targetId)} markdown=${params.markdown ? "yes" : "no"} ` +
      `replyToId=${params.replyToId ? "yes" : "no"} replyEventId=${params.replyEventId ? "yes" : "no"} ` +
      `textLen=${textLength}${mediaLabel}`
  );
}

function shouldRetryWithEventId(err: unknown): boolean {
  const status = err instanceof HttpError ? err.status : undefined;
  let body = "";
  if (err instanceof HttpError) {
    body = err.body ?? "";
  } else if (err instanceof Error) {
    body = err.message;
  } else {
    body = String(err);
  }

  const text = body.toLowerCase();
  const mentionsPassiveReply =
    text.includes("msg_id") ||
    text.includes("被动") ||
    text.includes("passive") ||
    text.includes("reply");
  if (!mentionsPassiveReply && !(typeof status === "number" && status >= 400 && status < 500)) {
    return false;
  }

  return (
    text.includes("expire") ||
    text.includes("invalid") ||
    text.includes("not found") ||
    text.includes("超过") ||
    text.includes("超时") ||
    text.includes("过期") ||
    text.includes("失效") ||
    text.includes("无效")
  );
}

function shouldSendTextAsFollowupForMedia(mediaUrl: string): boolean {
  return detectMediaType(stripTitleFromUrl(mediaUrl)) === "file";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveResponseRefIdx(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const direct = (response as { refIdx?: unknown }).refIdx;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const extInfo = (response as { ext_info?: { ref_idx?: unknown } }).ext_info;
  if (typeof extInfo?.ref_idx === "string" && extInfo.ref_idx.trim()) {
    return extInfo.ref_idx.trim();
  }

  return undefined;
}

function resolveOutboundAttachmentType(mediaUrl: string): RefAttachmentSummary["type"] {
  const detected = detectMediaType(stripTitleFromUrl(mediaUrl));
  if (detected === "image") return "image";
  if (detected === "video") return "video";
  if (detected === "audio") return "voice";
  if (detected === "file") return "file";
  return "unknown";
}

function resolveOutboundAttachmentFileName(mediaUrl: string): string | undefined {
  const source = stripTitleFromUrl(mediaUrl).trim();
  if (!source) return undefined;

  if (isHttpUrl(source)) {
    try {
      const base = path.posix.basename(new URL(source).pathname);
      return base && base !== "/" ? base : undefined;
    } catch {
      return undefined;
    }
  }

  const base = path.basename(source);
  return base || undefined;
}

function buildOutboundAttachmentSummary(params: {
  mediaUrl: string;
  text?: string;
}): RefAttachmentSummary {
  const source = stripTitleFromUrl(params.mediaUrl).trim();
  const type = resolveOutboundAttachmentType(source);
  const filename = resolveOutboundAttachmentFileName(source);
  const text = params.text?.trim();

  return {
    type,
    ...(filename ? { filename } : {}),
    ...(isHttpUrl(source) ? { url: source } : { localPath: source }),
    ...(type === "voice" && text
      ? {
          transcript: text,
          transcriptSource: "tts" as const,
        }
      : {}),
  };
}

function recordOutboundC2CRefIndex(params: {
  refIdx?: string;
  accountId?: string;
  text?: string;
  mediaUrl?: string;
}): void {
  const refIdx = params.refIdx?.trim();
  if (!refIdx) return;

  const text = params.text?.trim() ?? "";
  const attachments = params.mediaUrl?.trim()
    ? [buildOutboundAttachmentSummary({ mediaUrl: params.mediaUrl, text })]
    : undefined;

  if (!text && !attachments) {
    return;
  }

  try {
    const accountLabel = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
    setRefIndex(refIdx, {
      content: text,
      senderId: accountLabel,
      senderName: accountLabel,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments ? { attachments } : {}),
    });
    console.info(
      `[qqbot] cached outbound ref_idx=${refIdx} accountId=${accountLabel} textLen=${text.length} media=${params.mediaUrl?.trim() ? "yes" : "no"}`
    );
  } catch (err) {
    console.warn(`[qqbot] failed to cache outbound ref_idx=${refIdx}: ${String(err)}`);
  }
}

function buildPassiveReplyRefs(params: {
  replyToId?: string;
  replyEventId?: string;
}): { messageId?: string; eventId?: string } {
  if (params.replyToId) {
    return { messageId: params.replyToId };
  }
  if (params.replyEventId) {
    return { eventId: params.replyEventId };
  }
  return {};
}

export const qqbotOutbound = {
  deliveryMode: "direct" as const,
  textChunkLimit: 1500,
  chunkerMode: "markdown" as const,

  sendText: async (params: {
    cfg: PluginConfig;
    to: string;
    text: string;
    replyToId?: string;
    replyEventId?: string;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, text, replyToId, replyEventId, accountId } = params;
    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const credentials = resolveQQBotCredentials(qqCfg);
    if (!credentials) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    const accessToken = await getAccessToken(credentials.appId, credentials.clientSecret);
    const markdown = qqCfg.markdownSupport ?? true;
    const groupMarkdown = false;

    try {
      if (target.kind === "group") {
        if (!replyToId && !replyEventId) {
          logQQBotOutboundDispatch({
            action: "text",
            api: "sendProactiveGroupMessage",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            markdown,
            text,
          });
          const result = await sendProactiveGroupMessage({
            accessToken,
            groupOpenid: target.id,
            content: text,
            markdown,
          });
          return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
        }

        let result: { id: string; timestamp: number | string };
        try {
          logQQBotOutboundDispatch({
            action: "text",
            api: "sendGroupMessage",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            markdown: groupMarkdown,
            replyToId,
            replyEventId,
            text,
          });
          result = await sendGroupMessage({
            accessToken,
            groupOpenid: target.id,
            content: text,
            ...buildPassiveReplyRefs({ replyToId, replyEventId }),
            markdown: groupMarkdown,
          });
        } catch (err) {
          if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
            throw err;
          }
          logEventIdFallback({
            phase: "start",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(err),
          });
          try {
            result = await sendGroupMessage({
              accessToken,
              groupOpenid: target.id,
              content: text,
              eventId: replyEventId,
              markdown: groupMarkdown,
            });
            logEventIdFallback({
              phase: "success",
              action: "text",
              accountId,
              targetKind: target.kind,
              targetId: target.id,
              messageId: replyToId,
              eventId: replyEventId,
            });
          } catch (retryErr) {
            logEventIdFallback({
              phase: "failed",
              action: "text",
              accountId,
              targetKind: target.kind,
              targetId: target.id,
              messageId: replyToId,
              eventId: replyEventId,
              reason: summarizeError(retryErr),
            });
            throw retryErr;
          }
        }
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }
      if (target.kind === "channel") {
        logQQBotOutboundDispatch({
          action: "text",
          api: "sendChannelMessage",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          replyToId,
          text,
        });
        const result = await sendChannelMessage({
          accessToken,
          channelId: target.id,
          content: text,
          messageId: replyToId,
        });
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }

      if (!replyToId && !replyEventId) {
        logQQBotOutboundDispatch({
          action: "text",
          api: "sendProactiveC2CMessage",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          markdown,
          text,
        });
        const result = await sendProactiveC2CMessage({
          accessToken,
          openid: target.id,
          content: text,
          markdown,
        });
        const refIdx = resolveResponseRefIdx(result);
        recordOutboundC2CRefIndex({ refIdx, accountId, text });
        return {
          channel: "qqbot",
          messageId: result.id,
          timestamp: result.timestamp,
          ...(refIdx ? { refIdx } : {}),
        };
      }

      let result: QQBotResponseWithExtInfo;
      try {
        logQQBotOutboundDispatch({
          action: "text",
          api: "sendC2CMessage",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          markdown,
          replyToId,
          replyEventId,
          text,
        });
        result = await sendC2CMessage({
          accessToken,
          openid: target.id,
          content: text,
          ...buildPassiveReplyRefs({ replyToId, replyEventId }),
          markdown,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "text",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
          result = await sendC2CMessage({
            accessToken,
            openid: target.id,
            content: text,
            eventId: replyEventId,
            markdown,
          });
          logEventIdFallback({
            phase: "success",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "text",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      const refIdx = resolveResponseRefIdx(result);
      recordOutboundC2CRefIndex({ refIdx, accountId, text });
      return {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        ...(refIdx ? { refIdx } : {}),
      };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },

  sendMedia: async (params: {
    cfg: PluginConfig;
    to: string;
    text?: string;
    mediaUrl?: string;
    replyToId?: string;
    replyEventId?: string;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, mediaUrl, text, replyToId, replyEventId, accountId } = params;
    if (!mediaUrl) {
      const fallbackText = text?.trim() ?? "";
      if (!fallbackText) {
        return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
      }
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText, replyToId, replyEventId, accountId });
    }

    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    if (!resolveQQBotCredentials(qqCfg)) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    const trimmedText = text?.trim() ? text.trim() : undefined;
    const sendTextAsFollowup = trimmedText ? shouldSendTextAsFollowupForMedia(mediaUrl) : false;
    if (target.kind === "channel") {
      const fallbackText = trimmedText ? `${trimmedText}\n${mediaUrl}` : mediaUrl;
      return qqbotOutbound.sendText({ cfg, to, text: fallbackText, replyToId, replyEventId, accountId });
    }

    try {
      let result: { id: string; timestamp: number | string; refIdx?: string };
      try {
        logQQBotOutboundDispatch({
          action: "media",
          api: "sendFileQQBot",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          replyToId,
          replyEventId,
          text: sendTextAsFollowup ? undefined : trimmedText,
          mediaUrl,
        });
        result = await sendFileQQBot({
          cfg: qqCfg,
          target: { kind: target.kind, id: target.id },
          mediaUrl,
          text: sendTextAsFollowup ? undefined : trimmedText,
          messageId: replyToId,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "media",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
        result = await sendFileQQBot({
          cfg: qqCfg,
          target: { kind: target.kind, id: target.id },
          mediaUrl,
          text: sendTextAsFollowup ? undefined : trimmedText,
          eventId: replyEventId,
        });
          logEventIdFallback({
            phase: "success",
            action: "media",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "media",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      if (sendTextAsFollowup && trimmedText) {
        const textResult = await qqbotOutbound.sendText({
          cfg,
          to,
          text: trimmedText,
          replyToId,
          replyEventId,
          accountId,
        });
        if (textResult.error) {
          return {
            channel: "qqbot",
            error: `QQBot follow-up text send failed after media delivery: ${textResult.error}`,
          };
        }
      }
      const refIdx = target.kind === "c2c" ? resolveResponseRefIdx(result) : undefined;
      if (target.kind === "c2c") {
        recordOutboundC2CRefIndex({
          refIdx,
          accountId,
          text: sendTextAsFollowup ? undefined : trimmedText,
          mediaUrl,
        });
      }
      return {
        channel: "qqbot",
        messageId: result.id,
        timestamp: result.timestamp,
        ...(refIdx ? { refIdx } : {}),
      };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },

  sendTyping: async (params: {
    cfg: PluginConfig;
    to: string;
    replyToId?: string;
    replyEventId?: string;
    inputSecond?: number;
    accountId?: string;
  }): Promise<QQBotSendResult> => {
    const { cfg, to, replyToId, replyEventId, inputSecond, accountId } = params;
    const qqCfg = mergeQQBotAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
    const credentials = resolveQQBotCredentials(qqCfg);
    if (!credentials) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId/clientSecret)" };
    }

    const target = parseTarget(to);
    if (target.kind !== "c2c") {
      return { channel: "qqbot" };
    }

    try {
      const accessToken = await getAccessToken(credentials.appId, credentials.clientSecret);
      let typingResult: { refIdx?: string } | undefined;
      try {
        typingResult = await sendC2CInputNotify({
          accessToken,
          openid: target.id,
          messageId: replyToId,
          eventId: !replyToId ? replyEventId : undefined,
          inputSecond,
        });
      } catch (err) {
        if (!replyToId || !replyEventId || !shouldRetryWithEventId(err)) {
          throw err;
        }
        logEventIdFallback({
          phase: "start",
          action: "typing",
          accountId,
          targetKind: target.kind,
          targetId: target.id,
          messageId: replyToId,
          eventId: replyEventId,
          reason: summarizeError(err),
        });
        try {
          typingResult = await sendC2CInputNotify({
            accessToken,
            openid: target.id,
            eventId: replyEventId,
            inputSecond,
          });
          logEventIdFallback({
            phase: "success",
            action: "typing",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
          });
        } catch (retryErr) {
          logEventIdFallback({
            phase: "failed",
            action: "typing",
            accountId,
            targetKind: target.kind,
            targetId: target.id,
            messageId: replyToId,
            eventId: replyEventId,
            reason: summarizeError(retryErr),
          });
          throw retryErr;
        }
      }
      return {
        channel: "qqbot",
        ...(typingResult?.refIdx ? { refIdx: typingResult.refIdx } : {}),
      };
    } catch (err) {
      const message = summarizeError(err);
      return { channel: "qqbot", error: message };
    }
  },
};
