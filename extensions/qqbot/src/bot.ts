/**
 * QQ Bot 入站消息处理
 */

import {
  checkDmPolicy,
  checkGroupPolicy,
  cleanupFileSafe,
  createLogger,
  downloadToTempFile,
  type ExtractedMedia,
  finalizeInboundMediaFile,
  fetchMediaFromUrl,
  type Logger,
  appendCronHiddenPrompt,
  ASRError,
  detectMediaType,
  extractMediaFromText,
  isImagePath,
  isLocalReference,
  pruneInboundMediaDir,
  stripTitleFromUrl,
  transcribeTencentFlash,
} from "@xuanyue202/shared";
import {
  DEFAULT_QQBOT_C2C_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT,
  resolveQQBotASRCredentials,
  resolveInboundMediaDir,
  resolveInboundMediaKeepDays,
  resolveInboundMediaTempDir,
  resolveQQBotAutoSendLocalPathMedia,
  resolveQQBotC2CMarkdownSafeChunkByteLimit,
  resolveQQBotTypingHeartbeatIntervalMs,
  resolveQQBotTypingHeartbeatMode,
  resolveQQBotTypingInputSeconds,
  mergeQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  type QQBotC2CMarkdownChunkStrategy,
  type QQBotC2CMarkdownDeliveryMode,
  type QQBotAccountConfig,
  type PluginConfig,
} from "./config.js";
import {
  isQQBotHttpImageUrl,
  normalizeQQBotMarkdownImages,
} from "./markdown-images.js";
import { qqbotOutbound } from "./outbound.js";
import {
  getKnownQQBotTarget,
  upsertKnownQQBotTarget,
  type KnownQQBotTarget,
} from "./proactive.js";
import {
  formatRefEntryForAgent,
  getRefIndex,
  setRefIndex,
  type RefAttachmentSummary,
} from "./ref-index-store.js";
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
  eventId?: string;
  cfg?: PluginConfig;
  accountId: string;
  logger?: Logger;
};

type QQBotAgentRoute = {
  sessionKey: string;
  accountId: string;
  agentId?: string;
  mainSessionKey?: string;
  effectiveSessionKey?: string;
};

type QQBotSenderNameResolution = {
  displayName: string;
  persistentDisplayName?: string;
  source: "known-target" | "account-alias" | "global-alias" | "stable-id";
  matchedAliasKey?: string;
  knownTargetDisplayName?: string;
};

type SessionDispatchTask = {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

type SessionDispatchState = {
  queue: SessionDispatchTask[];
  processing: boolean;
  immediateActiveCount: number;
  waiters: Array<() => void>;
  abortGeneration: number;
};

const sessionDispatchQueue = new Map<string, SessionDispatchState>();
const QQBOT_ABORT_TRIGGERS = new Set([
  "stop",
  "esc",
  "abort",
  "wait",
  "exit",
  "interrupt",
  "detente",
  "deten",
  "detén",
  "arrete",
  "arrête",
  "停止",
  "やめて",
  "止めて",
  "रुको",
  "توقف",
  "стоп",
  "остановись",
  "останови",
  "остановить",
  "прекрати",
  "halt",
  "anhalten",
  "aufhören",
  "hoer auf",
  "stopp",
  "pare",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "stop don't do anything",
  "stop dont do anything",
  "stop do not do anything",
  "stop doing anything",
  "do not do that",
  "please stop",
  "stop please",
]);
const QQBOT_ABORT_TRAILING_PUNCTUATION_RE = /[.!?…,，。;；:：'"’”)\]}]+$/u;

function resolveQQBotRouteSessionKey(route: QQBotAgentRoute): string {
  const effectiveSessionKey = route.effectiveSessionKey?.trim();
  if (effectiveSessionKey) {
    return effectiveSessionKey;
  }
  return route.sessionKey;
}

function buildSessionDispatchQueueKey(route: QQBotAgentRoute): string {
  const accountId = route.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return `${accountId}:${resolveQQBotRouteSessionKey(route)}`;
}

function createSessionDispatchState(): SessionDispatchState {
  return {
    queue: [],
    processing: false,
    immediateActiveCount: 0,
    waiters: [],
    abortGeneration: 0,
  };
}

function getSessionDispatchState(queueKey: string): SessionDispatchState {
  const existing = sessionDispatchQueue.get(queueKey);
  if (existing) {
    return existing;
  }

  const created = createSessionDispatchState();
  sessionDispatchQueue.set(queueKey, created);
  return created;
}

function signalSessionDispatchState(state: SessionDispatchState): void {
  const waiters = state.waiters.splice(0, state.waiters.length);
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForSessionDispatchState(state: SessionDispatchState): Promise<void> {
  return new Promise((resolve) => {
    state.waiters.push(resolve);
  });
}

function cleanupSessionDispatchState(queueKey: string, state: SessionDispatchState): void {
  if (
    state.processing ||
    state.immediateActiveCount > 0 ||
    state.queue.length > 0 ||
    state.waiters.length > 0
  ) {
    return;
  }

  if (sessionDispatchQueue.get(queueKey) === state) {
    sessionDispatchQueue.delete(queueKey);
  }
}

function hasSessionDispatchBacklog(queueKey: string): boolean {
  const state = sessionDispatchQueue.get(queueKey);
  return Boolean(
    state &&
      (state.processing || state.immediateActiveCount > 0 || state.queue.length > 0)
  );
}

async function processSerializedSessionDispatchQueue(queueKey: string): Promise<void> {
  const state = sessionDispatchQueue.get(queueKey);
  if (!state || state.processing) {
    return;
  }

  state.processing = true;

  try {
    for (;;) {
      if (state.immediateActiveCount > 0) {
        await waitForSessionDispatchState(state);
        continue;
      }

      const next = state.queue.shift();
      if (!next) {
        break;
      }

      try {
        await next.task();
        next.resolve();
      } catch (err) {
        next.reject(err);
      }
    }
  } finally {
    state.processing = false;
    if (state.queue.length > 0) {
      void processSerializedSessionDispatchQueue(queueKey);
      return;
    }
    cleanupSessionDispatchState(queueKey, state);
  }
}

function dropQueuedSessionDispatches(queueKey: string): number {
  const state = sessionDispatchQueue.get(queueKey);
  if (!state || state.queue.length === 0) {
    return 0;
  }

  const dropped = state.queue.splice(0, state.queue.length);
  for (const item of dropped) {
    item.resolve();
  }
  signalSessionDispatchState(state);
  cleanupSessionDispatchState(queueKey, state);
  return dropped.length;
}

function markSessionDispatchAbort(queueKey: string): number {
  const state = getSessionDispatchState(queueKey);
  state.abortGeneration += 1;
  signalSessionDispatchState(state);
  return state.abortGeneration;
}

function normalizeQQBotSessionKeyPart(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : "unknown";
}

function buildQQBotDirectSessionKey(params: {
  routeSessionKey: string;
  accountId: string;
  senderStableId: string;
}): string {
  const normalizedAccountId = normalizeQQBotSessionKeyPart(params.accountId);
  const normalizedSenderId = normalizeQQBotSessionKeyPart(params.senderStableId);
  const trimmedRouteSessionKey = params.routeSessionKey.trim();
  if (!trimmedRouteSessionKey) {
    return `agent:main:qqbot:dm:${normalizedAccountId}:${normalizedSenderId}`;
  }

  const qqAgentRouteMatch = trimmedRouteSessionKey.match(/^(agent:[^:]+:qqbot:)(?:direct|dm):.+$/i);
  if (qqAgentRouteMatch?.[1]) {
    return `${qqAgentRouteMatch[1]}dm:${normalizedAccountId}:${normalizedSenderId}`;
  }

  return `${trimmedRouteSessionKey}:dm:${normalizedAccountId}:${normalizedSenderId}`;
}

function normalizeQQBotReplyTarget(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  let trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^qqbot:/i.test(trimmed)) {
    trimmed = trimmed.slice("qqbot:".length).trim();
  }

  if (/^c2c:/i.test(trimmed)) {
    const openid = trimmed.slice("c2c:".length).trim();
    return openid ? `user:${openid}` : undefined;
  }

  return /^(user|group|channel):/i.test(trimmed) ? trimmed : undefined;
}

async function runSerializedSessionDispatch<T>(
  queueKey: string,
  task: () => Promise<T>
): Promise<T> {
  const state = getSessionDispatchState(queueKey);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    state.queue.push({
      task: async () => {
        if (settled) {
          return;
        }
        try {
          const result = await task();
          if (!settled) {
            settled = true;
            resolve(result);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      },
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(undefined as T);
      },
      reject: (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(err);
      },
    });
    signalSessionDispatchState(state);
    void processSerializedSessionDispatchQueue(queueKey);
  });
}

async function runImmediateSessionDispatch<T>(
  queueKey: string,
  task: () => Promise<T>
): Promise<T> {
  const state = getSessionDispatchState(queueKey);
  state.immediateActiveCount += 1;
  signalSessionDispatchState(state);

  try {
    return await task();
  } finally {
    state.immediateActiveCount = Math.max(0, state.immediateActiveCount - 1);
    signalSessionDispatchState(state);
    if (state.queue.length > 0) {
      void processSerializedSessionDispatchQueue(queueKey);
    }
    cleanupSessionDispatchState(queueKey, state);
  }
}

function normalizeQQBotAbortTriggerText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(QQBOT_ABORT_TRAILING_PUNCTUATION_RE, "")
    .trim();
}

function isQQBotAbortTrigger(text: string): boolean {
  if (!text) {
    return false;
  }
  return QQBOT_ABORT_TRIGGERS.has(normalizeQQBotAbortTriggerText(text));
}

export function isQQBotFastAbortCommandText(text: string): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  return (
    lower === "/stop" ||
    normalizeQQBotAbortTriggerText(lower) === "/stop" ||
    isQQBotAbortTrigger(lower)
  );
}

function toString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeQQBotDisplayAliasesMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim();
    const value = toString(rawValue);
    if (!key || !value) {
      continue;
    }
    aliases[key] = value;
  }
  return aliases;
}

function resolveQQBotDisplayAliasMaps(
  cfg: PluginConfig | undefined,
  accountId: string
): {
  globalAliases: Record<string, string>;
  accountAliases: Record<string, string>;
} {
  const qqbot = cfg?.channels?.qqbot;
  return {
    globalAliases: normalizeQQBotDisplayAliasesMap(qqbot?.displayAliases),
    accountAliases: normalizeQQBotDisplayAliasesMap(qqbot?.accounts?.[accountId]?.displayAliases),
  };
}

function resolveQQBotSenderName(params: {
  inbound: QQInboundMessage;
  cfg?: PluginConfig;
  accountId: string;
}): QQBotSenderNameResolution {
  const { inbound, cfg, accountId } = params;
  const stableId = inbound.c2cOpenid?.trim() || inbound.senderId.trim();
  const { globalAliases, accountAliases } = resolveQQBotDisplayAliasMaps(cfg, accountId);

  if (inbound.type === "direct") {
    const knownTarget = stableId ? getKnownQQBotTarget({ accountId, target: `user:${stableId}` }) : undefined;
    const knownTargetDisplayName = knownTarget?.displayName?.trim();
    if (knownTargetDisplayName) {
      return {
        displayName: knownTargetDisplayName,
        persistentDisplayName: knownTargetDisplayName,
        source: "known-target",
        knownTargetDisplayName,
      };
    }

    const aliasKeys = [...new Set([`user:${stableId}`, stableId, inbound.senderId.trim()].filter(Boolean))];
    for (const aliasKey of aliasKeys) {
      const alias = accountAliases[aliasKey];
      if (alias) {
        return {
          displayName: alias,
          persistentDisplayName: alias,
          source: "account-alias",
          matchedAliasKey: aliasKey,
        };
      }
    }
    for (const aliasKey of aliasKeys) {
      const alias = globalAliases[aliasKey];
      if (alias) {
        return {
          displayName: alias,
          persistentDisplayName: alias,
          source: "global-alias",
          matchedAliasKey: aliasKey,
        };
      }
    }
  }

  return {
    displayName: stableId,
    source: "stable-id",
  };
}

