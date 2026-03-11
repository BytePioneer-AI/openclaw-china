import { TOPIC_ROBOT, type DWClient, type DWClientDownStream } from "dingtalk-stream";
import { handleDingtalkMessage } from "./bot-handler.js";
import {
  mergeDingtalkAccountConfig,
  type PluginConfig,
} from "./config.js";
import type { Logger } from "./logger.js";
import type { DingtalkRawMessage } from "./types.js";

export interface RegisterDingtalkBotHandlerParams {
  client: DWClient;
  config?: PluginConfig;
  accountId: string;
  logger: Logger;
  onMessageAccepted?: () => void;
  onDedupeHit?: (streamMessageId: string) => void;
  onAckError?: (err: unknown, streamMessageId?: string) => void;
  onParseError?: (err: unknown) => void;
}

const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL_MS = 60_000;
const MESSAGE_DEDUP_MAX_ENTRIES = 10_000;

function trimMessageDedupeCache(now: number): void {
  for (const [messageId, timestamp] of processedMessages) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) {
      processedMessages.delete(messageId);
    }
  }

  while (processedMessages.size > MESSAGE_DEDUP_MAX_ENTRIES) {
    const oldest = processedMessages.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    processedMessages.delete(oldest);
  }
}

function isDuplicateMessage(messageKey: string, now: number): boolean {
  const previous = processedMessages.get(messageKey);
  if (typeof previous === "number" && now - previous < MESSAGE_DEDUP_TTL_MS) {
    return true;
  }
  if (typeof previous === "number") {
    processedMessages.delete(messageKey);
  }
  processedMessages.set(messageKey, now);
  trimMessageDedupeCache(now);
  return false;
}

function parseContentPreview(rawMessage: DingtalkRawMessage): string {
  if (rawMessage.msgtype === "text" && rawMessage.text?.content) {
    return rawMessage.text.content.trim();
  }

  if (!rawMessage.content) {
    return "";
  }

  const contentObj =
    typeof rawMessage.content === "string"
      ? (() => {
          try {
            return JSON.parse(rawMessage.content) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : (rawMessage.content as Record<string, unknown>);

  if (!contentObj) {
    return "";
  }

  const recognition = contentObj.recognition;
  if (typeof recognition === "string") {
    return recognition.trim();
  }
  return "";
}

function parseRawMessage(payload: string, streamMessageId?: string): DingtalkRawMessage {
  const parsed = JSON.parse(payload) as DingtalkRawMessage;
  if (streamMessageId) {
    parsed.streamMessageId = streamMessageId;
  }
  return parsed;
}

function processDingtalkInbound(params: {
  payload: DWClientDownStream;
  client: DWClient;
  config?: PluginConfig;
  dingtalkCfg?: DingtalkConfig;
  accountId: string;
  logger: Logger;
  onMessageAccepted?: () => void;
  onDedupeHit?: (streamMessageId: string) => void;
  onAckError?: (err: unknown, streamMessageId?: string) => void;
  onParseError?: (err: unknown) => void;
}): void {
  const {
    payload,
    client,
    config,
    dingtalkCfg,
    accountId,
    logger,
    onMessageAccepted,
    onDedupeHit,
    onAckError,
    onParseError,
  } = params;
  const streamMessageId = payload?.headers?.messageId;
  const dedupeKey = streamMessageId ? `${accountId}:${streamMessageId}` : undefined;

  if (streamMessageId) {
    try {
      client.socketCallBackResponse(streamMessageId, { success: true });
    } catch (err) {
      onAckError?.(err, streamMessageId);
      logger.error(`failed to ACK message ${streamMessageId}: ${String(err)}`);
    }
  }

  if (dedupeKey && isDuplicateMessage(dedupeKey, Date.now())) {
    onDedupeHit?.(streamMessageId);
    logger.debug(`duplicate message ignored: ${streamMessageId}`);
    return;
  }

  try {
    const rawMessage = parseRawMessage(payload.data, streamMessageId);
    const senderName = rawMessage.senderNick ?? rawMessage.senderId;
    const contentText = parseContentPreview(rawMessage);
    const textPreview = contentText.slice(0, 50);
    logger.info(
      `Inbound: from=${senderName} text="${textPreview}${contentText.length > 50 ? "..." : ""}"`,
    );

    onMessageAccepted?.();
    void handleDingtalkMessage({
      cfg: config,
      raw: rawMessage,
      accountId,
      log: (msg: string) => logger.info(msg.replace(/^\[dingtalk\]\s*/, "")),
      error: (msg: string) => logger.error(msg.replace(/^\[dingtalk\]\s*/, "")),
      enableAICard: dingtalkCfg?.enableAICard ?? false,
    }).catch((err) => {
      logger.error(`error handling message: ${String(err)}`);
    });
  } catch (err) {
    onParseError?.(err);
    logger.error(`error parsing message: ${String(err)}`);
  }
}

export function registerDingtalkBotHandler(params: RegisterDingtalkBotHandlerParams): void {
  const dingtalkCfg = params.config
    ? mergeDingtalkAccountConfig(params.config, params.accountId)
    : undefined;
  params.client.registerCallbackListener(TOPIC_ROBOT, (payload) => {
    processDingtalkInbound({
      payload,
      client: params.client,
      config: params.config,
      dingtalkCfg,
      accountId: params.accountId,
      logger: params.logger,
      onMessageAccepted: params.onMessageAccepted,
      onDedupeHit: params.onDedupeHit,
      onAckError: params.onAckError,
      onParseError: params.onParseError,
    });
  });
}

export function clearDingtalkMessageDedupeCache(): void {
  processedMessages.clear();
}
