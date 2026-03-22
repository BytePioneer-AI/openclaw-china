import {
  buildEncryptedReplyXml,
  buildPlainReplyXml,
  computeMsgSignature,
  encryptWechatMpMessage,
} from "./crypto.js";
import { sendWechatMpMessage, sendTemplateMessage, uploadWechatMpMedia } from "./api.js";
import {
  WECHAT_TEXT_BYTE_LIMIT,
  getUtf8ByteLength,
  splitTextByByteLimit,
} from "./text.js";
import type {
  ResolvedWechatMpAccount,
  WechatMpActiveDeliveryMode,
  WechatMpReplyMode,
  TemplateDataField,
  MediaMessageParams,
  RetryConfig,
  TimeWindowConfig,
  SendCapabilityResult,
} from "./types.js";
import { withRetry } from "@openclaw-china/shared";
import {
  getLastInteractionTime,
  getInteractionWindowExpiry,
} from "./state.js";

export type PassiveReplyResult = {
  ok: boolean;
  body?: string;
  error?: string;
};

export type ActiveSendResult = {
  ok: boolean;
  msgid?: string;
  error?: string;
};

export function buildPassiveTextReply(params: {
  account: ResolvedWechatMpAccount;
  toUserName: string;
  fromUserName: string;
  content: string;
  timestamp?: string;
  nonce?: string;
}): PassiveReplyResult {
  const content = params.content.trim();
  if (!content) {
    return { ok: false, error: "empty passive reply content" };
  }

  const createTime = Number(params.timestamp ?? Math.floor(Date.now() / 1000));
  const plainXml = buildPlainReplyXml({
    toUserName: params.toUserName,
    fromUserName: params.fromUserName,
    createTime,
    msgType: "text",
    content,
  });

  if (params.account.config.messageMode === "plain" || !params.account.config.encodingAESKey) {
    return { ok: true, body: plainXml };
  }

  if (!params.account.config.appId || !params.account.config.token) {
    return { ok: false, error: "missing appId or token for encrypted passive reply" };
  }

  try {
    const timestamp = params.timestamp ?? String(Math.floor(Date.now() / 1000));
    const nonce = params.nonce ?? Math.random().toString(36).slice(2, 10);
    const encrypted = encryptWechatMpMessage({
      encodingAESKey: params.account.config.encodingAESKey,
      appId: params.account.config.appId,
      plaintext: plainXml,
    }).encrypt;
    const signature = computeMsgSignature({
      token: params.account.config.token,
      timestamp,
      nonce,
      encrypt: encrypted,
    });
    return {
      ok: true,
      body: buildEncryptedReplyXml({
        encrypt: encrypted,
        signature,
        timestamp,
        nonce,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendWechatMpActiveText(params: {
  account: ResolvedWechatMpAccount;
  toUserName: string;
  text: string;
  /** Optional retry configuration; if provided, enables retry on transient errors */
  retryConfig?: RetryConfig;
}): Promise<ActiveSendResult> {
  if (!params.account.canSendActive) {
    return {
      ok: false,
      error: "Account not configured for active sending (missing appId/appSecret)",
    };
  }

  const byteLength = getUtf8ByteLength(params.text);
  const retryConfig = params.retryConfig ?? resolveRetryConfig(params.account);

  // Single message within limit, send directly
  if (byteLength <= WECHAT_TEXT_BYTE_LIMIT) {
    return sendSingleMessage(params.account, params.toUserName, params.text, retryConfig);
  }

  // Exceeds limit, split and send chunks
  const chunks = splitTextByByteLimit(params.text, WECHAT_TEXT_BYTE_LIMIT);
  let lastResult: ActiveSendResult = { ok: true };

  for (const chunk of chunks) {
    lastResult = await sendSingleMessage(params.account, params.toUserName, chunk, retryConfig);
    if (!lastResult.ok) {
      return lastResult; // Stop on failure
    }
  }

  return lastResult;
}

async function sendSingleMessage(
  account: ResolvedWechatMpAccount,
  toUserName: string,
  text: string,
  retryConfig?: RetryConfig
): Promise<ActiveSendResult> {
  const doSend = async (): Promise<ActiveSendResult> => {
    try {
      const result = await sendWechatMpMessage(account, {
        touser: toUserName,
        msgtype: "text",
        text: { content: text },
      });
      return {
        ok: result.errcode === 0,
        msgid: result.msgid ? String(result.msgid) : undefined,
        error: result.errcode === 0 ? undefined : result.errmsg,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // If retry is disabled (maxRetries === 0), send directly
  if (retryConfig?.maxRetries === 0) {
    return doSend();
  }

  // Use retry wrapper for transient error handling
  try {
    return await sendWithRetry(doSend, retryConfig);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveReplyMode(account: ResolvedWechatMpAccount): WechatMpReplyMode {
  return account.config.replyMode ?? "passive";
}

export function resolveActiveDeliveryMode(account: ResolvedWechatMpAccount): WechatMpActiveDeliveryMode {
  return account.config.activeDeliveryMode ?? "split";
}

// ============================================================================
// Template Message Sending
// ============================================================================

export interface SendTemplateParams {
  templateId: string;
  data: Record<string, TemplateDataField>;
  url?: string;
  miniprogram?: {
    appid: string;
    pagepath?: string;
  };
}

/**
 * Send template message via WeChat MP template message API
 * https://developers.weixin.qq.com/doc/offiaccount/Message_management/Template_message_interface.html
 */
export async function sendWechatMpActiveTemplate(params: {
  account: ResolvedWechatMpAccount;
  toUserName: string;
  template: SendTemplateParams;
  /** Optional retry configuration; if provided, enables retry on transient errors */
  retryConfig?: RetryConfig;
}): Promise<ActiveSendResult> {
  if (!params.account.canSendActive) {
    return {
      ok: false,
      error: "Account not configured for active sending (missing appId/appSecret)",
    };
  }

  const retryConfig = params.retryConfig ?? resolveRetryConfig(params.account);

  const doSend = async (): Promise<ActiveSendResult> => {
    try {
      const result = await sendTemplateMessage(params.account, {
        touser: params.toUserName,
        template_id: params.template.templateId,
        url: params.template.url,
        miniprogram: params.template.miniprogram,
        data: params.template.data,
      });

      return {
        ok: result.errcode === 0,
        msgid: result.msgid ? String(result.msgid) : undefined,
        error: result.errcode === 0 ? undefined : result.errmsg,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // If retry is disabled (maxRetries === 0), send directly
  if (retryConfig?.maxRetries === 0) {
    return doSend();
  }

  // Use retry wrapper for transient error handling
  try {
    return await sendWithRetry(doSend, retryConfig);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Media Message Sending
// ============================================================================

/**
 * Send media message (image/voice/video) via WeChat MP customer service API
 * Workflow: Upload media -> Get media_id -> Send message
 */
export async function sendWechatMpActiveMedia(params: {
  account: ResolvedWechatMpAccount;
  toUserName: string;
  media: MediaMessageParams;
  /** Optional retry configuration; if provided, enables retry on transient errors */
  retryConfig?: RetryConfig;
}): Promise<ActiveSendResult> {
  if (!params.account.canSendActive) {
    return {
      ok: false,
      error: "Account not configured for active sending (missing appId/appSecret)",
    };
  }

  const retryConfig = params.retryConfig ?? resolveRetryConfig(params.account);

  const doSend = async (): Promise<ActiveSendResult> => {
    try {
      // Step 1: Upload media to WeChat
      const buffer = params.media.buffer instanceof Buffer
        ? params.media.buffer
        : Buffer.from(params.media.buffer);

      const uploadResult = await uploadWechatMpMedia(
        params.account,
        params.media.type,
        buffer,
        params.media.filename
      );

      // Step 2: Send message with media_id
      const messageParams: {
        touser: string;
        msgtype: "image" | "voice" | "video";
        image?: { media_id: string };
        voice?: { media_id: string };
        video?: { media_id: string; thumb_media_id: string; title?: string; description?: string };
      } = {
        touser: params.toUserName,
        msgtype: params.media.type,
      };

      if (params.media.type === "image") {
        messageParams.image = { media_id: uploadResult.media_id };
      } else if (params.media.type === "voice") {
        messageParams.voice = { media_id: uploadResult.media_id };
      } else if (params.media.type === "video") {
        messageParams.video = {
          media_id: uploadResult.media_id,
          thumb_media_id: uploadResult.media_id, // Use same media_id as thumbnail
          title: params.media.title,
          description: params.media.description,
        };
      }

      const result = await sendWechatMpMessage(params.account, messageParams);

      return {
        ok: result.errcode === 0,
        msgid: result.msgid ? String(result.msgid) : undefined,
        error: result.errcode === 0 ? undefined : result.errmsg,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // If retry is disabled (maxRetries === 0), send directly
  if (retryConfig?.maxRetries === 0) {
    return doSend();
  }

  // Use retry wrapper for transient error handling
  try {
    return await sendWithRetry(doSend, retryConfig);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}


// ============================================================================
// Retry Mechanism
// ============================================================================

/**
 * WeChat-specific error codes that should trigger retry
 */
const WECHAT_RETRYABLE_ERROR_CODES = new Set([
  45009, // API minute-quota reached
  45047, // API daily-quota reached
]);

/**
 * Determine if a WeChat error should be retried
 */
export function shouldRetryWechatError(
  error: unknown,
  attempt: number,
  maxRetries: number = 3
): boolean {
  // Don't retry if max attempts exceeded
  if (attempt > maxRetries) {
    return false;
  }

  // Check for WeChat API errors with retryable error codes
  if (error && typeof error === "object") {
    if ("errcode" in error) {
      const errcode = (error as { errcode: number }).errcode;
      return WECHAT_RETRYABLE_ERROR_CODES.has(errcode);
    }
  }

  // Retry on network errors
  if (error instanceof TypeError) {
    return true;
  }

  // Retry on timeout errors
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }

  return false;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
};

/**
 * Resolve retry configuration from account config
 */
export function resolveRetryConfig(
  account: ResolvedWechatMpAccount
): Required<RetryConfig> {
  // If account has explicit retry config, merge with defaults
  if (account.config.retryConfig) {
    return { ...DEFAULT_RETRY_CONFIG, ...account.config.retryConfig };
  }

  return DEFAULT_RETRY_CONFIG;
}

/**
 * Create a retry predicate function for WeChat operations
 */
function createRetryPredicate(maxRetries: number): (error: unknown, attempt: number) => boolean {
  return (error: unknown, attempt: number) => shouldRetryWechatError(error, attempt, maxRetries);
}

/**
 * Execute a send operation with retry logic
 *
 * @param fn The async function to execute
 * @param retryConfig Retry configuration options
 * @returns Promise with the result of the function
 *
 * @example
 * ```ts
 * const result = await sendWithRetry(
 *   () => sendSingleMessage(account, toUserName, text),
 *   { maxRetries: 3, initialDelay: 1000 }
 * );
 * ```
 */
export async function sendWithRetry<T>(
  fn: () => Promise<T>,
  retryConfig?: RetryConfig
): Promise<T> {
  const config: Required<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...retryConfig,
  };

  return withRetry(fn, {
    maxRetries: config.maxRetries,
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
    backoffMultiplier: config.backoffMultiplier,
    shouldRetry: createRetryPredicate(config.maxRetries),
  });
}

// ============================================================================
// Permission Detection & Time Window Helpers
// ============================================================================

/** 48 hours in milliseconds - WeChat's interaction window for customer service messages */
const INTERACTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Check if a user is within the 48h interaction window for active messaging.
 *
 * WeChat MP requires that users have interacted with the official account
 * within the last 48 hours to receive customer service messages.
 *
 * @param account The resolved account
 * @param openId The user's openId
 * @returns true if the user can receive active messages
 */
export async function canSendToUser(
  account: ResolvedWechatMpAccount,
  openId: string
): Promise<boolean> {
  const lastInteraction = await getLastInteractionTime(account.accountId, openId);

  // No interaction recorded - cannot send
  if (lastInteraction === null) {
    return false;
  }

  // Check if within 48h window
  const elapsed = Date.now() - lastInteraction;
  return elapsed < INTERACTION_WINDOW_MS;
}

/**
 * Check if current time is within allowed time window.
 *
 * Supports three modes:
 * - 'always': No time restriction (returns true)
 * - 'business': 9:00-18:00 on weekdays
 * - 'custom': User-defined hour ranges
 *
 * @param config Time window configuration (defaults to 'always')
 * @returns true if current time is within allowed window
 */
export function isInTimeWindow(config?: TimeWindowConfig): boolean {
  const mode = config?.mode ?? "always";

  // Always mode - no restriction
  if (mode === "always") {
    return true;
  }

  // Get current time in specified timezone or local
  const now = new Date();

  // Business hours mode: 9:00-18:00 on weekdays (Mon-Fri)
  if (mode === "business") {
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = now.getHours();

    // Check weekday (1-5)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return false;
    }

    // Check business hours (9:00-18:00)
    return hour >= 9 && hour < 18;
  }

  // Custom mode: check against provided ranges
  if (mode === "custom") {
    const ranges = config?.customRanges;
    if (!ranges || ranges.length === 0) {
      return true; // No ranges defined = no restriction
    }

    const currentHour = now.getHours();

    for (const range of ranges) {
      // Handle ranges that cross midnight (e.g., 22:00-02:00)
      if (range.startHour > range.endHour) {
        if (currentHour >= range.startHour || currentHour < range.endHour) {
          return true;
        }
      } else {
        if (currentHour >= range.startHour && currentHour < range.endHour) {
          return true;
        }
      }
    }

    return false;
  }

  // Unknown mode - default to allowed
  return true;
}

/**
 * Probe send capability without actually sending a message.
 *
 * Checks:
 * 1. Account is configured for active sending (canSendActive)
 * 2. User is within 48h interaction window
 * 3. (Optional) Current time is within allowed time window
 *
 * @param account The resolved account
 * @param openId The user's openId
 * @param timeWindowConfig Optional time window configuration
 * @returns Detailed capability result
 */
export async function probeSendCapability(
  account: ResolvedWechatMpAccount,
  openId: string,
  timeWindowConfig?: TimeWindowConfig
): Promise<SendCapabilityResult> {
  // Get interaction data
  const lastInteractionAt = await getLastInteractionTime(account.accountId, openId);
  const windowExpiresAt = await getInteractionWindowExpiry(account.accountId, openId);

  // Check 1: Account configuration
  if (!account.canSendActive) {
    return {
      canSend: false,
      reason: "account_not_configured_for_active_sending",
      lastInteractionAt,
      windowExpiresAt,
    };
  }

  // Check 2: 48h interaction window
  const withinWindow = await canSendToUser(account, openId);
  if (!withinWindow) {
    return {
      canSend: false,
      reason: lastInteractionAt === null ? "no_interaction_recorded" : "outside_48h_window",
      lastInteractionAt,
      windowExpiresAt,
    };
  }

  // Check 3: Time window (if configured)
  if (timeWindowConfig && !isInTimeWindow(timeWindowConfig)) {
    return {
      canSend: false,
      reason: "outside_time_window",
      lastInteractionAt,
      windowExpiresAt,
    };
  }

  // All checks passed
  return {
    canSend: true,
    lastInteractionAt,
    windowExpiresAt,
  };
}