function logQQBotSenderNameResolution(params: {
  logger: Logger;
  inbound: QQInboundMessage;
  accountId: string;
  resolution: QQBotSenderNameResolution;
}): void {
  const { logger, inbound, accountId, resolution } = params;
  logger.debug?.(
    `[display-name] accountId=${accountId} type=${inbound.type} senderId=${inbound.senderId} ` +
      `knownTarget=${resolution.knownTargetDisplayName ?? "-"} alias=${resolution.matchedAliasKey ?? "-"} ` +
      `final=${JSON.stringify(resolution.displayName)} source=${resolution.source}`
  );
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

function parseQQBotRefIndices(payload: Record<string, unknown>): {
  refMsgIdx?: string;
  msgIdx?: string;
} {
  const scene = payload.message_scene;
  if (!scene || typeof scene !== "object") {
    return {};
  }

  const ext = (scene as { ext?: unknown }).ext;
  if (!Array.isArray(ext)) {
    return {};
  }

  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;

  for (const value of ext) {
    const item = toString(value);
    if (!item) continue;
    if (item.startsWith("ref_msg_idx=")) {
      refMsgIdx = toString(item.slice("ref_msg_idx=".length));
      continue;
    }
    if (item.startsWith("msg_idx=")) {
      msgIdx = toString(item.slice("msg_idx=".length));
    }
  }

  return {
    ...(refMsgIdx ? { refMsgIdx } : {}),
    ...(msgIdx ? { msgIdx } : {}),
  };
}

function resolveEventId(payload: Record<string, unknown>, fallbackEventId?: string): string | undefined {
  return toString(payload.event_id) ?? toString(payload.eventId) ?? toString(fallbackEventId);
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
export const LONG_TASK_NOTICE_TEXT = "任务处理时间较长，请稍等，我还在继续处理。";
export const DEFAULT_LONG_TASK_NOTICE_DELAY_MS = 30000;
const QQ_GROUP_NO_REPLY_FALLBACK_TEXT = "我在。你可以直接说具体一点。";
const QQ_QUOTE_BODY_UNAVAILABLE_TEXT = "原始内容不可用";

type LongTaskNoticeController = {
  markReplyDelivered: () => void;
  dispose: () => void;
};

type QQBotTypingHeartbeatController = {
  stop: () => void;
  dispose: () => void;
};

export function startLongTaskNoticeTimer(params: {
  delayMs: number;
  logger: Pick<Logger, "warn">;
  sendNotice: () => Promise<void>;
}): LongTaskNoticeController {
  const { delayMs, logger, sendNotice } = params;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  if (delayMs > 0) {
    timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      timer = null;
      void sendNotice().catch((err) => {
        logger.warn(`send long-task notice failed: ${String(err)}`);
      });
    }, delayMs);
    timer.unref?.();
  } else {
    completed = true;
  }

  return {
    markReplyDelivered: () => {
      if (completed) return;
      completed = true;
      clear();
    },
    dispose: () => {
      completed = true;
      clear();
    },
  };
}

export function startQQBotTypingHeartbeat(params: {
  intervalMs: number;
  renew: () => Promise<void>;
  shouldRenew?: () => boolean;
}): QQBotTypingHeartbeatController {
  const { intervalMs, renew, shouldRenew } = params;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let renewalInFlight = false;

  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clear();
  };

  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (stopped || renewalInFlight) return;
      if (shouldRenew && !shouldRenew()) return;
      renewalInFlight = true;
      void renew()
        .catch(() => undefined)
        .finally(() => {
          renewalInFlight = false;
        });
    }, intervalMs);
    timer.unref?.();
  }

  return {
    stop,
    dispose: stop,
  };
}

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
  qqCfg: QQBotAccountConfig;
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
  const inboundMediaDir = resolveInboundMediaDir(qqCfg);
  const inboundMediaTempDir = resolveInboundMediaTempDir();

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
          tempDir: inboundMediaTempDir,
        });
        const finalPath = await finalizeInboundMediaFile({
          filePath: downloaded.path,
          tempDir: inboundMediaTempDir,
          inboundDir: inboundMediaDir,
        });
        next.localImagePath = finalPath;
        logger.info(`inbound image cached: ${finalPath}`);
        if (finalPath === downloaded.path) {
          scheduleTempCleanup(downloaded.path);
        }
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

function resolveRefAttachmentType(attachment: QQInboundAttachment): RefAttachmentSummary["type"] {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("image/") || isImageAttachment(attachment)) {
    return "image";
  }
  if (contentType === "voice" || contentType.startsWith("audio/") || isVoiceAttachment(attachment)) {
    return "voice";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }

  const mediaType = detectMediaType(attachment.filename?.trim() || attachment.url);
  if (mediaType === "image") return "image";
  if (mediaType === "audio") return "voice";
  if (mediaType === "video") return "video";
  if (mediaType === "file") return "file";
  return "unknown";
}

function buildInboundRefAttachmentSummaries(
  attachments: ResolvedInboundAttachment[]
): RefAttachmentSummary[] | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  return attachments.map((item) => ({
    type: resolveRefAttachmentType(item.attachment),
    ...(item.attachment.filename?.trim() ? { filename: item.attachment.filename.trim() } : {}),
    ...(item.attachment.contentType?.trim() ? { contentType: item.attachment.contentType.trim() } : {}),
    ...(item.localImagePath?.trim() ? { localPath: item.localImagePath.trim() } : {}),
    ...(item.attachment.url?.trim() ? { url: item.attachment.url.trim() } : {}),
    ...(item.voiceTranscript?.trim()
      ? {
          transcript: item.voiceTranscript.trim(),
          transcriptSource: "asr" as const,
        }
      : {}),
  }));
}

function buildQuotedAgentBody(params: {
  baseBody: string;
  replyToBody: string;
}): string {
  const quoteBlock = `[引用消息开始]\n${params.replyToBody}\n[引用消息结束]`;
  return params.baseBody ? `${quoteBlock}\n\n${params.baseBody}` : quoteBlock;
}

function resolveAgentBodyBase(ctx: InboundContext): string {
  if (typeof ctx.BodyForAgent === "string" && ctx.BodyForAgent.trim()) {
    return ctx.BodyForAgent;
  }
  if (typeof ctx.RawBody === "string" && ctx.RawBody.trim()) {
    return ctx.RawBody;
  }
  if (typeof ctx.Body === "string" && ctx.Body.trim()) {
    return ctx.Body;
  }
  if (typeof ctx.CommandBody === "string" && ctx.CommandBody.trim()) {
    return ctx.CommandBody;
  }
  return "";
}

function uniqueRefIndexKeys(...values: Array<string | undefined>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = value?.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    keys.push(next);
  }
  return keys;
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

function parseC2CMessage(data: unknown, fallbackEventId?: string): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const refIndices = parseQQBotRefIndices(payload);
  const id = toString(payload.id);
  const eventId = resolveEventId(payload, fallbackEventId);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const author = asRecord(payload.author) ?? {};
  const senderId = toString(author.user_openid);
  if ((!text && attachments.length === 0) || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    c2cOpenid: senderId,
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    eventId,
    timestamp,
    ...refIndices,
    mentionedBot: false,
  };
}

function parseGroupMessage(data: unknown, fallbackEventId?: string): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const eventId = resolveEventId(payload, fallbackEventId);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const groupOpenid = toString(payload.group_openid);
  const author = asRecord(payload.author) ?? {};
  const senderId = toString(author.member_openid);
  if ((!text && attachments.length === 0) || !id || !senderId || !groupOpenid) return null;

  return {
    type: "group",
    senderId,
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    eventId,
    timestamp,
    groupOpenid,
    mentionedBot: true,
  };
}

function parseChannelMessage(data: unknown, fallbackEventId?: string): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const eventId = resolveEventId(payload, fallbackEventId);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const channelId = toString(payload.channel_id);
  const guildId = toString(payload.guild_id);
  const author = asRecord(payload.author) ?? {};
  const senderId = toString(author.id);
  if ((!text && attachments.length === 0) || !id || !senderId || !channelId) return null;

  return {
    type: "channel",
    senderId,
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    eventId,
    timestamp,
    channelId,
    guildId,
    mentionedBot: true,
  };
}

function parseDirectMessage(data: unknown, fallbackEventId?: string): QQInboundMessage | null {
  const payload = data as Record<string, unknown>;
  const { text, attachments } = parseTextWithAttachments(payload);
  const id = toString(payload.id);
  const eventId = resolveEventId(payload, fallbackEventId);
  const timestamp = toNumber(payload.timestamp) ?? Date.now();
  const guildId = toString(payload.guild_id);
  const author = asRecord(payload.author) ?? {};
  const senderId = toString(author.id);
  if ((!text && attachments.length === 0) || !id || !senderId) return null;

  return {
    type: "direct",
    senderId,
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId: id,
    eventId,
    timestamp,
    guildId,
    mentionedBot: false,
  };
}

function resolveInbound(eventType: string, data: unknown, fallbackEventId?: string): QQInboundMessage | null {
  switch (eventType) {
    case "C2C_MESSAGE_CREATE":
      return parseC2CMessage(data, fallbackEventId);
    case "GROUP_AT_MESSAGE_CREATE":
      return parseGroupMessage(data, fallbackEventId);
    case "AT_MESSAGE_CREATE":
      return parseChannelMessage(data, fallbackEventId);
    case "DIRECT_MESSAGE_CREATE":
      return parseDirectMessage(data, fallbackEventId);
    default:
      return null;
  }
}

function resolveChatTarget(event: QQInboundMessage): { to: string; peerId: string; peerKind: "group" | "dm" } {
  if (event.type === "group") {
    const group = event.groupOpenid ?? "";
    const normalizedGroup = group.toLowerCase();
    return {
      to: `group:${group}`,
      peerId: `group:${normalizedGroup}`,
      peerKind: "group",
    };
  }
  if (event.type === "channel") {
    const channel = event.channelId ?? "";
    const normalizedChannel = channel.toLowerCase();
    return {
      to: `channel:${channel}`,
      peerId: `channel:${normalizedChannel}`,
      peerKind: "group",
    };
  }
  return {
    to: `user:${event.senderId}`,
    peerId: event.senderId,
    peerKind: "dm",
  };
}

