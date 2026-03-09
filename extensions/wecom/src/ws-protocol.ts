import crypto from "node:crypto";

import type { ResolvedWecomAccount, WecomInboundMessage } from "./types.js";
import { DEFAULT_WECOM_WS_URL } from "./config.js";
import type { WecomReplyMsgItem } from "./ws-media.js";

type JsonRecord = Record<string, unknown>;

export type WecomWsHeaders = {
  req_id?: string;
};

export type WecomWsFrame = {
  cmd?: string;
  headers?: WecomWsHeaders;
  body?: unknown;
  errcode?: number;
  errmsg?: string;
};

export type WecomWsMessageCallbackFrame = {
  cmd: "aibot_msg_callback";
  headers?: WecomWsHeaders;
  body?: WecomInboundMessage;
};

export type WecomWsEventCallbackFrame = {
  cmd: "aibot_event_callback";
  headers?: WecomWsHeaders;
  body?: WecomInboundMessage;
};

export type WecomWsNormalizedCallback =
  | {
      kind: "message";
      reqId: string;
      msg: WecomInboundMessage;
      target: string;
      msgId?: string;
    }
  | {
      kind: "event";
      reqId: string;
      msg: WecomInboundMessage;
      target: string;
      msgId?: string;
      eventType?: string;
    };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

export function createWecomWsReqId(): string {
  return crypto.randomUUID();
}

export function createWecomWsStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function buildWecomWsSubscribeCommand(account: ResolvedWecomAccount): WecomWsFrame {
  return {
    cmd: "aibot_subscribe",
    headers: {
      req_id: createWecomWsReqId(),
    },
    body: {
      bot_id: account.botId ?? "",
      secret: account.secret ?? "",
    },
  };
}

export function buildWecomWsPingCommand(reqId: string = createWecomWsReqId()): WecomWsFrame {
  return {
    cmd: "ping",
    headers: {
      req_id: reqId,
    },
  };
}

export function buildWecomWsRespondMessageCommand(params: {
  reqId: string;
  streamId: string;
  content?: string;
  finish: boolean;
  msgItems?: WecomReplyMsgItem[];
}): WecomWsFrame {
  const body: JsonRecord = {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: params.finish,
    },
  };
  const trimmed = params.content?.trim();
  if (trimmed) {
    (body.stream as JsonRecord).content = trimmed;
  }
  if (params.finish && Array.isArray(params.msgItems) && params.msgItems.length > 0) {
    (body.stream as JsonRecord).msg_item = params.msgItems;
  }
  return {
    cmd: "aibot_respond_msg",
    headers: {
      req_id: params.reqId,
    },
    body,
  };
}

export function buildWecomWsRespondWelcomeCommand(params: {
  reqId: string;
  content: string;
}): WecomWsFrame {
  return {
    cmd: "aibot_respond_welcome_msg",
    headers: {
      req_id: params.reqId,
    },
    body: {
      msgtype: "text",
      text: {
        content: params.content,
      },
    },
  };
}

export function buildWecomWsUpdateTemplateCardCommand(params: {
  reqId: string;
  templateCard: Record<string, unknown>;
}): WecomWsFrame {
  return {
    cmd: "aibot_respond_update_msg",
    headers: {
      req_id: params.reqId,
    },
    body: {
      response_type: "update_template_card",
      template_card: params.templateCard,
    },
  };
}

export function buildWecomWsSendMessageCommand(params: {
  chatId: string;
  body: Record<string, unknown>;
}): WecomWsFrame {
  return {
    cmd: "aibot_send_msg",
    headers: {
      req_id: createWecomWsReqId(),
    },
    body: {
      chatid: params.chatId,
      ...params.body,
    },
  };
}

export function resolveWecomWsTarget(msg: WecomInboundMessage): string {
  const chatType = String(msg.chattype ?? "").toLowerCase() === "group" ? "group" : "single";
  if (chatType === "group") {
    const chatId = String(msg.chatid ?? "").trim() || "unknown";
    return `group:${chatId}`;
  }
  const senderId = String(msg.from?.userid ?? "").trim() || "unknown";
  return `user:${senderId}`;
}

export function normalizeWecomWsCallback(frame: WecomWsFrame): WecomWsNormalizedCallback | null {
  const cmd = String(frame.cmd ?? "").trim();
  if (cmd !== "aibot_msg_callback" && cmd !== "aibot_event_callback") {
    return null;
  }
  const reqId = String(frame.headers?.req_id ?? "").trim();
  const body = asRecord(frame.body) as unknown as WecomInboundMessage;
  if (!reqId || !body || typeof body !== "object") {
    return null;
  }
  const msg = body;
  const target = resolveWecomWsTarget(msg);
  const msgId = typeof msg.msgid === "string" ? msg.msgid.trim() || undefined : undefined;
  if (cmd === "aibot_msg_callback") {
    return {
      kind: "message",
      reqId,
      msg,
      target,
      msgId,
    };
  }
  const eventType = String((msg as { event?: { eventtype?: string } }).event?.eventtype ?? "").trim() || undefined;
  return {
    kind: "event",
    reqId,
    msg,
    target,
    msgId,
    eventType,
  };
}

export function resolveWecomWsUrl(account: ResolvedWecomAccount): string {
  const configured = account.wsUrl.trim();
  return configured || DEFAULT_WECOM_WS_URL;
}
