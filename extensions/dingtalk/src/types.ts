// 钉钉类型定义

import type { DingtalkAccountConfig, DingtalkConfig } from "./config.js";

export type { DingtalkConfig, DingtalkAccountConfig };

/**
 * 富文本消息元素
 * 用于 richText 消息中的各种元素类型
 */
export interface RichTextElement {
  /** 元素类型: text = 文本, picture = 图片, at = @提及 */
  type: "text" | "picture" | "at";
  /** 文本内容（type = "text" 时） */
  text?: string;
  /** 下载码（type = "picture" 时） */
  downloadCode?: string;
  /** 图片下载码备选字段（type = "picture" 时） */
  pictureDownloadCode?: string;
  /** 被@用户 ID（type = "at" 时） */
  userId?: string;
}

/**
 * 媒体消息内容结构
 * 用于 picture, video, audio, file 等消息类型
 */
export interface DingtalkMediaContent {
  /** 下载码 */
  downloadCode?: string;
  /** 图片下载码（picture 消息备选字段） */
  pictureDownloadCode?: string;
  /** 视频下载码（video 消息备选字段） */
  videoDownloadCode?: string;
  /** 音频/视频时长（秒） */
  duration?: number;
  /** 语音识别文本（audio 消息） */
  recognition?: string;
  /** 文件名（file 消息） */
  fileName?: string;
  /** 文件大小（file 消息，字节） */
  fileSize?: number;
  /** 富文本内容（richText 消息） */
  richText?: RichTextElement[] | string;
}

/**
 * 钉钉原始消息结构
 * 从 Stream SDK 回调接收的原始消息格式
 */
export interface DingtalkRawMessage {
  /** 发送者 ID */
  senderId: string;
  /** Stream 消息 ID（从 headers.messageId 透传） */
  streamMessageId?: string;
  /** 发送者 staffId（部分事件提供） */
  senderStaffId?: string;
  /** 发送者 userId（部分事件提供） */
  senderUserId?: string;
  /** 发送者 userid（部分事件提供） */
  senderUserid?: string;
  /** 发送者昵称 */
  senderNick: string;
  /** 会话类型: "1" = 单聊, "2" = 群聊 */
  conversationType: "1" | "2";
  /** 会话 ID */
  conversationId: string;
  /** 消息类型: text, audio, image, file, picture, video, richText 等 */
  msgtype: string;
  /** 文本消息内容 */
  text?: { content: string };
  /**
   * 媒体消息内容
   * NOTE: 此字段可能是对象或 JSON 字符串，需要解析
   */
  content?: string | DingtalkMediaContent;
  /** @提及的用户列表 */
  atUsers?: Array<{ dingtalkId: string }>;
  /** 机器人 Code (clientId) */
  robotCode?: string;
}

/**
 * 解析后的消息上下文
 * 用于内部处理的标准化消息格式
 */
export interface DingtalkMessageContext {
  /** 会话 ID */
  conversationId: string;
  /** 消息 ID */
  messageId: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderNick?: string;
  /** 聊天类型: direct = 单聊, group = 群聊 */
  chatType: "direct" | "group";
  /** 消息内容 */
  content: string;
  /** 内容类型 */
  contentType: string;
  /** 是否 @提及了机器人 */
  mentionedBot: boolean;
  /** 机器人 Code */
  robotCode?: string;
}

/**
 * 发送消息结果
 */
export interface DingtalkSendResult {
  /** 消息 ID */
  messageId: string;
  /** 会话 ID */
  conversationId: string;
}

/**
 * 解析后的钉钉账户配置
 * 用于 ChannelPlugin config 适配器
 */
export interface ResolvedDingtalkAccount {
  /** 账户 ID */
  accountId: string;
  /** 账户名称 */
  name?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否已配置（有凭证） */
  configured: boolean;
  /** 客户端 ID */
  clientId?: string;
}