function resolveQQBotEffectiveSessionKey(params: {
  inbound: QQInboundMessage;
  route: QQBotAgentRoute;
  accountId: string;
}): string {
  const { inbound, route, accountId } = params;
  if (inbound.type !== "direct") {
    return route.sessionKey;
  }

  const senderStableId = inbound.c2cOpenid?.trim() || inbound.senderId?.trim();
  if (!senderStableId) {
    return route.sessionKey;
  }

  const resolvedAccountId = route.accountId?.trim() || accountId.trim() || DEFAULT_ACCOUNT_ID;
  return buildQQBotDirectSessionKey({
    routeSessionKey: route.sessionKey,
    accountId: resolvedAccountId,
    senderStableId,
  });
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

export function resolveKnownQQBotTargetFromInbound(params: {
  inbound: QQInboundMessage;
  accountId: string;
  persistentDisplayName?: string;
}): KnownQQBotTarget | undefined {
  const { inbound, accountId, persistentDisplayName } = params;

  if (inbound.type === "direct") {
    if (!inbound.c2cOpenid?.trim()) {
      return undefined;
    }
    return {
      accountId,
      kind: "user",
      target: `user:${inbound.c2cOpenid}`,
      ...(persistentDisplayName ? { displayName: persistentDisplayName } : {}),
      sourceChatType: "direct",
      firstSeenAt: inbound.timestamp,
      lastSeenAt: inbound.timestamp,
    };
  }

  if (inbound.type === "group" && inbound.groupOpenid?.trim()) {
    return {
      accountId,
      kind: "group",
      target: `group:${inbound.groupOpenid}`,
      ...(persistentDisplayName ? { displayName: persistentDisplayName } : {}),
      sourceChatType: "group",
      firstSeenAt: inbound.timestamp,
      lastSeenAt: inbound.timestamp,
    };
  }

  if (inbound.type === "channel" && inbound.channelId?.trim()) {
    return {
      accountId,
      kind: "channel",
      target: `channel:${inbound.channelId}`,
      ...(persistentDisplayName ? { displayName: persistentDisplayName } : {}),
      sourceChatType: "channel",
      firstSeenAt: inbound.timestamp,
      lastSeenAt: inbound.timestamp,
    };
  }

  return undefined;
}

function extractLocalMediaFromText(params: {
  text: string;
  logger?: Logger;
}): { text: string; mediaUrls: string[] } {
  const { text, logger } = params;
  const mediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  let nextText = text;
  const MARKDOWN_LINKED_IMAGE_RE = /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g;
  const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
  const BARE_LOCAL_MEDIA_PATH_RE =
    /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|\/mnt\/[A-Za-z]\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp|svg|ico|mp3|wav|ogg|m4a|amr|flac|aac|wma|mp4|mov|avi|mkv|webm|flv|wmv|m4v))`?/gi;

  const collectLocalRichMedia = (
    rawValue: string,
    allowedTypes?: ReadonlySet<"image" | "audio" | "video">
  ): string | undefined => {
    const candidate = stripTitleFromUrl(rawValue.trim());
    if (!candidate || !isLocalReference(candidate)) {
      return undefined;
    }
    if (!fs.existsSync(candidate)) {
      logger?.warn?.(`[media] local file not found: ${candidate}`);
      return undefined;
    }
    const mediaType = detectMediaType(candidate);
    if (mediaType === "file") {
      return undefined;
    }
    if (allowedTypes && !allowedTypes.has(mediaType)) {
      return undefined;
    }
    if (seenMedia.has(candidate)) {
      return candidate;
    }
    seenMedia.add(candidate);
    mediaUrls.push(candidate);
    return candidate;
  };

  nextText = nextText.replace(MARKDOWN_LINKED_IMAGE_RE, (fullMatch, _alt, rawPath) => {
    return collectLocalRichMedia(rawPath) ? "" : fullMatch;
  });

  nextText = nextText.replace(MARKDOWN_IMAGE_RE, (fullMatch, _alt, rawPath) => {
    return collectLocalRichMedia(rawPath) ? "" : fullMatch;
  });

  nextText = nextText.replace(MARKDOWN_LINK_RE, (fullMatch, _label, rawPath) => {
    const mediaPath = collectLocalRichMedia(rawPath, new Set(["audio", "video"]));
    if (!mediaPath) {
      return fullMatch;
    }
    return "";
  });

  nextText = nextText.replace(BARE_LOCAL_MEDIA_PATH_RE, (fullMatch, rawPath) => {
    return collectLocalRichMedia(rawPath) ? "" : fullMatch;
  });

  nextText = nextText.replace(/[ \t]+\n/g, "\n");
  nextText = nextText.replace(/\n{3,}/g, "\n\n");

  return {
    text: nextText.trim(),
    mediaUrls,
  };
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

export function extractQQBotReplyMedia(params: {
  text: string;
  logger?: Logger;
  autoSendLocalPathMedia?: boolean;
}): { text: string; mediaUrls: string[] } {
  const mediaLineResult = extractMediaLinesFromText({
    text: params.text,
    logger: params.logger,
  });
  if (!params.autoSendLocalPathMedia) {
    return mediaLineResult;
  }

  const localMediaResult = extractLocalMediaFromText({
    text: mediaLineResult.text,
    logger: params.logger,
  });

  return {
    text: localMediaResult.text,
    mediaUrls: [...new Set([...mediaLineResult.mediaUrls, ...localMediaResult.mediaUrls])],
  };
}

function buildMediaFallbackText(mediaUrl: string): string | undefined {
  if (!/^https?:\/\//i.test(mediaUrl)) {
    return undefined;
  }
  return `📎 ${mediaUrl}`;
}

const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const FINAL_BLOCK_RE = /<final\b[^>]*>([\s\S]*?)<\/final>/gi;
const RAW_THINK_OR_FINAL_TAG_RE = /<\/?(?:think|final)\b[^>]*>/gi;
const FILE_PLACEHOLDER_RE = /\[文件:\s*[^\]\n]+\]/g;
const DIRECTIVE_TAG_RE =
  /\[\[\s*(?:reply_to_current|reply_to\s*:[^\]]+|audio_as_voice|tts(?::text)?|\/tts(?::text)?)\s*\]\]/gi;
const VOICE_EMOTION_TAG_RE =
  /\[(?:happy|excited|calm|sad|angry|frustrated|softly|whispers|loudly|cheerfully|deadpan|sarcastically|laughs|sighs|chuckles|gasps|pause|slowly|rushed|hesitates|playfully|warmly|gently)\]/gi;
const TTS_LIKE_RAW_TEXT_RE =
  /\[\[\s*(?:tts(?::text)?|\/tts(?::text)?|audio_as_voice|reply_to_current|reply_to\s*:)/i;
const MARKDOWN_TABLE_SEPARATOR_RE = /^\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?)?\|?$/;
const MARKDOWN_THEMATIC_BREAK_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/;
const MARKDOWN_ATX_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const MARKDOWN_BLOCKQUOTE_RE = /^\s{0,3}>\s?/;
const MARKDOWN_FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const MARKDOWN_LIST_ITEM_RE = /^\s*(?:[-+*]|\d+\.)\s+/;
const MARKDOWN_LIST_CONTINUATION_RE = /^\s{2,}\S/;
const MARKDOWN_INLINE_STRUCTURE_RE = /(?:\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\*[^*\n]+\*)/;
const MARKDOWN_BOUNDARY_GUARD_RE = /[`*_~|]/;
const EXPLICIT_MARKDOWN_FENCE_RE = /(^|\n)(`{3,}|~{3,})\s*(?:markdown|md)\s*\n([\s\S]*?)\n\2(?=\n|$)/gi;
const GENERIC_MARKDOWN_FENCE_RE = /(^|\n)(`{3,}|~{3,})\s*\n([\s\S]*?)\n\2(?=\n|$)/g;
const QQBOT_MARKDOWN_SOFT_LIMIT_THRESHOLD = 128;
const QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_MIN = 16;
const QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_MAX = 320;
const QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_RATIO = 0.18;

type QQBotMarkdownBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "blockquote"
  | "table"
  | "code"
  | "thematic-break";

type QQBotMarkdownBlock = {
  kind: QQBotMarkdownBlockKind;
  text: string;
};

function extractFinalBlocks(text: string): string | undefined {
  const matches = Array.from(text.matchAll(FINAL_BLOCK_RE));
  if (matches.length === 0) return undefined;
  return matches.map((match) => (match[1] ?? "").trim()).filter(Boolean).join("\n");
}

export function sanitizeQQBotOutboundText(rawText: string): string {
  if (!rawText) return "";
  let next = rawText.replace(/\r\n/g, "\n");

  const finalOnly = extractFinalBlocks(next);
  if (typeof finalOnly === "string") {
    next = finalOnly;
  }

  next = next.replace(THINK_BLOCK_RE, "");
  next = next.replace(RAW_THINK_OR_FINAL_TAG_RE, "");
  next = next.replace(FILE_PLACEHOLDER_RE, " ");
  next = next.replace(DIRECTIVE_TAG_RE, " ");
  next = next.replace(VOICE_EMOTION_TAG_RE, " ");
  next = next.replace(/[ \t]+\n/g, "\n");
  next = next.replace(/\n{3,}/g, "\n\n");
  next = next.trim();

  if (!next) return "";
  if (/^NO_REPLY$/i.test(next)) return "";
  return next;
}

function formatQQBotOutboundPreview(text: string, maxLength = 240): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return '""';
  }
  const preview =
    normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
  return JSON.stringify(preview);
}

export function shouldSuppressQQBotTextWhenMediaPresent(rawText: string, sanitizedText: string): boolean {
  const raw = rawText.trim();
  if (!raw) return false;
  if (TTS_LIKE_RAW_TEXT_RE.test(raw)) return true;
  if (/<(?:think|final)\b/i.test(raw)) return true;
  if (!sanitizedText) return true;
  return !/[A-Za-z0-9\u4e00-\u9fff]/.test(sanitizedText);
}

export function resolveQQBotNoReplyFallback(params: {
  inbound: Pick<QQInboundMessage, "type" | "mentionedBot" | "content" | "attachments">;
  replyDelivered: boolean;
}): string | undefined {
  const { inbound, replyDelivered } = params;
  if (replyDelivered) return undefined;
  if (!inbound.mentionedBot) return undefined;
  if (inbound.type !== "group" && inbound.type !== "channel") return undefined;

  const hasVisibleInput = inbound.content.trim().length > 0 || (inbound.attachments?.length ?? 0) > 0;
  if (!hasVisibleInput) return undefined;

  return QQ_GROUP_NO_REPLY_FALLBACK_TEXT;
}

export function isQQBotGroupMessageInterfaceBlocked(errorMessage?: string): boolean {
  const text = (errorMessage ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("304103") ||
    text.includes("群内消息接口被临时封禁") ||
    text.includes("机器人存在安全风险")
  );
}

export function evaluateReplyFinalOnlyDelivery(params: {
  replyFinalOnly: boolean;
  kind?: string;
  hasMedia: boolean;
  sanitizedText: string;
}): { skipDelivery: boolean; suppressText: boolean } {
  const { replyFinalOnly, kind, hasMedia } = params;
  if (!replyFinalOnly || !kind || kind === "final") {
    return { skipDelivery: false, suppressText: false };
  }
  if (hasMedia) {
    return { skipDelivery: false, suppressText: true };
  }
  return { skipDelivery: true, suppressText: false };
}

function isQQBotC2CTarget(to: string): boolean {
  const trimmed = to.trim();
  const raw =
    trimmed.slice(0, "qqbot:".length).toLowerCase() === "qqbot:"
      ? trimmed.slice("qqbot:".length)
      : trimmed;
  const normalizedRaw = raw.toLowerCase();
  return !normalizedRaw.startsWith("group:") && !normalizedRaw.startsWith("channel:");
}

function splitQQBotMarkdownTransportMediaUrls(mediaUrls: string[]): {
  markdownImageUrls: string[];
  mediaQueue: string[];
} {
  const markdownImageUrls: string[] = [];
  const mediaQueue: string[] = [];
  const seenMarkdownImages = new Set<string>();
  const seenMedia = new Set<string>();

  for (const rawUrl of mediaUrls) {
    const next = rawUrl.trim();
    if (!next) continue;

    if (isQQBotHttpImageUrl(next)) {
      if (seenMarkdownImages.has(next)) continue;
      seenMarkdownImages.add(next);
      markdownImageUrls.push(next);
      continue;
    }

    if (seenMedia.has(next)) continue;
    seenMedia.add(next);
    mediaQueue.push(next);
  }

  return { markdownImageUrls, mediaQueue };
}

export function hasQQBotMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]?.trim() ?? "";
    const separator = lines[index + 1]?.trim() ?? "";
    if (!header.includes("|") || !MARKDOWN_TABLE_SEPARATOR_RE.test(separator)) {
      continue;
    }

    const headerColumns = header.split("|").filter((column) => column.trim()).length;
    const separatorColumns = separator.split("|").filter((column) => column.trim()).length;
    if (headerColumns >= 2 && separatorColumns >= 2) {
      return true;
    }
  }
  return false;
}

export function resolveQQBotTextReplyRefs(params: {
  to: string;
  text: string;
  markdownSupport: boolean;
  c2cMarkdownDeliveryMode?: QQBotC2CMarkdownDeliveryMode;
  replyToId?: string;
  replyEventId?: string;
}): {
  forceProactive: boolean;
  replyToId?: string;
  replyEventId?: string;
} {
  const mode = params.c2cMarkdownDeliveryMode ?? "proactive-table-only";
  const forceProactive =
    params.markdownSupport &&
    isQQBotC2CTarget(params.to) &&
    (mode === "proactive-all" ||
      (mode === "proactive-table-only" && hasQQBotMarkdownTable(params.text)));

  if (!forceProactive) {
    return {
      forceProactive: false,
      replyToId: params.replyToId,
      replyEventId: params.replyEventId,
    };
  }

  return {
    forceProactive: true,
    replyToId: undefined,
    replyEventId: undefined,
  };
}

export function appendQQBotBufferedText(bufferedTexts: string[], nextText: string): string[] {
  const normalized = nextText.trim();
  if (!normalized) return bufferedTexts;
  if (bufferedTexts.length === 0) return [normalized];

  const currentCombined = bufferedTexts.join("\n\n");
  if (currentCombined === normalized || currentCombined.includes(normalized)) {
    return bufferedTexts;
  }
  if (normalized.includes(currentCombined)) {
    return [normalized];
  }

  const last = bufferedTexts[bufferedTexts.length - 1];
  if (last === normalized) {
    return bufferedTexts;
  }

  return [...bufferedTexts, normalized];
}

function resolveQQBotLastNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .reverse()
    .find((line) => line.trim().length > 0);
}

function resolveQQBotFirstNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trimStart())
    .find((line) => line.trim().length > 0);
}

function resolveQQBotTrailingMarkdownTableColumnCount(text: string): number | undefined {
  const lines = text.split("\n");
  for (let index = Math.max(0, lines.length - 2); index >= 0; index -= 1) {
    if (!isQQBotMarkdownTableStart(lines, index)) {
      continue;
    }

    const trailingLines = lines.slice(index + 2).filter((line) => line.trim().length > 0);
    if (trailingLines.length === 0 || trailingLines.every((line) => line.includes("|"))) {
      return parseQQBotMarkdownTableRowCells(lines[index] ?? "").length;
    }
  }

  return undefined;
}

