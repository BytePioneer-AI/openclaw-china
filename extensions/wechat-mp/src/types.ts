import type { IncomingMessage, ServerResponse } from "http";

/**
 * ============================================================================
 * TARGET AND SESSION KEY CONVENTIONS
 * ============================================================================
 *
 * External Target Format (user-facing):
 *   - Primary: `user:<openid>` (openid-only, uses default account)
 *   - With account: `user:<openid>@<accountId>` (explicit account)
 *   - Legacy: `wechat-mp:user:<openid>` or `wechat-mp:user:<openid>@<accountId>`
 *
 * Internal Session Key Format (stable, internal):
 *   - Pattern: `dm:<appId>:<openid>`
 *   - The appId provides namespace isolation for multi-tenant scenarios
 *   - The openid is the stable user identifier from WeChat
 *
 * Why split external/internal:
 *   - External: User-friendly, can omit account, follows OpenClaw conventions
 *   - Internal: Stable, includes appId for multi-account isolation
 *
 * Account Resolution:
 *   - If accountId is provided: use accounts.<accountId> with root fallback
 *   - If no accountId: use root config as "default" account
 *   - Multi-account schema is day-one ready but setup CLI focuses on single account
 */

/**
 * WeChat MP DM policy for controlling direct message acceptance.
 */
export type WechatMpDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/**
 * WeChat MP message encryption mode.
 * - plain: No encryption
 * - safe: Full encryption
 * - compat: Compatible mode (both encrypted and plain supported)
 */
export type WechatMpMessageMode = "plain" | "safe" | "compat";

/**
 * WeChat MP reply mode.
 * - passive: Reply within 5-second webhook timeout (passive reply)
 * - active: Use customer service API for active sending
 */
export type WechatMpReplyMode = "passive" | "active";

/**
 * WeChat MP active delivery mode.
 * - merged: Buffer all chunks and send one final active message
 * - split: Send each chunk as its own active message
 */
export type WechatMpActiveDeliveryMode = "merged" | "split";

/**
 * Per-account configuration for WeChat MP.
 */
export type WechatMpAccountConfig = {
  name?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  encodingAESKey?: string;
  token?: string;
  webhookPath?: string;
  messageMode?: WechatMpMessageMode;
  replyMode?: WechatMpReplyMode;
  activeDeliveryMode?: WechatMpActiveDeliveryMode;
  /** Whether to render markdown-friendly text; default true. Set false to disable. */
  renderMarkdown?: boolean;
  welcomeText?: string;
  dmPolicy?: WechatMpDmPolicy;
  allowFrom?: string[];
  /** Retry configuration for message sending (optional) */
  retryConfig?: RetryConfig;
  /**
   * ASR (Automatic Speech Recognition) configuration for voice messages.
   * Uses Tencent Cloud Flash ASR service.
   */
  asr?: {
    enabled?: boolean;
    appId?: string;
    secretId?: string;
    secretKey?: string;
    engineType?: string;
    timeoutMs?: number;
  };
};

/**
 * ASR credentials for Tencent Cloud Flash ASR service.
 */
export type WechatMpASRCredentials = {
  appId: string;
  secretId: string;
  secretKey: string;
  engineType?: string;
  timeoutMs?: number;
};

/**
 * Root configuration for WeChat MP channel.
 * Supports multi-account via accounts object.
 */
export type WechatMpConfig = WechatMpAccountConfig & {
  accounts?: Record<string, WechatMpAccountConfig>;
  defaultAccount?: string;
};

/**
 * Template message data field.
 * Supports first, keyword (keyword1-keyword30), and remark fields.
 */
export interface TemplateDataField {
  value: string;
  color?: string; // Optional color in hex format (e.g., "#173177")
}

/**
 * Template message parameters for sending template messages.
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html
 */
export interface TemplateMessageParams {
  /** Receiver's openId */
  touser: string;
  /** Template ID from WeChat MP backend */
  template_id: string;
  /** Redirect URL after clicking (optional) */
  url?: string;
  /** Mini program jump target (optional, mutually exclusive with url) */
  miniprogram?: {
    appid: string;
    pagepath?: string;
  };
  /** Template data with first, keyword(s), and remark fields */
  data: {
    first?: TemplateDataField;
    remark?: TemplateDataField;
    [key: `keyword${number}`]: TemplateDataField | undefined;
  } & Record<string, TemplateDataField | undefined>;
}

/**
 * Template message API response.
 */
export interface TemplateMessageResult {
  errcode: number;
  errmsg: string;
  msgid?: number;
}

/**
 * Supported media message types for */
export type MediaMessageType = "image" | "voice" | "video";

/**
 * Media message parameters for sending
 */
