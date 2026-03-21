import { HttpError, httpGet, httpPost, type HttpRequestOptions } from "@xuanyue202/shared";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const MSG_SEQ_BASE = 1000000;
const MAX_DUPLICATE_MSG_SEQ_RETRIES = 5;

type TokenCache = {
  token: string;
  expiresAt: number;
};

// 按 appId 区分的 token 缓存（支持多账户）
const tokenCacheMap = new Map<string, TokenCache>();
const tokenPromiseMap = new Map<string, Promise<string>>();

const msgSeqMap = new Map<string, number>();
let fallbackMsgSeq = 0;

function toTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const next = String(value).trim();
  return next ? next : undefined;
}

function requireTrimmedString(value: unknown, field: string): string {
  const normalized = toTrimmedString(value);
  if (!normalized) {
    throw new Error(`QQBot ${field} is empty`);
  }
  return normalized;
}

function sanitizeUploadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return "file";
  const normalized = trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return normalized || "file";
}

function nextMsgSeq(sequenceKey?: string): number {
  if (!sequenceKey) {
    fallbackMsgSeq += 1;
    return MSG_SEQ_BASE + fallbackMsgSeq;
  }
  const current = msgSeqMap.get(sequenceKey) ?? 0;
  const next = current + 1;
  msgSeqMap.set(sequenceKey, next);
  if (msgSeqMap.size > 1000) {
    const keys = Array.from(msgSeqMap.keys());
    for (let i = 0; i < 500; i += 1) {
      msgSeqMap.delete(keys[i]);
    }
  }
  return MSG_SEQ_BASE + next;
}

function resolveMsgSeqKey(messageId?: string, eventId?: string): string | undefined {
  if (messageId) return `msg:${messageId}`;
  if (eventId) return `event:${eventId}`;
  return undefined;
}

function isDuplicateMsgSeqError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 400) {
    return false;
  }

  const body = err.body?.trim();
  if (!body) {
    return false;
  }

  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      err_code?: unknown;
      message?: unknown;
    };
    if (parsed.code === 40054005 || parsed.err_code === 40054005) {
      return true;
    }
    const message = typeof parsed.message === "string" ? parsed.message.toLowerCase() : "";
    return message.includes("msgseq") && (message.includes("去重") || message.includes("duplicate"));
  } catch {
    const lowered = body.toLowerCase();
    return lowered.includes("msgseq") && (lowered.includes("去重") || lowered.includes("duplicate"));
  }
}

async function postPassiveMessage<T>(params: {
  accessToken: string;
  path: string;
  sequenceKey?: string;
  options?: HttpRequestOptions;
  buildBody: (msgSeq: number) => Record<string, unknown>;
}): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_DUPLICATE_MSG_SEQ_RETRIES; attempt += 1) {
    const msgSeq = nextMsgSeq(params.sequenceKey);
    try {
      return await apiPost(params.accessToken, params.path, params.buildBody(msgSeq), params.options);
    } catch (err) {
      lastError = err;
      if (!isDuplicateMsgSeqError(err) || attempt === MAX_DUPLICATE_MSG_SEQ_RETRIES) {
        throw err;
      }
    }
  }

  throw lastError;
}

export function clearTokenCache(appId?: string | number): void {
  const normalizedAppId = toTrimmedString(appId);
  if (normalizedAppId) {
    tokenCacheMap.delete(normalizedAppId);
    tokenPromiseMap.delete(normalizedAppId);
  } else {
    tokenCacheMap.clear();
    tokenPromiseMap.clear();
  }
}

export async function getAccessToken(
  appId: string | number,
  clientSecret: string | number,
  options?: HttpRequestOptions
): Promise<string> {
  const normalizedAppId = requireTrimmedString(appId, "appId");
  const normalizedClientSecret = requireTrimmedString(clientSecret, "clientSecret");

  const cached = tokenCacheMap.get(normalizedAppId);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const existingPromise = tokenPromiseMap.get(normalizedAppId);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = (async () => {
    try {
      const data = await httpPost<{ access_token?: string; expires_in?: number }>(
        TOKEN_URL,
        { appId: normalizedAppId, clientSecret: normalizedClientSecret },
        { timeout: options?.timeout ?? 15000 }
      );

      if (!data.access_token) {
        throw new Error("access_token missing from QQ response");
      }

      tokenCacheMap.set(normalizedAppId, {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
      });
      return data.access_token;
    } finally {
      tokenPromiseMap.delete(normalizedAppId);
    }
  })();

  tokenPromiseMap.set(normalizedAppId, promise);
  return promise;
}


