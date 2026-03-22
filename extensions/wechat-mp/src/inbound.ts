import { buildWechatMpSessionKey, buildWechatMpTarget } from "./config.js";
import type {
  ResolvedWechatMpAccount,
  WechatMpInboundCandidate,
  WechatMpInboundEventName,
  WechatMpInboundMessage,
} from "./types.js";

const INTENTFUL_EVENTS = new Set<WechatMpInboundEventName>(["subscribe", "scan", "click"]);
const TRACKED_EVENTS = new Set<WechatMpInboundEventName>([
  "subscribe",
  "unsubscribe",
  "scan",
  "click",
  "view",
]);

function normalizeEventName(raw: string | undefined): WechatMpInboundEventName | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (TRACKED_EVENTS.has(value as WechatMpInboundEventName)) {
    return value as WechatMpInboundEventName;
  }
  return undefined;
}

export function normalizeWechatMpInbound(params: {
  account: ResolvedWechatMpAccount;
  message: WechatMpInboundMessage;
  encrypted: boolean;
}): WechatMpInboundCandidate | null {
  const { account, message, encrypted } = params;
  const openId = String(message.FromUserName ?? "").trim();
  if (!openId) return null;

  const createTime = Number(message.CreateTime ?? 0) || 0;
  const target = buildWechatMpTarget(openId, account.accountId);
  const sessionKey = account.config.appId
    ? buildWechatMpSessionKey(account.config.appId, openId)
    : undefined;

  if (message.MsgType === "text") {
    const content = String(message.Content ?? "").trim();
    if (!content) return null;
    const msgId = String(message.MsgId ?? "").trim() || undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "text",
      msgId,
      dedupeKey: msgId || `text:${account.accountId}:${openId}:${createTime}:${content}`,
      encrypted,
      hasUserIntent: true,
      content,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "event") {
    const eventValue =
      "Event" in message && typeof message.Event === "string"
        ? message.Event
        : undefined;
    const event = normalizeEventName(eventValue);
    if (!event) return null;
    const eventKey =
      "EventKey" in message && typeof message.EventKey === "string"
        ? message.EventKey.trim() || undefined
        : undefined;
    const ticket =
      "Ticket" in message && typeof message.Ticket === "string"
        ? message.Ticket.trim() || undefined
        : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "event",
      dedupeKey: `event:${account.accountId}:${openId}:${event}:${eventKey ?? ""}:${createTime}`,
      encrypted,
      hasUserIntent: INTENTFUL_EVENTS.has(event),
      event,
      eventKey,
      ticket,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "image") {
    const picUrl =
      "PicUrl" in message && typeof message.PicUrl === "string"
        ? message.PicUrl.trim() || undefined
        : undefined;
    const mediaId =
      "MediaId" in message && typeof message.MediaId === "string"
        ? message.MediaId.trim() || undefined
        : undefined;
    const msgId = "MsgId" in message && typeof message.MsgId === "string"
      ? message.MsgId.trim() || undefined
      : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "image",
      msgId,
      dedupeKey: msgId || `image:${account.accountId}:${openId}:${createTime}:${mediaId ?? ""}`,
      encrypted,
      hasUserIntent: true, // Image messages have user intent
      picUrl,
      mediaId,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "voice") {
    const mediaId =
      "MediaId" in message && typeof message.MediaId === "string"
        ? message.MediaId.trim() || undefined
        : undefined;
    const format =
      "Format" in message && typeof message.Format === "string"
        ? message.Format.trim() || undefined
        : undefined;
    const recognition =
      "Recognition" in message && typeof message.Recognition === "string"
        ? message.Recognition.trim() || undefined
        : undefined;
    const msgId = "MsgId" in message && typeof message.MsgId === "string"
      ? message.MsgId.trim() || undefined
      : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "voice",
      msgId,
      dedupeKey: msgId || `voice:${account.accountId}:${openId}:${createTime}:${mediaId ?? ""}`,
      encrypted,
      hasUserIntent: true,
      mediaId,
      format,
      recognition,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "video" || message.MsgType === "shortvideo") {
    const mediaId =
      "MediaId" in message && typeof message.MediaId === "string"
        ? message.MediaId.trim() || undefined
        : undefined;
    const thumbMediaId =
      "ThumbMediaId" in message && typeof message.ThumbMediaId === "string"
        ? message.ThumbMediaId.trim() || undefined
        : undefined;
    const msgId = "MsgId" in message && typeof message.MsgId === "string"
      ? message.MsgId.trim() || undefined
      : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: message.MsgType,
      msgId,
      dedupeKey: msgId || `${message.MsgType}:${account.accountId}:${openId}:${createTime}:${mediaId ?? ""}`,
      encrypted,
      hasUserIntent: true,
      mediaId,
      thumbMediaId,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "location") {
    const locationX =
      "Location_X" in message && typeof message.Location_X === "number"
        ? message.Location_X
        : undefined;
    const locationY =
      "Location_Y" in message && typeof message.Location_Y === "number"
        ? message.Location_Y
        : undefined;
    const scale =
      "Scale" in message && typeof message.Scale === "number"
        ? message.Scale
        : undefined;
    const label =
      "Label" in message && typeof message.Label === "string"
        ? message.Label.trim() || undefined
        : undefined;
    const msgId = "MsgId" in message && typeof message.MsgId === "string"
      ? message.MsgId.trim() || undefined
      : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "location",
      msgId,
      dedupeKey: msgId || `location:${account.accountId}:${openId}:${createTime}:${locationX},${locationY}`,
      encrypted,
      hasUserIntent: true,
      locationX,
      locationY,
      scale,
      label,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  if (message.MsgType === "link") {
    const title =
      "Title" in message && typeof message.Title === "string"
        ? message.Title.trim() || undefined
        : undefined;
    const description =
      "Description" in message && typeof message.Description === "string"
        ? message.Description.trim() || undefined
        : undefined;
    const url =
      "Url" in message && typeof message.Url === "string"
        ? message.Url.trim() || undefined
        : undefined;
    const msgId = "MsgId" in message && typeof message.MsgId === "string"
      ? message.MsgId.trim() || undefined
      : undefined;
    return {
      accountId: account.accountId,
      openId,
      appId: account.config.appId,
      target,
      sessionKey,
      createTime,
      msgType: "link",
      msgId,
      dedupeKey: msgId || `link:${account.accountId}:${openId}:${createTime}:${url ?? ""}`,
      encrypted,
      hasUserIntent: true,
      title,
      description,
      url,
      toUserName: String(message.ToUserName ?? "").trim() || undefined,
      raw: message,
    };
  }

  return null;
}
