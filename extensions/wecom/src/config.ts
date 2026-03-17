// 企业微信配置 schema
import { z } from "zod";

import type {
  ResolvedWecomAccount,
  WecomAccountConfig,
  WecomConfig,
  WecomDmPolicy,
  WecomFooterConfig,
  WecomGroupPolicy,
  WecomTransportMode,
  WecomWsImageReplyMode,
} from "./types.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
export const DEFAULT_WECOM_WS_HEARTBEAT_MS = 30_000;
export const DEFAULT_WECOM_WS_RECONNECT_INITIAL_MS = 1_000;
export const DEFAULT_WECOM_WS_RECONNECT_MAX_MS = 30_000;

const WecomAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["webhook", "ws"]).optional(),
  webhookPath: z.string().optional(),
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),
  botId: z.string().optional(),
  secret: z.string().optional(),
  wsUrl: z.string().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  reconnectInitialDelayMs: z.number().int().positive().optional(),
  reconnectMaxDelayMs: z.number().int().positive().optional(),
  publicBaseUrl: z.string().optional(),
  wsImageReplyMode: z.enum(["native", "markdown-url"]).optional(),
  welcomeText: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  requireMention: z.boolean().optional(),
  footer: z
    .object({
      status: z.boolean().optional(),
      elapsed: z.boolean().optional(),
    })
    .optional(),
});

export const WecomConfigSchema = WecomAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(WecomAccountSchema).optional(),
});

export type ParsedWecomConfig = z.infer<typeof WecomConfigSchema>;

export const WecomConfigJsonSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      mode: { type: "string", enum: ["webhook", "ws"], default: "ws" },
      webhookPath: { type: "string" },
      token: { type: "string" },
      encodingAESKey: { type: "string" },
      receiveId: { type: "string" },
      botId: { type: "string" },
      secret: { type: "string" },
      wsUrl: { type: "string" },
      heartbeatIntervalMs: { type: "integer", minimum: 1 },
      reconnectInitialDelayMs: { type: "integer", minimum: 1 },
      reconnectMaxDelayMs: { type: "integer", minimum: 1 },
      publicBaseUrl: { type: "string" },
      wsImageReplyMode: { type: "string", enum: ["native", "markdown-url"] },
      welcomeText: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
      allowFrom: { type: "array", items: { type: "string" } },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      requireMention: { type: "boolean" },
      footer: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "boolean" },
          elapsed: { type: "boolean" },
        },
      },
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            mode: { type: "string", enum: ["webhook", "ws"], default: "ws" },
            webhookPath: { type: "string" },
            token: { type: "string" },
            encodingAESKey: { type: "string" },
            receiveId: { type: "string" },
            botId: { type: "string" },
            secret: { type: "string" },
            wsUrl: { type: "string" },
            heartbeatIntervalMs: { type: "integer", minimum: 1 },
            reconnectInitialDelayMs: { type: "integer", minimum: 1 },
            reconnectMaxDelayMs: { type: "integer", minimum: 1 },
            publicBaseUrl: { type: "string" },
            wsImageReplyMode: { type: "string", enum: ["native", "markdown-url"] },
            welcomeText: { type: "string" },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
            allowFrom: { type: "array", items: { type: "string" } },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            requireMention: { type: "boolean" },
            footer: {
              type: "object",
              additionalProperties: false,
              properties: {
                status: { type: "boolean" },
                elapsed: { type: "boolean" },
              },
            }
          }
        }
      }
    }
  }
};

export interface PluginConfig {
  session?: {
    store?: unknown;
  };
  channels?: {
    wecom?: WecomConfig;
  };
}

export function parseWecomConfig(raw: unknown): WecomConfig | undefined {
  const parsed = WecomConfigSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data as WecomConfig;
}

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function normalizeMode(raw?: string | null): WecomTransportMode {
  return raw === "webhook" ? "webhook" : "ws";
}

