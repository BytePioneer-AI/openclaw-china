/**
 * QQ Bot 入站消息处理
 */

import {
  checkDmPolicy,
  checkGroupPolicy,
  cleanupFileSafe,
  createLogger,
  downloadToTempFile,
  fetchMediaFromUrl,
  type Logger,
  appendCronHiddenPrompt,
  ASRError,
  extractMediaFromText,
  isImagePath,
  transcribeTencentFlash,
} from "@openclaw-china/shared";
import {
  QQBotConfigSchema,
  resolveQQBotASRCredentials,
  type QQBotConfig,
} from "./config.js";
import { qqbotOutbound } from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";
import type {
  InboundContext,
  QQInboundAttachment,
  QQInboundMessage,
} from "./types.js";
import * as fs from "node:fs";

type DispatchParams = {
  eventType: string;
  eventData: unknown;
  cfg?: {
    channels?: {
      qqbot?: QQBotConfig;
    };
  };
  accountId: string;
  logger?: Logger;
};

function toString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

function normalizeAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

function parseAttachments(payload: Record<string, unknown>): QQInboundAttachment[] {
  const raw = payload.attachments;
  if (!Array.isArray(raw)) return [];

  const items: QQInboundAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const data = entry as Record<string, unknown>;
    const url = normalizeAttachmentUrl(data.url);
    if (!url) continue;
    items.push({
      url,
      filename: toString(data.filename),
      contentType: toString(data.content_type),
      size: toNonNegativeNumber(data.size),
    });
  }
  return items;
}

function parseTextWithAttachments(payload: Record<string, unknown>): {
  text: string;
  attachments: QQInboundAttachment[];
} {
  const rawContent = typeof payload.content === "string" ? payload.content : "";
  const attachments = parseAttachments(payload);
  return {
    text: rawContent.trim(),
    attachments,
  };
}

type ResolvedInboundAttachment = {
  attachment: QQInboundAttachment;
  localImagePath?: string;
  voiceTranscript?: string;
};

type ResolvedInboundAttachmentResult = {
  attachments: ResolvedInboundAttachment[];
  hasVoiceAttachment: boolean;
  hasVoiceTranscript: boolean;
  asrErrorMessage?: string;
};

const VOICE_ASR_FALLBACK_TEXT = "当前语音功能未启动或识别失败，请稍后重试。";
const VOICE_EXTENSIONS = [".silk", ".amr", ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".speex"];
const VOICE_ASR_ERROR_MAX_LENGTH = 500;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isImageAttachment(att: QQInboundAttachment): boolean {
  const contentType = att.contentType?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return true;
  }

  if (att.filename && isImagePath(att.filename)) {
    return true;
  }

  try {
    return isImagePath(new URL(att.url).pathname);
  } catch {
    return false;
  }
}