function mergeQQBotBufferedTextSegments(current: string, next: string): string {
  const currentTrimmed = current.trimEnd();
  const nextTrimmed = next.trimStart();
  if (!currentTrimmed) return nextTrimmed;
  if (!nextTrimmed) return currentTrimmed;
  if (currentTrimmed === nextTrimmed || currentTrimmed.includes(nextTrimmed)) {
    return currentTrimmed;
  }
  if (nextTrimmed.includes(currentTrimmed)) {
    return nextTrimmed;
  }

  const lastLine = resolveQQBotLastNonEmptyLine(currentTrimmed) ?? "";
  const firstLine = resolveQQBotFirstNonEmptyLine(nextTrimmed) ?? "";
  const trailingTableColumnCount = resolveQQBotTrailingMarkdownTableColumnCount(currentTrimmed);
  const lastLineLooksLikeTable = lastLine.includes("|");
  const firstLineLooksLikeTable = firstLine.startsWith("|");
  const firstLineContainsTableCell = firstLine.includes("|");
  const expectedPipeCount =
    typeof trailingTableColumnCount === "number" && trailingTableColumnCount > 0
      ? trailingTableColumnCount + 1
      : undefined;
  const lastLinePipeCount = (lastLine.match(/\|/g) ?? []).length;
  const firstLinePipeCount = (firstLine.match(/\|/g) ?? []).length;
  const sameRowJoiner =
    typeof expectedPipeCount === "number" &&
    lastLinePipeCount + firstLinePipeCount < expectedPipeCount
      ? " | "
      : " ";
  const lastLineEndsInsideTableRow = Boolean(
    trailingTableColumnCount &&
      lastLineLooksLikeTable &&
      (!lastLine.trimEnd().endsWith("|") ||
        (typeof expectedPipeCount === "number" && lastLinePipeCount < expectedPipeCount))
  );

  if (lastLineEndsInsideTableRow && nextTrimmed.includes("|")) {
    return `${currentTrimmed}${sameRowJoiner}${nextTrimmed}`;
  }

  if (firstLineLooksLikeTable) {
    if (lastLineLooksLikeTable || hasQQBotMarkdownTable(currentTrimmed)) {
      return `${currentTrimmed}\n${nextTrimmed}`;
    }
  }

  if (trailingTableColumnCount && firstLineContainsTableCell) {
    return `${currentTrimmed}${sameRowJoiner}${nextTrimmed}`;
  }

  return joinQQBotMarkdownPieces([currentTrimmed, nextTrimmed]);
}

export function combineQQBotBufferedText(bufferedTexts: string[]): string {
  return bufferedTexts.reduce((combined, segment) => {
    const normalized = segment.trim();
    if (!normalized) {
      return combined;
    }
    return mergeQQBotBufferedTextSegments(combined, normalized);
  }, "");
}

export function normalizeQQBotRenderedMarkdown(text: string): string {
  if (!text.trim()) return "";

  let next = text.trim();
  let changed = false;

  next = next.replace(
    EXPLICIT_MARKDOWN_FENCE_RE,
    (block, leadingLineBreak: string, _fence: string, inner: string) => {
      const normalizedInner = inner.trim();
      if (!normalizedInner) {
        return block;
      }
      changed = true;
      return `${leadingLineBreak}${normalizedInner}`;
    }
  );

  next = next.replace(
    GENERIC_MARKDOWN_FENCE_RE,
    (block, leadingLineBreak: string, _fence: string, inner: string) => {
      const normalizedInner = inner.trim();
      if (!normalizedInner) {
        return block;
      }
      if (!hasQQBotMarkdownTable(normalizedInner)) {
        return block;
      }
      changed = true;
      return `${leadingLineBreak}${normalizedInner}`;
    }
  );

  return changed ? next.trim() : text.trim();
}

function normalizeQQBotMarkdownSegment(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isBlankQQBotMarkdownLine(line: string): boolean {
  return line.trim().length === 0;
}

function resolveQQBotFenceDelimiter(line: string): string | undefined {
  const match = line.match(MARKDOWN_FENCE_RE);
  return match?.[1];
}

function isQQBotFenceClosingLine(line: string, delimiter: string): boolean {
  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closingRe = new RegExp(`^\\s*${escapedDelimiter}${delimiter[0]}*\\s*$`);
  return closingRe.test(line);
}

function joinQQBotMarkdownPieces(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n").trim();
}

function isQQBotMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim() ?? "";
  const separator = lines[index + 1]?.trim() ?? "";
  return Boolean(header.includes("|") && MARKDOWN_TABLE_SEPARATOR_RE.test(separator));
}

function collectQQBotFencedCodeBlock(
  lines: string[],
  startIndex: number
): { block: QQBotMarkdownBlock; nextIndex: number } {
  const openingLine = lines[startIndex] ?? "";
  const delimiter = resolveQQBotFenceDelimiter(openingLine) ?? "```";
  let index = startIndex + 1;
  while (index < lines.length) {
    if (isQQBotFenceClosingLine(lines[index] ?? "", delimiter)) {
      index += 1;
      break;
    }
    index += 1;
  }

  return {
    block: {
      kind: "code",
      text: lines.slice(startIndex, index).join("\n").trimEnd(),
    },
    nextIndex: index,
  };
}

function collectQQBotMarkdownTableBlock(
  lines: string[],
  startIndex: number
): { block: QQBotMarkdownBlock; nextIndex: number } {
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlankQQBotMarkdownLine(line) || !line.includes("|")) {
      break;
    }
    index += 1;
  }

  return {
    block: {
      kind: "table",
      text: lines.slice(startIndex, index).join("\n").trimEnd(),
    },
    nextIndex: index,
  };
}

function collectQQBotBlockquoteBlock(
  lines: string[],
  startIndex: number
): { block: QQBotMarkdownBlock; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (MARKDOWN_BLOCKQUOTE_RE.test(line)) {
      collected.push(line);
      index += 1;
      continue;
    }
    if (
      isBlankQQBotMarkdownLine(line) &&
      index + 1 < lines.length &&
      MARKDOWN_BLOCKQUOTE_RE.test(lines[index + 1] ?? "")
    ) {
      collected.push(line);
      index += 1;
      continue;
    }
    break;
  }

  return {
    block: {
      kind: "blockquote",
      text: collected.join("\n").trimEnd(),
    },
    nextIndex: index,
  };
}

function collectQQBotListBlock(
  lines: string[],
  startIndex: number
): { block: QQBotMarkdownBlock; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlankQQBotMarkdownLine(line)) {
      break;
    }
    if (
      MARKDOWN_FENCE_RE.test(line) ||
      MARKDOWN_BLOCKQUOTE_RE.test(line) ||
      MARKDOWN_ATX_HEADING_RE.test(line) ||
      MARKDOWN_THEMATIC_BREAK_RE.test(line) ||
      isQQBotMarkdownTableStart(lines, index)
    ) {
      break;
    }
    if (
      collected.length > 0 &&
      !MARKDOWN_LIST_ITEM_RE.test(line) &&
      !MARKDOWN_LIST_CONTINUATION_RE.test(line)
    ) {
      collected.push(line);
      index += 1;
      continue;
    }

    collected.push(line);
    index += 1;
  }

  return {
    block: {
      kind: "list",
      text: collected.join("\n").trimEnd(),
    },
    nextIndex: index,
  };
}

function collectQQBotParagraphBlock(
  lines: string[],
  startIndex: number
): { block: QQBotMarkdownBlock; nextIndex: number } {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlankQQBotMarkdownLine(line)) {
      break;
    }
    if (
      collected.length > 0 &&
      (MARKDOWN_FENCE_RE.test(line) ||
        MARKDOWN_BLOCKQUOTE_RE.test(line) ||
        MARKDOWN_ATX_HEADING_RE.test(line) ||
        MARKDOWN_THEMATIC_BREAK_RE.test(line) ||
        MARKDOWN_LIST_ITEM_RE.test(line) ||
        isQQBotMarkdownTableStart(lines, index))
    ) {
      break;
    }
    collected.push(line);
    index += 1;
  }

  return {
    block: {
      kind: "paragraph",
      text: collected.join("\n").trimEnd(),
    },
    nextIndex: index,
  };
}

function parseQQBotMarkdownBlocks(text: string): QQBotMarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: QQBotMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && isBlankQQBotMarkdownLine(lines[index] ?? "")) {
      index += 1;
    }
    if (index >= lines.length) {
      break;
    }

    const line = lines[index] ?? "";
    if (MARKDOWN_FENCE_RE.test(line)) {
      const result = collectQQBotFencedCodeBlock(lines, index);
      blocks.push(result.block);
      index = result.nextIndex;
      continue;
    }
    if (isQQBotMarkdownTableStart(lines, index)) {
      const result = collectQQBotMarkdownTableBlock(lines, index);
      blocks.push(result.block);
      index = result.nextIndex;
      continue;
    }
    if (MARKDOWN_THEMATIC_BREAK_RE.test(line)) {
      blocks.push({ kind: "thematic-break", text: line.trim() });
      index += 1;
      continue;
    }
    if (MARKDOWN_BLOCKQUOTE_RE.test(line)) {
      const result = collectQQBotBlockquoteBlock(lines, index);
      blocks.push(result.block);
      index = result.nextIndex;
      continue;
    }
    if (MARKDOWN_ATX_HEADING_RE.test(line)) {
      blocks.push({ kind: "heading", text: line.trimEnd() });
      index += 1;
      continue;
    }
    if (MARKDOWN_LIST_ITEM_RE.test(line)) {
      const result = collectQQBotListBlock(lines, index);
      blocks.push(result.block);
      index = result.nextIndex;
      continue;
    }

    const result = collectQQBotParagraphBlock(lines, index);
    blocks.push(result.block);
    index = result.nextIndex;
  }

  return blocks;
}

function hasQQBotBoundaryGuard(text: string): boolean {
  return MARKDOWN_BOUNDARY_GUARD_RE.test(text);
}

function measureQQBotUtf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function findQQBotIndexWithinUtf8Limit(text: string, limit: number): number {
  if (limit <= 0 || !text) {
    return 0;
  }

  let totalBytes = 0;
  let index = 0;

  for (const char of text) {
    const charBytes = measureQQBotUtf8Length(char);
    if (totalBytes + charBytes > limit) {
      break;
    }
    totalBytes += charBytes;
    index += char.length;
  }

  return index;
}

function isQQBotSafeMarkdownBoundary(text: string, index: number): boolean {
  const left = text.slice(Math.max(0, index - 3), index).replace(/\s+/g, "");
  const right = text.slice(index, Math.min(text.length, index + 3)).replace(/\s+/g, "");
  const leftEdge = left.slice(-1);
  const rightEdge = right.slice(0, 1);
  return !hasQQBotBoundaryGuard(leftEdge) && !hasQQBotBoundaryGuard(rightEdge);
}

function findQQBotRegexBoundary(text: string, limit: number, pattern: RegExp): number | undefined {
  const scopedIndex = findQQBotIndexWithinUtf8Limit(text, limit);
  const scopedText = text.slice(0, scopedIndex);
  const regex = new RegExp(pattern.source, pattern.flags);
  let match = regex.exec(scopedText);
  let lastBoundary: number | undefined;

  while (match) {
    const boundary = match.index + match[0].length;
    if (
      boundary > 0 &&
      measureQQBotUtf8Length(text.slice(0, boundary)) <= limit &&
      isQQBotSafeMarkdownBoundary(text, boundary)
    ) {
      lastBoundary = boundary;
    }
    match = regex.exec(scopedText);
  }

  return lastBoundary;
}

function findQQBotFallbackBoundary(text: string, limit: number): number {
  const maxIndex = findQQBotIndexWithinUtf8Limit(text, limit);
  const minIndex = Math.max(1, maxIndex - 120);
  for (let index = maxIndex; index >= minIndex; index -= 1) {
    if (isQQBotSafeMarkdownBoundary(text, index)) {
      return index;
    }
  }
  return maxIndex;
}

function findQQBotSafeSplitIndex(text: string, limit: number): number {
  const boundaryPatterns = [
    /\n\n+/g,
    /\n/g,
    /[。！？.!?；;:：](?:\s+|$)/g,
    /[,，](?:\s+|$)/g,
    /\s+/g,
  ];

  for (const pattern of boundaryPatterns) {
    const boundary = findQQBotRegexBoundary(text, limit, pattern);
    if (boundary && boundary > 0) {
      return boundary;
    }
  }

  return findQQBotFallbackBoundary(text, limit);
}

function splitQQBotHardText(text: string, limit: number): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(text) <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (measureQQBotUtf8Length(remaining) > limit) {
    const nextIndex = Math.max(1, findQQBotIndexWithinUtf8Limit(remaining, limit));
    chunks.push(remaining.slice(0, nextIndex));
    remaining = remaining.slice(nextIndex);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function splitQQBotTextSafely(
  text: string,
  limit: number,
  options?: { trimLeading?: boolean; trimTrailing?: boolean }
): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(text) <= limit) {
    return [text];
  }

  const trimLeading = options?.trimLeading ?? true;
  const trimTrailing = options?.trimTrailing ?? true;
  const chunks: string[] = [];
  let remaining = text;

  while (measureQQBotUtf8Length(remaining) > limit) {
    const splitIndex = findQQBotSafeSplitIndex(remaining, limit);
    let nextChunk = remaining.slice(0, splitIndex);
    let nextRemaining = remaining.slice(splitIndex);

    if (trimTrailing) {
      nextChunk = nextChunk.trimEnd();
    }
    if (trimLeading) {
      nextRemaining = nextRemaining.trimStart();
    }

    if (!nextChunk) {
      const hardChunkIndex = Math.max(1, findQQBotIndexWithinUtf8Limit(remaining, limit));
      const hardChunk = remaining.slice(0, hardChunkIndex);
      chunks.push(hardChunk);
      remaining = remaining.slice(hardChunk.length);
      continue;
    }

    chunks.push(nextChunk);
    remaining = nextRemaining;
  }

  const finalChunk = trimTrailing ? remaining.trimEnd() : remaining;
  if (finalChunk) {
    chunks.push(finalChunk);
  }

  return chunks;
}

