import { httpGet, httpPost, type HttpRequestOptions } from "@openclaw-china/shared";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

type TokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;
let tokenPromise: Promise<string> | null = null;

const MSG_SEQ_BASE = Math.floor(Date.now() / 1000) % 100000000;
const msgSeqMap = new Map<string, number>();

function nextMsgSeq(messageId?: string): number {
  if (!messageId) return MSG_SEQ_BASE + 1;
  const current = msgSeqMap.get(messageId) ?? 0;
  const next = current + 1;
  msgSeqMap.set(messageId, next);
  if (msgSeqMap.size > 1000) {
    const keys = Array.from(msgSeqMap.keys());
    for (let i = 0; i < 500; i += 1) {
      msgSeqMap.delete(keys[i]);
    }
  }
  return MSG_SEQ_BASE + next;
}

export function clearTokenCache(): void {
  tokenCache = null;
}

export async function getAccessToken(
  appId: string,
  clientSecret: string,
  options?: HttpRequestOptions
): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    try {
      const data = await httpPost<{ access_token?: string; expires_in?: number }>(
        TOKEN_URL,
        { appId, clientSecret },
        { timeout: options?.timeout ?? 15000 }
      );

      if (!data.access_token) {
        throw new Error("access_token missing from QQ response");
      }

      tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
      };
      return tokenCache.token;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
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

function buildMessageBody(params: {
  content: string;
  messageId?: string;
  markdown?: boolean;
}): Record<string, unknown> {
  const msgSeq = nextMsgSeq(params.messageId);
  const body: Record<string, unknown> = params.markdown
    ? {
        markdown: { content: params.content },
        msg_type: 2,
        msg_seq: msgSeq,
      }
    : {
        content: params.content,
        msg_type: 0,
        msg_seq: msgSeq,
      };

  if (params.messageId) {
    body.msg_id = params.messageId;
  }
  return body;
}

export async function sendC2CMessage(params: {
  accessToken: string;
  openid: string;
  content: string;
  messageId?: string;
  markdown?: boolean;
}): Promise<{ id: string; timestamp: number | string }> {
  const body = buildMessageBody({
    content: params.content,
    messageId: params.messageId,
    markdown: params.markdown,
  });
  return apiPost(params.accessToken, `/v2/users/${params.openid}/messages`, body, {
    timeout: 15000,
  });
}

export async function sendGroupMessage(params: {
  accessToken: string;
  groupOpenid: string;
  content: string;
  messageId?: string;
  markdown?: boolean;
}): Promise<{ id: string; timestamp: number | string }> {
  const body = buildMessageBody({
    content: params.content,
    messageId: params.messageId,
    markdown: params.markdown,
  });
  const groupOpenidLower = params.groupOpenid.toLowerCase();
  return apiPost(params.accessToken, `/v2/groups/${groupOpenidLower}/messages`, body, {
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
  const channelIdLower = params.channelId.toLowerCase();
  return apiPost(params.accessToken, `/channels/${channelIdLower}/messages`, body, {
    timeout: 15000,
  });
}

export async function sendC2CInputNotify(params: {
  accessToken: string;
  openid: string;
  messageId?: string;
  inputSecond?: number;
}): Promise<void> {
  const msgSeq = nextMsgSeq(params.messageId);
  await apiPost(
    params.accessToken,
    `/v2/users/${params.openid}/messages`,
    {
      msg_type: 6,
      input_notify: {
        input_type: 1,
        input_second: params.inputSecond ?? 60,
      },
      msg_seq: msgSeq,
      ...(params.messageId ? { msg_id: params.messageId } : {}),
    },
    { timeout: 15000 }
  );
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
}): Promise<UploadMediaResponse> {
  const body: Record<string, unknown> = {
    file_type: params.fileType,
  };
  if (params.url) {
    body.url = params.url;
  } else if (params.fileData) {
    body.file_data = params.fileData;
  } else {
    throw new Error("uploadC2CMedia requires url or fileData");
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
}): Promise<UploadMediaResponse> {
  const body: Record<string, unknown> = {
    file_type: params.fileType,
  };
  if (params.url) {
    body.url = params.url;
  } else if (params.fileData) {
    body.file_data = params.fileData;
  } else {
    throw new Error("uploadGroupMedia requires url or fileData");
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
  content?: string;
}): Promise<{ id: string; timestamp: number | string }> {
  const msgSeq = nextMsgSeq(params.messageId);
  return apiPost(
    params.accessToken,
    `/v2/users/${params.openid}/messages`,
    {
      msg_type: 7,
      media: { file_info: params.fileInfo },
      msg_seq: msgSeq,
      ...(params.content ? { content: params.content } : {}),
      ...(params.messageId ? { msg_id: params.messageId } : {}),
    },
    { timeout: 15000 }
  );
}

export async function sendGroupMediaMessage(params: {
  accessToken: string;
  groupOpenid: string;
  fileInfo: string;
  messageId?: string;
  content?: string;
}): Promise<{ id: string; timestamp: number | string }> {
  const msgSeq = nextMsgSeq(params.messageId);
  return apiPost(
    params.accessToken,
    `/v2/groups/${params.groupOpenid}/messages`,
    {
      msg_type: 7,
      media: { file_info: params.fileInfo },
      msg_seq: msgSeq,
      ...(params.content ? { content: params.content } : {}),
      ...(params.messageId ? { msg_id: params.messageId } : {}),
    },
    { timeout: 15000 }
  );
}
