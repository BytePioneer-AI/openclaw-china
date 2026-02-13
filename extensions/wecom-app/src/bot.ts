/**
 * 企业微信自建应用消息处理
 *
 * 按参考实现的 session/envelope + buffered dispatcher 方式分发
 * 支持主动发送消息
 */

import {
  checkDmPolicy,
  createLogger,
  transcribeTencentFlash,
  type Logger,
} from "@openclaw-china/shared";
import { readFile } from "node:fs/promises";

import type { PluginRuntime } from "./runtime.js";
import type { ResolvedWecomAppAccount, WecomAppInboundMessage, WecomAppDmPolicy } from "./types.js";
import {
  resolveAllowFrom,
  resolveWecomAppASRCredentials,
  resolveDmPolicy,
  resolveInboundMediaEnabled,
  resolveInboundMediaMaxBytes,
  type PluginConfig,
} from "./config.js";
import {
  sendWecomAppMessage,
  downloadAndSendImage,
  downloadWecomMediaToFile,
  cleanupFile,
  finalizeInboundMedia,
  pruneInboundMediaDir,
} from "./api.js";

export type WecomAppDispatchHooks = {
  onChunk: (text: string) => void;
  onError?: (err: unknown) => void;
};

function resolveVoiceFormat(msg: WecomAppInboundMessage, savedPath: string): string {
  const declared = String((msg as { Format?: string }).Format ?? "").trim().toLowerCase();
  if (declared === "amr" || declared === "speex") return declared;
  const lowerPath = savedPath.toLowerCase();
  if (lowerPath.endsWith(".speex")) return "speex";
  if (lowerPath.endsWith(".amr")) return "amr";
  return "silk";
}

/**
 * 提取消息内容
 */
