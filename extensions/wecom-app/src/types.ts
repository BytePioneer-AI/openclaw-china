/**
 * 企业微信自建应用类型定义
 */

/** DM 消息策略 */
export type WecomAppDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/** 群组消息策略 */
export type WecomAppGroupPolicy = "open" | "allowlist" | "disabled";

/**
 * 企业微信自建应用账户配置
 * 相比普通 wecom 智能机器人，增加了 corpId, corpSecret, agentId 用于主动发送消息
 */
export type WecomAppAccountConfig = {
  name?: string;
  enabled?: boolean;

  /** Webhook 路径 */
  webhookPath?: string;
  /** 回调 Token */
  token?: string;
  /** 回调消息加密密钥 */
  encodingAESKey?: string;
  /** 接收者 ID (用于解密验证) */
  receiveId?: string;

  /** 企业 ID (用于主动发送) */
  corpId?: string;
  /** 应用 Secret (用于主动发送) */
  corpSecret?: string;
  /** 应用 AgentId (用于主动发送) */
  agentId?: number;

  /** 入站媒体（图片/文件）落盘设置 */
  inboundMedia?: {
    /** 是否启用入站媒体落盘（默认 true） */
    enabled?: boolean;
    /** 保存目录（默认 /root/.openclaw/media/wecom-app/inbound） */
    dir?: string;
    /** 单个文件最大字节数（默认 10MB） */
    maxBytes?: number;
    /** 保留天数（默认 7） */
    keepDays?: number;
  };

  /** 欢迎文本 */
  welcomeText?: string;

  /** DM 策略 */
  dmPolicy?: WecomAppDmPolicy;
  /** DM 允许列表 */
  allowFrom?: string[];

  /** 群组策略 */
  groupPolicy?: WecomAppGroupPolicy;
  /** 群组允许列表 */
  groupAllowFrom?: string[];
  /** 是否需要 @ 提及 */
  requireMention?: boolean;
};

/**
 * 企业微信自建应用配置 (顶层)
 */
export type WecomAppConfig = WecomAppAccountConfig & {
  accounts?: Record<string, WecomAppAccountConfig>;
  defaultAccount?: string;
};

/**
 * 解析后的企业微信自建应用账户
 */
export type ResolvedWecomAppAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  /** 回调 Token */
  token?: string;
  /** 回调消息加密密钥 */
  encodingAESKey?: string;
  /** 接收者 ID */
  receiveId: string;
  /** 企业 ID */
  corpId?: string;
  /** 应用 Secret */
  corpSecret?: string;
  /** 应用 AgentId */
  agentId?: number;
  /** 是否支持主动发送 (corpId + corpSecret + agentId 均已配置) */
  canSendActive: boolean;
  config: WecomAppAccountConfig;
};

/** 消息发送目标 */
export type WecomAppSendTarget = {
  /** 用户 ID (与 chatid 二选一) */
  userId?: string;
  /** 群聊 ID (与 userId 二选一) */
  chatid?: string;
};

/** Access Token 缓存条目 */
export type AccessTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 入站消息类型
// ─────────────────────────────────────────────────────────────────────────────

export type WecomAppInboundBase = {
  MsgId?: string;
  msgid?: string;
  aibotid?: string;
  chattype?: "single" | "group";
  chatid?: string;
  response_url?: string;
  from?: { userid?: string; corpid?: string };
  FromUserName?: string;
  ToUserName?: string;
  CreateTime?: number;
  MsgType?: string;
  msgtype?: string;
  AgentID?: number;
};

export type WecomAppInboundText = WecomAppInboundBase & {
  msgtype: "text";
  MsgType?: "text";
  text?: { content?: string };
  Content?: string;
  quote?: unknown;
};

export type WecomAppInboundVoice = WecomAppInboundBase & {
  msgtype: "voice";
  MsgType?: "voice";
  voice?: { content?: string };
  Recognition?: string;
  quote?: unknown;
};

export type WecomAppInboundImage = WecomAppInboundBase & {
  msgtype: "image";
  MsgType?: "image";
  image?: { url?: string };
  PicUrl?: string;
  MediaId?: string;
};

export type WecomAppInboundEvent = WecomAppInboundBase & {
  msgtype: "event";
  MsgType?: "event";
  create_time?: number;
  Event?: string;
  EventKey?: string;
  event?: {
    eventtype?: string;
    [key: string]: unknown;
  };
};

export type WecomAppInboundStreamRefresh = WecomAppInboundBase & {
  msgtype: "stream";
  stream?: { id?: string };
};

export type WecomAppInboundMessage =
  | WecomAppInboundText
  | WecomAppInboundVoice
  | WecomAppInboundImage
  | WecomAppInboundStreamRefresh
  | WecomAppInboundEvent
  | (WecomAppInboundBase & Record<string, unknown>);
