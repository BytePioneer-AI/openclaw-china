/**
 * 飞书消息处理
 *
 * 实现消息解析、策略检查和 Agent 分发
 */

import type { FeishuMessageEvent, FeishuMessageContext } from "./types.js";
import type { FeishuConfig } from "./config.js";
import { FeishuConfigSchema } from "./config.js";
import { getFeishuRuntime, isFeishuRuntimeInitialized } from "./runtime.js";
import {
  sendFileFeishu,
  sendImageFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  processLocalImagesInMarkdown,
} from "./send.js";
import { createLogger, type Logger } from "./logger.js";
import {
  checkDmPolicy,
  checkGroupPolicy,
  extractFilesFromText,
  extractMediaFromText,
  isImagePath,
  appendCronHiddenPrompt,
} from "@xuanyue202/shared";
import * as fs from "node:fs";

/**
 * 解析飞书消息事件为标准化上下文
 */
export function parseFeishuMessageEvent(event: FeishuMessageEvent): FeishuMessageContext {
  const message = event.message ?? {};
  const sender = event.sender?.sender_id ?? {};

  const chatType = message.chat_type === "group" ? "group" : "direct";
  const senderId = sender.open_id ?? sender.user_id ?? sender.union_id ?? "";
  const messageId = message.message_id ?? `${message.chat_id ?? ""}_${Date.now()}`;
  const contentType = message.message_type ?? "";

  let content = "";
  if (contentType === "text" && message.content) {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      content = (parsed.text ?? "").trim();
    } catch {
      content = message.content.trim();
    }
  }

  const mentions = message.mentions ?? [];
  const mentionedBot = mentions.length > 0;

  return {
    chatId: message.chat_id ?? "",
    messageId,
    senderId,
    chatType,
    content,
    contentType,
    mentionedBot,
  };
}

/**
 * 从文本中提取行首 MEDIA: 指令（支持 file:// / 绝对路径 / URL）
 * 使用 shared 模块的 extractMediaFromText 实现
 */
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
        logger?.warn?.(`[feishu] local media not found: ${p}`);
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

/**
 * 入站消息上下文
 */
export interface InboundContext {
  Body: string;
  RawBody: string;
  CommandBody: string;
  BodyForAgent?: string;
  BodyForCommands?: string;
  From: string;
  To: string;
  SessionKey: string;
  AccountId: string;
  ChatType: "direct" | "group";
  GroupSubject?: string;
  SenderName?: string;
  SenderId: string;
  Provider: "feishu";
  MessageSid: string;
  Timestamp: number;
  WasMentioned: boolean;
  CommandAuthorized: boolean;
  OriginatingChannel: "feishu-china";
  OriginatingTo: string;
}

/**
 * 构建入站消息上下文
 */
export function buildInboundContext(
  ctx: FeishuMessageContext,
  sessionKey: string,
  accountId: string
): InboundContext {
  const isGroup = ctx.chatType === "group";

  const from = isGroup
    ? `feishu:group:${ctx.chatId}`
    : `feishu:${ctx.senderId}`;
  const to = isGroup
    ? `chat:${ctx.chatId}`
    : `user:${ctx.senderId}`;

  return {
    Body: ctx.content,
    RawBody: ctx.content,
    CommandBody: ctx.content,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: ctx.chatType,
    GroupSubject: isGroup ? ctx.chatId : undefined,
    SenderName: ctx.senderId,
    SenderId: ctx.senderId,
    Provider: "feishu",
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "feishu-china",
    OriginatingTo: to,
  };
}

/**
 * 处理飞书入站消息
 */
