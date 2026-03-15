/**
 * 微信客服渠道类型定义
 */

/** DM 消息策略 */
export type WecomKfDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

/**
 * 微信客服账户配置
 * 使用 corpId + corpSecret 获取 access_token，openKfid 标识客服账号
 */
export type WecomKfAccountConfig = {
  name?: string;
  enabled?: boolean;

  /** Webhook 路径（接收企微回调） */
  webhookPath?: string;
  /** 回调 Token（用于验签） */
  token?: string;
  /** 回调消息加密密钥 */
  encodingAESKey?: string;
  /** 接收者 ID（用于解密验证，通常为 corpId） */
  receiveId?: string;

  /** 企业 ID */
  corpId?: string;
  /** 微信客服应用 Secret（用于获取 access_token） */
  corpSecret?: string;
  /** 客服账号 ID（open_kfid） */
  openKfid?: string;
  /** 企业微信 API 基础地址（可选，默认 https://qyapi.weixin.qq.com） */
  apiBaseUrl?: string;

  /** 欢迎文本 */
  welcomeText?: string;

  /** DM 策略 */
  dmPolicy?: WecomKfDmPolicy;
  /** DM 允许列表（external_userid） */
  allowFrom?: string[];

  /** 入站媒体（图片/文件/语音）落盘设置 */
  inboundMedia?: {
    /** 是否启用入站媒体落盘（默认 true） */
    enabled?: boolean;
    /** 保存目录（默认 /root/.openclaw/media/wecom-kf/inbound） */
    dir?: string;
    /** 单个文件最大字节数（默认 10MB） */
    maxBytes?: number;
    /** 过期清理天数（默认 7） */
    keepDays?: number;
  };

  /**
   * 语音发送转码策略
   * 默认会对非 amr/speex 的音频自动转码为 amr；
   * enabled=false 时显式关闭转码，对不兼容格式回退为 file 发送。
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
};

/**
 * 微信客服配置（顶层）
 */
export type WecomKfConfig = WecomKfAccountConfig & {
  accounts?: Record<string, WecomKfAccountConfig>;
  defaultAccount?: string;
};

/**
 * 解析后的微信客服账户
 */
export type ResolvedWecomKfAccount = {
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
  /** 微信客服应用 Secret */
  corpSecret?: string;
  /** 客服账号 ID（open_kfid） */
  openKfid?: string;
  /** 是否支持收发消息（corpId + corpSecret + openKfid 均已配置） */
  canSend: boolean;
  /** 原始账户配置 */
  config: WecomKfAccountConfig;
};

/** 消息发送目标 */
export type WecomKfSendTarget = {
  /** 外部用户 ID（external_userid） */
  externalUserId: string;
  /** 当前会话对应的客服账号 ID（open_kfid） */
  openKfId?: string;
};

/** Access Token 缓存条目 */
export type AccessTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

/** ASR 凭证 */
export type WecomKfASRCredentials = {
  appId: string;
  secretId: string;
  secretKey: string;
  engineType?: string;
  timeoutMs?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 入站消息类型（通过 sync_msg 拉取到的消息）
// ─────────────────────────────────────────────────────────────────────────────

/** sync_msg 返回的消息基础字段 */
export type WecomKfInboundBase = {
  msgid?: string;
  open_kfid?: string;
  external_userid?: string;
  send_time?: number;
  /**
   * 消息来源
   * 3: 微信客户发送
   * 4: 系统推送
   * 5: 接待人员在企业微信回复
   */
  origin?: number;
  servicer_userid?: string;
  msgtype?: string;
};

export type WecomKfInboundText = WecomKfInboundBase & {
  msgtype: "text";
  text?: { content?: string; menu_id?: string };
};

export type WecomKfInboundImage = WecomKfInboundBase & {
  msgtype: "image";
  image?: { media_id?: string };
};

export type WecomKfInboundVoice = WecomKfInboundBase & {
  msgtype: "voice";
  voice?: { media_id?: string };
};

export type WecomKfInboundVideo = WecomKfInboundBase & {
  msgtype: "video";
  video?: { media_id?: string };
};

export type WecomKfInboundFile = WecomKfInboundBase & {
  msgtype: "file";
  file?: { media_id?: string };
};

export type WecomKfInboundLocation = WecomKfInboundBase & {
  msgtype: "location";
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
};

export type WecomKfInboundLink = WecomKfInboundBase & {
  msgtype: "link";
  link?: {
    title?: string;
    desc?: string;
    url?: string;
    pic_url?: string;
  };
};

export type WecomKfInboundBusinessCard = WecomKfInboundBase & {
  msgtype: "business_card";
  business_card?: { userid?: string };
};

export type WecomKfInboundMiniprogram = WecomKfInboundBase & {
  msgtype: "miniprogram";
  miniprogram?: {
    title?: string;
    appid?: string;
    pagepath?: string;
    thumb_media_id?: string;
  };
};

/** 事件消息（会话状态变更、接待人员变更等） */
export type WecomKfInboundEvent = WecomKfInboundBase & {
  msgtype: "event";
  event?: {
    event_type?: string;
    open_kfid?: string;
    external_userid?: string;
    scene?: string;
    scene_param?: string;
    welcome_code?: string;
    wechat_channels?: Record<string, unknown>;
    fail_msgid?: string;
    fail_type?: number;
    servicer_userid?: string;
    status?: number;
    change_type?: number;
    old_servicer_userid?: string;
    new_servicer_userid?: string;
    msg_code?: string;
    recall_msgid?: string;
    [key: string]: unknown;
  };
};

export type WecomKfInboundMessage =
  | WecomKfInboundText
  | WecomKfInboundImage
  | WecomKfInboundVoice
  | WecomKfInboundVideo
  | WecomKfInboundFile
  | WecomKfInboundLocation
  | WecomKfInboundLink
  | WecomKfInboundBusinessCard
  | WecomKfInboundMiniprogram
  | WecomKfInboundEvent
  | (WecomKfInboundBase & Record<string, unknown>);

// ─────────────────────────────────────────────────────────────────────────────
// sync_msg 响应
// ─────────────────────────────────────────────────────────────────────────────

export type SyncMsgResponse = {
  errcode?: number;
  errmsg?: string;
  next_cursor?: string;
  has_more?: number;
  msg_list?: WecomKfInboundMessage[];
};