function splitQQBotMarkdownLineBlock(text: string, limit: number): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(text) <= limit) {
    return [text];
  }

  const lines = text.split("\n");
  const chunks: string[] = [];
  let currentLines: string[] = [];

  const flushCurrent = (): void => {
    if (currentLines.length === 0) {
      return;
    }
    const chunk = currentLines.join("\n").trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    currentLines = [];
  };

  for (const line of lines) {
    const candidate = currentLines.length > 0 ? `${currentLines.join("\n")}\n${line}` : line;
    if (measureQQBotUtf8Length(candidate) <= limit) {
      currentLines.push(line);
      continue;
    }

    flushCurrent();
    if (measureQQBotUtf8Length(line) <= limit) {
      currentLines.push(line);
      continue;
    }

    for (const piece of splitQQBotTextSafely(line, limit, {
      trimLeading: false,
      trimTrailing: false,
    })) {
      if (piece) {
        chunks.push(piece);
      }
    }
  }

  flushCurrent();
  return chunks;
}

function parseQQBotMarkdownTableRowCells(row: string, columnCount?: number): string[] {
  const trimmed = row.trim();
  const inner = trimmed.replace(/^\|\s*/, "").replace(/\s*\|$/, "");
  const cells = inner.split("|").map((cell) => cell.trim());

  if (typeof columnCount !== "number" || !Number.isFinite(columnCount) || columnCount <= 0) {
    return cells;
  }

  if (cells.length >= columnCount) {
    return cells.slice(0, columnCount);
  }

  return [...cells, ...Array.from({ length: columnCount - cells.length }, () => "")];
}

function renderQQBotMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function splitQQBotMarkdownTableRowByCells(params: {
  row: string;
  columnCount: number;
  limit: number;
  anchorColumnCount?: number;
}): string[] {
  const { row, columnCount, limit } = params;
  const normalizedCells = parseQQBotMarkdownTableRowCells(row, columnCount);
  const normalizedRow = renderQQBotMarkdownTableRow(normalizedCells);
  if (measureQQBotUtf8Length(normalizedRow) <= limit) {
    return [normalizedRow];
  }

  const anchorColumnCount = Math.min(
    Math.max(1, params.anchorColumnCount ?? 2),
    columnCount
  );
  const anchorCells = normalizedCells.map((cell, index) =>
    index < anchorColumnCount ? cell : ""
  );
  const chunks: string[] = [];
  let currentCells = [...anchorCells];
  let hasContent = false;

  const flushCurrent = (): void => {
    if (!hasContent) {
      return;
    }
    chunks.push(renderQQBotMarkdownTableRow(currentCells));
    currentCells = [...anchorCells];
    hasContent = false;
  };

  for (let index = anchorColumnCount; index < columnCount; index += 1) {
    const cell = normalizedCells[index] ?? "";
    if (!cell) {
      continue;
    }

    const candidateCells = [...currentCells];
    candidateCells[index] = cell;
    if (measureQQBotUtf8Length(renderQQBotMarkdownTableRow(candidateCells)) <= limit) {
      currentCells[index] = cell;
      hasContent = true;
      continue;
    }

    if (hasContent) {
      flushCurrent();
      const nextCandidateCells = [...currentCells];
      nextCandidateCells[index] = cell;
      if (measureQQBotUtf8Length(renderQQBotMarkdownTableRow(nextCandidateCells)) <= limit) {
        currentCells[index] = cell;
        hasContent = true;
        continue;
      }
    }

    const emptyRowBytes = measureQQBotUtf8Length(renderQQBotMarkdownTableRow(currentCells));
    const availableCellBytes = Math.max(1, limit - emptyRowBytes);
    for (const cellPiece of splitQQBotTextSafely(cell, availableCellBytes, {
      trimLeading: false,
      trimTrailing: false,
    })) {
      const pieceCells = [...anchorCells];
      pieceCells[index] = cellPiece;
      chunks.push(renderQQBotMarkdownTableRow(pieceCells));
    }
    currentCells = [...anchorCells];
    hasContent = false;
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : splitQQBotTextSafely(normalizedRow, limit);
}

function resolveQQBotMarkdownTableBlockLimit(params: {
  header: string;
  separator: string;
  rows: string[];
  limit: number;
}): number {
  const { header, separator, rows, limit } = params;
  if (limit <= 512) {
    return limit;
  }

  const columnCount = parseQQBotMarkdownTableRowCells(header).length;
  if (columnCount < 8) {
    return limit;
  }

  const tablePrefixBytes = measureQQBotUtf8Length(`${header}\n${separator}`);
  const extraColumnCount = Math.max(0, columnCount - 7);
  const columnPenalty = Math.min(240, extraColumnCount * 55);
  const headerPenalty = Math.min(120, Math.floor(tablePrefixBytes * 0.25));
  const reducedLimit = limit - columnPenalty - headerPenalty;
  const minTableLimit = Math.max(tablePrefixBytes + 64, Math.floor(limit * 0.45));
  const maxSingleRowRequirement = Math.min(
    limit,
    rows.reduce((max, row) => {
      const normalizedRow = renderQQBotMarkdownTableRow(
        parseQQBotMarkdownTableRowCells(row, columnCount)
      );
      return Math.max(max, measureQQBotUtf8Length(`${header}\n${separator}\n${normalizedRow}`));
    }, tablePrefixBytes)
  );

  return Math.min(
    limit,
    Math.max(maxSingleRowRequirement, minTableLimit, Math.min(limit, reducedLimit))
  );
}

function splitQQBotMarkdownTableBlock(text: string, limit: number): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(text) <= limit) {
    return [text];
  }

  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const separator = lines[1] ?? "";
  const rows = lines.slice(2);
  const packingLimit = resolveQQBotMarkdownTableBlockLimit({
    header,
    separator,
    rows,
    limit,
  });
  const tablePrefix = `${header}\n${separator}`;
  const columnCount = parseQQBotMarkdownTableRowCells(header).length;
  const chunks: string[] = [];
  let currentRows: string[] = [];

  const flushCurrent = (): void => {
    if (currentRows.length === 0) {
      return;
    }
    chunks.push(`${tablePrefix}\n${currentRows.join("\n")}`);
    currentRows = [];
  };

  for (const row of rows) {
    const candidate =
      currentRows.length > 0
        ? `${tablePrefix}\n${currentRows.join("\n")}\n${row}`
        : `${tablePrefix}\n${row}`;
    if (measureQQBotUtf8Length(candidate) <= packingLimit) {
      currentRows.push(row);
      continue;
    }

    flushCurrent();
    if (measureQQBotUtf8Length(`${tablePrefix}\n${row}`) <= limit) {
      currentRows.push(row);
      continue;
    }

    const maxRowLength = Math.max(16, limit - measureQQBotUtf8Length(tablePrefix) - 1);
    for (const rowPiece of splitQQBotMarkdownTableRowByCells({
      row,
      columnCount,
      limit: maxRowLength,
    })) {
      chunks.push(`${tablePrefix}\n${rowPiece}`);
    }
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [text];
}

function splitQQBotMarkdownCodeFence(text: string, limit: number): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(text) <= limit) {
    return [text];
  }

  const lines = text.split("\n");
  const openingLine = lines[0] ?? "```";
  const delimiter = resolveQQBotFenceDelimiter(openingLine) ?? "```";
  const hasClosingFence =
    lines.length > 1 && isQQBotFenceClosingLine(lines[lines.length - 1] ?? "", delimiter);
  const closingLine = hasClosingFence ? lines[lines.length - 1] ?? delimiter : delimiter;
  const codeLines = lines.slice(1, hasClosingFence ? -1 : lines.length);
  const fixedOverhead =
    measureQQBotUtf8Length(openingLine) + measureQQBotUtf8Length(closingLine) + 2;
  const availableLineLength = Math.max(1, limit - fixedOverhead);
  const chunks: string[] = [];
  let currentCodeLines: string[] = [];

  const flushCurrent = (): void => {
    if (currentCodeLines.length === 0) {
      return;
    }
    chunks.push(`${openingLine}\n${currentCodeLines.join("\n")}\n${closingLine}`);
    currentCodeLines = [];
  };

  for (const codeLine of codeLines) {
    const candidate =
      currentCodeLines.length > 0
        ? `${openingLine}\n${currentCodeLines.join("\n")}\n${codeLine}\n${closingLine}`
        : `${openingLine}\n${codeLine}\n${closingLine}`;
    if (measureQQBotUtf8Length(candidate) <= limit) {
      currentCodeLines.push(codeLine);
      continue;
    }

    flushCurrent();
    if (measureQQBotUtf8Length(`${openingLine}\n${codeLine}\n${closingLine}`) <= limit) {
      currentCodeLines.push(codeLine);
      continue;
    }

    for (const linePiece of splitQQBotHardText(codeLine, availableLineLength)) {
      chunks.push(`${openingLine}\n${linePiece}\n${closingLine}`);
    }
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [text];
}

function splitQQBotMarkdownBlock(block: QQBotMarkdownBlock, limit: number): string[] {
  if (limit <= 0 || measureQQBotUtf8Length(block.text) <= limit) {
    return [block.text];
  }

  switch (block.kind) {
    case "table":
      return splitQQBotMarkdownTableBlock(block.text, limit);
    case "code":
      return splitQQBotMarkdownCodeFence(block.text, limit);
    case "blockquote":
      return splitQQBotMarkdownLineBlock(block.text, limit);
    case "list":
      return splitQQBotMarkdownLineBlock(block.text, limit);
    case "paragraph":
    case "heading":
      return splitQQBotTextSafely(block.text, limit);
    case "thematic-break":
      return [block.text];
    default:
      return [block.text];
  }
}

function resolveQQBotStructuredMarkdownSoftLimit(
  limit: number,
  safeChunkByteLimit?: number
): number {
  if (limit <= QQBOT_MARKDOWN_SOFT_LIMIT_THRESHOLD) {
    return limit;
  }

  const configuredSafeLimit =
    typeof safeChunkByteLimit === "number" && Number.isFinite(safeChunkByteLimit) && safeChunkByteLimit > 0
      ? Math.floor(safeChunkByteLimit)
      : undefined;
  if (configuredSafeLimit) {
    return Math.min(limit, configuredSafeLimit);
  }

  const reservedLength = Math.min(
    QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_MAX,
    Math.max(
      QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_MIN,
      Math.floor(limit * QQBOT_MARKDOWN_SOFT_LIMIT_HEADROOM_RATIO)
    )
  );
  const softLimit = limit - reservedLength;
  const boundedSoftLimit = Math.min(
    softLimit > 0 ? softLimit : limit,
    DEFAULT_QQBOT_C2C_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT
  );
  return boundedSoftLimit > 0 ? boundedSoftLimit : limit;
}

function maybePrefixQQBotContinuationPiece(params: {
  prefix?: string;
  piece: string;
  limit: number;
}): string {
  const prefix = params.prefix?.trim();
  if (!prefix) {
    return params.piece;
  }

  const prefixedPiece = joinQQBotMarkdownPieces([prefix, params.piece]);
  return measureQQBotUtf8Length(prefixedPiece) <= params.limit ? prefixedPiece : params.piece;
}

function resolveQQBotMarkdownLeadPiece(
  blocks: QQBotMarkdownBlock[],
  index: number,
  limit: number
): string | undefined {
  const block = blocks[index];
  if (!block) {
    return undefined;
  }

  if (block.kind === "heading") {
    const nextBlock = blocks[index + 1];
    if (nextBlock && nextBlock.kind !== "thematic-break") {
      const nextPieces = splitQQBotMarkdownBlock(nextBlock, limit);
      const firstBodyPiece = nextPieces[0];
      if (firstBodyPiece) {
        const pairedText = joinQQBotMarkdownPieces([block.text, firstBodyPiece]);
        if (measureQQBotUtf8Length(pairedText) <= limit) {
          return pairedText;
        }
      }
    }
  }

  return splitQQBotMarkdownBlock(block, limit)
    .map((piece) => piece.trim())
    .find(Boolean);
}