async function apiGet<T>(
  accessToken: string,
  path: string,
  options?: HttpRequestOptions
): Promise<T> {
  const url = `${API_BASE}${path}`;
  return httpGet<T>(url, {
    ...options,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      ...(options?.headers ?? {}),
    },
  });
}

async function apiPost<T>(
  accessToken: string,
  path: string,
  body: unknown,
  options?: HttpRequestOptions
): Promise<T> {
  const url = `${API_BASE}${path}`;
  return httpPost<T>(url, body, {
    ...options,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      ...(options?.headers ?? {}),
    },
  });
}

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiGet<{ url: string }>(accessToken, "/gateway", { timeout: 15000 });
  return data.url;
}

type QQBotMessageResponse = {
  id: string;
  timestamp: number | string;
  ext_info?: {
    ref_idx?: string;
  };
};

function buildMessageBody(params: {
  content: string;
  messageId?: string;
  eventId?: string;
  markdown?: boolean;
  msgSeq: number;
}): Record<string, unknown> {
  const body = buildTextMessageBody({
    content: params.content,
    markdown: params.markdown,
  });
  body.msg_seq = params.msgSeq;

  if (params.messageId) {
    body.msg_id = params.messageId;
  } else if (params.eventId) {
    body.event_id = params.eventId;
  }
  return body;
}

function buildTextMessageBody(params: {
  content: string;
  markdown?: boolean;
}): Record<string, unknown> {
  return params.markdown
    ? {
        markdown: { content: params.content },
        msg_type: 2,
      }
    : {
        content: params.content,
        msg_type: 0,
      };
}

function buildProactiveMessageBody(params: {
  content: string;
  markdown?: boolean;
}): Record<string, unknown> {
  if (!params.content.trim()) {
    throw new Error("QQBot proactive message content is empty");
  }
  return buildTextMessageBody(params);
}

export async function sendC2CMessage(params: {
  accessToken: string;
  openid: string;
  content: string;
  messageId?: string;
  eventId?: string;
  markdown?: boolean;
}): Promise<QQBotMessageResponse> {
  return postPassiveMessage({
    accessToken: params.accessToken,
    path: `/v2/users/${params.openid}/messages`,
    sequenceKey: resolveMsgSeqKey(params.messageId, params.eventId),
    options: { timeout: 15000 },
    buildBody: (msgSeq) =>
      buildMessageBody({
        content: params.content,
        messageId: params.messageId,
        eventId: params.eventId,
        markdown: params.markdown,
        msgSeq,
      }),
  });
}

export async function sendGroupMessage(params: {
  accessToken: string;
  groupOpenid: string;
  content: string;
  messageId?: string;
  eventId?: string;
  markdown?: boolean;
}): Promise<{ id: string; timestamp: number | string }> {
  return postPassiveMessage({
    accessToken: params.accessToken,
    path: `/v2/groups/${params.groupOpenid}/messages`,
    sequenceKey: resolveMsgSeqKey(params.messageId, params.eventId),
    options: { timeout: 15000 },
    buildBody: (msgSeq) =>
      buildMessageBody({
        content: params.content,
        messageId: params.messageId,
        eventId: params.eventId,
        markdown: params.markdown,
        msgSeq,
      }),
  });
}

export async function sendProactiveC2CMessage(params: {
  accessToken: string;
  openid: string;
  content: string;
  markdown?: boolean;
}): Promise<QQBotMessageResponse> {
  const body = buildProactiveMessageBody({
    content: params.content,
    markdown: params.markdown,
  });
  return apiPost(params.accessToken, `/v2/users/${params.openid}/messages`, body, {
    timeout: 15000,
  });
}

export async function sendProactiveGroupMessage(params: {
  accessToken: string;
  groupOpenid: string;
  content: string;
  markdown?: boolean;
}): Promise<{ id: string; timestamp: number | string }> {
  const body = buildProactiveMessageBody({
    content: params.content,
    markdown: params.markdown,
  });
  return apiPost(params.accessToken, `/v2/groups/${params.groupOpenid}/messages`, body, {
    timeout: 15000,
  });
}

export async function sendChannelMessage(params: {
  accessToken: string;
  channelId: string;
  content: string;
  messageId?: string;
}): Promise<{ id: string; timestamp: number | string }> {
  const body: Record<string, unknown> = { content: params.content };
  if (params.messageId) {
    body.msg_id = params.messageId;
  }
  return apiPost(params.accessToken, `/channels/${params.channelId}/messages`, body, {
    timeout: 15000,
  });
}