function isVoiceAttachment(att: QQInboundAttachment): boolean {
  const contentType = att.contentType?.trim().toLowerCase() ?? "";
  if (contentType === "voice" || contentType.startsWith("audio/")) {
    return true;
  }

  const lowerName = att.filename?.trim().toLowerCase() ?? "";
  if (VOICE_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return true;
  }

  try {
    const pathname = new URL(att.url).pathname.toLowerCase();
    return VOICE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function scheduleTempCleanup(filePath: string): void {
  const timer = setTimeout(() => {
    void cleanupFileSafe(filePath);
  }, 20 * 60 * 1000);
  timer.unref?.();
}

function trimTextForReply(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function buildVoiceASRFallbackReply(errorMessage?: string): string {
  const detail = errorMessage?.trim();
  if (!detail) return VOICE_ASR_FALLBACK_TEXT;
  return `${VOICE_ASR_FALLBACK_TEXT}\n\n接口错误：${trimTextForReply(detail, VOICE_ASR_ERROR_MAX_LENGTH)}`;
}

async function resolveInboundAttachmentsForAgent(params: {
  attachments?: QQInboundAttachment[];
  qqCfg: QQBotConfig;
  logger: Logger;
}): Promise<ResolvedInboundAttachmentResult> {
  const { attachments, qqCfg, logger } = params;
  const list = attachments ?? [];
  if (list.length === 0) {
    return {
      attachments: [],
      hasVoiceAttachment: false,
      hasVoiceTranscript: false,
      asrErrorMessage: undefined,
    };
  }

  const timeout = qqCfg.mediaTimeoutMs ?? 30000;
  const maxFileSizeMB = qqCfg.maxFileSizeMB ?? 100;
  const maxSize = Math.floor(maxFileSizeMB * 1024 * 1024);
  const asrCredentials = resolveQQBotASRCredentials(qqCfg);

  const resolved: ResolvedInboundAttachment[] = [];
  let hasVoiceAttachment = false;
  let hasVoiceTranscript = false;
  let asrErrorMessage: string | undefined;

  for (const att of list) {
    const next: ResolvedInboundAttachment = { attachment: att };
    if (isImageAttachment(att) && isHttpUrl(att.url)) {
      try {
        const downloaded = await downloadToTempFile(att.url, {
          timeout,
          maxSize,
          sourceFileName: att.filename,
          tempPrefix: "qqbot-inbound",
        });
        next.localImagePath = downloaded.path;
        logger.info(`inbound image cached: ${downloaded.path}`);
        scheduleTempCleanup(downloaded.path);
      } catch (err) {
        logger.warn(`failed to download inbound attachment: ${String(err)}`);
      }
    }

    if (isVoiceAttachment(att)) {
      hasVoiceAttachment = true;
      if (!qqCfg.asr?.enabled) {
        logger.info("voice attachment received but ASR is disabled");
      } else if (!asrCredentials) {
        logger.warn("voice ASR enabled but credentials are missing or invalid");
      } else if (!isHttpUrl(att.url)) {
        logger.warn("voice ASR skipped: attachment URL is not an HTTP URL");
      } else {
        try {
          const media = await fetchMediaFromUrl(att.url, {
            timeout,
            maxSize,
          });
          const transcript = await transcribeTencentFlash({
            audio: media.buffer,
            config: {
              appId: asrCredentials.appId,
              secretId: asrCredentials.secretId,
              secretKey: asrCredentials.secretKey,
              timeoutMs: timeout,
            },
          });
          if (transcript.trim()) {
            next.voiceTranscript = transcript.trim();
            hasVoiceTranscript = true;
            logger.info(
              `[voice-asr] transcript: ${next.voiceTranscript}${att.filename ? ` (file: ${att.filename})` : ""}`
            );
          }
        } catch (err) {
          if (err instanceof ASRError) {
            logger.warn(
              `voice ASR failed: kind=${err.kind} provider=${err.provider} retryable=${err.retryable} message=${err.message}`
            );
            asrErrorMessage ??= err.message.trim() || undefined;
          } else {
            logger.warn(`voice ASR failed: ${String(err)}`);
          }
        }
      }
    }
    resolved.push(next);
  }
  return {
    attachments: resolved,
    hasVoiceAttachment,
    hasVoiceTranscript,
    asrErrorMessage,
  };
}

function buildInboundContentWithAttachments(params: {
  content: string;
  attachments?: ResolvedInboundAttachment[];
}): string {
  const { content, attachments } = params;
  const list = attachments ?? [];
  if (list.length === 0) return content;

  const imageRefs = list
    .map((item) => item.localImagePath)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => `[Image: source: ${value}]`);

  const voiceTranscripts = list
    .filter((item) => typeof item.voiceTranscript === "string" && item.voiceTranscript.trim())
    .map((item, index) => {
      const filename = item.attachment.filename?.trim() || `voice-${index + 1}`;
      return `- ${filename}: ${item.voiceTranscript as string}`;
    });

  const lines = list.map((item, index) => {
    const att = item.attachment;
    const filename = att.filename?.trim() ? att.filename.trim() : `attachment-${index + 1}`;
    const meta = [att.contentType, typeof att.size === "number" ? `${att.size} bytes` : undefined]
      .filter((v): v is string => Boolean(v))
      .join(", ");
    const tail = item.localImagePath ? "[local image attached]" : att.url;
    return meta ? `- ${filename} (${meta}): ${tail}` : `- ${filename}: ${tail}`;
  });
  const block = ["[QQ attachments]", ...lines].join("\n");

  const parts: string[] = [];
  if (content) parts.push(content);
  if (imageRefs.length > 0) parts.push(imageRefs.join("\n"));
  if (voiceTranscripts.length > 0) {
    parts.push(["[QQ voice transcripts]", ...voiceTranscripts].join("\n"));
  }
  parts.push(block);
  return parts.join("\n\n");
}

function resolveInboundLogContent(params: {
  content: string;
  attachments?: QQInboundAttachment[];
}): string {
  const text = params.content.trim();
  if (text) return text;

  const attachments = params.attachments ?? [];
  if (attachments.some((att) => isVoiceAttachment(att))) {
    return "【语音】";
  }
  if (attachments.some((att) => isImageAttachment(att))) {
    return "【图片】";
  }
  if (attachments.length > 0) {
    return "【附件】";
  }
  return "【空消息】";
}

function sanitizeInboundLogText(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}

function parseC2CMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.user_openid);
  if ((!text && attachments.length === 0) || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    c2cOpenid: senderId,
    senderName: toString(author.username),
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    timestamp,
    mentionedBot: false,
  };
}

function parseGroupMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const groupOpenid = toString(payload.group_openid);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.member_openid);
  if ((!text && attachments.length === 0) || !id || !senderId || !groupOpenid) return null;

  return {
    type: "group",
    senderId,
    senderName: toString(author.nickname) ?? toString(author.username),
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    timestamp,
    groupOpenid,
    mentionedBot: true,
  };
}

function parseChannelMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const channelId = toString(payload.channel_id);
  const guildId = toString(payload.guild_id);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.id);
  if ((!text && attachments.length === 0) || !id || !senderId || !channelId) return null;

  return {
    type: "channel",
    senderId,
    senderName: toString(author.username),
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    timestamp,
    channelId,
    guildId,
    mentionedBot: true,
  };
}

function parseDirectMessage(data: unknown): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const guildId = toString(payload.guild_id);
  const author = (payload.author ?? {}) as Record<string, unknown>;
  const senderId = toString(author.id);
  if ((!text && attachments.length === 0) || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    senderName: toString(author.username),
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    timestamp,
    guildId,
    mentionedBot: false,
  };
}

function resolveInbound(eventType: string, data: unknown): QQInboundMessage | null {
  switch (eventType) {
    case "C2C_MESSAGE_CREATE":
      return parseC2CMessage(data);
    case "GROUP_AT_MESSAGE_CREATE":
      return parseGroupMessage(data);
    case "AT_MESSAGE_CREATE":
      return parseChannelMessage(data);
    case "DIRECT_MESSAGE_CREATE":
      return parseDirectMessage(data);
    default:
      return null;
  }
}

function resolveChatTarget(event: QQInboundMessage): { to: string; peerId: string; peerKind: "group" | "dm" } {
  if (event.type === "group") {
    const group = (event.groupOpenid ?? "").toLowerCase();
    return {
      to: `group:${group}`,
      peerId: `group:${group}`,
      peerKind: "group",
    };
  }
  if (event.type === "channel") {
    const channel = (event.channelId ?? "").toLowerCase();
    return {
      to: `channel:${channel}`,
      peerId: `channel:${channel}`,
      peerKind: "group",
    };
  }
  return {
    to: `user:${event.senderId}`,
    peerId: event.senderId,
    peerKind: "dm",
  };
}

function resolveEnvelopeFrom(event: QQInboundMessage): string {
  if (event.type === "group") {
    return `group:${(event.groupOpenid ?? "unknown").toLowerCase()}`;
  }
  if (event.type === "channel") {
    return `channel:${(event.channelId ?? "unknown").toLowerCase()}`;
  }
  return event.senderName?.trim() || event.senderId;
}

function extractLocalMediaFromText(params: {
  text: string;
  logger?: Logger;
}): { text: string; mediaUrls: string[] } {
  const { text, logger } = params;
  const result = extractMediaFromText(text, {
    removeFromText: true,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[media] local file not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: false,
    parseMarkdownImages: true,
    parseHtmlImages: false,
    parseBarePaths: true,
    parseMarkdownLinks: true,
  });

  const mediaUrls = result.all
    .filter((m) => m.isLocal && m.localPath)
    .map((m) => m.localPath as string);

  return { text: result.text, mediaUrls };
}

