/**
 * 钉钉 Stream SDK 客户端封装
 * 
 * 提供:
 * - DWClient 实例创建和缓存
 * - Access Token 获取和缓存管理
 */

import { DWClient } from "dingtalk-stream";
import { resolveDingtalkCredentials, type DingtalkConfig } from "./config.js";

// ============================================================================
// DWClient 封装
// ============================================================================

interface DingtalkClientOptions {
  clientId: string;
  clientSecret: string;
}

/** 缓存的客户端实例 */
let cachedClient: DWClient | null = null;
/** 缓存的配置（用于比较是否需要重建客户端） */
let cachedConfig: { clientId: string; clientSecret: string } | null = null;

/**
 * 创建钉钉 Stream 客户端
 * 
 * 如果已存在相同配置的客户端实例，则返回缓存的实例。
 * 
 * @param opts 客户端配置选项
 * @returns DWClient 实例
 */
export function createDingtalkClient(opts: DingtalkClientOptions): DWClient {
  // 检查缓存是否可用
  if (
    cachedClient &&
    cachedConfig &&
    cachedConfig.clientId === opts.clientId &&
    cachedConfig.clientSecret === opts.clientSecret
  ) {
    return cachedClient;
  }

  // 创建新客户端
  // keepAlive: 启用客户端心跳检测，每 8 秒发送 ping，
  // 如果 pong 未返回则强制断开并触发自动重连，防止连接"假死"
  const client = new DWClient({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    keepAlive: true,
  });

  // 更新缓存
  cachedClient = client;
  cachedConfig = {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  };

  return client;
}

/**
 * 从配置创建钉钉 Stream 客户端
 * 
 * @param cfg 钉钉配置
 * @returns DWClient 实例
 * @throws Error 如果凭证未配置
 */
export function createDingtalkClientFromConfig(cfg: DingtalkConfig): DWClient {
  const creds = resolveDingtalkCredentials(cfg);
  if (!creds) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return createDingtalkClient(creds);
}

/**
 * 清除客户端缓存
 * 
 * 用于测试或需要强制重建客户端的场景
 */
export function clearClientCache(): void {
  cachedClient = null;
  cachedConfig = null;
}


// ============================================================================
// Access Token 管理
// ============================================================================

/** 钉钉 OAuth API 端点 */
const DINGTALK_OAUTH_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";

/** Token 请求超时时间（毫秒） */
const TOKEN_REQUEST_TIMEOUT = 10000;

/** Token 提前刷新时间（毫秒）- 提前 5 分钟刷新 */
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

/** Token 缓存结构 */
interface TokenCache {
  /** 访问令牌 */
  accessToken: string;
  /** 过期时间戳（毫秒） */
  expiresAt: number;
  /** 关联的 clientId（用于多账户场景） */
  clientId: string;
}

/** Token 缓存（按 clientId 索引） */
const tokenCacheMap = new Map<string, TokenCache>();

/**
 * 获取钉钉 Access Token
 * 
 * 实现 token 缓存和自动刷新：
 * - 如果缓存的 token 未过期（提前 5 分钟），返回缓存的 token
 * - 否则从钉钉 OAuth 端点获取新 token
 * 
 * @param clientId 钉钉应用 AppKey
 * @param clientSecret 钉钉应用 AppSecret
 * @returns Access Token 字符串
 * @throws Error 如果获取 token 失败
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const now = Date.now();
  const cached = tokenCacheMap.get(clientId);

  // 检查缓存是否有效（提前 5 分钟刷新）
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER) {
    return cached.accessToken;
  }

  // 从钉钉 OAuth 端点获取新 token
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT);

  try {
    const response = await fetch(DINGTALK_OAUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appKey: clientId,
        appSecret: clientSecret,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get DingTalk access token: HTTP ${response.status} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      accessToken: string;
      expireIn: number;
    };

    if (!data.accessToken) {
      throw new Error("DingTalk OAuth response missing accessToken");
    }

    // 缓存 token（过期时间 = 当前时间 + expireIn 秒）
    const expiresAt = now + data.expireIn * 1000;
    tokenCacheMap.set(clientId, {
      accessToken: data.accessToken,
      expiresAt,
      clientId,
    });

    return data.accessToken;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk access token request timed out after ${TOKEN_REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从配置获取 Access Token
 * 
 * @param cfg 钉钉配置
 * @returns Access Token 字符串
 * @throws Error 如果凭证未配置或获取 token 失败
 */
export async function getAccessTokenFromConfig(cfg: DingtalkConfig): Promise<string> {
  const creds = resolveDingtalkCredentials(cfg);
  if (!creds) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(creds.clientId, creds.clientSecret);
}

/**
 * 清除 Token 缓存
 * 
 * @param clientId 可选，指定要清除的 clientId。如果不指定则清除所有缓存
 */
export function clearTokenCache(clientId?: string): void {
  if (clientId) {
    tokenCacheMap.delete(clientId);
  } else {
    tokenCacheMap.clear();
  }
}

/**
 * 检查 Token 是否已缓存且有效
 * 
 * 用于测试和诊断
 * 
 * @param clientId 钉钉应用 AppKey
 * @returns 是否有有效的缓存 token
 */
export function isTokenCached(clientId: string): boolean {
  const cached = tokenCacheMap.get(clientId);
  if (!cached) return false;
  return cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER;
}

/**
 * 获取 Token 缓存信息（用于测试）
 * 
 * @param clientId 钉钉应用 AppKey
 * @returns Token 缓存信息或 undefined
 */
export function getTokenCacheInfo(clientId: string): TokenCache | undefined {
  return tokenCacheMap.get(clientId);
}