export async function sendC2CInputNotify(params: {
  accessToken: string;
  openid: string;
  messageId?: string;
  eventId?: string;
  inputSecond?: number;
}): Promise<{ refIdx?: string }> {
  const response = await postPassiveMessage<QQBotMessageResponse>({
    accessToken: params.accessToken,
    path: `/v2/users/${params.openid}/messages`,
    sequenceKey: resolveMsgSeqKey(params.messageId, params.eventId),
    options: { timeout: 15000 },
    buildBody: (msgSeq) => ({
      msg_type: 6,
      input_notify: {
        input_type: 1,
        input_second: params.inputSecond ?? 60,
      },
      msg_seq: msgSeq,
      ...(params.messageId
        ? { msg_id: params.messageId }
        : params.eventId
          ? { event_id: params.eventId }
          : {}),
    }),
  });
  const refIdx = response.ext_info?.ref_idx?.trim();
  return refIdx ? { refIdx } : {};
}

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

export async function uploadC2CMedia(params: {
  accessToken: string;
  openid: string;
  fileType: MediaFileType;
  url?: string;
  fileData?: string;
  fileName?: string;
  srvSendMsg?: boolean;
}): Promise<UploadMediaResponse> {
  const body: Record<string, unknown> = {
    file_type: params.fileType,
    srv_send_msg: params.srvSendMsg ?? false,
  };
  if (params.url) {
    body.url = params.url;
  } else if (params.fileData) {
    body.file_data = params.fileData;
  } else {
    throw new Error("uploadC2CMedia requires url or fileData");
  }
  if (params.fileType === MediaFileType.FILE && params.fileName?.trim()) {
    body.file_name = sanitizeUploadFileName(params.fileName);
  }

  return apiPost(params.accessToken, `/v2/users/${params.openid}/files`, body, {
    timeout: 30000,
  });
}

export async function uploadGroupMedia(params: {
  accessToken: string;
  groupOpenid: string;
  fileType: MediaFileType;
  url?: string;
  fileData?: string;
  fileName?: string;
  srvSendMsg?: boolean;
}): Promise<UploadMediaResponse> {
  const body: Record<string, unknown> = {
    file_type: params.fileType,
    srv_send_msg: params.srvSendMsg ?? false,
  };
  if (params.url) {
    body.url = params.url;
  } else if (params.fileData) {
    body.file_data = params.fileData;
  } else {
    throw new Error("uploadGroupMedia requires url or fileData");
  }
  if (params.fileType === MediaFileType.FILE && params.fileName?.trim()) {
    body.file_name = sanitizeUploadFileName(params.fileName);
  }

  return apiPost(params.accessToken, `/v2/groups/${params.groupOpenid}/files`, body, {
    timeout: 30000,
  });
}

export async function sendC2CMediaMessage(params: {
  accessToken: string;
  openid: string;
  fileInfo: string;
  messageId?: string;
  eventId?: string;
  content?: string;
}): Promise<QQBotMessageResponse> {
  return postPassiveMessage({
    accessToken: params.accessToken,
    path: `/v2/users/${params.openid}/messages`,
    sequenceKey: resolveMsgSeqKey(params.messageId, params.eventId),
    options: { timeout: 15000 },
    buildBody: (msgSeq) => ({
      msg_type: 7,
      media: { file_info: params.fileInfo },
      msg_seq: msgSeq,
      ...(params.content ? { content: params.content } : {}),
      ...(params.messageId
        ? { msg_id: params.messageId }
        : params.eventId
          ? { event_id: params.eventId }
          : {}),
    }),
  });
}

export async function sendGroupMediaMessage(params: {
  accessToken: string;
  groupOpenid: string;
  fileInfo: string;
  messageId?: string;
  eventId?: string;
  content?: string;
}): Promise<{ id: string; timestamp: number | string }> {
  return postPassiveMessage({
    accessToken: params.accessToken,
    path: `/v2/groups/${params.groupOpenid}/messages`,
    sequenceKey: resolveMsgSeqKey(params.messageId, params.eventId),
    options: { timeout: 15000 },
    buildBody: (msgSeq) => ({
      msg_type: 7,
      media: { file_info: params.fileInfo },
      msg_seq: msgSeq,
      ...(params.content ? { content: params.content } : {}),
      ...(params.messageId
        ? { msg_id: params.messageId }
        : params.eventId
          ? { event_id: params.eventId }
          : {}),
    }),
  });
}
