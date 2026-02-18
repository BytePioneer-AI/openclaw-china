/**
 * 钉钉消息处理
 *
 * 实现消息解析、策略检查和 Agent 分发
 */

import type { DingtalkRawMessage, DingtalkMessageContext } from "./types.js";
import {
  type DingtalkConfig,
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
  resolveInboundMediaTempDir,
} from "./config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDingtalkRuntime, isDingtalkRuntimeInitialized } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
import {
  sendMediaDingtalk,
  extractFileFromMessage,
  downloadDingTalkFile,
  parseRichTextMessage,
  downloadRichTextImages,
  type DownloadedFile,
  type ExtractedFileInfo,
  type MediaMsgType,
} from "./media.js";
import { getAccessToken } from "./client.js";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import {
  createLogger,
  type Logger,
  checkDmPolicy,
  checkGroupPolicy,
  resolveFileCategory,
  extractMediaFromText,
  normalizeLocalPath,
  isImagePath,
  appendCronHiddenPrompt,
  splitCronHiddenPrompt,
  finalizeInboundMediaFile,
  pruneInboundMediaDir,
} from "@openclaw-china/shared";

function buildGatewayUserContent(inboundCtx: InboundContext, logger: Logger): string {
  const base = inboundCtx.CommandBody ?? inboundCtx.Body ?? "";
  const { base: baseText, prompt } = splitCronHiddenPrompt(base);
  const rawPaths: string[] = [];

  if (typeof inboundCtx.MediaPath === "string") {
    rawPaths.push(inboundCtx.MediaPath);
  }
  if (Array.isArray(inboundCtx.MediaPaths)) {
    rawPaths.push(...inboundCtx.MediaPaths);
  }

  const files = new Set<string>();
  for (const raw of rawPaths) {
    const localPath = normalizeLocalPath(raw);
    if (!localPath) continue;
    if (isImagePath(localPath)) continue;
    if (!fs.existsSync(localPath)) {
      logger.warn(`[gateway] local file not found: ${localPath}`);
      continue;
    }
    files.add(localPath);
  }

  if (files.size === 0) {
    return prompt ? `${baseText}\n\n${prompt}` : baseText;
  }

  const list = Array.from(files).map((p) => `- ${p}`).join("\n");
  const content = `${baseText}\n\n[local files]\n${list}`;
  return prompt ? `${content}\n\n${prompt}` : content;
}

/**
 * 从文本中提取本地媒体路径（图片/文件），但不修改原始文本
 */