function extractMediaLinesFromText(params: {
  text: string;
  logger?: Logger;
}): { text: string; mediaUrls: string[] } {
  const { text, logger } = params;
  const result = extractMediaFromText(text, {
    removeFromText: true,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[media] local file not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: true,
    parseMarkdownImages: false,
    parseHtmlImages: false,
    parseBarePaths: false,
    parseMarkdownLinks: false,
  });

  const mediaUrls = result.all
    .map((m) => (m.isLocal ? m.localPath ?? m.source : m.source))
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0);

  return { text: result.text, mediaUrls };
}

function isOfficialQQFileSendLimit(errorMessage: string | undefined): boolean {
  const text = (errorMessage ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("file_type=4") ||
    text.includes("generic files") ||
    text.includes("not support generic files") ||
    text.includes("暂不支持通用文件")
  );
}

function buildMediaFallbackText(mediaUrl: string, errorMessage?: string): string {
  if (isOfficialQQFileSendLimit(errorMessage)) {
    return [
      "说明：根据 QQ 官方接口规范，当前 C2C/群聊暂不支持直接发送 PDF/文档等通用文件（file_type=4）。",
      "这属于平台限制，不是插件缺陷；图片等媒体仍可正常发送。",
      `已为你附上文件链接：${mediaUrl}`,
    ].join("\n");
  }
  return `📎 ${mediaUrl}`;
}

function buildInboundContext(params: {
  event: QQInboundMessage;
  sessionKey: string;
  accountId: string;
  body?: string;
  rawBody?: string;
  commandBody?: string;
}): InboundContext {
  const { event, sessionKey, accountId } = params;
  const body = params.body ?? event.content;
  const rawBody = params.rawBody ?? event.content;
  const commandBody = params.commandBody ?? event.content;
  const chatType = event.type === "group" || event.type === "channel" ? "group" : "direct";
  const { to } = resolveChatTarget(event);
  const from =
    event.type === "group"
      ? `qqbot:group:${event.groupOpenid ?? ""}`
      : event.type === "channel"
        ? `qqbot:channel:${event.channelId ?? ""}`
        : `qqbot:${event.senderId}`;

  return {
    Body: body,
    RawBody: rawBody,
    CommandBody: commandBody,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    GroupSubject: event.type === "group" ? event.groupOpenid : event.channelId,
    SenderName: event.senderName,
    SenderId: event.senderId,
    Provider: "qqbot",
    MessageSid: event.messageId,
    Timestamp: event.timestamp,
    WasMentioned: event.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "qqbot",
    OriginatingTo: to,
  };
}