function shouldQQBotCarryThematicBreakToNextBlock(params: {
  blocks: QQBotMarkdownBlock[];
  index: number;
  currentPieces: string[];
  limit: number;
}): boolean {
  const block = params.blocks[params.index];
  if (!block || block.kind !== "thematic-break") {
    return false;
  }

  if (params.currentPieces.length === 0) {
    return true;
  }

  const withBreak = joinQQBotMarkdownPieces([...params.currentPieces, block.text]);
  if (measureQQBotUtf8Length(withBreak) > params.limit) {
    return true;
  }

  const nextLeadPiece = resolveQQBotMarkdownLeadPiece(
    params.blocks,
    params.index + 1,
    params.limit
  );
  if (!nextLeadPiece) {
    return false;
  }

  const prefixedLeadPiece = joinQQBotMarkdownPieces([block.text, nextLeadPiece]);
  if (measureQQBotUtf8Length(prefixedLeadPiece) > params.limit) {
    return false;
  }

  const sectionCandidate = joinQQBotMarkdownPieces([
    ...params.currentPieces,
    block.text,
    nextLeadPiece,
  ]);
  return measureQQBotUtf8Length(sectionCandidate) > params.limit;
}

function chunkQQBotStructuredMarkdown(
  text: string,
  limit: number,
  safeChunkByteLimit?: number
): string[] {
  const blocks = parseQQBotMarkdownBlocks(text);
  if (blocks.length === 0 || limit <= 0) {
    return [text.trim()];
  }

  // Keep a small buffer below the transport limit so structured markdown can
  // break on stable boundaries before QQ's rendered payload hits the ceiling.
  const chunkLimit = resolveQQBotStructuredMarkdownSoftLimit(limit, safeChunkByteLimit);
  const chunks: string[] = [];
  let currentPieces: string[] = [];
  let pendingPrefixPieces: string[] = [];

  const flushCurrent = (): void => {
    if (currentPieces.length === 0) {
      return;
    }
    const chunk = joinQQBotMarkdownPieces(currentPieces);
    if (chunk) {
      chunks.push(chunk);
    }
    currentPieces = [];
  };

  const appendPiece = (piece: string): void => {
    if (!piece) {
      return;
    }
    const pieces =
      measureQQBotUtf8Length(piece) > chunkLimit
        ? splitQQBotTextSafely(piece, chunkLimit)
        : [piece];
    for (const nextPiece of pieces) {
      const normalizedPiece = nextPiece.trim();
      if (!normalizedPiece) {
        continue;
      }
      const candidate = joinQQBotMarkdownPieces([...currentPieces, normalizedPiece]);
      if (
        currentPieces.length === 0 ||
        measureQQBotUtf8Length(candidate) <= chunkLimit
      ) {
        currentPieces.push(normalizedPiece);
        continue;
      }
      flushCurrent();
      currentPieces.push(normalizedPiece);
    }
  };

  const consumePendingPrefix = (piece: string): string => {
    if (pendingPrefixPieces.length === 0) {
      return piece;
    }
    const prefixed = joinQQBotMarkdownPieces([...pendingPrefixPieces, piece]);
    pendingPrefixPieces = [];
    return prefixed;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) {
      continue;
    }

    if (block.kind === "thematic-break") {
      if (
        shouldQQBotCarryThematicBreakToNextBlock({
          blocks,
          index,
          currentPieces,
          limit: chunkLimit,
        })
      ) {
        flushCurrent();
        pendingPrefixPieces.push(block.text);
        continue;
      }

      if (currentPieces.length > 0) {
        const candidate = joinQQBotMarkdownPieces([...currentPieces, block.text]);
        if (measureQQBotUtf8Length(candidate) <= chunkLimit) {
          currentPieces.push(block.text);
          continue;
        }
        flushCurrent();
      }
      pendingPrefixPieces.push(block.text);
      continue;
    }

    if (block.kind === "heading") {
      const headingText = consumePendingPrefix(block.text);
      const nextBlock = blocks[index + 1];
      if (nextBlock && nextBlock.kind !== "thematic-break") {
        const nextPieces = splitQQBotMarkdownBlock(nextBlock, chunkLimit);
        const firstBodyPiece = nextPieces[0];
        if (firstBodyPiece) {
          const pairedText = joinQQBotMarkdownPieces([headingText, firstBodyPiece]);
          const pairedCandidate = joinQQBotMarkdownPieces([
            ...currentPieces,
            headingText,
            firstBodyPiece,
          ]);
          if (
            measureQQBotUtf8Length(pairedText) <= chunkLimit &&
            (currentPieces.length === 0 ||
              measureQQBotUtf8Length(pairedCandidate) <= chunkLimit)
          ) {
            currentPieces.push(headingText, firstBodyPiece);
            for (let pieceIndex = 1; pieceIndex < nextPieces.length; pieceIndex += 1) {
              const nextPiece = nextPieces[pieceIndex] ?? "";
              appendPiece(
                nextBlock.kind === "table"
                  ? maybePrefixQQBotContinuationPiece({
                      prefix: headingText,
                      piece: nextPiece,
                      limit: chunkLimit,
                    })
                  : nextPiece
              );
            }
            index += 1;
            continue;
          }
          if (
            currentPieces.length > 0 &&
            measureQQBotUtf8Length(pairedText) <= chunkLimit
          ) {
            flushCurrent();
            currentPieces.push(headingText, firstBodyPiece);
            for (let pieceIndex = 1; pieceIndex < nextPieces.length; pieceIndex += 1) {
              const nextPiece = nextPieces[pieceIndex] ?? "";
              appendPiece(
                nextBlock.kind === "table"
                  ? maybePrefixQQBotContinuationPiece({
                      prefix: headingText,
                      piece: nextPiece,
                      limit: chunkLimit,
                    })
                  : nextPiece
              );
            }
            index += 1;
            continue;
          }
        }
      }

      appendPiece(headingText);
      continue;
    }

    const blockText = consumePendingPrefix(block.text);
    for (const piece of splitQQBotMarkdownBlock({ ...block, text: blockText }, chunkLimit)) {
      appendPiece(piece);
    }
  }

  if (pendingPrefixPieces.length > 0 && currentPieces.length > 0) {
    const trailingCandidate = joinQQBotMarkdownPieces([...currentPieces, ...pendingPrefixPieces]);
    if (measureQQBotUtf8Length(trailingCandidate) <= chunkLimit) {
      currentPieces.push(...pendingPrefixPieces);
      pendingPrefixPieces = [];
    }
  }

  if (pendingPrefixPieces.length > 0 && chunks.length > 0) {
    const trailingPrefix = joinQQBotMarkdownPieces(pendingPrefixPieces);
    const lastChunk = chunks[chunks.length - 1] ?? "";
    const trailingCandidate = joinQQBotMarkdownPieces([lastChunk, trailingPrefix]);
    if (measureQQBotUtf8Length(trailingCandidate) <= chunkLimit) {
      chunks[chunks.length - 1] = trailingCandidate;
      pendingPrefixPieces = [];
    }
  }

  if (pendingPrefixPieces.length > 0) {
    currentPieces.push(joinQQBotMarkdownPieces(pendingPrefixPieces));
  }

  flushCurrent();
  return chunks.length > 0 ? chunks : [text.trim()];
}

export function looksLikeStructuredMarkdown(text: string): boolean {
  const normalized = normalizeQQBotMarkdownSegment(text);
  if (!normalized) {
    return false;
  }

  const lines = normalized.split("\n");
  if (hasQQBotMarkdownTable(normalized)) {
    return true;
  }

  return (
    normalized.includes("\n\n") ||
    lines.some((line) => MARKDOWN_ATX_HEADING_RE.test(line)) ||
    lines.some((line) => MARKDOWN_BLOCKQUOTE_RE.test(line)) ||
    lines.some((line) => MARKDOWN_FENCE_RE.test(line)) ||
    lines.some((line) => MARKDOWN_THEMATIC_BREAK_RE.test(line)) ||
    lines.some((line) => MARKDOWN_LIST_ITEM_RE.test(line)) ||
    MARKDOWN_INLINE_STRUCTURE_RE.test(normalized)
  );
}

export function chunkC2CMarkdownText(params: {
  text: string;
  limit: number;
  strategy?: QQBotC2CMarkdownChunkStrategy;
  safeChunkByteLimit?: number;
  fallbackChunkText?: (text: string) => string[];
}): string[] {
  const normalized = params.text.trim();
  if (!normalized) {
    return [];
  }

  const strategy = params.strategy ?? "markdown-block";
  if (strategy === "length") {
    return params.fallbackChunkText ? params.fallbackChunkText(normalized) : [normalized];
  }

  if (params.limit <= 0 || !looksLikeStructuredMarkdown(normalized)) {
    return params.fallbackChunkText ? params.fallbackChunkText(normalized) : [normalized];
  }

  return chunkQQBotStructuredMarkdown(normalized, params.limit, params.safeChunkByteLimit);
}

