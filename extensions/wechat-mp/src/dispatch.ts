import { resolveAllowFrom, resolveWechatMpASRCredentials } from "./config.js";
import { updateAccountState } from "./state.js";
import { normalizeWechatMpText, resolveRenderMarkdown } from "./text.js";
import { downloadWechatMpMedia } from "./api.js";
import { transcribeTencentFlash, ASRError } from "@openclaw-china/shared";
import type {
  PluginConfig,
  PluginRuntime,
  ResolvedWechatMpAccount,
  WechatMpInboundCandidate,
} from "./types.js";

const VOICE_ASR_FALLBACK_TEXT = "当前语音功能未启动或识别失败，请稍后重试。";
const VOICE_ASR_ERROR_MAX_LENGTH = 500;

function trimTextForReply(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength) + "…";
}

function formatASRErrorLog(err: unknown): string {
  if (err instanceof ASRError) {
    return `${err.kind}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function buildVoiceASRFallbackReply(errorMessage?: string): string {
  if (!errorMessage) return VOICE_ASR_FALLBACK_TEXT;
  return `${VOICE_ASR_FALLBACK_TEXT}\n\n接口错误：${trimTextForReply(errorMessage, VOICE_ASR_ERROR_MAX_LENGTH)}`;
}

function createLogger(opts: { log?: (message: string) => void; error?: (message: string) => void }) {
  return {
    info: (message: string) => (opts.log ?? console.log)(`[wechat-mp] ${message}`),
    warn: (message: string) => (opts.log ?? console.log)(`[wechat-mp] [WARN] ${message}`),
    error: (message: string) => (opts.error ?? console.error)(`[wechat-mp] [ERROR] ${message}`),
  };
}

function isSenderAllowed(account: ResolvedWechatMpAccount, senderId: string): { allowed: boolean; reason?: string } {
  const policy = account.config.dmPolicy ?? "open";
  if (policy === "disabled") {
    return { allowed: false, reason: "dm disabled" };
  }
  if (policy === "allowlist") {
    const allowFrom = resolveAllowFrom(account.config);
    const allowed = allowFrom.includes(senderId.trim().toLowerCase());
    return allowed ? { allowed: true } : { allowed: false, reason: "sender not in allowlist" };
  }
  if (policy === "pairing") {
    const allowFrom = resolveAllowFrom(account.config);
    if (allowFrom.length > 0 && !allowFrom.includes(senderId.trim().toLowerCase())) {
      return { allowed: false, reason: "sender not paired" };
    }
  }
  return { allowed: true };
}

/**
 * Build voice message body with optional ASR transcription.
 * If ASR is enabled and configured, downloads voice and transcribes to text.
 * Falls back to WeChat's built-in recognition if available.
 */
async function buildVoiceBody(
  candidate: WechatMpInboundCandidate,
  account: ResolvedWechatMpAccount,
  logger: ReturnType<typeof createLogger>
): Promise<{ text: string; asrErrorMessage?: string }> {
  const parts = ["[voice]"];

  // If WeChat already provided recognition, use it
  if (candidate.recognition) {
    parts.push(`recognition=${candidate.recognition}`);
    if (candidate.format) {
      parts.push(`format=${candidate.format}`);
    }
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    return { text: parts.join("\n").trim() };
  }

  // Check if ASR is configured
  const asrCredentials = resolveWechatMpASRCredentials(account.config);
  if (!asrCredentials || !candidate.mediaId) {
    // No ASR configured, return basic voice info
    if (candidate.format) {
      parts.push(`format=${candidate.format}`);
    }
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    return { text: parts.join("\n").trim() };
  }

  // Download voice and transcribe
  try {
    logger.info(`downloading voice for ASR accountId=${account.accountId} mediaId=${candidate.mediaId}`);
    const voiceBuffer = await downloadWechatMpMedia(account, candidate.mediaId);

    logger.info(`transcribing voice accountId=${account.accountId} size=${voiceBuffer.length}`);
    const transcript = await transcribeTencentFlash({
      audio: voiceBuffer,
      config: {
        appId: asrCredentials.appId,
        secretId: asrCredentials.secretId,
        secretKey: asrCredentials.secretKey,
        engineType: asrCredentials.engineType ?? "16k_zh",
        voiceFormat: candidate.format ?? "amr",
        timeoutMs: asrCredentials.timeoutMs ?? 30000,
      },
    });

    const safeTranscript = transcript.trim();
    if (safeTranscript) {
      parts.push(`recognition=${safeTranscript}`);
      if (candidate.format) {
        parts.push(`format=${candidate.format}`);
      }
      parts.push(`mediaId=${candidate.mediaId}`);
      return { text: parts.join("\n").trim() };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      `[voice-asr] transcription failed accountId=${account.accountId} detail=${formatASRErrorLog(err)}`
    );
    // Return basic info with error
    if (candidate.format) {
      parts.push(`format=${candidate.format}`);
    }
    parts.push(`mediaId=${candidate.mediaId}`);
    return { text: parts.join("\n").trim(), asrErrorMessage: errorMessage };
  }

  // Fallback
  if (candidate.format) {
    parts.push(`format=${candidate.format}`);
  }
  if (candidate.mediaId) {
    parts.push(`mediaId=${candidate.mediaId}`);
  }
  return { text: parts.join("\n").trim() };
}

function buildCandidateBody(candidate: WechatMpInboundCandidate): string {
  if (candidate.msgType === "text") {
    return String(candidate.content ?? "").trim();
  }

  if (candidate.msgType === "image") {
    const parts = ["[image]"];
    if (candidate.picUrl) {
      parts.push(`url=${candidate.picUrl}`);
    }
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    return parts.join("\n").trim();
  }

  if (candidate.msgType === "voice") {
    const parts = ["[voice]"];
    if (candidate.recognition) {
      parts.push(`recognition=${candidate.recognition}`);
    }
    if (candidate.format) {
      parts.push(`format=${candidate.format}`);
    }
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    return parts.join("\n").trim();
  }

  if (candidate.msgType === "video") {
    const parts = ["[video]"];
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    if (candidate.thumbMediaId) {
      parts.push(`thumbMediaId=${candidate.thumbMediaId}`);
    }
    return parts.join("\n").trim();
  }

  if (candidate.msgType === "shortvideo") {
    const parts = ["[shortvideo]"];
    if (candidate.mediaId) {
      parts.push(`mediaId=${candidate.mediaId}`);
    }
    if (candidate.thumbMediaId) {
      parts.push(`thumbMediaId=${candidate.thumbMediaId}`);
    }
    return parts.join("\n").trim();
  }

  if (candidate.msgType === "location") {
    const parts = ["[location]"];
    if (candidate.label) {
      parts.push(`address=${candidate.label}`);
    }
    if (candidate.locationX !== undefined && candidate.locationY !== undefined) {
      parts.push(`coords=${candidate.locationX},${candidate.locationY}`);
    }
    if (candidate.scale !== undefined) {
      parts.push(`scale=${candidate.scale}`);
    }
    return parts.join("\n").trim();
  }

  if (candidate.msgType === "link") {
    const parts = ["[link]"];
    if (candidate.title) {
      parts.push(`title=${candidate.title}`);
    }
    if (candidate.description) {
      parts.push(`description=${candidate.description}`);
    }
    if (candidate.url) {
      parts.push(`url=${candidate.url}`);
    }
    return parts.join("\n").trim();
  }

  // Event messages
  const parts = [`[event:${candidate.event ?? "unknown"}]`];
  if (candidate.eventKey) {
    parts.push(`eventKey=${candidate.eventKey}`);
  }
  if (candidate.ticket) {
    parts.push(`ticket=${candidate.ticket}`);
  }
  return parts.join("\n").trim();
}

/**
 * Async version of buildCandidateBody that handles voice ASR.
 */
async function buildCandidateBodyAsync(
  candidate: WechatMpInboundCandidate,
  account: ResolvedWechatMpAccount,
  logger: ReturnType<typeof createLogger>
): Promise<{ text: string; asrErrorMessage?: string }> {
  // Handle voice with potential ASR
  if (candidate.msgType === "voice") {
    return buildVoiceBody(candidate, account, logger);
  }

  // All other message types use sync builder
  return { text: buildCandidateBody(candidate) };
}

export async function dispatchWechatMpCandidate(params: {
  cfg: PluginConfig;
  account: ResolvedWechatMpAccount;
  candidate: WechatMpInboundCandidate;
  runtime: PluginRuntime;
  onChunk?: (text: string) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<{ dispatched: boolean; reason?: string; combinedReply?: string }> {
  const logger = createLogger({ log: params.log, error: params.error });
  const { candidate } = params;

  if (!candidate.hasUserIntent) {
    return { dispatched: false, reason: "non-intentful event" };
  }

  // Use async builder to support voice ASR
  const { text: bodyRaw, asrErrorMessage } = await buildCandidateBodyAsync(candidate, params.account, logger);
  if (!bodyRaw) {
    return { dispatched: false, reason: "empty inbound body" };
  }

  // If ASR failed, notify user and stop dispatch
  if (asrErrorMessage) {
    logger.warn(`ASR failed, sending fallback reply to user`);
    if (params.onChunk) {
      await params.onChunk(buildVoiceASRFallbackReply(asrErrorMessage));
    }
    return { dispatched: false, reason: "asr failed", combinedReply: buildVoiceASRFallbackReply(asrErrorMessage) };
  }

  const policyResult = isSenderAllowed(params.account, candidate.openId);
  if (!policyResult.allowed) {
    logger.info(`skip sender=${candidate.openId} reason=${policyResult.reason ?? "policy rejected"}`);
    return { dispatched: false, reason: policyResult.reason };
  }

  const channel = params.runtime.channel;
  const resolveAgentRoute = channel?.routing?.resolveAgentRoute;
  const dispatchReply = channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!resolveAgentRoute || !dispatchReply) {
    const message = "runtime routing or buffered reply dispatcher unavailable";
    logger.warn(message);
    await updateAccountState(params.account.accountId, { lastError: message });
    return { dispatched: false, reason: message };
  }

  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "wechat-mp",
    accountId: params.account.accountId,
    peer: { kind: "dm", id: candidate.openId },
  });

  const fromLabel = `user:${candidate.openId}`;
  const from = `wechat-mp:${candidate.target}`;
  const to = candidate.target;
  const effectiveSessionKey = route.sessionKey;
  const storePath = channel.session?.resolveStorePath?.(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = storePath
    ? channel.session?.readSessionUpdatedAt?.({
        storePath,
        sessionKey: effectiveSessionKey,
      })
    : null;
  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions?.(params.cfg);
  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeChat MP",
        from: fromLabel,
        previousTimestamp: previousTimestamp ?? undefined,
        envelope: envelopeOptions,
        body: bodyRaw,
      })
    : bodyRaw;

  const ctxPayload =
    (channel.reply?.finalizeInboundContext?.({
      Body: body,
      RawBody: bodyRaw,
      CommandBody: bodyRaw,
      From: from,
      To: to,
      SessionKey: effectiveSessionKey,
      AccountId: route.accountId ?? params.account.accountId,
      ChatType: "direct",
      ConversationLabel: fromLabel,
      SenderName: candidate.openId,
      SenderId: candidate.openId,
      Provider: "wechat-mp",
      Surface: "wechat-mp",
      MessageSid: candidate.msgId,
      OriginatingChannel: "wechat-mp",
      OriginatingTo: to,
      EventName: candidate.event,
      EventKey: candidate.eventKey,
    }) as Record<string, unknown> | undefined) ?? {
      Body: body,
      RawBody: bodyRaw,
      CommandBody: bodyRaw,
      From: from,
      To: to,
      SessionKey: effectiveSessionKey,
      AccountId: route.accountId ?? params.account.accountId,
      ChatType: "direct",
      ConversationLabel: fromLabel,
      SenderName: candidate.openId,
      SenderId: candidate.openId,
      Provider: "wechat-mp",
      Surface: "wechat-mp",
      MessageSid: candidate.msgId,
      OriginatingChannel: "wechat-mp",
      OriginatingTo: to,
      EventName: candidate.event,
      EventKey: candidate.eventKey,
    };
  ctxPayload.CommandAuthorized = true;

  if (channel.session?.recordInboundSession && storePath) {
    await channel.session.recordInboundSession({
      storePath,
      sessionKey: String(ctxPayload.SessionKey ?? effectiveSessionKey),
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: String((route.mainSessionKey ?? effectiveSessionKey) || effectiveSessionKey),
        channel: "wechat-mp",
        to,
        accountId: route.accountId ?? params.account.accountId,
      },
      onRecordError: (error) => {
        logger.error(`recordInboundSession failed: ${String(error)}`);
      },
    });
  }

  const convertTables =
    channel.text?.convertMarkdownTables && channel.text?.resolveMarkdownTableMode
      ? (text: string) =>
          channel.text!.convertMarkdownTables!(
            text,
            channel.text!.resolveMarkdownTableMode!({
              cfg: params.cfg,
              channel: "wechat-mp",
              accountId: params.account.accountId,
            })
          )
      : (text: string) => text;

  const renderMarkdown = resolveRenderMarkdown(params.account.config);

  const responseChunks: string[] = [];
  await dispatchReply({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const text = String(payload.text ?? "").trim();
        if (!text) return;
        const convertedText = convertTables(text);
        if (!convertedText) return;
        const normalizedText = normalizeWechatMpText(convertedText, renderMarkdown);
        if (!normalizedText) return;
        if (params.onChunk) {
          await params.onChunk(normalizedText);
          return;
        }
        responseChunks.push(normalizedText);
      },
      onError: (error, info) => {
        logger.error(`${info.kind} reply failed: ${String(error)}`);
      },
    },
  });

  const combinedReply = params.onChunk ? "" : responseChunks.join("\n\n").trim();
  if (combinedReply) {
    await updateAccountState(params.account.accountId, {
      lastOutboundAt: Date.now(),
    });
  }

  return { dispatched: true, combinedReply };
}
