/**
 * 企业微信自建应用类型定义
 */

/** DM 消息策略 */
export type WecomAppDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

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
  /** 企业微信 API 基础地址（可选，默认 https://qyapi.weixin.qq.com） */
  apiBaseUrl?: string;

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

  /** 媒体文件大小限制 (MB)，默认 100 */
  maxFileSizeMB?: number;

  /**
   * 语音发送转码策略（可选）
   * enabled=true 时：当检测到 wav/mp3 等不支持的语音格式，
   * - 若系统存在 ffmpeg：自动转码为 amr 再以 voice 发送
   * - 若无 ffmpeg：降级为 file 发送
   */
  voiceTranscode?: {
    enabled?: boolean;
    prefer?: "amr";
  };

  /**
   * 入站语音 ASR 配置（腾讯云录音文件识别极速版）
   */
  asr?: {
    enabled?: boolean;
    appId?: string;
    secretId?: string;
    secretKey?: string;
    engineType?: string;
    timeoutMs?: number;
  };

  /** 欢迎文本 */
  welcomeText?: string;

  /** DM 策略 */
  dmPolicy?: WecomAppDmPolicy;
  /** DM 允许列表 */
  allowFrom?: string[];
};

/**
 * 企业微信自建应用配置 (顶层)
 */
export type WecomAppConfig = WecomAppAccountConfig & {
  accounts?: Record<string, WecomAppAccountConfig>;
  defaultAccount?: string;
};

export type WecomAppASRCredentials = {
  appId: string;
  secretId: string;
  secretKey: string;
  engineType?: string;
  timeoutMs?: number;
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
  /** 用户 ID */
  userId: string;
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
  /** 语音 MediaId (用于下载原始语音文件) */
  MediaId?: string;
  /** 语音格式 (amr/speex) */
  Format?: string;
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
