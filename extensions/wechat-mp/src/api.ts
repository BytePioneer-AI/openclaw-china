/**
 * WeChat MP HTTP API adapter layer
 *
 * Provides unified HTTP client for WeChat MP API calls with:
 * - Token injection and refresh on expiry
 * - Error code handling and retry logic
 * - Type-safe request/response handling
 */

import type { ResolvedWechatMpAccount } from "./types.js";
import { getAccessToken, isInvalidTokenError, clearAccessTokenCache } from "./token.js";
import { buildWechatMpXml } from "./crypto.js";

// ============================================================================
// Types
// ============================================================================

export interface WechatMpApiResponse<T = unknown> {
  errcode?: number;
  errmsg?: string;
  data?: T;
}

export interface WechatMpApiError extends Error {
  errcode: number;
  errmsg: string;
  accountId: string;
}

export class WechatMpApiErrorImpl extends Error implements WechatMpApiError {
  constructor(
    message: string,
    public errcode: number,
    public errmsg: string,
    public accountId: string
  ) {
    super(message);
    this.name = "WechatMpApiError";
  }
}

// ============================================================================
// API Client
// ============================================================================

const API_BASE = "https://api.weixin.qq.com";

interface RequestConfig {
  method: "GET" | "POST";
  path: string;
  params?: Record<string, string | number | boolean>;
  body?: unknown;
  requireToken?: boolean;
}

/**
 * Make an API call to WeChat MP
 */