function extractLocalMediaFromText(params: {
  text: string;
  logger?: Logger;
}): { mediaUrls: string[] } {
  const { text, logger } = params;

  const result = extractMediaFromText(text, {
    removeFromText: false,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[stream] local media not found: ${p}`);
      }
      return exists;
    },
    parseMediaLines: false,
    parseMarkdownImages: true,
    parseHtmlImages: false, // 钉钉不支持 HTML
    parseBarePaths: true,
    parseMarkdownLinks: true,
  });

  const mediaUrls = result.all
    .filter((m) => m.isLocal && m.localPath)
    .map((m) => m.localPath as string);

  return { mediaUrls };
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
    removeFromText: false,
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        logger?.warn?.(`[stream] local media not found: ${p}`);
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

function resolveAudioRecognition(raw: DingtalkRawMessage): string | undefined {
  if (raw.msgtype !== "audio") return undefined;
  if (!raw.content) return undefined;

  const contentObj =
    typeof raw.content === "string"
      ? (() => {
          try {
            return JSON.parse(raw.content);
          } catch {
            return null;
          }
        })()
      : raw.content;

  if (!contentObj || typeof contentObj !== "object") return undefined;

  const recognition = (contentObj as Record<string, unknown>).recognition;
  if (typeof recognition !== "string") return undefined;
  const trimmed = recognition.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveGatewayAuthFromConfigFile(logger: Logger): string | undefined {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const home = os.homedir();
    const candidates = [
      path.join(home, ".openclaw", "openclaw.json"),
      path.join(home, ".openclaw", "config.json"),
    ];
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf8");
      const cleaned = raw.replace(/^\uFEFF/, "").trim();
      const cfg = JSON.parse(cleaned) as Record<string, unknown>;
      const gateway = (cfg.gateway as Record<string, unknown> | undefined) ?? {};
      const auth = (gateway.auth as Record<string, unknown> | undefined) ?? {};
      const mode = typeof auth.mode === "string" ? auth.mode : "";
      const token = typeof auth.token === "string" ? auth.token : "";
      const password = typeof auth.password === "string" ? auth.password : "";
      if (mode === "token" && token) return token;
      if (mode === "password" && password) return password;
      if (token) return token;
      if (password) return password;
    }
  } catch (err) {
    logger.debug(`[gateway] failed to read openclaw config: ${String(err)}`);
  }
  return undefined;
}

function resolveGatewayRequestParams(
  runtime: unknown,
  dingtalkCfg: DingtalkConfig,
  logger: Logger
): { gatewayUrl: string; headers: Record<string, string> } {
  const runtimeRecord = runtime as Record<string, unknown>;
  const gateway = runtimeRecord?.gateway as Record<string, unknown> | undefined;
  const gatewayPort = typeof gateway?.port === "number" ? gateway.port : 18789;
  const gatewayUrl =
    typeof gateway?.url === "string"
      ? gateway.url
      : `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
  const authToken =
    dingtalkCfg.gatewayToken ??
    dingtalkCfg.gatewayPassword ??
    (gateway?.auth as Record<string, unknown> | undefined)?.token ??
    (gateway as Record<string, unknown> | undefined)?.authToken ??
    (gateway as Record<string, unknown> | undefined)?.token ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    resolveGatewayAuthFromConfigFile(logger);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (typeof authToken === "string" && authToken.trim()) {
    headers["Authorization"] = `Bearer ${authToken}`;
  } else {
    logger.warn("[gateway] auth token not found; request may be rejected");
  }

  return { gatewayUrl, headers };
}

async function* streamFromGateway(params: {
  runtime: unknown;
  sessionKey: string;
  userContent: string;
  logger: Logger;
  dingtalkCfg: DingtalkConfig;
  abortSignal?: AbortSignal;
}): AsyncGenerator<string, void, unknown> {
  const { runtime, sessionKey, userContent, logger, dingtalkCfg, abortSignal } = params;
  const { gatewayUrl, headers } = resolveGatewayRequestParams(runtime, dingtalkCfg, logger);

  logger.debug(`[gateway] streaming via ${gatewayUrl}, session=${sessionKey}`);

  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: userContent }],
      stream: true,
      user: sessionKey,
    }),
    signal: abortSignal,
  });

  if (!response.ok || !response.body) {
    const errText = response.body ? await response.text() : "(no body)";
    throw new Error(`Gateway error: ${response.status} - ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastChunkTime: number | null = null; // 初始为 null，第一个 chunk 不检测
  const TASK_BOUNDARY_THRESHOLD_MS = 1000; // 超过1秒认为是任务边界

  while (true) {
    const { done: readDone, value } = await reader.read();
    if (readDone) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
        const choice = chunk?.choices?.[0];
        const content = choice?.delta?.content;

        if (typeof content === "string" && content) {
          const now = Date.now();

          // 检测时间间隔，判断是否为任务边界（跳过第一个 chunk）
            if (lastChunkTime !== null) {
              const timeSinceLastChunk = now - lastChunkTime;
              if (timeSinceLastChunk > TASK_BOUNDARY_THRESHOLD_MS) {
                yield "\n\n---\n\n"; 
              }
            }

          yield content;
          lastChunkTime = now;
        }
      } catch {
        continue;
      }
    }
  }
}

/**
 * 解析钉钉原始消息为标准化的消息上下文
 * 
 * @param raw 钉钉原始消息对象
 * @returns 解析后的消息上下�?
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export function parseDingtalkMessage(raw: DingtalkRawMessage): DingtalkMessageContext {
  // 根据 conversationType 判断聊天类型
  // "1" = 单聊 (direct), "2" = 群聊 (group)
  const chatType = raw.conversationType === "2" ? "group" : "direct";
  
  // 提取消息内容
  let content = "";
  
  if (raw.msgtype === "text" && raw.text?.content) {
    // 文本消息：提�?text.content
    content = raw.text.content.trim();
  } else if (raw.msgtype === "audio") {
    // 音频消息：提取语音识别文�?content.recognition
    const recognition = resolveAudioRecognition(raw);
    if (recognition) {
      content = recognition;
    }
  }
  
  // 检查是�?@提及了机器人
  const mentionedBot = resolveMentionedBot(raw);
  
  // 使用 Stream 消息 ID（如果可用），确保去重稳�?
  const messageId = raw.streamMessageId ?? `${raw.conversationId}_${Date.now()}`;
  
  const senderId =
    raw.senderStaffId ??
    raw.senderUserId ??
    raw.senderUserid ??
    raw.senderId;

  return {
    conversationId: raw.conversationId,
    messageId,
    senderId,
    senderNick: raw.senderNick,
    chatType,
    content,
    contentType: raw.msgtype,
    mentionedBot,
    robotCode: raw.robotCode,
  };
}

/**
 * 判断是否 @提及了机器人
 *
 * 钉钉群聊机器人只有被 @ 才会收到消息，因此只要 atUsers 数组非空，
 * 就认为机器人被提及。不需要检查 robotCode 是否在 atUsers 中，
 * 因为钉钉 Stream SDK 只会将 @ 机器人的消息推送给机器人。
 */
function resolveMentionedBot(raw: DingtalkRawMessage): boolean {
  const atUsers = raw.atUsers ?? [];
  return atUsers.length > 0;
}

/**
 * 入站消息上下�?
 * 用于传递给 Moltbot 核心的标准化上下�?
 */
export interface InboundContext {
  /** 消息正文 */
  Body: string;
  /** 原始消息正文 */
  RawBody: string;
  /** 命令正文 */
  CommandBody: string;
  /** 发送给 LLM 的正文（可选覆盖） */
  BodyForAgent?: string;
  /** 用于命令解析的正文（可选覆盖） */
  BodyForCommands?: string;
  /** 发送方标识 */
  From: string;
  /** 接收方标�?*/
  To: string;
  /** 会话�?*/
  SessionKey: string;
  /** 账户 ID */
  AccountId: string;
  /** 聊天类型 */
  ChatType: "direct" | "group";
  /** 群组主题（群聊时�?*/
  GroupSubject?: string;
  /** 发送者名�?*/
  SenderName?: string;
  /** 发送�?ID */
  SenderId: string;
  /** 渠道提供�?*/
  Provider: "dingtalk";
  /** 消息 ID */
  MessageSid: string;
  /** 时间�?*/
  Timestamp: number;
  /** 是否�?@提及 */
  WasMentioned: boolean;
  /** 命令是否已授�?*/
  CommandAuthorized: boolean;
  /** 原始渠道 */
  OriginatingChannel: "dingtalk";
  /** 原始接收�?*/
  OriginatingTo: string;
  /** 钉钉会话 ID（群聊/单聊） */
  ConversationId?: string;
  /** 钉钉用户 ID */
  UserId?: string;
  /** 群 ID（仅群聊） */
  GroupId?: string;
  
  // ===== 媒体相关字段 (Requirements 7.1-7.8) =====
  
  /** 单个媒体文件的本地绝对路�?*/
  MediaPath?: string;
  /** 单个媒体文件�?MIME 类型 (�?"image/jpeg") */
  MediaType?: string;
  /** 多个媒体文件的本地绝对路径数�?(用于 richText 消息) */
  MediaPaths?: string[];
  /** 多个媒体文件�?MIME 类型数组 (用于 richText 消息) */
  MediaTypes?: string[];
  /** 原始文件�?(用于 file 消息) */
  FileName?: string;
  /** 文件大小（字节）(用于 file 消息) */
  FileSize?: number;
  /** 语音识别文本 (用于 audio 消息) */
  Transcript?: string;
}

/**
 * 构建入站消息上下�?
 * 
 * @param ctx 解析后的消息上下�?
 * @param sessionKey 会话�?
 * @param accountId 账户 ID
 * @returns 入站消息上下�?
 * 
 * Requirements: 6.4
 */
export function buildInboundContext(
  ctx: DingtalkMessageContext,
  sessionKey: string,
  accountId: string,
): InboundContext {
  const isGroup = ctx.chatType === "group";
  
  // 构建 From �?To 标识
  const from = isGroup
    ? `dingtalk:group:${ctx.conversationId}`
    : `dingtalk:${ctx.senderId}`;
  const to = isGroup
    ? `chat:${ctx.conversationId}`
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
    GroupSubject: isGroup ? ctx.conversationId : undefined,
    SenderName: ctx.senderNick,
    SenderId: ctx.senderId,
    UserId: ctx.senderId,
    ConversationId: ctx.conversationId,
    GroupId: isGroup ? ctx.conversationId : undefined,
    Provider: "dingtalk",
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  };
}

function buildTargetMeta(
  ctx: DingtalkMessageContext,
  inboundCtx?: Pick<InboundContext, "From" | "To">
): Record<string, unknown> {
  const isGroup = ctx.chatType === "group";
  const from = isGroup
    ? `dingtalk:group:${ctx.conversationId}`
    : `dingtalk:${ctx.senderId}`;
  const to = isGroup
    ? `chat:${ctx.conversationId}`
    : `user:${ctx.senderId}`;

  return {
    chatType: ctx.chatType,
    senderId: ctx.senderId,
    userId: ctx.senderId,
    conversationId: ctx.conversationId,
    groupId: isGroup ? ctx.conversationId : undefined,
    targetId: isGroup ? ctx.conversationId : ctx.senderId,
    from: inboundCtx?.From ?? from,
    to: inboundCtx?.To ?? to,
    messageId: ctx.messageId,
  };
}

/**
 * 处理 AI Card 流式响应
 * 
 * 通过 Moltbot 核心 API 获取 LLM 响应，并流式更新 AI Card
 * 仅支持 gateway-sse (HTTP SSE) 流式输出
 * 
 * @param params 处理参数
 * @returns Promise<void>
 */
async function handleAICardStreaming(params: {
  card: AICardInstance;
  cfg: unknown;
  route: { sessionKey: string; accountId: string; agentId?: string };
  inboundCtx: InboundContext;
  dingtalkCfg: DingtalkConfig;
  targetId: string;
  chatType: "direct" | "group";
  logger: Logger;
  }): Promise<void> {
    const { card, cfg, route, inboundCtx, dingtalkCfg, targetId, chatType, logger } = params;
    let accumulated = "";
    const streamStartAt = Date.now();
    const streamStartIso = new Date(streamStartAt).toISOString();
    let firstChunkAt: number | null = null;
    let chunkCount = 0;

  try {
    const core = getDingtalkRuntime();
    let lastUpdateTime = 0;
    const updateInterval = 100; // 最小更新间隔 ms
    const firstFrameContent = " ";
    let firstFrameSent = false;

    try {
      await streamAICard(card, firstFrameContent, false, (msg) => logger.debug(msg));
      firstFrameSent = true;
      lastUpdateTime = Date.now();
    } catch (err) {
      logger.debug(`failed to send first frame: ${String(err)}`);
    }

    // 根据配置选择流式源
    const gatewayUserContent = buildGatewayUserContent(inboundCtx, logger);
    for await (const chunk of streamFromGateway({
      runtime: core,
      sessionKey: route.sessionKey,
      userContent: gatewayUserContent,
      logger,
      dingtalkCfg,
    })) {
      accumulated += chunk;
      chunkCount += 1;
      if (!firstChunkAt) {
        firstChunkAt = Date.now();
        const firstChunkIso = new Date(firstChunkAt).toISOString();
        logger.debug(
          `[stream] first chunk at ${firstChunkIso} (after ${firstChunkAt - streamStartAt}ms, len=${chunk.length}, start=${streamStartIso})`
        );
      }
      const now = Date.now();
        if (!firstFrameSent || now - lastUpdateTime >= updateInterval) {
          await streamAICard(card, accumulated, false);
          lastUpdateTime = now;
          firstFrameSent = true;
        }
      }

      // 完成卡片
      await finishAICard(card, accumulated, (msg) => logger.debug(msg));
      logger.info(`AI Card streaming completed with ${accumulated.length} chars`);

      const { mediaUrls: mediaFromLines } = extractMediaLinesFromText({
        text: accumulated,
        logger,
      });
      const { mediaUrls: localMediaFromText } = extractLocalMediaFromText({
        text: accumulated,
        logger,
      });
      const mediaQueue: string[] = [];
      const seenMedia = new Set<string>();
      const addMedia = (value?: string) => {
        const trimmed = value?.trim();
        if (!trimmed) return;
        if (seenMedia.has(trimmed)) return;
        seenMedia.add(trimmed);
        mediaQueue.push(trimmed);
      };
      for (const url of mediaFromLines) addMedia(url);
      for (const url of localMediaFromText) addMedia(url);

      // 单独发送媒体消息（图片/文件）
      if (mediaQueue.length > 0) {
        logger.debug(`[stream] sending ${mediaQueue.length} media attachments`);
        for (const mediaUrl of mediaQueue) {
          try {
            await sendMediaDingtalk({
              cfg: dingtalkCfg,
              to: targetId,
              mediaUrl,
              chatType,
            });
            logger.debug(`[stream] sent media: ${mediaUrl}`);
          } catch (fileErr) {
            logger.warn(`[stream] failed to send media ${mediaUrl}: ${String(fileErr)}`);
          }
        }
      }
    } catch (err) {
    logger.error(`AI Card streaming failed: ${String(err)}`);
    // 尝试用错误信息完成卡片
    try {
      const errorMsg = `⚠️ Response interrupted: ${String(err)}`;
      await finishAICard(card, errorMsg, (msg) => logger.debug(msg));
    } catch (finishErr) {
      logger.error(`Failed to finish card with error: ${String(finishErr)}`);
    }

    // 回退到普通消息发送（使用钉钉 SDK）
      try {
        const fallbackText = accumulated.trim()
          ? accumulated
          : `⚠️ Response interrupted: ${String(err)}`;
        const limit = dingtalkCfg.textChunkLimit ?? 4000;
        for (let i = 0; i < fallbackText.length; i += limit) {
          const chunk = fallbackText.slice(i, i + limit);
          await sendMessageDingtalk({
            cfg: dingtalkCfg,
            to: targetId,
            text: chunk,
            chatType,
          });
        }
        const { mediaUrls: mediaFromLines } = extractMediaLinesFromText({
          text: fallbackText,
          logger,
        });
        const { mediaUrls: localMediaFromText } = extractLocalMediaFromText({
          text: fallbackText,
          logger,
        });
        const mediaQueue: string[] = [];
        const seenMedia = new Set<string>();
        const addMedia = (value?: string) => {
          const trimmed = value?.trim();
          if (!trimmed) return;
          if (seenMedia.has(trimmed)) return;
          seenMedia.add(trimmed);
          mediaQueue.push(trimmed);
        };
        for (const url of mediaFromLines) addMedia(url);
        for (const url of localMediaFromText) addMedia(url);
        for (const mediaUrl of mediaQueue) {
          await sendMediaDingtalk({
            cfg: dingtalkCfg,
            to: targetId,
            mediaUrl,
            chatType,
          });
        }

        logger.info("AI Card failed; fallback message sent via SDK");
      } catch (fallbackErr) {
      logger.error(`Failed to send fallback message: ${String(fallbackErr)}`);
    }
  }
}

/**
 * 构建文件上下文消�?
 * 
 * 根据文件类型返回对应的中文描述文�?
 * 
 * @param msgType 消息类型 (picture, video, audio, file)
 * @param fileName 文件名（可选，用于 file 类型�?
 * @returns 消息正文描述
 * 
 * Requirements: 9.5
 */
export function buildFileContextMessage(
  msgType: MediaMsgType,
  fileName?: string
): string {
  switch (msgType) {
    case "picture":
      return "[图片]";
    case "audio":
      return "[语音消息]";
    case "video":
      return "[视频]";
    case "file": {
      // 根据文件扩展名确定文件类�?
      const displayName = fileName ?? "未知文件";
      
      if (fileName) {
        // 使用 resolveFileCategory 来确定文件类�?
        const category = resolveFileCategory("application/octet-stream", fileName);
        
        switch (category) {
          case "document":
            return `[文档: ${displayName}]`;
          case "archive":
            return `[压缩�? ${displayName}]`;
          case "code":
            return `[代码文件: ${displayName}]`;
          default:
            return `[文件: ${displayName}]`;
        }
      }
      
      return `[文件: ${displayName}]`;
    }
    default:
      return `[文件: ${fileName ?? "未知文件"}]`;
  }
}


/**
 * 处理钉钉入站消息
 * 
 * 集成消息解析、策略检查和 Agent 分发
 * 
 * @param params 处理参数
 * @returns Promise<void>
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
export async function handleDingtalkMessage(params: {
  cfg: unknown; // ClawdbotConfig
  raw: DingtalkRawMessage;
  accountId?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  enableAICard?: boolean;
}): Promise<void> {
  const {
    cfg,
    raw,
    accountId = "default",
    enableAICard = false,
  } = params;
  
  // 创建日志�?
  const logger: Logger = createLogger("dingtalk", {
    log: params.log,
    error: params.error,
  });
  
  // 解析消息
  const ctx = parseDingtalkMessage(raw);
  const isGroup = ctx.chatType === "group";
  const audioRecognition = resolveAudioRecognition(raw);
  const inboundTargetMeta = buildTargetMeta(ctx);
  logger.info(
    `[inbound] received=${JSON.stringify({
      ...inboundTargetMeta,
      contentType: ctx.contentType,
      mentionedBot: ctx.mentionedBot,
    })}`
  );
  
  // 获取钉钉配置
  const dingtalkCfg = (cfg as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  const channelCfg = dingtalkCfg?.dingtalk as DingtalkConfig | undefined;
  const inboundMediaDir = resolveInboundMediaDir(channelCfg);
  const inboundMediaKeepDays = resolveInboundMediaKeepDays(channelCfg);
  const inboundMediaTempDir = resolveInboundMediaTempDir();

  const archiveInboundMedia = async (file: DownloadedFile): Promise<DownloadedFile> => {
    const finalPath = await finalizeInboundMediaFile({
      filePath: file.path,
      tempDir: inboundMediaTempDir,
      inboundDir: inboundMediaDir,
    });
    if (finalPath === file.path) return file;
    return { ...file, path: finalPath };
  };
  
  // 策略检�?
  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "open";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;
    
    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.conversationId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });
    
    if (!policyResult.allowed) {
      logger.debug(
        `[policy] rejected=${JSON.stringify({
          reason: policyResult.reason,
          ...inboundTargetMeta,
        })}`
      );
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
      logger.debug(
        `[policy] rejected=${JSON.stringify({
          reason: policyResult.reason,
          ...inboundTargetMeta,
        })}`
      );
      return;
    }
  }
  
  // 检查运行时是否已初始化
  if (!isDingtalkRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }
  
  // ===== 媒体消息处理变量 (�?try 块外声明以便 catch 块访�? =====
  let downloadedMedia: DownloadedFile | null = null;
  let downloadedRichTextImages: DownloadedFile[] = [];
  let extractedFileInfo: ExtractedFileInfo | null = null;
  
  try {
    // 获取完整�?Moltbot 运行时（包含 core API�?
    const core = getDingtalkRuntime();
    const coreRecord = core as Record<string, unknown>;
    const coreChannel = coreRecord?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;
    const routingApi = coreChannel?.routing as Record<string, unknown> | undefined;
    
    // 检查必要的 API 是否存在
    if (!routingApi?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }
    
    if (!replyApi?.dispatchReplyFromConfig) {
      logger.debug("core.channel.reply.dispatchReplyFromConfig not available, skipping dispatch");
      return;
    }

    if (!replyApi?.createReplyDispatcher && !replyApi?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }
    
    // 解析路由
    const resolveAgentRoute = routingApi.resolveAgentRoute as (opts: Record<string, unknown>) => Record<string, unknown>;
    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });
    
    // ===== 媒体消息处理 (Requirements 9.1, 9.2, 9.4, 9.6) =====
    // 用于存储下载的媒体文件信�?
    let mediaBody: string | null = null;
    let richTextParseResult: ReturnType<typeof parseRichTextMessage> = null;
    
    // 检测并处理媒体消息类型 (picture, video, audio, file)
    const mediaTypes: MediaMsgType[] = ["picture", "video", "audio", "file"];
    if (mediaTypes.includes(raw.msgtype as MediaMsgType)) {
      if (raw.msgtype === "audio" && audioRecognition) {
        logger.debug("[audio] recognition present; treat as text and skip audio file download");
      } else {
        try {
          // 提取文件信息 (Requirement 9.1)
          extractedFileInfo = extractFileFromMessage(raw);
          
          if (extractedFileInfo && channelCfg?.clientId && channelCfg?.clientSecret) {
            // 获取 access token (Requirement 9.6)
            const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);
            
            // 下载文件 (Requirement 9.2)
            downloadedMedia = await downloadDingTalkFile({
              downloadCode: extractedFileInfo.downloadCode,
              robotCode: channelCfg.clientId,
              accessToken,
              fileName: extractedFileInfo.fileName,
              msgType: extractedFileInfo.msgType,
              log: logger,
              maxFileSizeMB: channelCfg.maxFileSizeMB,
            });

            downloadedMedia = await archiveInboundMedia(downloadedMedia);
            logger.debug(`downloaded media file: ${downloadedMedia.path} (${downloadedMedia.size} bytes)`);
            
            // 构建消息正文 (Requirement 9.5)
            mediaBody = buildFileContextMessage(
              extractedFileInfo.msgType,
              extractedFileInfo.fileName
            );
          }
        } catch (err) {
          // 优雅降级：记录警告并继续处理文本内容 (Requirement 9.4)
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`media download failed, continuing with text: ${errorMessage}`);
          downloadedMedia = null;
          extractedFileInfo = null;
        }
      }
    }
    
    // ===== richText 消息处理 (Requirements 9.3, 3.6) =====
    if (raw.msgtype === "richText") {
      try {
        // 解析 richText 消息
        richTextParseResult = parseRichTextMessage(raw);
        
        if (richTextParseResult && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 检查是否有图片需要下�?(Requirement 3.6)
          if (richTextParseResult.imageCodes.length > 0) {
            // 获取 access token
            const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);
            
            // 批量下载图片
            downloadedRichTextImages = await downloadRichTextImages({
              imageCodes: richTextParseResult.imageCodes,
              robotCode: channelCfg.clientId,
              accessToken,
              log: logger,
              maxFileSizeMB: channelCfg.maxFileSizeMB,
            });

            downloadedRichTextImages = await Promise.all(
              downloadedRichTextImages.map((file) => archiveInboundMedia(file))
            );
            logger.debug(`downloaded ${downloadedRichTextImages.length}/${richTextParseResult.imageCodes.length} richText images`);
          }

          const orderedLines: string[] = [];
          const imageQueue = [...downloadedRichTextImages];

          for (const element of richTextParseResult.elements ?? []) {
            if (!element) continue;
            if (element.type === "picture") {
              const file = imageQueue.shift();
              orderedLines.push(file?.path ?? "[图片]");
              continue;
            }
            if (element.type === "text" && typeof element.text === "string") {
              orderedLines.push(element.text);
              continue;
            }
            if (element.type === "at" && typeof element.userId === "string") {
              orderedLines.push(`@${element.userId}`);
              continue;
            }
          }

          if (orderedLines.length > 0) {
            mediaBody = orderedLines.join("\n");
          } else if (richTextParseResult.textParts.length > 0) {
            mediaBody = richTextParseResult.textParts.join("\n");
          } else if (downloadedRichTextImages.length > 0) {
            // 兜底：如果只有图片没有文本，设置为图片描述
            mediaBody = downloadedRichTextImages.length === 1 
              ? "[图片]" 
              : `[${downloadedRichTextImages.length}张图片]`;
          }
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`richText processing failed: ${errorMessage}`);
        richTextParseResult = null;
        downloadedRichTextImages = [];
      }
    }
    
    // 构建入站上下�?
    const inboundCtx = buildInboundContext(ctx, (route as Record<string, unknown>)?.sessionKey as string, (route as Record<string, unknown>)?.accountId as string);
    if (audioRecognition) {
      inboundCtx.Transcript = audioRecognition;
    }
    
    // 设置媒体相关字段 (Requirements 7.1-7.8)
    if (downloadedMedia) {
      inboundCtx.MediaPath = downloadedMedia.path;
      inboundCtx.MediaType = downloadedMedia.contentType;
      
      // 设置消息正文为媒体描�?
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
      
      // 文件消息特有字段
      if (extractedFileInfo?.msgType === "file") {
        if (extractedFileInfo.fileName) {
          inboundCtx.FileName = extractedFileInfo.fileName;
        }
        if (extractedFileInfo.fileSize !== undefined) {
          inboundCtx.FileSize = extractedFileInfo.fileSize;
        }
      }
      
      // 音频消息的语音识别文�?
      if (extractedFileInfo?.msgType === "audio" && extractedFileInfo.recognition) {
        inboundCtx.Transcript = extractedFileInfo.recognition;
      }
    }
    
    // 设置 richText 消息的媒体字�?(Requirements 7.3, 7.4)
    if (downloadedRichTextImages.length > 0) {
      inboundCtx.MediaPaths = downloadedRichTextImages.map(f => f.path);
      inboundCtx.MediaTypes = downloadedRichTextImages.map(f => f.contentType);
      
      // 设置消息正文
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
    } else if (richTextParseResult && richTextParseResult.textParts.length > 0) {
      // 纯文�?richText 消息 (Requirement 3.6)
      // 不设�?MediaPath/MediaType，只设置 Body
      const textBody = richTextParseResult.textParts.join("\n");
      inboundCtx.Body = textBody;
      inboundCtx.RawBody = textBody;
      inboundCtx.CommandBody = textBody;
    }

    // 如果�?finalizeInboundContext，使用它
    const finalizeInboundContext = replyApi?.finalizeInboundContext as
      | ((ctx: InboundContext) => InboundContext)
      | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;
    const resolvedTargetMeta = buildTargetMeta(ctx, finalCtx);
    logger.debug(`[inbound] context=${JSON.stringify(resolvedTargetMeta)}`);

    let cronSource = "";
    let cronBase = "";
    if (typeof finalCtx.RawBody === "string" && finalCtx.RawBody) {
      cronSource = "RawBody";
      cronBase = finalCtx.RawBody;
    } else if (typeof finalCtx.Body === "string" && finalCtx.Body) {
      cronSource = "Body";
      cronBase = finalCtx.Body;
    } else if (typeof finalCtx.CommandBody === "string" && finalCtx.CommandBody) {
      cronSource = "CommandBody";
      cronBase = finalCtx.CommandBody;
    }

    if (cronBase) {
      const nextCron = appendCronHiddenPrompt(cronBase);
      const injected = nextCron !== cronBase;
      if (injected) {
        // 只覆盖发送给 LLM 的正文，避免污染 Body/RawBody
        finalCtx.BodyForAgent = nextCron;
      }
    }

    // 记录 inbound session，用于 last route（cron/heartbeat 依赖）
    const channelSession = coreChannel?.session as
      | {
          resolveStorePath?: (store: unknown, params: { agentId?: string }) => string | undefined;
          recordInboundSession?: (params: {
            storePath: string;
            sessionKey: string;
            ctx: unknown;
            updateLastRoute?: {
              sessionKey: string;
              channel: string;
              to: string;
              accountId?: string;
              threadId?: string | number;
            };
            onRecordError?: (err: unknown) => void;
          }) => Promise<void>;
        }
      | undefined;
    const storePath = channelSession?.resolveStorePath?.(
      (cfg as Record<string, unknown>)?.session?.store,
      { agentId: (route as Record<string, unknown>)?.agentId as string | undefined },
    );
    if (channelSession?.recordInboundSession && storePath) {
      const mainSessionKeyRaw = (route as Record<string, unknown>)?.mainSessionKey;
      const mainSessionKey =
        typeof mainSessionKeyRaw === "string" && mainSessionKeyRaw.trim()
          ? mainSessionKeyRaw
          : undefined;
      const updateLastRoute =
        !isGroup && mainSessionKey
          ? {
              sessionKey: mainSessionKey,
              channel: "dingtalk",
              to:
                ((finalCtx as { OriginatingTo?: string }).OriginatingTo ??
                  (finalCtx as { To?: string }).To ??
                  `user:${ctx.senderId}`) as string,
              accountId: (route as Record<string, unknown>)?.accountId as string | undefined,
            }
          : undefined;

      const recordSessionKeyRaw =
        (finalCtx as { SessionKey?: string }).SessionKey ?? (route as { sessionKey?: string }).sessionKey;
      const recordSessionKey =
        typeof recordSessionKeyRaw === "string" && recordSessionKeyRaw.trim()
          ? recordSessionKeyRaw
          : String(recordSessionKeyRaw ?? "");

      await channelSession.recordInboundSession({
        storePath,
        sessionKey: recordSessionKey,
        ctx: finalCtx,
        updateLastRoute,
        onRecordError: (err: unknown) => {
          logger.error(`dingtalk: failed updating session meta: ${String(err)}`);
        },
      });
    }

    const dingtalkCfgResolved = channelCfg;
    if (!dingtalkCfgResolved) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    // ===== AI Card 流式处理 =====
    if (enableAICard) {
      const card = await createAICard({
        cfg: dingtalkCfgResolved,
        conversationType: ctx.chatType === "group" ? "2" : "1",
        conversationId: ctx.conversationId,
        senderId: ctx.senderId,
        senderStaffId: raw.senderStaffId,
        log: (msg) => logger.debug(msg),
      });

      if (card) {
        logger.info("AI Card created, using streaming mode");
        await handleAICardStreaming({
          card,
          cfg,
          route: route as { sessionKey: string; accountId: string; agentId?: string },
          inboundCtx: finalCtx,
          dingtalkCfg: dingtalkCfgResolved,
          targetId: isGroup ? ctx.conversationId : ctx.senderId,
          chatType: isGroup ? "group" : "direct",
          logger,
        });
        return;
      } else {
        logger.warn("AI Card creation failed, falling back to normal message");
      }
    }

    // ===== 普通消息模�?=====
    const textApi = coreChannel?.text as Record<string, unknown> | undefined;
    
    const textChunkLimitResolved =
      (textApi?.resolveTextChunkLimit as ((opts: Record<string, unknown>) => number) | undefined)?.(
        {
          cfg,
          channel: "dingtalk",
          defaultLimit: dingtalkCfgResolved.textChunkLimit ?? 4000,
        }
      ) ?? (dingtalkCfgResolved.textChunkLimit ?? 4000);
    const chunkMode = (textApi?.resolveChunkMode as ((cfg: unknown, channel: string) => unknown) | undefined)?.(cfg, "dingtalk");
    const tableMode = "bullets";

    const deliver = async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info?: { kind?: string }) => {
      logger.debug(
        `[reply] meta=${JSON.stringify({
          ...resolvedTargetMeta,
          kind: info?.kind ?? "unknown",
          hasText: typeof payload.text === "string",
          mediaCount: Array.isArray(payload.mediaUrls)
            ? payload.mediaUrls.length
            : payload.mediaUrl
              ? 1
              : 0,
        })}`
      );
      const targetId = isGroup ? ctx.conversationId : ctx.senderId;
      const chatType = isGroup ? "group" : "direct";
      let sent = false;

      const sendMediaWithFallback = async (mediaUrl: string): Promise<void> => {
        try {
          await sendMediaDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            mediaUrl,
            chatType,
          });
          sent = true;
        } catch (err) {
          logger.error(
            `[reply] sendMediaDingtalk failed (target=${JSON.stringify(resolvedTargetMeta)}): ${String(err)}`
          );
          const fallbackText = `📎 ${mediaUrl}`;
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: fallbackText,
            chatType,
          });
          sent = true;
        }
      };

      const payloadMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const rawText = payload.text ?? "";
      const { mediaUrls: mediaFromLines } = extractMediaLinesFromText({
        text: rawText,
        logger,
      });
      const { mediaUrls: localMediaFromText } = extractLocalMediaFromText({
        text: rawText,
        logger,
      });

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
      for (const url of localMediaFromText) addMedia(url);

      const converted = (textApi?.convertMarkdownTables as ((text: string, mode: string) => string) | undefined)?.(
        rawText,
        tableMode
      ) ?? rawText;

      const hasText = converted.trim().length > 0;
      if (hasText) {
        const chunks =
          textApi?.chunkTextWithMode && typeof textChunkLimitResolved === "number" && textChunkLimitResolved > 0
            ? (textApi.chunkTextWithMode as (text: string, limit: number, mode: unknown) => string[])(converted, textChunkLimitResolved, chunkMode)
            : [converted];

        for (const chunk of chunks) {
          await sendMessageDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            text: chunk,
            chatType,
          });
          sent = true;
        }
      }

      for (const mediaUrl of mediaQueue) {
        await sendMediaWithFallback(mediaUrl);
      }

      if (!hasText && mediaQueue.length === 0) {
        return false;
      }
      return sent;
    };

    const humanDelay = (replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined)?.(
      cfg,
      (route as Record<string, unknown>)?.agentId as string | undefined
    );

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatchReplyWithBufferedBlockDispatcher = replyApi?.dispatchReplyWithBufferedBlockDispatcher as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (dispatchReplyWithBufferedBlockDispatcher) {
      logger.debug(
        `[dispatch] buffered=${JSON.stringify({
          sessionKey: (route as Record<string, unknown>)?.sessionKey,
          ...resolvedTargetMeta,
        })}`
      );
      const deliveryState = { delivered: false, skippedNonSilent: 0 };
      const result = await dispatchReplyWithBufferedBlockDispatcher({
        ctx: finalCtx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            const didSend = await deliver(
              payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] },
              info
            );
            if (didSend) {
              deliveryState.delivered = true;
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

      if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
        await sendMessageDingtalk({
          cfg: dingtalkCfgResolved,
          to: isGroup ? ctx.conversationId : ctx.senderId,
          text: "No response generated. Please try again.",
          chatType: isGroup ? "group" : "direct",
        });
      }

      const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
      const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
      logger.debug(
        `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`
      );
      return;
    }

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown, info?: { kind?: string }) => {
            await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info);
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
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

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as Record<string, unknown> | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(
      `[dispatch] standard=${JSON.stringify({
        sessionKey: (route as Record<string, unknown>)?.sessionKey,
        ...resolvedTargetMeta,
      })}`
    );

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const result = await dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as (() => void) | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
    const queuedFinal = (result as Record<string, unknown>)?.queuedFinal as unknown;
    logger.debug(
      `dispatch complete (queuedFinal=${typeof queuedFinal === "boolean" ? queuedFinal : "unknown"}, replies=${counts?.final ?? 0})`
    );
  } catch (err) {
    logger.error(
      `failed to dispatch message (target=${JSON.stringify(inboundTargetMeta)}): ${String(err)}`
    );
  } finally {
    try {
      await pruneInboundMediaDir({
        inboundDir: inboundMediaDir,
        keepDays: inboundMediaKeepDays,
      });
    } catch (err) {
      logger.debug(`failed to prune inbound media dir: ${String(err)}`);
    }
  }
}