export interface MediaMessageParams {
  /** Media type: image, voice, or video */
  type: MediaMessageType;
  /** Media buffer (binary data) */
  buffer: Buffer | Uint8Array;
  /** Optional filename for upload */
  filename?: string;
  /** Video title (video only) */
  title?: string;
  /** Video description (video only) */
  description?: string;
}

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Retry policy presets
 */
export type RetryPolicy = "none" | "conservative" | "aggressive";

/**
 * Retry configuration for message sending
 */
export interface RetryConfig {
  /** Maximum retry attempts (default 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default 1000) */
  initialDelay?: number;
  /** Maximum delay in milliseconds (default 10000) */
  maxDelay?: number;
  /** Backoff multiplier (default 2) */
  backoffMultiplier?: number;
}

/**
 * Default retry configurations
 */
export const DEFAULT_RETRY_CONFIGS: Record<RetryPolicy, RetryConfig> = {
  none: { maxRetries: 0 },
  conservative: { maxRetries: 2, initialDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 },
  aggressive: { maxRetries: 5, initialDelay: 500, maxDelay: 30000, backoffMultiplier: 1.5 },
};

// ============================================================================
// Time Window Configuration
// ============================================================================

/**
 * Time window mode for controlling when messages can be sent.
 * - always: No time restriction (default)
 * - business: Only during business hours (9:00-18:00 weekdays)
 * - custom: Use custom hour ranges defined in customRanges
 */
export type TimeWindowMode = "always" | "business" | "custom";

/**
 * Time range for custom time windows.
 * Hours are in 24-hour format (0-23).
 */
export interface TimeRange {
  /** Start hour (0-23) */
  startHour: number;
  /** End hour (0-23, exclusive) */
  endHour: number;
}

/**
 * Configuration for time window checking.
 * Controls when messages are allowed to be sent.
 */
export interface TimeWindowConfig {
  /** Time window mode */
  mode: TimeWindowMode;
  /** Optional timezone (e.g., 'Asia/Shanghai'), defaults to local time */
  timezone?: string;
  /** Custom time ranges (required when mode is 'custom') */
  customRanges?: TimeRange[];
}

/**
 * Result of probing send capability.
 * Provides detailed information about whether a message can be sent.
 */
export interface SendCapabilityResult {
  /** Whether message can be sent */
  canSend: boolean;
  /** Reason if cannot send (e.g., 'outside_48h_window', 'outside_time_window') */
  reason?: string;
  /** Timestamp of last user interaction (null if never interacted) */
  lastInteractionAt: number | null;
  /** When the 48h interaction window expires (null if outside window) */
  windowExpiresAt: number | null;
}

/**
 * Plugin configuration interface (partial).
 */
export interface PluginConfig {
  session?: {
    store?: unknown;
  };
  channels?: Record<string, unknown> & {
    "wechat-mp"?: WechatMpConfig;
  };
  [key: string]: unknown;
}

/**
 * Resolved account with all configuration merged and validated.
 */
export type ResolvedWechatMpAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appId?: string;
  appSecret?: string;
  encodingAESKey?: string;
  token?: string;
  canSendActive: boolean;
  config: WechatMpAccountConfig;
};

/**
 * WeChat MP access token cache entry.
 */
export type AccessTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

/**
 * WeChat MP inbound text message structure.
 */
export type WechatMpTextMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "text";
  Content: string;
  MsgId: string;
};

/**
 * WeChat MP inbound event message structure.
 */
export type WechatMpEventMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "event";
  Event: string;
  EventKey?: string;
  Ticket?: string;
};

/**
 * WeChat MP inbound image message structure.
 */
export type WechatMpImageMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "image";
  PicUrl: string;
  MediaId: string;
  MsgId: string;
};

/**
 * WeChat MP inbound voice message structure.
 */
export type WechatMpVoiceMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "voice";
  MediaId: string;
  Format: string;
  MsgId: string;
  /** Voice recognition result (if voice recognition is enabled) */
  Recognition?: string;
};

/**
 * WeChat MP inbound video message structure.
 */
export type WechatMpVideoMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "video";
  MediaId: string;
  ThumbMediaId: string;
  MsgId: string;
};

/**
 * WeChat MP inbound short video message structure.
 */
export type WechatMpShortVideoMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "shortvideo";
  MediaId: string;
  ThumbMediaId: string;
  MsgId: string;
};

/**
 * WeChat MP inbound location message structure.
 */
export type WechatMpLocationMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "location";
  Location_X: number;
  Location_Y: number;
  Scale: number;
  Label: string;
  MsgId: string;
};

/**
 * WeChat MP inbound link message structure.
 */
export type WechatMpLinkMessage = {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: "link";
  Title: string;
  Description: string;
  Url: string;
  MsgId: string;
};

/**
 * Union type for all WeChat MP inbound messages.
 */
