import type { PluginConfig, WechatMpConfig, WechatMpAccountConfig, WechatMpASRCredentials } from "./types.js";

/**
 * Default account identifier for single-account configurations.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * List all configured WeChat MP account IDs.
 * Returns the default account ID if no multi-account config exists.
 */
export function listWechatMpAccountIds(cfg: PluginConfig): string[] {
  const channelCfg = cfg?.channels?.["wechat-mp"] as WechatMpConfig | undefined;
  if (!channelCfg) return [];

  const ids: string[] = [];

  // Add dedicated accounts
  if (channelCfg.accounts) {
    ids.push(...Object.keys(channelCfg.accounts));
  }

  // Include default if root config has credentials
  const hasRootConfig = Boolean(
    channelCfg.appId || channelCfg.appSecret || channelCfg.token
  );
  if (hasRootConfig && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }

  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/**
 * Resolve the default WeChat MP account ID.
 * Returns the first available account or "default".
 */
export function resolveDefaultWechatMpAccountId(cfg: PluginConfig): string {
  const ids = listWechatMpAccountIds(cfg);
  const channelCfg = cfg?.channels?.["wechat-mp"] as WechatMpConfig | undefined;
  const explicitDefault = channelCfg?.defaultAccount;
  if (explicitDefault && ids.includes(explicitDefault)) {
    return explicitDefault;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolved WeChat MP account with merged configuration.
 */
export interface ResolvedWechatMpAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  canSendActive: boolean;
  config: WechatMpAccountConfig;
}

/**
 * Resolve a WeChat MP account configuration.
 * Merges root config with account-specific overrides.
 */
export function resolveWechatMpAccount(params: {
  cfg: PluginConfig;
  accountId?: string;
}): ResolvedWechatMpAccount {
  const { cfg, accountId } = params;
  const channelCfg = (cfg?.channels?.["wechat-mp"] ?? {}) as WechatMpConfig;

  const targetId = accountId?.trim() || resolveDefaultWechatMpAccountId(cfg);

  // Check if dedicated account exists
  const dedicatedAccount = channelCfg.accounts?.[targetId];

  // Merge configurations: root defaults + account overrides
  const merged: WechatMpAccountConfig = dedicatedAccount
    ? {
        name: channelCfg.name,
        enabled: channelCfg.enabled,
        appId: channelCfg.appId,
        appSecret: channelCfg.appSecret,
        encodingAESKey: channelCfg.encodingAESKey,
        token: channelCfg.token,
        webhookPath: channelCfg.webhookPath,
        messageMode: channelCfg.messageMode,
        replyMode: channelCfg.replyMode,
        activeDeliveryMode: channelCfg.activeDeliveryMode,
        renderMarkdown: channelCfg.renderMarkdown,
        welcomeText: channelCfg.welcomeText,
        dmPolicy: channelCfg.dmPolicy,
        allowFrom: channelCfg.allowFrom,
        retryConfig: channelCfg.retryConfig,
        asr: channelCfg.asr,
        ...dedicatedAccount,
      }
    : {
        name: channelCfg.name,
        enabled: channelCfg.enabled,
        appId: channelCfg.appId,
        appSecret: channelCfg.appSecret,
        encodingAESKey: channelCfg.encodingAESKey,
        token: channelCfg.token,
        webhookPath: channelCfg.webhookPath,
        messageMode: channelCfg.messageMode,
        replyMode: channelCfg.replyMode,
        activeDeliveryMode: channelCfg.activeDeliveryMode,
        renderMarkdown: channelCfg.renderMarkdown,
        welcomeText: channelCfg.welcomeText,
        dmPolicy: channelCfg.dmPolicy,
        allowFrom: channelCfg.allowFrom,
        retryConfig: channelCfg.retryConfig,
        asr: channelCfg.asr,
      };

  const configured = Boolean(
    merged.appId &&
    merged.token &&
    (merged.messageMode === "plain" || merged.encodingAESKey)
  );

  const canSendActive = Boolean(
    configured &&
    merged.appId &&
    merged.appSecret
  );

  return {
    accountId: targetId,
    name: merged.name ?? `WeChat MP (${targetId})`,
    enabled: merged.enabled !== false,
    configured,
    canSendActive,
    config: merged,
  };
}

/**
 * Resolve the allowFrom list from account configuration.
 */
export function resolveAllowFrom(config: WechatMpAccountConfig): string[] {
  const list = config.allowFrom ?? [];
  return list
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
}

// ============================================================================
// TARGET AND SESSION KEY HELPERS
// ============================================================================

/**
 * Parse an external target string into openId and accountId components.
 * Supports formats:
 *   - `user:<openid>` (default account)
 *   - `user:<openid>@<accountId>` (explicit account)
 *   - `wechat-mp:user:<openid>` (legacy prefix)
 *   - `wechat-mp:user:<openid>@<accountId>` (legacy with account)
 *   - `<openid>` (bare openid, default account)
 *   - `<openid>@<accountId>` (bare with account)
 */
export function parseWechatMpTarget(
  target: string
): { openId: string; accountId?: string } | null {
  let raw = String(target ?? "").trim();
  if (!raw) return null;

  // Strip wechat-mp: prefix if present
  if (raw.startsWith("wechat-mp:")) {
    raw = raw.slice("wechat-mp:".length);
  }

  // Extract accountId from @ suffix
  let accountId: string | undefined;
  const atIndex = raw.lastIndexOf("@");
  if (atIndex > 0 && atIndex < raw.length - 1) {
    accountId = raw.slice(atIndex + 1).trim();
    raw = raw.slice(0, atIndex);
  }

  // Strip user: prefix if present
  if (raw.startsWith("user:")) {
    raw = raw.slice("user:".length);
  }

  const openId = raw.trim();
  if (!openId) return null;

  return { openId, accountId };
}

/**
 * Build an external target string from openId and optional accountId.
 */
export function buildWechatMpTarget(openId: string, accountId?: string): string {
  const base = `user:${openId}`;
  return accountId ? `${base}@${accountId}` : base;
}

/**
 * Build an internal session key from appId and openId.
 * Format: `dm:<appId>:<openId>`
 */
export function buildWechatMpSessionKey(appId: string, openId: string): string {
  return `dm:${appId}:${openId}`;
}

/**
 * Parse an internal session key to extract appId and openId.
 */
export function parseWechatMpSessionKey(
  sessionKey: string
): { appId: string; openId: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length !== 3 || parts[0] !== "dm") return null;
  return { appId: parts[1], openId: parts[2] };
}

// ============================================================================
// ASR CONFIGURATION HELPERS
// ============================================================================

/**
 * Resolve ASR credentials from account configuration.
 * Returns undefined if ASR is disabled or not fully configured.
 */
export function resolveWechatMpASRCredentials(config: WechatMpAccountConfig): WechatMpASRCredentials | undefined {
  const asr = config.asr;
  if (!asr?.enabled) return undefined;
  if (!asr.appId || !asr.secretId || !asr.secretKey) return undefined;

  return {
    appId: asr.appId,
    secretId: asr.secretId,
    secretKey: asr.secretKey,
    engineType: asr.engineType,
    timeoutMs: asr.timeoutMs,
  };
}
