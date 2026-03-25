import type {
  QQBotAccountConfig,
  QQBotC2CMarkdownChunkStrategy,
  QQBotC2CMarkdownDeliveryMode,
  QQBotTypingHeartbeatMode,
} from "./config.js";

export type {
  QQBotConfig,
  QQBotAccountConfig,
  PluginConfig,
  QQBotC2CMarkdownChunkStrategy,
  QQBotC2CMarkdownDeliveryMode,
  QQBotTypingHeartbeatMode,
} from "./config.js";

export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appId?: string;
  config: QQBotAccountConfig;
  markdownSupport?: boolean;
  c2cMarkdownDeliveryMode?: QQBotC2CMarkdownDeliveryMode;
  c2cMarkdownChunkStrategy?: QQBotC2CMarkdownChunkStrategy;
  typingHeartbeatMode?: QQBotTypingHeartbeatMode;
}

export interface QQBotSendResult {
  channel: "qqbot";
  messageId?: string;
  timestamp?: number | string;
  refIdx?: string;
  error?: string;
}

export type QQChatType = "direct" | "group" | "channel";

export interface QQInboundAttachment {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export interface QQInboundMessage {
  type: QQChatType;
  senderId: string;
  c2cOpenid?: string;
  senderName?: string;
  content: string;
  attachments?: QQInboundAttachment[];
  messageId: string;
  eventId?: string;
  timestamp: number;
  groupOpenid?: string;
  channelId?: string;
  guildId?: string;
  refMsgIdx?: string;
  msgIdx?: string;
  mentionedBot: boolean;
}

export interface InboundContext {
  Body: string;
  RawBody: string;
  CommandBody: string;
  BodyForAgent?: string;
  BodyForCommands?: string;
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;
  ReplyToIsQuote?: boolean;
  From: string;
  To: string;
  SessionKey: string;
  AccountId: string;
  ChatType: "direct" | "group";
  GroupSubject?: string;
  SenderName?: string;
  SenderId: string;
  Provider: "qqbot";
  MessageSid: string;
  Timestamp: number;
  WasMentioned: boolean;
  CommandAuthorized: boolean;
  OriginatingChannel: "qqbot";
  OriginatingTo: string;
}