export type WechatMpInboundMessage =
  | WechatMpTextMessage
  | WechatMpEventMessage
  | WechatMpImageMessage
  | WechatMpVoiceMessage
  | WechatMpVideoMessage
  | WechatMpShortVideoMessage
  | WechatMpLocationMessage
  | WechatMpLinkMessage
  | (Record<string, unknown> & { MsgType: string });

/**
 * Per-user interaction tracking for 48h window enforcement.
 */
export interface UserInteractionState {
  /** Last interaction timestamp (ms) */
  lastInteractionAt: number;
}

/**
 * WeChat MP account state for tracking runtime status.
 */
export type WechatMpAccountState = {
  configured?: boolean;
  running?: boolean;
  webhookPath?: string;
  lastStartAt?: number;
  lastStopAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastIntentfulAt?: number;
  lastError?: string;
  lastMessageId?: string;
  lastEvent?: string;
  lastFromUserName?: string;
  /** Per-user interaction tracking for 48h window enforcement */
  userInteractions?: Record<string, UserInteractionState>;
};

/**
 * WeChat MP persisted state structure.
 */
export type WechatMpPersistedState = {
  version: 1;
  processedMsgIds: Record<string, number>;
  accounts: Record<string, WechatMpAccountState>;
};

export type WechatMpInboundEventName =
  | "subscribe"
  | "unsubscribe"
  | "scan"
  | "click"
  | "view";

export type WechatMpInboundCandidate = {
  accountId: string;
  openId: string;
  appId?: string;
  target: string;
  sessionKey?: string;
  createTime: number;
  msgType: "text" | "event" | "image" | "voice" | "video" | "shortvideo" | "location" | "link";
  msgId?: string;
  dedupeKey: string;
  encrypted: boolean;
  hasUserIntent: boolean;
  content?: string;
  event?: WechatMpInboundEventName;
  eventKey?: string;
  ticket?: string;
  /** Image URL (image messages only) */
  picUrl?: string;
  /** Media ID for downloading media messages */
  mediaId?: string;
  /** Voice format (voice messages only) */
  format?: string;
  /** Voice recognition result (voice messages only, requires voice recognition enabled) */
  recognition?: string;
  /** Thumbnail media ID (video/shortvideo messages only) */
  thumbMediaId?: string;
  /** Location latitude (location messages only) */
  locationX?: number;
  /** Location longitude (location messages only) */
  locationY?: number;
  /** Map scale (location messages only) */
  scale?: number;
  /** Location label/address (location messages only) */
  label?: string;
  /** Link title (link messages only) */
  title?: string;
  /** Link description (link messages only) */
  description?: string;
  /** Link URL (link messages only) */
  url?: string;
  toUserName?: string;
  raw: WechatMpInboundMessage;
};

/**
 * Webhook target registration parameters.
 */
export type WebhookTarget = {
  account: ResolvedWechatMpAccount;
  config: PluginConfig;
  runtime: {
    log: (message: string) => void;
    error: (message: string) => void;
  };
  path: string;
  statusSink?: (patch: Record<string, unknown>) => void;
};

/**
 * Plugin runtime interface defining host capabilities needed by the plugin.
 */
export interface PluginRuntime {
  log?: (message: string) => void;
  error?: (message: string) => void;
  channel?: {
    routing?: {
      resolveAgentRoute?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
        peer: { kind: string; id: string };
      }) => {
        sessionKey: string;
        accountId: string;
        agentId?: string;
        mainSessionKey?: string;
      };
    };
    reply?: {
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<void>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: {
        channel: string;
        from: string;
        previousTimestamp?: number;
        envelope?: unknown;
        body: string;
      }) => string;
    };
    session?: {
      resolveStorePath?: (
        store: unknown,
        params: { agentId?: string }
      ) => string | undefined;
      readSessionUpdatedAt?: (params: {
        storePath?: string;
        sessionKey: string;
      }) => number | null;
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
    };
    text?: {
      resolveMarkdownTableMode?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
      }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
    };
  };
  [key: string]: unknown;
}

type HttpRouteMatch = "exact" | "prefix";
type HttpRouteAuth = "gateway" | "plugin";

/**
 * HTTP route registration parameters.
 */
export type HttpRouteParams = {
  path: string;
  auth: HttpRouteAuth;
  match?: HttpRouteMatch;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
};

/**
 * Moltbot plugin API interface for host registration.
 */
export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerCli?: (
    registrar: (ctx: { program: unknown; config?: PluginConfig }) => void | Promise<void>,
    opts?: { commands?: string[] }
  ) => void;
  registerHttpHandler?: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean
  ) => void;
  registerHttpRoute?: (params: HttpRouteParams) => void;
  config?: PluginConfig;
  runtime?: unknown;
  [key: string]: unknown;
}
