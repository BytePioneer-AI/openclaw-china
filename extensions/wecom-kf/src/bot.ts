/**
 * 微信客服渠道消息处理
 *
 * 将拉取到的消息分发给 OpenClaw Agent
 * 支持语音 ASR、图片/文件下载归档
 */

import {
  ASRError,
  ASRAuthError,
  ASRRequestError,
  ASRResponseParseError,
  ASRServiceError,
  appendCronHiddenPrompt,
  checkDmPolicy,
  createLogger,
  transcribeTencentFlash,
  type Logger,
} from "@openclaw-china/shared";
import { readFile } from "node:fs/promises";

import type { PluginRuntime } from "./runtime.js";
import type { ResolvedWecomKfAccount, WecomKfInboundMessage, WecomKfDmPolicy } from "./types.js";
import {
  resolveAllowFrom,
  resolveWecomKfASRCredentials,
  resolveDmPolicy,
  resolveInboundMediaEnabled,
  resolveInboundMediaMaxBytes,
  type PluginConfig,
} from "./config.js";
import {
  downloadWecomMediaToFile,
  finalizeInboundMedia,
  pruneInboundMediaDir,
} from "./api.js";

export type WecomKfDispatchHooks = {
  onChunk: (text: string) => void | Promise<void>;
  onError?: (err: unknown) => void;
};

function resolveVoiceFormat(_msg: WecomKfInboundMessage, savedPath: string, mimeType?: string): string {
  const lowerPath = savedPath.toLowerCase();
  if (lowerPath.endsWith(".speex")) return "speex";
  if (lowerPath.endsWith(".amr")) return "amr";
  if (lowerPath.endsWith(".silk")) return "silk";
  if (lowerPath.endsWith(".mp3")) return "mp3";
  if (lowerPath.endsWith(".wav")) return "wav";
  if (lowerPath.endsWith(".ogg")) return "ogg";
  if (lowerPath.endsWith(".m4a")) return "m4a";
  if (lowerPath.endsWith(".aac")) return "aac";
  if (lowerPath.endsWith(".flac")) return "flac";

  const mime = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/amr") return "amr";
  if (mime === "audio/speex" || mime === "audio/x-speex") return "speex";
  if (mime === "audio/silk" || mime === "audio/x-silk") return "silk";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/aac") return "aac";
  if (mime === "audio/x-m4a" || mime === "audio/mp4") return "m4a";
  if (mime === "audio/flac") return "flac";

  return "silk";
}

function formatASRErrorLog(err: unknown): string {
  if (err instanceof ASRError) {
    const detail: Record<string, unknown> = {
      kind: err.kind,
      provider: err.provider,
      retryable: err.retryable,
      message: err.message,
    };
    if (err instanceof ASRAuthError && typeof err.status === "number") {
      detail.status = err.status;
    }
    if (err instanceof ASRRequestError) {
      if (typeof err.status === "number") detail.status = err.status;
      if (err.bodySnippet) detail.bodySnippet = err.bodySnippet;
    }
    if (err instanceof ASRResponseParseError) {
      if (typeof err.status === "number") detail.status = err.status;
      if (err.bodySnippet) detail.bodySnippet = err.bodySnippet;
    }
    if (err instanceof ASRServiceError && typeof err.serviceCode === "number") {
      detail.serviceCode = err.serviceCode;
    }
    return JSON.stringify(detail);
  }
  return JSON.stringify({
    message: err instanceof Error ? err.message : String(err),
  });
}

const VOICE_ASR_FALLBACK_TEXT = "当前语音功能未启动或识别失败，请稍后重试。";
const VOICE_ASR_ERROR_MAX_LENGTH = 500;
const STALE_INBOUND_GRACE_MS = 5_000;