export async function sendQQBotMediaWithFallback(params: {
  qqCfg: QQBotAccountConfig;
  to: string;
  mediaQueue: string[];
  replyToId?: string;
  replyEventId?: string;
  accountId?: string;
  logger: Logger;
  onDelivered?: () => void;
  onError?: (error: string) => void;
  shouldContinue?: () => boolean;
  outbound?: Pick<typeof qqbotOutbound, "sendMedia" | "sendText">;
}): Promise<void> {
  const { qqCfg, to, mediaQueue, replyToId, replyEventId, accountId, logger, onDelivered, onError } =
    params;
  const outbound = params.outbound ?? qqbotOutbound;
  const shouldContinue = params.shouldContinue ?? (() => true);
  for (const mediaUrl of mediaQueue) {
    if (!shouldContinue()) {
      return;
    }
    const result = await outbound.sendMedia({
      cfg: { channels: { qqbot: qqCfg } },
      to,
      mediaUrl,
      replyToId,
      replyEventId,
      accountId,
    });
    if (result.error) {
      logger.error(`sendMedia failed: ${result.error}`);
      onError?.(result.error);
      const fallback = buildMediaFallbackText(mediaUrl);
      if (!fallback) {
        continue;
      }
      if (!shouldContinue()) {
        return;
      }
      const fallbackResult = await outbound.sendText({
        cfg: { channels: { qqbot: qqCfg } },
        to,
        text: fallback,
        replyToId,
        replyEventId,
        accountId,
      });
      if (fallbackResult.error) {
        logger.error(`sendText fallback failed: ${fallbackResult.error}`);
        onError?.(fallbackResult.error);
      } else {
        onDelivered?.();
      }
    } else {
      onDelivered?.();
    }
  }
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
  qqCfg: QQBotAccountConfig;
  accountId: string;
  logger: Logger;
  route: QQBotAgentRoute;
}): Promise<void> {
  const { inbound, cfg, qqCfg, accountId, logger, route } = params;
  const runtime = getQQBotRuntime();
  const routeSessionKey = resolveQQBotRouteSessionKey(route);
  const queueKey = buildSessionDispatchQueueKey(route);
  const isFastAbortCommand = isQQBotFastAbortCommandText(inbound.content);
  const dispatchAbortGeneration = getSessionDispatchState(queueKey).abortGeneration;
  const shouldSuppressVisibleReplies = (): boolean => {
    const currentAbortGeneration =
      sessionDispatchQueue.get(queueKey)?.abortGeneration ?? dispatchAbortGeneration;
    return currentAbortGeneration !== dispatchAbortGeneration;
  };
  const target = resolveChatTarget(inbound);
  const outboundAccountId = route.accountId ?? accountId;
  const typingHeartbeatMode = resolveQQBotTypingHeartbeatMode(qqCfg);
  const typingHeartbeatIntervalMs = resolveQQBotTypingHeartbeatIntervalMs(qqCfg);
  const typingInputSeconds = resolveQQBotTypingInputSeconds(qqCfg);
  let typingRefIdx: string | undefined;
  if (inbound.c2cOpenid && !isFastAbortCommand && !shouldSuppressVisibleReplies()) {
    const typing = await qqbotOutbound.sendTyping({
      cfg: { channels: { qqbot: qqCfg } },
      to: `user:${inbound.c2cOpenid}`,
      replyToId: inbound.messageId,
      replyEventId: inbound.eventId,
      inputSecond: typingInputSeconds,
      accountId: outboundAccountId,
    });
    if (typing.error) {
      logger.warn(`sendTyping failed: ${typing.error}`);
    } else {
      typingRefIdx = typing.refIdx;
    }
  }

  const replyApi = runtime.channel?.reply;
  if (!replyApi) {
    logger.warn("reply API not available");
    return;
  }

  let replyDelivered = false;
  let groupMessageInterfaceBlocked = false;
  let lastVisibleOutboundAt = Date.now();
  let typingHeartbeat: QQBotTypingHeartbeatController | null = null;
  const markReplyDelivered = () => {
    replyDelivered = true;
    longTaskNotice.markReplyDelivered();
  };
  const markVisibleOutboundStarted = () => {
    lastVisibleOutboundAt = Date.now();
  };
  const markGroupMessageInterfaceBlocked = (error?: string) => {
    if (!isQQBotGroupMessageInterfaceBlocked(error)) return;
    if (!groupMessageInterfaceBlocked) {
      logger.warn("QQ group message interface is temporarily blocked by platform; suppressing extra sends");
    }
    groupMessageInterfaceBlocked = true;
  };

  if (
    inbound.c2cOpenid &&
    typingHeartbeatMode !== "none" &&
    !isFastAbortCommand &&
    !shouldSuppressVisibleReplies()
  ) {
    typingHeartbeat = startQQBotTypingHeartbeat({
      intervalMs: typingHeartbeatIntervalMs,
      shouldRenew: () => {
        if (shouldSuppressVisibleReplies()) {
          return false;
        }
        if (typingHeartbeatMode === "always") {
          return true;
        }
        return Date.now() - lastVisibleOutboundAt >= typingHeartbeatIntervalMs;
      },
      renew: async () => {
        try {
          const typing = await qqbotOutbound.sendTyping({
            cfg: { channels: { qqbot: qqCfg } },
            to: `user:${inbound.c2cOpenid}`,
            replyToId: inbound.messageId,
            replyEventId: inbound.eventId,
            inputSecond: typingInputSeconds,
            accountId: outboundAccountId,
          });
          void typing;
        } catch {
          // Best effort only. Renewal failure should not affect reply flow.
        }
      },
    });
  }

  const longTaskNotice = startLongTaskNoticeTimer({
    delayMs: qqCfg.longTaskNoticeDelayMs ?? DEFAULT_LONG_TASK_NOTICE_DELAY_MS,
    logger,
    sendNotice: async () => {
      if (groupMessageInterfaceBlocked || isFastAbortCommand || shouldSuppressVisibleReplies()) return;
      markVisibleOutboundStarted();
      const result = await qqbotOutbound.sendText({
        cfg: { channels: { qqbot: qqCfg } },
        to: target.to,
        text: LONG_TASK_NOTICE_TEXT,
        replyToId: inbound.messageId,
        replyEventId: inbound.eventId,
        accountId: outboundAccountId,
      });
      if (result.error) {
        logger.warn(`send long-task notice failed: ${result.error}`);
        markGroupMessageInterfaceBlocked(result.error);
      } else {
        markReplyDelivered();
      }
    },
  });
  const inboundMediaDir = resolveInboundMediaDir(qqCfg);
  const inboundMediaKeepDays = resolveInboundMediaKeepDays(qqCfg);

  try {
    const sessionApi = runtime.channel?.session;
    const sessionConfig = (cfg as { session?: { store?: unknown } } | undefined)?.session;
    const storePath = sessionApi?.resolveStorePath?.(
      sessionConfig?.store,
      { agentId: route.agentId }
    );

    const envelopeOptions = replyApi.resolveEnvelopeFormatOptions?.(cfg);
    const previousTimestamp =
      storePath && sessionApi?.readSessionUpdatedAt
        ? sessionApi.readSessionUpdatedAt({ storePath, sessionKey: routeSessionKey })
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
      if (shouldSuppressVisibleReplies()) {
        return;
      }
      markVisibleOutboundStarted();
      const fallback = await qqbotOutbound.sendText({
        cfg: { channels: { qqbot: qqCfg } },
        to: target.to,
        text: buildVoiceASRFallbackReply(resolvedAttachmentResult.asrErrorMessage),
        replyToId: inbound.messageId,
        replyEventId: inbound.eventId,
        accountId: outboundAccountId,
      });
      if (fallback.error) {
        logger.error(`sendText ASR fallback failed: ${fallback.error}`);
        markGroupMessageInterfaceBlocked(fallback.error);
      } else {
        markReplyDelivered();
      }
      return;
    }
    const resolvedAttachments = resolvedAttachmentResult.attachments;
    const localImageCount = resolvedAttachments.filter((item) => Boolean(item.localImagePath)).length;
    if (localImageCount > 0) {
      logger.info(`prepared ${localImageCount} local image attachment(s) for agent`);
    }
    let replyToId: string | undefined;
    let replyToBody: string | undefined;
    let replyToSender: string | undefined;
    let replyToIsQuote = false;

    if (inbound.c2cOpenid && inbound.refMsgIdx) {
      replyToId = inbound.refMsgIdx;
      replyToIsQuote = true;
      const refEntry = getRefIndex(inbound.refMsgIdx);
      if (refEntry) {
        replyToBody = formatRefEntryForAgent(refEntry);
        replyToSender = refEntry.senderName ?? refEntry.senderId;
        logger.info(`quote context resolved refMsgIdx=${inbound.refMsgIdx}`);
      } else {
        replyToBody = QQ_QUOTE_BODY_UNAVAILABLE_TEXT;
        logger.warn(`quote context missing refMsgIdx=${inbound.refMsgIdx}`);
      }
    }

    const refAttachmentSummaries = buildInboundRefAttachmentSummaries(resolvedAttachments);
    const currentRefIndexKeys = inbound.c2cOpenid
      ? uniqueRefIndexKeys(inbound.msgIdx, typingRefIdx)
      : [];
    if (currentRefIndexKeys.length > 0) {
      for (const currentRefIndexKey of currentRefIndexKeys) {
        setRefIndex(currentRefIndexKey, {
          content: inbound.content,
          senderId: inbound.senderId,
          ...(inbound.senderName ? { senderName: inbound.senderName } : {}),
          timestamp: inbound.timestamp,
          ...(refAttachmentSummaries ? { attachments: refAttachmentSummaries } : {}),
        });
      }
      logger.info(
        `cached inbound ref_idx keys=${currentRefIndexKeys.join(",")} msgIdx=${inbound.msgIdx ?? "-"} typingRefIdx=${typingRefIdx ?? "-"}`
      );
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
      sessionKey: routeSessionKey,
      accountId: outboundAccountId,
      body: inboundBody,
      rawBody,
      commandBody: rawBody,
    });

    const finalizeInboundContext = replyApi?.finalizeInboundContext as
      | ((ctx: InboundContext) => InboundContext)
      | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;
    const ctxTo = normalizeQQBotReplyTarget(finalCtx.To);
    const ctxOriginatingTo = normalizeQQBotReplyTarget(finalCtx.OriginatingTo);
    const stableTo = ctxOriginatingTo ?? ctxTo ?? target.to;
    finalCtx.To = stableTo;
    finalCtx.OriginatingTo = stableTo;
    if (replyToId) {
      finalCtx.ReplyToId = replyToId;
      finalCtx.ReplyToBody = replyToBody;
      finalCtx.ReplyToSender = replyToSender;
      finalCtx.ReplyToIsQuote = replyToIsQuote;
    }

    const isSlashCommand =
      typeof finalCtx.CommandBody === "string"
        ? finalCtx.CommandBody.trim().startsWith("/")
        : typeof finalCtx.RawBody === "string"
          ? finalCtx.RawBody.trim().startsWith("/")
          : false;
    if (!isSlashCommand) {
      let agentBody = resolveAgentBodyBase(finalCtx);
      if (replyToIsQuote && replyToBody && replyToBody !== QQ_QUOTE_BODY_UNAVAILABLE_TEXT) {
        agentBody = buildQuotedAgentBody({
          baseBody: agentBody,
          replyToBody,
        });
      }
      finalCtx.BodyForAgent = appendCronHiddenPrompt(agentBody);
    }

    if (storePath) {
      const mainSessionKeyRaw = route.mainSessionKey;
      const mainSessionKey =
        typeof mainSessionKeyRaw === "string" && mainSessionKeyRaw.trim()
          ? mainSessionKeyRaw.trim()
          : undefined;
      const isGroup = inbound.type === "group" || inbound.type === "channel";
      const updateLastRoute =
        !isGroup
          ? {
              sessionKey: mainSessionKey ?? route.sessionKey,
              channel: "qqbot",
              to: stableTo,
              accountId: outboundAccountId,
            }
          : undefined;

      const recordSessionKey =
        typeof finalCtx.SessionKey === "string" && finalCtx.SessionKey.trim()
          ? finalCtx.SessionKey
          : routeSessionKey;

      if (sessionApi?.recordInboundSession) {
        try {
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

      if (sessionApi?.recordSessionMetaFromInbound) {
        try {
          await sessionApi.recordSessionMetaFromInbound({
            storePath,
            sessionKey: recordSessionKey,
            ctx: finalCtx,
            createIfMissing: true,
          });
        } catch (err) {
          logger.warn(`failed to record inbound session meta: ${String(err)}`);
        }
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
      accountId: outboundAccountId,
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
    const markdownSupport = qqCfg.markdownSupport ?? true;
    const c2cMarkdownDeliveryMode = qqCfg.c2cMarkdownDeliveryMode ?? "proactive-table-only";
    const c2cMarkdownChunkStrategy = qqCfg.c2cMarkdownChunkStrategy ?? "markdown-block";
    const c2cMarkdownSafeChunkByteLimit = resolveQQBotC2CMarkdownSafeChunkByteLimit(qqCfg);
    const isC2CTarget = isQQBotC2CTarget(target.to);
    const useC2CMarkdownTransport = markdownSupport && isC2CTarget;
    let bufferedC2CMarkdownTexts: string[] = [];
    let bufferedC2CMarkdownMediaUrls: string[] = [];
    const bufferedC2CMarkdownMediaSeen = new Set<string>();

    const hasBufferedC2CMarkdownReply = (): boolean =>
      bufferedC2CMarkdownTexts.length > 0 || bufferedC2CMarkdownMediaUrls.length > 0;

    const bufferC2CMarkdownMedia = (url?: string): void => {
      const next = url?.trim();
      if (!next || bufferedC2CMarkdownMediaSeen.has(next)) return;
      bufferedC2CMarkdownMediaSeen.add(next);
      bufferedC2CMarkdownMediaUrls.push(next);
    };

    const sendC2CMarkdownTransportPayload = async (params: {
      text: string;
      mediaUrls: string[];
      phase: "buffered" | "immediate";
    }): Promise<void> => {
      if (shouldSuppressVisibleReplies()) {
        return;
      }
      const normalizedText = normalizeQQBotRenderedMarkdown(params.text);
      const { markdownImageUrls, mediaQueue } = splitQQBotMarkdownTransportMediaUrls(params.mediaUrls);
      const finalMarkdownText = await normalizeQQBotMarkdownImages({
        text: normalizedText,
        appendImageUrls: markdownImageUrls,
      });
      if (shouldSuppressVisibleReplies()) {
        return;
      }
      const textReplyRefs = resolveQQBotTextReplyRefs({
        to: target.to,
        text: finalMarkdownText || normalizedText,
        markdownSupport,
        c2cMarkdownDeliveryMode,
        replyToId: inbound.messageId,
        replyEventId: inbound.eventId,
      });
      const textChunks = finalMarkdownText
        ? chunkC2CMarkdownText({
            text: finalMarkdownText,
            limit,
            strategy: c2cMarkdownChunkStrategy,
            safeChunkByteLimit: c2cMarkdownSafeChunkByteLimit,
            fallbackChunkText: chunkText,
          })
        : [];
      const deliveryLabel = textReplyRefs.forceProactive
        ? "c2c-markdown-proactive"
        : "c2c-markdown-passive";
      logger.info(
        `delivery=${deliveryLabel} to=${target.to} chunks=${textChunks.length} media=${mediaQueue.length} ` +
          `replyToId=${textReplyRefs.replyToId ? "yes" : "no"} replyEventId=${textReplyRefs.replyEventId ? "yes" : "no"} ` +
          `phase=${params.phase} tableMode=${String(resolvedTableMode)} chunkMode=${String(chunkMode ?? "default")} ` +
          `chunkStrategy=${c2cMarkdownChunkStrategy} safeChunkByteLimit=${String(c2cMarkdownSafeChunkByteLimit ?? "auto")}`
      );

      if (!shouldSuppressVisibleReplies()) {
        if (mediaQueue.length > 0) {
          markVisibleOutboundStarted();
        }
        await sendQQBotMediaWithFallback({
          qqCfg,
          to: target.to,
          mediaQueue,
          replyToId: textReplyRefs.replyToId,
          replyEventId: textReplyRefs.replyEventId,
          accountId: outboundAccountId,
          logger,
          onDelivered: () => {
            markReplyDelivered();
          },
          onError: (error) => {
            markGroupMessageInterfaceBlocked(error);
          },
          shouldContinue: () => !shouldSuppressVisibleReplies(),
        });
      }

      if (!finalMarkdownText) {
        return;
      }

      for (let chunkIndex = 0; chunkIndex < textChunks.length; chunkIndex += 1) {
        if (shouldSuppressVisibleReplies()) {
          return;
        }
        const chunk = textChunks[chunkIndex] ?? "";
        logger.info(
          `delivery=${deliveryLabel} segment=1/1 chunk=${chunkIndex + 1}/${textChunks.length} ` +
            `phase=${params.phase} preview=${formatQQBotOutboundPreview(chunk)}`
        );
        markVisibleOutboundStarted();
        const result = await qqbotOutbound.sendText({
          cfg: { channels: { qqbot: qqCfg } },
          to: target.to,
          text: chunk,
          replyToId: textReplyRefs.replyToId,
          replyEventId: textReplyRefs.replyEventId,
          accountId: outboundAccountId,
        });
        if (result.error) {
          logger.error(`send QQ markdown reply failed: ${result.error}`);
          markGroupMessageInterfaceBlocked(result.error);
        } else {
          logger.info(`sent QQ markdown reply (phase=${params.phase}, len=${chunk.length})`);
          markReplyDelivered();
        }
      }
    };

    const flushBufferedC2CMarkdownReply = async (): Promise<void> => {
      if (
        !useC2CMarkdownTransport ||
        (bufferedC2CMarkdownTexts.length === 0 && bufferedC2CMarkdownMediaUrls.length === 0)
      ) {
        bufferedC2CMarkdownTexts = [];
        bufferedC2CMarkdownMediaUrls = [];
        bufferedC2CMarkdownMediaSeen.clear();
        return;
      }

      if (shouldSuppressVisibleReplies()) {
        bufferedC2CMarkdownTexts = [];
        bufferedC2CMarkdownMediaUrls = [];
        bufferedC2CMarkdownMediaSeen.clear();
        return;
      }

      const combinedText = combineQQBotBufferedText(bufferedC2CMarkdownTexts);
      const combinedMediaUrls = [...bufferedC2CMarkdownMediaUrls];
      bufferedC2CMarkdownTexts = [];
      bufferedC2CMarkdownMediaUrls = [];
      bufferedC2CMarkdownMediaSeen.clear();

      await sendC2CMarkdownTransportPayload({
        text: combinedText,
        mediaUrls: combinedMediaUrls,
        phase: "buffered",
      });
    };

    const deliver = async (payload: unknown, info?: { kind?: string }): Promise<void> => {
      if (shouldSuppressVisibleReplies()) {
        return;
      }
      const typed = payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] } | undefined;
      const extractedTextMedia = extractQQBotReplyMedia({
        text: typed?.text ?? "",
        logger,
        autoSendLocalPathMedia: resolveQQBotAutoSendLocalPathMedia(qqCfg),
      });
      const cleanedText = sanitizeQQBotOutboundText(extractedTextMedia.text);

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
      for (const url of extractedTextMedia.mediaUrls) addMedia(url);

      const deliveryDecision = evaluateReplyFinalOnlyDelivery({
        replyFinalOnly,
        kind: info?.kind,
        hasMedia: mediaQueue.length > 0,
        sanitizedText: cleanedText,
      });
      if (deliveryDecision.skipDelivery) return;

      const suppressEchoText =
        mediaQueue.length > 0 &&
        shouldSuppressQQBotTextWhenMediaPresent(extractedTextMedia.text, cleanedText);
      const suppressText = deliveryDecision.suppressText || suppressEchoText;
      const textToSend = suppressText ? "" : cleanedText;

      if (useC2CMarkdownTransport) {
        const shouldBufferFinalOnlyPayload = replyFinalOnly && (!info?.kind || info.kind === "final");
        const shouldBufferStructuredMarkdownPayload =
          !replyFinalOnly &&
          c2cMarkdownChunkStrategy === "markdown-block" &&
          info?.kind !== "tool" &&
          (hasBufferedC2CMarkdownReply() || looksLikeStructuredMarkdown(textToSend));

        if (shouldBufferFinalOnlyPayload || shouldBufferStructuredMarkdownPayload) {
          if (textToSend) {
            bufferedC2CMarkdownTexts = appendQQBotBufferedText(bufferedC2CMarkdownTexts, textToSend);
          }

          for (const url of mediaQueue) {
            bufferC2CMarkdownMedia(url);
          }
          return;
        }

        if (hasBufferedC2CMarkdownReply()) {
          await flushBufferedC2CMarkdownReply();
          if (shouldSuppressVisibleReplies()) {
            return;
          }
        }

        await sendC2CMarkdownTransportPayload({
          text: textToSend,
          mediaUrls: mediaQueue,
          phase: "immediate",
        });
        return;
      }

      if (textToSend) {
        const converted = textApi?.convertMarkdownTables
          ? textApi.convertMarkdownTables(textToSend, resolvedTableMode)
          : textToSend;
        const textReplyRefs = resolveQQBotTextReplyRefs({
          to: target.to,
          text: converted,
          markdownSupport,
          c2cMarkdownDeliveryMode,
          replyToId: inbound.messageId,
          replyEventId: inbound.eventId,
        });
        const chunks = chunkText(converted);
        for (const chunk of chunks) {
          if (shouldSuppressVisibleReplies()) {
            return;
          }
          markVisibleOutboundStarted();
          const result = await qqbotOutbound.sendText({
            cfg: { channels: { qqbot: qqCfg } },
            to: target.to,
            text: chunk,
            replyToId: textReplyRefs.replyToId,
            replyEventId: textReplyRefs.replyEventId,
            accountId: outboundAccountId,
          });
          if (result.error) {
            logger.error(`sendText failed: ${result.error}`);
            markGroupMessageInterfaceBlocked(result.error);
          } else {
            markReplyDelivered();
          }
        }
      }

      if (shouldSuppressVisibleReplies()) {
        return;
      }

      if (mediaQueue.length > 0) {
        markVisibleOutboundStarted();
      }
      await sendQQBotMediaWithFallback({
        qqCfg,
        to: target.to,
        mediaQueue,
        replyToId: inbound.messageId,
        replyEventId: inbound.eventId,
        accountId: outboundAccountId,
        logger,
        onDelivered: () => {
          markReplyDelivered();
        },
        onError: (error) => {
          markGroupMessageInterfaceBlocked(error);
        },
        shouldContinue: () => !shouldSuppressVisibleReplies(),
      });
    };

    const humanDelay = replyApi.resolveHumanDelayConfig?.(cfg, route.agentId);
    const dispatchDirect = replyApi.dispatchReplyWithDispatcher;
    const dispatchBuffered = replyApi.dispatchReplyWithBufferedBlockDispatcher;
    const streamingReplyOptions =
      isC2CTarget && !replyFinalOnly
        ? {
            disableBlockStreaming: false,
          }
        : undefined;
    if (isC2CTarget && !replyFinalOnly && dispatchDirect) {
      logger.debug(`[dispatch] mode=direct session=${routeSessionKey} to=${target.to}`);
      await dispatchDirect({
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
        replyOptions: streamingReplyOptions,
      });
      await flushBufferedC2CMarkdownReply();
    } else if (dispatchBuffered) {
      logger.debug(`[dispatch] mode=buffered session=${routeSessionKey} to=${target.to}`);
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
        replyOptions: streamingReplyOptions,
      });
      await flushBufferedC2CMarkdownReply();
    } else {
      logger.debug(`[dispatch] mode=legacy session=${routeSessionKey} to=${target.to}`);
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
        replyOptions: {
          ...(typeof dispatcherResult.replyOptions === "object" && dispatcherResult.replyOptions
            ? dispatcherResult.replyOptions
            : {}),
          ...(streamingReplyOptions ?? {}),
        },
      });

      dispatcherResult.markDispatchIdle?.();
      await flushBufferedC2CMarkdownReply();
    }

    const noReplyFallback = resolveQQBotNoReplyFallback({
      inbound,
      replyDelivered,
    });
    if (
      noReplyFallback &&
      !groupMessageInterfaceBlocked &&
      !isFastAbortCommand &&
      !shouldSuppressVisibleReplies()
    ) {
      logger.info("no visible reply generated for group mention; sending fallback text");
      markVisibleOutboundStarted();
      const fallbackResult = await qqbotOutbound.sendText({
        cfg: { channels: { qqbot: qqCfg } },
        to: target.to,
        text: noReplyFallback,
        replyToId: inbound.messageId,
        replyEventId: inbound.eventId,
        accountId: outboundAccountId,
      });
      if (fallbackResult.error) {
        logger.error(`sendText no-reply fallback failed: ${fallbackResult.error}`);
        markGroupMessageInterfaceBlocked(fallbackResult.error);
      } else {
        markReplyDelivered();
      }
    }
  } finally {
    typingHeartbeat?.dispose();
    longTaskNotice.dispose();
    try {
      await pruneInboundMediaDir({
        inboundDir: inboundMediaDir,
        keepDays: inboundMediaKeepDays,
      });
    } catch (err) {
      logger.warn(`failed to prune qqbot inbound media dir: ${String(err)}`);
    }
  }
}