export async function handleFeishuMessage(params: {
  cfg: unknown;
  event: FeishuMessageEvent;
  accountId?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, event, accountId = "default" } = params;

  const logger: Logger = createLogger("feishu", {
    log: params.log,
    error: params.error,
  });
  const receivedAt = Date.now();
  logger.info?.(`[trace] inbound received_at=${new Date(receivedAt).toISOString()}`);

  const ctx = parseFeishuMessageEvent(event);
  const isGroup = ctx.chatType === "group";

  if (!ctx.content || ctx.contentType !== "text") {
    logger.debug("unsupported message type or empty content, skipping");
    return;
  }

  const feishuCfg = (cfg as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  const rawChannelCfg = feishuCfg?.["feishu-china"] as FeishuConfig | undefined;
  const parsedCfg = rawChannelCfg ? FeishuConfigSchema.safeParse(rawChannelCfg) : null;
  if (parsedCfg && !parsedCfg.success) {
    logger.warn(`invalid feishu config, using raw values: ${parsedCfg.error.message}`);
  }
  const channelCfg = parsedCfg?.success ? parsedCfg.data : rawChannelCfg;
  logger.debug(
    `config snapshot: channels.feishu-china=${channelCfg ? "present" : "missing"}, sendMarkdownAsCard=${
      channelCfg?.sendMarkdownAsCard ?? "undefined"
    }`
  );

  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "open";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;

    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.chatId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicy = channelCfg?.dmPolicy ?? "open";
    const allowFrom = channelCfg?.allowFrom ?? [];

    const policyResult = checkDmPolicy({
      dmPolicy,
      senderId: ctx.senderId,
      allowFrom,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }

  if (!isFeishuRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }

  try {
    const core = getFeishuRuntime();

    if (!core.channel?.routing?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }

    if (
      !core.channel?.reply?.dispatchReplyFromConfig &&
      !core.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher
    ) {
      logger.debug("core.channel.reply dispatcher not available, skipping dispatch");
      return;
    }

    if (!core.channel?.reply?.createReplyDispatcher && !core.channel?.reply?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu-china",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.chatId : ctx.senderId,
      },
    });

    const inboundCtx = buildInboundContext(ctx, route.sessionKey, route.accountId);

    const finalCtx = core.channel.reply.finalizeInboundContext
      ? core.channel.reply.finalizeInboundContext(inboundCtx)
      : inboundCtx;

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

    if (!channelCfg) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    const textApi = core.channel?.text;

    const textChunkLimit =
      textApi?.resolveTextChunkLimit?.({
        cfg,
        channel: "feishu-china",
        defaultLimit: channelCfg.textChunkLimit ?? 4000,
      }) ?? (channelCfg.textChunkLimit ?? 4000);
    const chunkMode = textApi?.resolveChunkMode?.(cfg, "feishu-china");

    const replyFinalOnly = channelCfg.replyFinalOnly !== false;
    const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);
    const isFeishuImageKey = (value: string): boolean => /^img_v\d+_/i.test(value.trim());

    const sendTextFeishu = async (text: string): Promise<void> => {
      if (channelCfg.sendMarkdownAsCard) {
        await sendMarkdownCardFeishu({
          cfg: channelCfg,
          to: ctx.chatId,
          text,
          receiveIdType: "chat_id",
        });
      } else {
        await sendMessageFeishu({
          cfg: channelCfg,
          to: ctx.chatId,
          text,
          receiveIdType: "chat_id",
        });
      }
    };

    const sendMediaWithFallback = async (mediaUrl: string): Promise<boolean> => {
      try {
        const sendAsImage = isFeishuImageKey(mediaUrl)
          ? true
          : isHttpUrl(mediaUrl)
            ? isImagePath(new URL(mediaUrl).pathname)
            : isImagePath(mediaUrl);
        if (sendAsImage) {
          await sendImageFeishu({
            cfg: channelCfg,
            to: ctx.chatId,
            mediaUrl,
            receiveIdType: "chat_id",
          });
        } else {
          await sendFileFeishu({
            cfg: channelCfg,
            to: ctx.chatId,
            mediaUrl,
            receiveIdType: "chat_id",
          });
        }
        return true;
      } catch (err) {
        logger.error?.(`[feishu] sendMedia failed: ${String(err)}`);
        await sendTextFeishu(`📎 ${mediaUrl}`);
        return true;
      }
    };

    const deliver = async (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
      info?: { kind?: string }
    ): Promise<boolean> => {
      if (replyFinalOnly && (!info || info.kind !== "final")) {
        return false;
      }
      const rawText = payload.text ?? "";
      const { text: textWithoutMediaLines, mediaUrls: mediaFromLines } = extractMediaLinesFromText({
        text: rawText,
        logger,
      });

      const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const mediaQueue: string[] = [];
      const seenMedia = new Set<string>();
      const addMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (seenMedia.has(trimmed)) return;
        seenMedia.add(trimmed);
        mediaQueue.push(trimmed);
      };
      for (const url of payloadMediaUrls) addMedia(url);
      for (const url of mediaFromLines) addMedia(url);

      let sent = false;
      const replyKind = info?.kind ?? "unknown";
      const deliverAt = Date.now();
      logger.info?.(
        `[trace] deliver_start=${new Date(deliverAt).toISOString()} (+${deliverAt - receivedAt}ms)`
      );

      const chunks =
        textApi?.chunkTextWithMode && typeof textChunkLimit === "number" && textChunkLimit > 0
          ? textApi.chunkTextWithMode(textWithoutMediaLines, textChunkLimit, chunkMode)
          : [textWithoutMediaLines];

      const localFilesSet = new Set<string>();
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;

        const processedChunk = await processLocalImagesInMarkdown(channelCfg, chunk);
        const { text: cleanedChunk, files } = extractFilesFromText(processedChunk, {
          removeFromText: true,
          checkExists: false,
          parseBarePaths: true,
          parseMarkdownLinks: true,
        });

        const localFiles = files
          .filter((f) => f.isLocal && f.localPath && !isImagePath(f.localPath))
          .map((f) => f.localPath as string)
          .filter((p) => {
            if (fs.existsSync(p)) return true;
            logger.warn?.(`[feishu] local file not found: ${p}`);
            return false;
          });
        for (const filePath of localFiles) {
          localFilesSet.add(filePath);
        }

        logger.debug(
          `send reply via ${
            channelCfg.sendMarkdownAsCard ? "interactive markdown card" : "text message"
          } (receive_id_type=chat_id, chunk_len=${cleanedChunk.length}, local_files=${localFiles.length}, kind=${replyKind})`
        );
        await sendTextFeishu(cleanedChunk);
        sent = true;
        const sentAt = Date.now();
        logger.info?.(
          `[trace] deliver_sent=${new Date(sentAt).toISOString()} (+${sentAt - receivedAt}ms)`
        );
      }

      if (localFilesSet.size > 0) {
        for (const filePath of localFilesSet) {
          addMedia(filePath);
        }
      }

      for (const mediaUrl of mediaQueue) {
        const didSend = await sendMediaWithFallback(mediaUrl);
        if (didSend) {
          sent = true;
        }
      }

      if (!sent && mediaQueue.length === 0) {
        return false;
      }
      return sent;
    };

    const humanDelay = core.channel.reply.resolveHumanDelayConfig
      ? core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId)
      : undefined;

    const dispatchReplyWithBufferedBlockDispatcher = core.channel.reply
      ?.dispatchReplyWithBufferedBlockDispatcher as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (dispatchReplyWithBufferedBlockDispatcher) {
      logger.debug(`dispatching to agent (buffered, session=${route.sessionKey})`);
      const deliveryState = { delivered: false, skippedNonSilent: 0 };
      const buffered = {
        lastText: "",
        mediaUrls: [] as string[],
        hasPayload: false,
      };
      const addBufferedMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (buffered.mediaUrls.includes(trimmed)) return;
        buffered.mediaUrls.push(trimmed);
      };

      const result = await dispatchReplyWithBufferedBlockDispatcher({
        ctx: finalCtx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            if (!replyFinalOnly) {
              const didSend = await deliver(
                payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                info
              );
              if (didSend) {
                deliveryState.delivered = true;
              }
              return;
            }

            if (!info || info.kind !== "final") {
              return;
            }

            const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] };
            buffered.hasPayload = true;
            if (typeof typed.text === "string" && typed.text.trim()) {
              buffered.lastText = typed.text;
            }
            if (Array.isArray(typed.mediaUrls)) {
              for (const url of typed.mediaUrls) addBufferedMedia(url);
            } else if (typed.mediaUrl) {
              addBufferedMedia(typed.mediaUrl);
            }
          },
          humanDelay,
          onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
            if (info.reason !== "silent") {
              deliveryState.skippedNonSilent += 1;
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        },
      });

      if (buffered.hasPayload) {
        const didSend = await deliver(
          {
            text: buffered.lastText,
            mediaUrls: buffered.mediaUrls.length ? buffered.mediaUrls : undefined,
          },
          { kind: "final" }
        );
        if (didSend) {
          deliveryState.delivered = true;
        }
      }

      if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
        await sendTextFeishu("No response generated. Please try again.");
      }

      const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
      const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
      const dispatchDoneAt = Date.now();
      logger.debug(
        `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0}, +${dispatchDoneAt - receivedAt}ms)`
      );
      return;
    }

    const dispatcherResult = core.channel.reply.createReplyDispatcherWithTyping
      ? core.channel.reply.createReplyDispatcherWithTyping({
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info);
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: core.channel.reply.createReplyDispatcher?.({
            deliver: async (payload: unknown, info?: { kind?: string }) => {
              await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info);
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    if (!dispatcherResult.dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(`dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher: dispatcherResult.dispatcher,
      replyOptions: dispatcherResult.replyOptions,
    });

    dispatcherResult.markDispatchIdle?.();

    const dispatchDoneAt = Date.now();
    logger.debug(
      `dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final}, +${dispatchDoneAt - receivedAt}ms)`
    );
  } catch (err) {
    logger.error(`failed to dispatch message: ${String(err)}`);
  }
}