function normalizeWsImageReplyMode(raw?: string | null): WecomWsImageReplyMode {
  return raw === "markdown-url" ? "markdown-url" : "native";
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.wecom?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWecomAccountIds(cfg: PluginConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomAccountId(cfg: PluginConfig): string {
  const wecomConfig = cfg.channels?.wecom;
  if (wecomConfig?.defaultAccount?.trim()) return wecomConfig.defaultAccount.trim();
  const ids = listWecomAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): WecomAccountConfig | undefined {
  const accounts = cfg.channels?.wecom?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WecomAccountConfig | undefined;
}

function mergeWecomAccountConfig(cfg: PluginConfig, accountId: string): WecomAccountConfig {
  const base = (cfg.channels?.wecom ?? {}) as WecomConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const footer: WecomFooterConfig | undefined =
    baseConfig.footer || account.footer ? { ...(baseConfig.footer ?? {}), ...(account.footer ?? {}) } : undefined;
  return {
    ...baseConfig,
    ...account,
    footer,
  };
}

export function resolveWecomAccount(params: { cfg: PluginConfig; accountId?: string | null }): ResolvedWecomAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.wecom?.enabled !== false;
  const merged = mergeWecomAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;
  const mode = normalizeMode(merged.mode);

  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
  const token = merged.token?.trim() || (isDefaultAccount ? process.env.WECOM_TOKEN?.trim() : undefined) || undefined;
  const encodingAESKey =
    merged.encodingAESKey?.trim() || (isDefaultAccount ? process.env.WECOM_ENCODING_AES_KEY?.trim() : undefined) || undefined;
  const botId = merged.botId?.trim() || (isDefaultAccount ? process.env.WECOM_BOT_ID?.trim() : undefined) || undefined;
  const secret = merged.secret?.trim() || (isDefaultAccount ? process.env.WECOM_SECRET?.trim() : undefined) || undefined;
  const receiveId = merged.receiveId?.trim() ?? "";
  const wsUrl = merged.wsUrl?.trim() || DEFAULT_WECOM_WS_URL;
  const publicBaseUrl =
    merged.publicBaseUrl?.trim() || (isDefaultAccount ? process.env.WECOM_PUBLIC_BASE_URL?.trim() : undefined) || undefined;
  const wsImageReplyMode = normalizeWsImageReplyMode(merged.wsImageReplyMode);
  const heartbeatIntervalMs = merged.heartbeatIntervalMs ?? DEFAULT_WECOM_WS_HEARTBEAT_MS;
  const reconnectInitialDelayMs = merged.reconnectInitialDelayMs ?? DEFAULT_WECOM_WS_RECONNECT_INITIAL_MS;
  const reconnectMaxDelayMs = merged.reconnectMaxDelayMs ?? DEFAULT_WECOM_WS_RECONNECT_MAX_MS;
  const configured = mode === "ws" ? Boolean(botId && secret) : Boolean(token && encodingAESKey);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    mode,
    token,
    encodingAESKey,
    receiveId,
    botId,
    secret,
    wsUrl,
    heartbeatIntervalMs,
    reconnectInitialDelayMs,
    reconnectMaxDelayMs,
    publicBaseUrl,
    wsImageReplyMode,
    config: merged,
  };
}

export function listEnabledWecomAccounts(cfg: PluginConfig): ResolvedWecomAccount[] {
  return listWecomAccountIds(cfg)
    .map((accountId) => resolveWecomAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveDmPolicy(config: WecomAccountConfig): WecomDmPolicy {
  return (config.dmPolicy ?? "pairing") as WecomDmPolicy;
}

export function resolveGroupPolicy(config: WecomAccountConfig): WecomGroupPolicy {
  return (config.groupPolicy ?? "open") as WecomGroupPolicy;
}

export function resolveRequireMention(config: WecomAccountConfig): boolean {
  if (typeof config.requireMention === "boolean") return config.requireMention;
  return true;
}

export function resolveAllowFrom(config: WecomAccountConfig): string[] {
  return config.allowFrom ?? [];
}

export function resolveGroupAllowFrom(config: WecomAccountConfig): string[] {
  return config.groupAllowFrom ?? [];
}
