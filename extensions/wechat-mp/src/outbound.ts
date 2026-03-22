import { resolveWechatMpAccount } from "./config.js";
import {
  sendWechatMpActiveText,
  sendWechatMpActiveTemplate,
  sendWechatMpActiveMedia,
  probeSendCapability,
  isInTimeWindow,
  type SendTemplateParams,
} from "./send.js";
import { normalizeWechatMpText, resolveRenderMarkdown } from "./text.js";
import type {
  PluginConfig,
  MediaMessageType,
  TimeWindowConfig,
  SendCapabilityResult,
  ResolvedWechatMpAccount,
} from "./types.js";
import { recordUserInteraction } from "./state.js";

function parseTarget(rawTarget: string): { accountId?: string; openId: string } | null {
  let raw = String(rawTarget ?? "").trim();
  if (!raw) return null;
  if (/^wechat-mp:/i.test(raw)) {
    raw = raw.slice("wechat-mp:".length);
  }
  let accountId: string | undefined;
  const atIndex = raw.lastIndexOf("@");
  if (atIndex > 0 && atIndex < raw.length - 1) {
    accountId = raw.slice(atIndex + 1).trim();
    raw = raw.slice(0, atIndex);
  }
  if (/^user:/i.test(raw)) {
    raw = raw.slice("user:".length);
  }
  const openId = raw.trim();
  return openId ? { accountId, openId } : null;
}

export const wechatMpOutbound = {
  deliveryMode: "direct" as const,
  textChunkLimit: 600,

  sendText: async (params: {
    cfg: PluginConfig;
    accountId?: string;
    to: string;
    text: string;
  }) => {
    const parsed = parseTarget(params.to);
    if (!parsed) {
      return {
        channel: "wechat-mp",
        ok: false,
        messageId: "",
        error: new Error(`Unsupported target for WeChat MP: ${params.to}`),
      };
    }

    const account = resolveWechatMpAccount({
      cfg: params.cfg,
      accountId: parsed.accountId ?? params.accountId,
    });

    const renderMarkdown = resolveRenderMarkdown(account.config);
    const normalizedText = normalizeWechatMpText(params.text, renderMarkdown);

    const result = await sendWechatMpActiveText({
      account,
      toUserName: parsed.openId,
      text: normalizedText,
    });
    return {
      channel: "wechat-mp",
      ok: result.ok,
      messageId: result.msgid ?? "",
      error: result.ok ? undefined : new Error(result.error ?? "send failed"),
    };
  },

  /**
   * Send template message via WeChat MP template message API
   * @see https://developers.weixin.qq.com/doc/offiaccount/Message_management/Template_message_interface.html
   */
  sendTemplate: async (params: {
    cfg: PluginConfig;
    accountId?: string;
    to: string;
    templateId: string;
    data: Record<string, { value: string; color?: string }>;
    url?: string;
    miniprogram?: {
      appid: string;
      pagepath?: string;
    };
  }) => {
    const parsed = parseTarget(params.to);
    if (!parsed) {
      return {
        channel: "wechat-mp",
        ok: false,
        messageId: "",
        error: new Error(`Unsupported target for WeChat MP: ${params.to}`),
      };
    }

    const account = resolveWechatMpAccount({
      cfg: params.cfg,
      accountId: parsed.accountId ?? params.accountId,
    });

    const result = await sendWechatMpActiveTemplate({
      account,
      toUserName: parsed.openId,
      template: {
        templateId: params.templateId,
        data: params.data,
        url: params.url,
        miniprogram: params.miniprogram,
      },
    });

    return {
      channel: "wechat-mp",
      ok: result.ok,
      messageId: result.msgid ?? "",
      error: result.ok ? undefined : new Error(result.error ?? "template send failed"),
    };
  },

  /**
   * Send media message (image/voice/video) via WeChat MP customer service API
   * Workflow: Upload media -> Get media_id -> Send message
   */
  sendMedia: async (params: {
    cfg: PluginConfig;
    accountId?: string;
    to: string;
    mediaType: MediaMessageType;
    buffer: Buffer | Uint8Array;
    filename?: string;
    title?: string;
    description?: string;
  }) => {
    const parsed = parseTarget(params.to);
    if (!parsed) {
      return {
        channel: "wechat-mp",
        ok: false,
        messageId: "",
        error: new Error(`Unsupported target for WeChat MP: ${params.to}`),
      };
    }

    const account = resolveWechatMpAccount({
      cfg: params.cfg,
      accountId: parsed.accountId ?? params.accountId,
    });

    const result = await sendWechatMpActiveMedia({
      account,
      toUserName: parsed.openId,
      media: {
        type: params.mediaType,
        buffer: params.buffer,
        filename: params.filename,
        title: params.title,
        description: params.description,
      },
    });

    return {
      channel: "wechat-mp",
      ok: result.ok,
      messageId: result.msgid ?? "",
      error: result.ok ? undefined : new Error(result.error ?? "media send failed"),
    };
  },

  // ============================================================================
  // Permission & Time Window Checks
  // ============================================================================

  /**
   * Check if a message can be sent to a user without actually sending.
   * Useful for pre-flight checks and user feedback.
   *
   * Checks:
   * - Account is configured for active sending
   * - User is within 48h interaction window
   * - (Optional) Current time is within allowed window
   *
   * @param params Check parameters
   * @returns Detailed capability result
   */
  checkCapability: async (params: {
    cfg: PluginConfig;
    accountId?: string;
    to: string;
    /** Optional time window configuration */
    timeWindowConfig?: TimeWindowConfig;
  }): Promise<SendCapabilityResult> => {
    const parsed = parseTarget(params.to);
    if (!parsed) {
      return {
        canSend: false,
        reason: "invalid_target",
        lastInteractionAt: null,
        windowExpiresAt: null,
      };
    }

    const account = resolveWechatMpAccount({
      cfg: params.cfg,
      accountId: parsed.accountId ?? params.accountId,
    });

    return probeSendCapability(account, parsed.openId, params.timeWindowConfig);
  },

  /**
   * Check if current time is within allowed sending window.
   *
   * @param params Check parameters with time window configuration
   * @returns true if within allowed window
   */
  checkTimeWindow: (params: {
    /** Time window configuration */
    config?: TimeWindowConfig;
  }): boolean => {
    return isInTimeWindow(params.config);
  },

  /**
   * Record a user interaction (call when receiving inbound messages).
   * This is needed for the 48h interaction window tracking.
   *
   * @param params Interaction parameters
   */
  recordInteraction: async (params: {
    cfg: PluginConfig;
    accountId?: string;
    openId: string;
    timestamp?: number;
  }): Promise<void> => {
    const account = resolveWechatMpAccount({
      cfg: params.cfg,
      accountId: params.accountId,
    });

    await recordUserInteraction(account.accountId, params.openId, params.timestamp);
  },
};