async function callApi<T = unknown>(
  account: ResolvedWechatMpAccount,
  config: RequestConfig
): Promise<WechatMpApiResponse<T>> {
  const url = new URL(`${API_BASE}${config.path}`);

  // Add query params
  if (config.params) {
    for (const [key, value] of Object.entries(config.params)) {
      url.searchParams.set(key, String(value));
    }
  }

  // Add access_token if required
  if (config.requireToken !== false) {
    const token = await getAccessToken(account);
    url.searchParams.set("access_token", token);
  }

  const fetchOptions: RequestInit = {
    method: config.method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (config.body && config.method === "POST") {
    fetchOptions.body = JSON.stringify(config.body);
  }

  const response = await fetch(url.toString(), fetchOptions);
  const data = (await response.json()) as WechatMpApiResponse<T>;

  // Handle token expiry
  if (data.errcode && isInvalidTokenError(data.errcode)) {
    clearAccessTokenCache(account);
    // Retry once with fresh token
    const newToken = await getAccessToken(account);
    url.searchParams.set("access_token", newToken);

    const retryResponse = await fetch(url.toString(), fetchOptions);
    return (await retryResponse.json()) as WechatMpApiResponse<T>;
  }

  return data;
}

/**
 * Make API call with error handling
 * @throws WechatMpApiError if API returns an error
 */
export async function callWechatMpApi<T = unknown>(
  account: ResolvedWechatMpAccount,
  config: RequestConfig
): Promise<T> {
  const response = await callApi<T>(account, config);

  if (response.errcode !== undefined && response.errcode !== 0) {
    throw new WechatMpApiErrorImpl(
      `WeChat MP API error: ${response.errmsg ?? "unknown error"}`,
      response.errcode,
      response.errmsg ?? "unknown error",
      account.accountId
    );
  }

  return response.data as T;
}

// ============================================================================
// Send Message API
// ============================================================================

export interface SendMessageParams {
  touser: string;
  msgtype: "text" | "image" | "voice" | "video" | "music" | "news" | "mpnews" | "msgmenu";
  text?: { content: string };
  image?: { media_id: string };
  voice?: { media_id: string };
  video?: {
    media_id: string;
    thumb_media_id: string;
    title?: string;
    description?: string;
  };
}

export interface SendMessageResult {
  errcode: number;
  errmsg: string;
  msgid?: number;
}

/**
 * Send customer service message (active send)
 */
export async function sendWechatMpMessage(
  account: ResolvedWechatMpAccount,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const response = await callApi<SendMessageResult>(account, {
    method: "POST",
    path: "/cgi-bin/message/custom/send",
    body: params,
  });

  return {
    errcode: response.errcode ?? 0,
    errmsg: response.errmsg ?? "ok",
    msgid: response.data?.msgid,
  };
}

// ============================================================================
// Media Upload API
// ============================================================================

export interface UploadMediaResult {
  type: string;
  media_id: string;
  created_at: number;
}

/**
 * Upload temporary media
 */
export async function uploadWechatMpMedia(
  account: ResolvedWechatMpAccount,
  type: "image" | "voice" | "video" | "thumb",
  media: Buffer,
  filename?: string
): Promise<UploadMediaResult> {
  const token = await getAccessToken(account);
  const url = new URL(`${API_BASE}/cgi-bin/media/upload`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("type", type);

  const formData = new FormData();
  const blob = new Blob([media]);
  formData.append("media", blob, filename ?? `media.${type === "image" ? "jpg" : "mp3"}`);

  const response = await fetch(url.toString(), {
    method: "POST",
    body: formData,
  });

  const data = (await response.json()) as WechatMpApiResponse<UploadMediaResult>;

  if (data.errcode && isInvalidTokenError(data.errcode)) {
    clearAccessTokenCache(account);
    return uploadWechatMpMedia(account, type, media, filename);
  }

  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new WechatMpApiErrorImpl(
      `Upload media failed: ${data.errmsg ?? "unknown error"}`,
      data.errcode,
      data.errmsg ?? "unknown error",
      account.accountId
    );
  }

  return data.data as UploadMediaResult;
}

/**
 * Download temporary media (voice, image, video)
 * Returns the media content as Buffer
 */
export async function downloadWechatMpMedia(
  account: ResolvedWechatMpAccount,
  mediaId: string
): Promise<Buffer> {
  const token = await getAccessToken(account);
  const url = new URL(`${API_BASE}/cgi-bin/media/get`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("media_id", mediaId);

  const response = await fetch(url.toString());

  // Check for JSON error response
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await response.json()) as WechatMpApiResponse;

    if (data.errcode && isInvalidTokenError(data.errcode)) {
      clearAccessTokenCache(account);
      return downloadWechatMpMedia(account, mediaId);
    }

    if (data.errcode !== undefined && data.errcode !== 0) {
      throw new WechatMpApiErrorImpl(
        `Download media failed: ${data.errmsg ?? "unknown error"}`,
        data.errcode,
        data.errmsg ?? "unknown error",
        account.accountId
      );
    }
  }

  // Return binary content as Buffer
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// Menu API
// ============================================================================

export interface MenuButton {
  type: "click" | "view" | "scancode_push" | "scancode_waitmsg" | "pic_sysphoto" | "pic_photo_or_album" | "pic_weixin" | "location_select" | "media_id" | "view_limited";
  name: string;
  key?: string;
  url?: string;
  media_id?: string;
  sub_button?: MenuButton[];
}

export interface MenuConfig {
  button: MenuButton[];
}

/**
 * Create custom menu
 */
export async function createWechatMpMenu(
  account: ResolvedWechatMpAccount,
  menu: MenuConfig
): Promise<{ errcode: number; errmsg: string }> {
  const response = await callApi(account, {
    method: "POST",
    path: "/cgi-bin/menu/create",
    body: menu,
  });

  return {
    errcode: response.errcode ?? 0,
    errmsg: response.errmsg ?? "ok",
  };
}

/**
 * Delete custom menu
 */
export async function deleteWechatMpMenu(
  account: ResolvedWechatMpAccount
): Promise<{ errcode: number; errmsg: string }> {
  const response = await callApi(account, {
    method: "GET",
    path: "/cgi-bin/menu/delete",
  });

  return {
    errcode: response.errcode ?? 0,
    errmsg: response.errmsg ?? "ok",
  };
}

// ============================================================================
// Template Message API
// ============================================================================

export interface TemplateMessageParams {
  touser: string;
  template_id: string;
  url?: string;
  miniprogram?: {
    appid: string;
    pagepath?: string;
  };
  data: Record<string, { value: string; color?: string }>;
}

export interface TemplateMessageResult {
  errcode: number;
  errmsg: string;
  msgid?: number;
}

/**
 * Send template message
 * https://developers.weixin.qq.com/doc/offiaccount/Message_management/Template_message_interface.html
 */
export async function sendTemplateMessage(
  account: ResolvedWechatMpAccount,
  params: TemplateMessageParams
): Promise<TemplateMessageResult> {
  const response = await callApi<TemplateMessageResult>(account, {
    method: "POST",
    path: "/cgi-bin/message/template/send",
    body: params,
  });

  return {
    errcode: response.errcode ?? 0,
    errmsg: response.errmsg ?? "ok",
    msgid: response.data?.msgid,
  };
}