async function dispatchToAgent(params: {
  inbound: QQInboundMessage;
  cfg: unknown;
  qqCfg: QQBotConfig;
  accountId: string;
  logger: Logger;
}): Promise<void> {
  const { inbound, cfg, qqCfg, accountId, logger } = params;
  const runtime = getQQBotRuntime();
  const routing = runtime.channel?.routing?.resolveAgentRoute;
  if (!routing) {
    logger.warn("routing API not available");
    return;
  }

  const target = resolveChatTarget(inbound);
  if (inbound.c2cOpenid) {
    const typing = await qqbotOutbound.sendTyping({
      cfg: { channels: { qqbot: qqCfg } },
      to: `user:${inbound.c2cOpenid}`,
      replyToId: inbound.messageId,
      inputSecond: 60,
    });
    if (typing.error) {
      logger.warn(`sendTyping failed: ${typing.error}`);
    }
  }
  const route = routing({
    cfg,
    channel: "qqbot",
    accountId,
    peer: { kind: target.peerKind, id: target.peerId },
  });

  const replyApi = runtime.channel?.reply;
  if (!replyApi) {
    logger.warn("reply API not available");
    return;
  }

  const sessionApi = runtime.channel?.session;
  const storePath = sessionApi?.resolveStorePath?.(
    (cfg as Record<string, unknown>)?.session?.store,
    { agentId: route.agentId }
  );

  const envelopeOptions = replyApi.resolveEnvelopeFormatOptions?.(cfg);
  const previousTimestamp =
    storePath && sessionApi?.readSessionUpdatedAt
      ? sessionApi.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey })
      : null;
  const resolvedAttachmentResult = await resolveInboundAttachmentsForAgent({
    attachments: inbound.attachments,
    qqCfg,
    logger,
  });
  if (
    qqCfg.asr?.enabled &&
    resolvedAttachmentResult.hasVoiceAttachment &&
    !resolvedAttachmentResult.hasVoiceTranscript
  ) {
    const fallback = await qqbotOutbound.sendText({
      cfg: { channels: { qqbot: qqCfg } },
      to: target.to,
      text: buildVoiceASRFallbackReply(resolvedAttachmentResult.asrErrorMessage),
      replyToId: inbound.messageId,
    });
    if (fallback.error) {
      logger.error(`sendText ASR fallback failed: ${fallback.error}`);
    }
    return;
  }
  const resolvedAttachments = resolvedAttachmentResult.attachments;
  const localImageCount = resolvedAttachments.filter((item) => Boolean(item.localImagePath)).length;
  if (localImageCount > 0) {
    logger.info(`prepared ${localImageCount} local image attachment(s) for agent`);
  }
  const rawBody = buildInboundContentWithAttachments({
    content: inbound.content,
    attachments: resolvedAttachments,
  });
  const envelopeFrom = resolveEnvelopeFrom(inbound);
  const inboundBody =
    replyApi.formatInboundEnvelope
      ? replyApi.formatInboundEnvelope({
          channel: "QQ",
          from: envelopeFrom,
          body: rawBody,
          timestamp: inbound.timestamp,
          previousTimestamp: previousTimestamp ?? undefined,
          chatType: inbound.type === "direct" ? "direct" : "group",
          senderLabel: inbound.senderName ?? inbound.senderId,
          sender: { id: inbound.senderId, name: inbound.senderName ?? undefined },
          envelope: envelopeOptions,
        })
      : replyApi.formatAgentEnvelope
        ? replyApi.formatAgentEnvelope({
            channel: "QQ",
            from: envelopeFrom,
            timestamp: inbound.timestamp,
            previousTimestamp: previousTimestamp ?? undefined,
            envelope: envelopeOptions,
            body: rawBody,
          })
        : rawBody;

  const inboundCtx = buildInboundContext({
    event: inbound,
    sessionKey: route.sessionKey,
    accountId: route.accountId ?? accountId,
    body: inboundBody,
    rawBody,
    commandBody: rawBody,
  });

  const finalizeInboundContext = replyApi?.finalizeInboundContext as
    | ((ctx: InboundContext) => InboundContext)
    | undefined;
  const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;

  let cronBase = "";
  if (typeof finalCtx.RawBody === "string" && finalCtx.RawBody) {
    cronBase = finalCtx.RawBody;
  } else if (typeof finalCtx.Body === "string" && finalCtx.Body) {
    cronBase = finalCtx.Body;
  } else if (typeof finalCtx.CommandBody === "string" && finalCtx.CommandBody) {
    cronBase = finalCtx.CommandBody;
  }

  if (cronBase) {
    const nextCron = appendCronHiddenPrompt(cronBase);
    if (nextCron !== cronBase) {
      finalCtx.BodyForAgent = nextCron;
    }
  }

  if (storePath && sessionApi?.recordInboundSession) {
    try {
      const mainSessionKeyRaw = (route as Record<string, unknown>)?.mainSessionKey;
      const mainSessionKey =
        typeof mainSessionKeyRaw === "string" && mainSessionKeyRaw.trim()
          ? mainSessionKeyRaw
          : undefined;
      const isGroup = inbound.type === "group" || inbound.type === "channel";
      const updateLastRoute =
        !isGroup
          ? {
              sessionKey: mainSessionKey ?? route.sessionKey,
              channel: "qqbot",
              to: (finalCtx.OriginatingTo ?? finalCtx.To ?? `user:${inbound.senderId}`) as string,
              accountId: route.accountId ?? accountId,
            }
          : undefined;

      const recordSessionKey =
        typeof finalCtx.SessionKey === "string" && finalCtx.SessionKey.trim()
          ? finalCtx.SessionKey
          : route.sessionKey;

      await sessionApi.recordInboundSession({
        storePath,
        sessionKey: recordSessionKey,
        ctx: finalCtx,
        updateLastRoute,
        onRecordError: (err: unknown) => {
          logger.warn(`failed to record inbound session: ${String(err)}`);
        },
      });
    } catch (err) {
      logger.warn(`failed to record inbound session: ${String(err)}`);
    }
  }

  const textApi = runtime.channel?.text;
  const limit =
    textApi?.resolveTextChunkLimit?.({
      cfg,
      channel: "qqbot",
      defaultLimit: qqCfg.textChunkLimit ?? 1500,
    }) ?? (qqCfg.textChunkLimit ?? 1500);

  const chunkMode = textApi?.resolveChunkMode?.(cfg, "qqbot");
  const tableMode = textApi?.resolveMarkdownTableMode?.({
    cfg,
    channel: "qqbot",
    accountId: route.accountId ?? accountId,
  });
  const resolvedTableMode = tableMode ?? "bullets";
  const chunkText = (text: string): string[] => {
    if (textApi?.chunkMarkdownText && limit > 0) {
      return textApi.chunkMarkdownText(text, limit);
    }
    if (textApi?.chunkTextWithMode && limit > 0) {
      return textApi.chunkTextWithMode(text, limit, chunkMode);
    }
    return [text];
  };

  const replyFinalOnly = qqCfg.replyFinalOnly ?? false;

  const deliver = async (payload: unknown, info?: { kind?: string }): Promise<void> => {
    if (replyFinalOnly && info?.kind && info.kind !== "final") return;
    const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] } | undefined;
    const rawText = typed?.text ?? "";
    const mediaLineResult = extractMediaLinesFromText({
      text: rawText,
      logger,
    });
    const localMediaResult = extractLocalMediaFromText({
      text: mediaLineResult.text,
      logger,
    });
    const trimmed = localMediaResult.text.trim();

    const payloadMediaUrls = Array.isArray(typed?.mediaUrls)
      ? typed?.mediaUrls
      : typed?.mediaUrl
        ? [typed.mediaUrl]
        : [];

    const mediaQueue: string[] = [];
    const seenMedia = new Set<string>();
    const addMedia = (value?: string) => {
      const next = value?.trim();
      if (!next) return;
      if (seenMedia.has(next)) return;
      seenMedia.add(next);
      mediaQueue.push(next);
    };

    for (const url of payloadMediaUrls) addMedia(url);
    for (const url of mediaLineResult.mediaUrls) addMedia(url);
    for (const url of localMediaResult.mediaUrls) addMedia(url);

    if (trimmed) {
      const converted = textApi?.convertMarkdownTables
        ? textApi.convertMarkdownTables(trimmed, resolvedTableMode)
        : trimmed;
      const chunks = chunkText(converted);
      for (const chunk of chunks) {
        const result = await qqbotOutbound.sendText({
          cfg: { channels: { qqbot: qqCfg } },
          to: target.to,
          text: chunk,
          replyToId: inbound.messageId,
        });
        if (result.error) {
          logger.error(`sendText failed: ${result.error}`);
        }
      }
    }

    for (const mediaUrl of mediaQueue) {
      const result = await qqbotOutbound.sendMedia({
        cfg: { channels: { qqbot: qqCfg } },
        to: target.to,
        mediaUrl,
        replyToId: inbound.messageId,
      });
      if (result.error) {
        logger.error(`sendMedia failed: ${result.error}`);
        const fallback = buildMediaFallbackText(mediaUrl, result.error);
        const fallbackResult = await qqbotOutbound.sendText({
          cfg: { channels: { qqbot: qqCfg } },
          to: target.to,
          text: fallback,
          replyToId: inbound.messageId,
        });
        if (fallbackResult.error) {
          logger.error(`sendText fallback failed: ${fallbackResult.error}`);
        }
      }
    }
  };

  const humanDelay = replyApi.resolveHumanDelayConfig?.(cfg, route.agentId);
  const dispatchBuffered = replyApi.dispatchReplyWithBufferedBlockDispatcher;
  if (dispatchBuffered) {
    await dispatchBuffered({
      ctx: finalCtx,
      cfg,
      dispatcherOptions: {
        deliver,
        humanDelay,
        onError: (err: unknown, info: { kind: string }) => {
          logger.error(`${info.kind} reply failed: ${String(err)}`);
        },
        onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
          if (info.reason !== "silent") {
            logger.info(`reply skipped: ${info.reason}`);
          }
        },
      },
    });
    return;
  }

  const dispatcherResult = replyApi.createReplyDispatcherWithTyping
    ? replyApi.createReplyDispatcherWithTyping({
        deliver,
        humanDelay,
        onError: (err: unknown, info: { kind: string }) => {
          logger.error(`${info.kind} reply failed: ${String(err)}`);
        },
      })
    : {
        dispatcher: replyApi.createReplyDispatcher?.({
          deliver,
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        }),
        replyOptions: {},
        markDispatchIdle: () => undefined,
      };

  if (!dispatcherResult.dispatcher || !replyApi.dispatchReplyFromConfig) {
    logger.warn("dispatcher not available, skipping reply");
    return;
  }

  await replyApi.dispatchReplyFromConfig({
    ctx: finalCtx,
    cfg,
    dispatcher: dispatcherResult.dispatcher,
    replyOptions: dispatcherResult.replyOptions,
  });

  dispatcherResult.markDispatchIdle?.();
}