function shouldHandleMessage(event: QQInboundMessage, qqCfg: QQBotAccountConfig, logger: Logger): boolean {
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
  const inbound = resolveInbound(params.eventType, params.eventData, params.eventId);
  if (!inbound) {
    return;
  }

  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const qqCfg = params.cfg ? mergeQQBotAccountConfig(params.cfg, accountId) : undefined;
  if (!qqCfg) {
    logger.warn("qqbot config missing, ignoring inbound message");
    return;
  }
  if (qqCfg.enabled === false) {
    logger.info("qqbot disabled, ignoring inbound message");
    return;
  }

  const senderNameResolution = resolveQQBotSenderName({
    inbound,
    cfg: params.cfg,
    accountId,
  });
  const resolvedInbound: QQInboundMessage = {
    ...inbound,
    senderName: senderNameResolution.displayName,
  };
  logQQBotSenderNameResolution({
    logger,
    inbound,
    accountId,
    resolution: senderNameResolution,
  });

  const content = resolvedInbound.content.trim();
  const inboundLogContent = sanitizeInboundLogText(
    resolveInboundLogContent({
      content,
      attachments: resolvedInbound.attachments,
    })
  );
  logger.info(
    `[inbound-user] accountId=${accountId} senderId=${resolvedInbound.senderId} ` +
      `senderName=${JSON.stringify(resolvedInbound.senderName ?? resolvedInbound.senderId)} content=${inboundLogContent}`
  );

  if (!shouldHandleMessage(resolvedInbound, qqCfg, logger)) {
    return;
  }

  const knownTarget = resolveKnownQQBotTargetFromInbound({
    inbound: resolvedInbound,
    accountId,
    persistentDisplayName: senderNameResolution.persistentDisplayName,
  });
  if (knownTarget) {
    try {
      upsertKnownQQBotTarget({ target: knownTarget });
    } catch (err) {
      logger.warn(`failed to record known qqbot target: ${String(err)}`);
    }
  }

  const attachmentCount = resolvedInbound.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    logger.info(`inbound message includes ${attachmentCount} attachment(s)`);
  }
  if (!content && attachmentCount === 0) {
    return;
  }

  const runtime = getQQBotRuntime();
  const routing = runtime.channel?.routing?.resolveAgentRoute;
  if (!routing) {
    logger.warn("routing API not available");
    return;
  }

  const target = resolveChatTarget(resolvedInbound);
  const route = routing({
    cfg: params.cfg,
    channel: "qqbot",
    accountId,
    peer: { kind: target.peerKind, id: target.peerId },
  }) as QQBotAgentRoute;
  const effectiveSessionKey = resolveQQBotEffectiveSessionKey({
    inbound: resolvedInbound,
    route,
    accountId,
  });
  const resolvedRoute =
    effectiveSessionKey === route.sessionKey
      ? route
      : {
          ...route,
          mainSessionKey: route.mainSessionKey?.trim() || route.sessionKey,
          effectiveSessionKey,
        };
  const queueKey = buildSessionDispatchQueueKey(resolvedRoute);
  if (isQQBotFastAbortCommandText(content)) {
    const routeSessionKey = resolveQQBotRouteSessionKey(resolvedRoute);
    markSessionDispatchAbort(queueKey);
    const droppedCount = dropQueuedSessionDispatches(queueKey);
    logger.info(
      `session fast-abort command detected; executing immediately sessionKey=${routeSessionKey}`
    );
    logger.info(
      `session fast-abort command dropped ${droppedCount} queued messages sessionKey=${routeSessionKey}`
    );
    await runImmediateSessionDispatch(queueKey, async () =>
      dispatchToAgent({
        inbound: { ...resolvedInbound, content },
        cfg: params.cfg,
        qqCfg,
        accountId,
        logger,
        route: resolvedRoute,
      })
    );
    return;
  }

  if (hasSessionDispatchBacklog(queueKey)) {
    logger.info(`session busy; queueing inbound dispatch sessionKey=${resolveQQBotRouteSessionKey(resolvedRoute)}`);
  }

  await runSerializedSessionDispatch(queueKey, async () =>
    dispatchToAgent({
      inbound: { ...resolvedInbound, content },
      cfg: params.cfg,
      qqCfg,
      accountId,
      logger,
      route: resolvedRoute,
    })
  );
}