function trimTextForReply(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function buildVoiceASRFallbackReply(errorMessage?: string): string {
  const detail = errorMessage?.trim();
  if (!detail) return VOICE_ASR_FALLBACK_TEXT;
  return `${VOICE_ASR_FALLBACK_TEXT}\n\n接口错误：${trimTextForReply(detail, VOICE_ASR_ERROR_MAX_LENGTH)}`;
}

function normalizeInboundSendTimeMs(sendTime?: number): number | undefined {
  if (typeof sendTime !== "number" || !Number.isFinite(sendTime) || sendTime <= 0) return undefined;
  return sendTime >= 1_000_000_000_000 ? sendTime : sendTime * 1000;
}

/**
 * 提取消息内容（基础版，不含媒体下载）
 */
export function extractWecomKfContent(msg: WecomKfInboundMessage): string {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  if (msgtype === "text") {
    const content = (msg as { text?: { content?: string } }).text?.content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "image") {
    const mediaId = (msg as { image?: { media_id?: string } }).image?.media_id;
    return mediaId ? `[image] media_id:${mediaId}` : "[image]";
  }
  if (msgtype === "voice") {
    const mediaId = (msg as { voice?: { media_id?: string } }).voice?.media_id;
    return mediaId ? `[voice] media_id:${mediaId}` : "[voice]";
  }
  if (msgtype === "video") {
    const mediaId = (msg as { video?: { media_id?: string } }).video?.media_id;
    return mediaId ? `[video] media_id:${mediaId}` : "[video]";
  }
  if (msgtype === "file") {
    const mediaId = (msg as { file?: { media_id?: string } }).file?.media_id;
    return mediaId ? `[file] media_id:${mediaId}` : "[file]";
  }
  if (msgtype === "location") {
    const loc = (msg as { location?: { latitude?: number; longitude?: number; name?: string; address?: string } }).location;
    const parts: string[] = [];
    if (loc?.latitude !== undefined && loc?.longitude !== undefined) {
      parts.push(`${loc.latitude},${loc.longitude}`);
    }
    if (loc?.name) parts.push(loc.name);
    if (loc?.address) parts.push(loc.address);
    return parts.length ? `[location] ${parts.join(" ")}` : "[location]";
  }
  if (msgtype === "link") {
    const link = (msg as { link?: { title?: string; desc?: string; url?: string } }).link;
    const parts: string[] = [];
    if (link?.title) parts.push(link.title);
    if (link?.url) parts.push(link.url);
    return parts.length ? `[link] ${parts.join(" ")}` : "[link]";
  }
  if (msgtype === "business_card") {
    const userid = (msg as { business_card?: { userid?: string } }).business_card?.userid;
    return userid ? `[business_card] ${userid}` : "[business_card]";
  }
  if (msgtype === "miniprogram") {
    const mp = (msg as { miniprogram?: { title?: string; appid?: string } }).miniprogram;
    return mp?.title ? `[miniprogram] ${mp.title}` : "[miniprogram]";
  }
  if (msgtype === "event") {
    const eventType = (msg as { event?: { event_type?: string } }).event?.event_type;
    return eventType ? `[event] ${eventType}` : "[event]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体增强：下载/ASR/归档
// ─────────────────────────────────────────────────────────────────────────────

export async function enrichInboundContentWithMedia(params: {
  cfg: PluginConfig;
  account: ResolvedWecomKfAccount;
  msg: WecomKfInboundMessage;
  logger?: Logger;
}): Promise<{ text: string; mediaPaths: string[]; asrErrorMessage?: string; cleanup: () => Promise<void> }> {
  const { account, msg, logger } = params;
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  const accountConfig = account?.config ?? {};
  const enabled = resolveInboundMediaEnabled(accountConfig);
  const maxBytes = resolveInboundMediaMaxBytes(accountConfig);

  const mediaPaths: string[] = [];
  let asrErrorMessage: string | undefined;

  const makeResult = (text: string) => ({
    text,
    mediaPaths,
    asrErrorMessage,
    cleanup: async () => {
      try { await pruneInboundMediaDir(account); } catch { /* ignore */ }
    },
  });

  if (!enabled) {
    return makeResult(extractWecomKfContent(msg));
  }

  // 图片
  if (msgtype === "image") {
    try {
      const mediaId = String((msg as { image?: { media_id?: string } }).image?.media_id ?? "").trim();
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "img" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[image] saved:${finalPath}`);
        }
        return makeResult(`[image] (save failed) ${saved.error ?? ""}`.trim());
      }
      return makeResult(extractWecomKfContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[image] (download error: ${errorMsg})`);
    }
  }

  // 文件
  if (msgtype === "file") {
    try {
      const mediaId = String((msg as { file?: { media_id?: string } }).file?.media_id ?? "").trim();
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "file" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[file] saved:${finalPath}`);
        }
        return makeResult(`[file] (save failed) ${saved.error ?? ""}`.trim());
      }
      return makeResult(extractWecomKfContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[file] (download error: ${errorMsg})`);
    }
  }

  // 视频
  if (msgtype === "video") {
    try {
      const mediaId = String((msg as { video?: { media_id?: string } }).video?.media_id ?? "").trim();
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "video" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[video] saved:${finalPath}`);
        }
        return makeResult(`[video] (save failed) ${saved.error ?? ""}`.trim());
      }
      return makeResult(extractWecomKfContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[video] (download error: ${errorMsg})`);
    }
  }

  // 语音：下载 + 可选 ASR
  if (msgtype === "voice") {
    try {
      const mediaId = String((msg as { voice?: { media_id?: string } }).voice?.media_id ?? "").trim();
      const asrCredentials = resolveWecomKfASRCredentials(accountConfig);

      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "voice" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);

          if (asrCredentials) {
            try {
              const audio = await readFile(finalPath);
              const asrConfig: {
                appId: string;
                secretId: string;
                secretKey: string;
                engineType?: string;
                voiceFormat: string;
                timeoutMs?: number;
              } = {
                appId: asrCredentials.appId,
                secretId: asrCredentials.secretId,
                secretKey: asrCredentials.secretKey,
                voiceFormat: resolveVoiceFormat(msg, finalPath, saved.mimeType),
              };
              if (asrCredentials.engineType) {
                asrConfig.engineType = asrCredentials.engineType;
              }
              if (typeof asrCredentials.timeoutMs === "number") {
                asrConfig.timeoutMs = asrCredentials.timeoutMs;
              }
              const transcript = await transcribeTencentFlash({ audio, config: asrConfig });
              const safeTranscript = transcript.trim();
              if (safeTranscript) {
                return makeResult(`[voice] saved:${finalPath}\n[recognition] ${safeTranscript}`);
              }
            } catch (err) {
              asrErrorMessage = err instanceof Error ? err.message : String(err);
              logger?.warn(
                `[voice-asr] transcription failed accountId=${account.accountId} msgId=${String(msg.msgid ?? "")} detail=${formatASRErrorLog(err)}`
              );
            }
          }

          return makeResult(`[voice] saved:${finalPath}`);
        }
        return makeResult(`[voice] (save failed) ${saved.error ?? ""}`.trim());
      }

      return makeResult(extractWecomKfContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[voice] (download error: ${errorMsg})`);
    }
  }

  return makeResult(extractWecomKfContent(msg));
}

// ─────────────────────────────────────────────────────────────────────────────
// 消息分发
// ─────────────────────────────────────────────────────────────────────────────

function resolveSenderId(msg: WecomKfInboundMessage): string {
  return msg.external_userid?.trim() || "unknown";
}

function resolveChatId(_msg: WecomKfInboundMessage, senderId: string): string {
  return senderId;
}

async function buildInboundBody(params: {
  cfg: PluginConfig;
  account: ResolvedWecomKfAccount;
  msg: WecomKfInboundMessage;
  logger?: Logger;
}): Promise<{ text: string; asrErrorMessage?: string; cleanup: () => Promise<void> }> {
  const enriched = await enrichInboundContentWithMedia({
    cfg: params.cfg,
    account: params.account,
    msg: params.msg,
    logger: params.logger,
  });
  return { text: enriched.text, asrErrorMessage: enriched.asrErrorMessage, cleanup: enriched.cleanup };
}

/**
 * 分发微信客服消息
 */
export async function dispatchWecomKfMessage(params: {
  cfg?: PluginConfig;
  account: ResolvedWecomKfAccount;
  msg: WecomKfInboundMessage;
  core: PluginRuntime;
  hooks: WecomKfDispatchHooks;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core, hooks } = params;
  const safeCfg = (cfg ?? {}) as PluginConfig;

  const logger: Logger = createLogger("wecom-kf", { log: params.log, error: params.error });

  const senderId = resolveSenderId(msg);
  const chatId = resolveChatId(msg, senderId);

  const accountConfig = account?.config ?? {};

  const dmPolicy = resolveDmPolicy(accountConfig);
  const allowFrom = resolveAllowFrom(accountConfig);

  const policyResult = checkDmPolicy({
    dmPolicy,
    senderId,
    allowFrom,
  });

  if (!policyResult.allowed) {
    logger.debug(`policy rejected: ${policyResult.reason}`);
    return;
  }

  const channel = core.channel;
  if (!channel?.routing?.resolveAgentRoute || !channel.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    logger.debug("core routing or buffered dispatcher missing, skipping dispatch");
    return;
  }

  const route = channel.routing.resolveAgentRoute({
    cfg: safeCfg,
    channel: "wecom-kf",
    accountId: account.accountId,
    peer: { kind: "dm", id: chatId },
  });

  const storePath = channel.session?.resolveStorePath?.(safeCfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = channel.session?.readSessionUpdatedAt
    ? channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined
    : undefined;

  const inboundSendTimeMs = normalizeInboundSendTimeMs(msg.send_time);
  if (
    inboundSendTimeMs !== undefined &&
    previousTimestamp !== undefined &&
    inboundSendTimeMs + STALE_INBOUND_GRACE_MS < previousTimestamp
  ) {
    logger.info(
      `skip stale inbound message: msgid=${String(msg.msgid ?? "")} sessionKey=${route.sessionKey} sendTimeMs=${inboundSendTimeMs} sessionUpdatedAt=${previousTimestamp}`
    );
    return;
  }

  const { text: rawBody, asrErrorMessage, cleanup } = await buildInboundBody({ cfg: safeCfg, account, msg, logger });
  const fromLabel = `user:${senderId}`;

  if (asrErrorMessage) {
    await hooks.onChunk(buildVoiceASRFallbackReply(asrErrorMessage));
    await cleanup();
    return;
  }

  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
    ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
    : undefined;

  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeCom KF",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const msgid = msg.msgid ?? undefined;

  const from = `wecom-kf:user:${senderId}`;
  const to = `user:${senderId}`;

  const ctxPayload = (channel.reply?.finalizeInboundContext
    ? channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      })
    : {
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: from,
        To: to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId ?? account.accountId,
        ChatType: "direct",
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-kf",
        Surface: "wecom-kf",
        MessageSid: msgid,
        OriginatingChannel: "wecom-kf",
        OriginatingTo: to,
      }) as {
    SessionKey?: string;
    [key: string]: unknown;
  };

  const ctxTo =
    typeof ctxPayload.To === "string" && ctxPayload.To.trim()
      ? ctxPayload.To.trim()
      : undefined;
  const ctxOriginatingTo =
    typeof ctxPayload.OriginatingTo === "string" && ctxPayload.OriginatingTo.trim()
      ? ctxPayload.OriginatingTo.trim()
      : undefined;
  const stableTo = ctxOriginatingTo ?? ctxTo ?? to;
  ctxPayload.To = stableTo;
  ctxPayload.OriginatingTo = stableTo;

  ctxPayload.SenderId = senderId;
  ctxPayload.SenderName = senderId;
  ctxPayload.ConversationLabel = fromLabel;
  ctxPayload.CommandAuthorized = true;

  let cronBase = "";
  if (typeof ctxPayload.RawBody === "string" && ctxPayload.RawBody) {
    cronBase = ctxPayload.RawBody;
  } else if (typeof ctxPayload.Body === "string" && ctxPayload.Body) {
    cronBase = ctxPayload.Body;
  }

  if (cronBase) {
    const nextCron = appendCronHiddenPrompt(cronBase);
    if (nextCron !== cronBase) {
      ctxPayload.BodyForAgent = nextCron;
    }
  }

  if (channel.session?.recordInboundSession && storePath) {
    const mainSessionKeyRaw = (route as Record<string, unknown>)?.mainSessionKey;
    const mainSessionKey =
      typeof mainSessionKeyRaw === "string" && mainSessionKeyRaw.trim()
        ? mainSessionKeyRaw
        : undefined;
    const updateLastRoute = {
      sessionKey: mainSessionKey ?? route.sessionKey,
      channel: "wecom-kf",
      to: stableTo,
      accountId: route.accountId ?? account.accountId,
    };
    const recordSessionKeyRaw = ctxPayload.SessionKey ?? route.sessionKey;
    const recordSessionKey =
      typeof recordSessionKeyRaw === "string" && recordSessionKeyRaw.trim()
        ? recordSessionKeyRaw
        : route.sessionKey;

    await channel.session.recordInboundSession({
      storePath,
      sessionKey: recordSessionKey,
      ctx: ctxPayload,
      updateLastRoute,
      onRecordError: (err: unknown) => {
        logger.error(`wecom-kf: failed updating session meta: ${String(err)}`);
      },
    });
  }

  const tableMode = channel.text?.resolveMarkdownTableMode
    ? channel.text.resolveMarkdownTableMode({ cfg: safeCfg, channel: "wecom-kf", accountId: account.accountId })
    : undefined;

  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: safeCfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const rawText = payload.text ?? "";
        if (!rawText.trim()) return;
        const converted = channel.text?.convertMarkdownTables && tableMode
          ? channel.text.convertMarkdownTables(rawText, tableMode)
          : rawText;
        await hooks.onChunk(converted);
      },
      onError: (err: unknown, info: { kind: string }) => {
        hooks.onError?.(err);
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  await cleanup();
}