function shouldHandleMessage(event: QQInboundMessage, qqCfg: QQBotConfig, logger: Logger): boolean {
  if (event.type === "direct") {
    const dmPolicy = qqCfg.dmPolicy ?? "open";
    const allowed = checkDmPolicy({
      dmPolicy,
      senderId: event.senderId,
      allowFrom: qqCfg.allowFrom ?? [],
    });
    if (!allowed.allowed) {
      logger.info(`dm blocked: ${allowed.reason ?? "policy"}`);
      return false;
    }
    return true;
  }

  const groupPolicy = qqCfg.groupPolicy ?? "open";
  const conversationId =
    event.type === "group"
      ? event.groupOpenid ?? ""
      : event.channelId ?? "";
  const allowed = checkGroupPolicy({
    groupPolicy,
    conversationId,
    groupAllowFrom: qqCfg.groupAllowFrom ?? [],
    requireMention: qqCfg.requireMention ?? true,
    mentionedBot: event.mentionedBot,
  });
  if (!allowed.allowed) {
    logger.info(`group blocked: ${allowed.reason ?? "policy"}`);
    return false;
  }
  return true;
}

export async function handleQQBotDispatch(params: DispatchParams): Promise<void> {
  const logger = params.logger ?? createLogger("qqbot");
  const inbound = resolveInbound(params.eventType, params.eventData);
  if (!inbound) {
    return;
  }

  const rawCfg = params.cfg?.channels?.qqbot;
  const parsedCfg = rawCfg ? QQBotConfigSchema.safeParse(rawCfg) : null;
  const qqCfg = parsedCfg?.success ? parsedCfg.data : rawCfg;
  if (!qqCfg) {
    logger.warn("qqbot config missing, ignoring inbound message");
    return;
  }
  if (!qqCfg.enabled) {
    logger.info("qqbot disabled, ignoring inbound message");
    return;
  }

  const content = inbound.content.trim();
  const inboundLogContent = sanitizeInboundLogText(
    resolveInboundLogContent({
      content,
      attachments: inbound.attachments,
    })
  );
  logger.info(`[inbound-user] senderId=${inbound.senderId} content=${inboundLogContent}`);

  if (!shouldHandleMessage(inbound, qqCfg, logger)) {
    return;
  }

  const attachmentCount = inbound.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    logger.info(`inbound message includes ${attachmentCount} attachment(s)`);
  }
  if (!content && attachmentCount === 0) {
    return;
  }

  await dispatchToAgent({
    inbound: { ...inbound, content },
    cfg: params.cfg,
    qqCfg,
    accountId: params.accountId,
    logger,
  });
}