export function extractWecomAppContent(msg: WecomAppInboundMessage): string {
  const msgtype = String(msg.msgtype ?? msg.MsgType ?? "").toLowerCase();

  if (msgtype === "text") {
    const content = (msg as { text?: { content?: string }; Content?: string }).text?.content ?? (msg as { Content?: string }).Content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "voice") {
    const content = (msg as { voice?: { content?: string }; Recognition?: string }).voice?.content ?? (msg as { Recognition?: string }).Recognition;
    return typeof content === "string" ? content : "[voice]";
  }
  if (msgtype === "mixed") {
    const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
    if (Array.isArray(items)) {
      return items
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return "";
          const typed = item as { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
          const t = String(typed.msgtype ?? "").toLowerCase();
          if (t === "text") return String(typed.text?.content ?? "");
          if (t === "image") return `[image] ${String(typed.image?.url ?? "").trim()}`.trim();
          return t ? `[${t}]` : "";
        })
        .filter((part) => Boolean(part && part.trim()))
        .join("\n");
    }
    return "[mixed]";
  }
  if (msgtype === "image") {
    const url = String((msg as { image?: { url?: string }; PicUrl?: string }).image?.url ?? (msg as { PicUrl?: string }).PicUrl ?? "").trim();
    return url ? `[image] ${url}` : "[image]";
  }
  if (msgtype === "file") {
    const url = String((msg as { file?: { url?: string } }).file?.url ?? "").trim();
    return url ? `[file] ${url}` : "[file]";
  }
  if (msgtype === "location") {
    const m = msg as { Location_X?: string; Location_Y?: string; Scale?: string; Label?: string };
    const lat = String(m.Location_X ?? "").trim();
    const lon = String(m.Location_Y ?? "").trim();
    const scale = String(m.Scale ?? "").trim();
    const label = String(m.Label ?? "").trim();
    const parts: string[] = [];
    if (lat && lon) parts.push(`${lat},${lon}`);
    if (label) parts.push(label);
    if (scale) parts.push(`scale=${scale}`);
    return parts.length ? `[location] ${parts.join(" ")}` : "[location]";
  }
  if (msgtype === "event") {
    const eventtype = String(
      (msg as { event?: { eventtype?: string }; Event?: string }).event?.eventtype ??
      (msg as { Event?: string }).Event ?? ""
    ).trim();
    return eventtype ? `[event] ${eventtype}` : "[event]";
  }
  if (msgtype === "stream") {
    const id = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    return id ? `[stream_refresh] ${id}` : "[stream_refresh]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体：保存到临时目录，处理完成后清理
// ─────────────────────────────────────────────────────────────────────────────

export async function enrichInboundContentWithMedia(params: {
  cfg: PluginConfig;
  account: ResolvedWecomAppAccount;
  msg: WecomAppInboundMessage;
}): Promise<{ text: string; mediaPaths: string[]; cleanup: () => Promise<void> }> {
  const { account, msg } = params;
  const msgtype = String(msg.msgtype ?? msg.MsgType ?? "").toLowerCase();

  const accountConfig = account?.config ?? {};
  const enabled = resolveInboundMediaEnabled(accountConfig);
  const maxBytes = resolveInboundMediaMaxBytes(accountConfig);

  const mediaPaths: string[] = [];

  // 清理函数：
  // - 入站媒体会在“入站解析阶段”就归档到 inbound/YYYY-MM-DD，并把最终路径写进消息体
  // - cleanup 阶段只做（尽力而为的）过期清理，避免影响主流程
  const makeResult = (text: string) => ({
    text,
    mediaPaths,
    cleanup: async () => {
      try {
        await pruneInboundMediaDir(account);
      } catch {
        // ignore
      }
    },
  });

  if (!enabled) {
    return makeResult(extractWecomAppContent(msg));
  }

  // 图片
  if (msgtype === "image") {
    try {
      const mediaId = String((msg as { MediaId?: string }).MediaId ?? "").trim();
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "img" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[image] saved:${finalPath}`);
        }
        // 如果失败，回退到原始文本
        return makeResult(`[image] (save failed) ${saved.error ?? ""}`.trim());
      }

      // 当没有提供 media_id 时，回退到基于 URL 的下载
      const url = String((msg as { image?: { url?: string }; PicUrl?: string }).image?.url ?? (msg as { PicUrl?: string }).PicUrl ?? "").trim();
      if (url) {
        try {
          const saved = await downloadWecomMediaToFile(account, url, { maxBytes, prefix: "img" });
          if (saved.ok && saved.path) {
            const finalPath = await finalizeInboundMedia(account, saved.path);
            mediaPaths.push(finalPath);
            return makeResult(`[image] saved:${finalPath}`);
          }
        } catch {
          // 忽略
        }
      }

      return makeResult(extractWecomAppContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[image] (download error: ${errorMsg})`);
    }
  }

  // 文件（某些企业微信变体可能携带 MediaId，但当前类型不支持）
  if (msgtype === "file") {
    try {
      const mediaId = String((msg as { MediaId?: string; mediaid?: string }).MediaId ?? (msg as { mediaid?: string }).mediaid ?? "").trim();
      if (mediaId) {
        const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "file" });
        if (saved.ok && saved.path) {
          const finalPath = await finalizeInboundMedia(account, saved.path);
          mediaPaths.push(finalPath);
          return makeResult(`[file] saved:${finalPath}`);
        }
        return makeResult(`[file] (save failed) ${saved.error ?? ""}`.trim());
      }
      return makeResult(extractWecomAppContent(msg));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[file] (download error: ${errorMsg})`);
    }
  }

  // 语音：下载语音文件到本地，如果有识别文本则包含
  if (msgtype === "voice") {
    try {
      const mediaId = String((msg as { MediaId?: string }).MediaId ?? "").trim();
      const recognition = String((msg as { Recognition?: string }).Recognition ?? "").trim();
      const asrCredentials = resolveWecomAppASRCredentials(accountConfig);

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
                voiceFormat: resolveVoiceFormat(msg, finalPath),
              };
              if (asrCredentials.engineType) {
                asrConfig.engineType = asrCredentials.engineType;
              }
              if (typeof asrCredentials.timeoutMs === "number") {
                asrConfig.timeoutMs = asrCredentials.timeoutMs;
              }
              const transcript = await transcribeTencentFlash({
                audio,
                config: asrConfig,
              });
              const safeTranscript = transcript.trim();
              if (safeTranscript) {
                return makeResult(`[voice] saved:${finalPath}\n[recognition] ${safeTranscript}`);
              }
            } catch (err) {
              // ASR 失败时保持兼容回退：优先使用企业微信自带 Recognition，再回退文件路径。
            }
          }

          // 如果有识别文本，包含它以便 Agent 看到转录内容
          if (recognition) {
            return makeResult(`[voice] saved:${finalPath}\n[recognition] ${recognition}`);
          }
          return makeResult(`[voice] saved:${finalPath}`);
        }
        // 回退：如果保存失败，包含识别文本
        if (recognition) {
          return makeResult(`[voice] (save failed) ${saved.error ?? ""}\n[recognition] ${recognition}`.trim());
        }
        return makeResult(`[voice] (save failed) ${saved.error ?? ""}`.trim());
      }

      // 没有 mediaId，如果有识别文本则返回
      if (recognition) {
        return makeResult(`[voice]\n[recognition] ${recognition}`);
      }
      return makeResult(extractWecomAppContent(msg));
    } catch (err) {
      const recognition = String((msg as { Recognition?: string }).Recognition ?? "").trim();
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (recognition) {
        return makeResult(`[voice] (download error: ${errorMsg})\n[recognition] ${recognition}`);
      }
      return makeResult(`[voice] (download error: ${errorMsg})`);
    }
  }

  // 混合消息：尝试持久化图片项（如果存在）
  if (msgtype === "mixed") {
    try {
      const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
      if (!Array.isArray(items)) return makeResult(extractWecomAppContent(msg));

      const parts: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const typed = item as any;
        const t = String(typed.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const c = String(typed.text?.content ?? "").trim();
          if (c) parts.push(c);
          continue;
        }
        if (t === "image") {
          const mediaId = String(typed.image?.media_id ?? typed.MediaId ?? typed.media_id ?? "").trim();
          if (mediaId) {
            try {
              const saved = await downloadWecomMediaToFile(account, mediaId, { maxBytes, prefix: "img" });
              if (saved.ok && saved.path) {
                const finalPath = await finalizeInboundMedia(account, saved.path);
                mediaPaths.push(finalPath);
                parts.push(`[image] saved:${finalPath}`);
              } else {
                const url = String(typed.image?.url ?? "").trim();
                parts.push(url ? `[image] ${url}` : "[image]");
              }
            } catch (imgErr) {
              const url = String(typed.image?.url ?? "").trim();
              parts.push(url ? `[image] ${url}` : "[image]");
            }
          } else {
            const url = String(typed.image?.url ?? "").trim();
            parts.push(url ? `[image] ${url}` : "[image]");
          }
          continue;
        }
        if (t) parts.push(`[${t}]`);
      }

      const text = parts.filter(Boolean).join("\n") || "[mixed]";
      return makeResult(text);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return makeResult(`[mixed] (processing error: ${errorMsg})`);
    }
  }

  return makeResult(extractWecomAppContent(msg));
}

function resolveSenderId(msg: WecomAppInboundMessage): string {
  const userid = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim();
  return userid || "unknown";
}

function resolveChatId(msg: WecomAppInboundMessage, senderId: string): string {
  return senderId;
}

async function buildInboundBody(params: {
  cfg: PluginConfig;
  account: ResolvedWecomAppAccount;
  msg: WecomAppInboundMessage;
}): Promise<{ text: string; cleanup: () => Promise<void> }> {
  // 尽可能使用增强的消息体（将入站媒体保存到本地）
  const enriched = await enrichInboundContentWithMedia({
    cfg: params.cfg,
    account: params.account,
    msg: params.msg,
  });
  return { text: enriched.text, cleanup: enriched.cleanup };
}

/**
 * 分发企业微信自建应用消息
 */
export async function dispatchWecomAppMessage(params: {
  cfg?: PluginConfig;
  account: ResolvedWecomAppAccount;
  msg: WecomAppInboundMessage;
  core: PluginRuntime;
  hooks: WecomAppDispatchHooks;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core, hooks } = params;
  const safeCfg = (cfg ?? {}) as PluginConfig;

  const logger: Logger = createLogger("wecom-app", { log: params.log, error: params.error });

  const senderId = resolveSenderId(msg);
  const chatId = resolveChatId(msg, senderId);

  const accountConfig = account?.config ?? {};

  // DM 策略检查
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
    channel: "wecom-app",
    accountId: account.accountId,
    peer: { kind: "dm", id: chatId },
  });

  const { text: rawBody, cleanup } = await buildInboundBody({ cfg: safeCfg, account, msg });
  const fromLabel = `user:${senderId}`;

  const storePath = channel.session?.resolveStorePath?.(safeCfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = channel.session?.readSessionUpdatedAt
    ? channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined
    : undefined;

  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
    ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
    : undefined;

  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeCom App",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const msgid = msg.msgid ?? msg.MsgId ?? undefined;

  // 构建标准化的目标标识，用于自动回复到当前会话
  // - From: 带渠道前缀，用于标识来源渠道
  // - To: 不带渠道前缀，只带类型前缀，用于回复时路由
  const from = `wecom-app:user:${senderId}`;
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
        Provider: "wecom-app",
        Surface: "wecom-app",
        MessageSid: msgid,
        OriginatingChannel: "wecom-app",
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
        Provider: "wecom-app",
        Surface: "wecom-app",
        MessageSid: msgid,
        OriginatingChannel: "wecom-app",
        OriginatingTo: to,
      }) as {
    SessionKey?: string;
    [key: string]: unknown;
  };

  if (channel.session?.recordInboundSession && storePath) {
    await channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        logger.error(`wecom-app: failed updating session meta: ${String(err)}`);
      },
    });
  }

  const tableMode = channel.text?.resolveMarkdownTableMode
    ? channel.text.resolveMarkdownTableMode({ cfg: safeCfg, channel: "wecom-app", accountId: account.accountId })
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
        hooks.onChunk(converted);
      },
      onError: (err: unknown, info: { kind: string }) => {
        hooks.onError?.(err);
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  // 消息处理完成后清理临时媒体文件
  await cleanup();
}

/**
 * 主动发送消息 (仅限自建应用)
 */
export async function sendActiveMessage(params: {
  account: ResolvedWecomAppAccount;
  userId?: string;
  chatid?: string;
  message: string;
  log?: (msg: string) => void;
}): Promise<{ ok: boolean; error?: string; msgid?: string }> {
  const { account, userId, chatid, message } = params;

  if (!account.canSendActive) {
    return { ok: false, error: "Account not configured for active sending" };
  }

  try {
    const result = await sendWecomAppMessage(account, { userId, chatid }, message);
    return {
      ok: result.ok,
      error: result.ok ? undefined : result.errmsg,
      msgid: result.msgid,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 主动发送图片消息 (仅限自建应用)
 * 完整流程：下载图片 → 上传素材 → 发送图片
 */
export async function sendActiveImageMessage(params: {
  account: ResolvedWecomAppAccount;
  userId?: string;
  chatid?: string;
  imageUrl: string;
  log?: (msg: string) => void;
}): Promise<{ ok: boolean; error?: string; msgid?: string }> {
  const { account, userId, chatid, imageUrl } = params;

  if (!account.canSendActive) {
    return { ok: false, error: "Account not configured for active sending" };
  }

  try {
    const result = await downloadAndSendImage(account, { userId, chatid }, imageUrl);
    return {
      ok: result.ok,
      error: result.ok ? undefined : result.errmsg,
      msgid: result.msgid,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
