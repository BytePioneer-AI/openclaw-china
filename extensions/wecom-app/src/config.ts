/**
 * 企业微信自建应用配置 schema
 */
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ResolvedWecomAppAccount,
  WecomAppAccountConfig,
  WecomAppASRCredentials,
  WecomAppConfig,
  WecomAppDmPolicy,
} from "./types.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

const WecomAppAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  webhookPath: z.string().optional(),
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),
  // 自建应用特有字段
  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  agentId: z.number().optional(),
  apiBaseUrl: z.string().optional(),

  // 媒体文件大小限制 (MB)
  maxFileSizeMB: z.number().optional(),

  // 入站媒体（图片/文件）落盘设置
  inboundMedia: z
    .object({
      enabled: z.boolean().optional(),
      dir: z.string().optional(),
      maxBytes: z.number().optional(),
      keepDays: z.number().optional(),
    })
    .optional(),

  // 语音发送策略（可选）：当遇到不支持的格式（如 wav/mp3）时，
  // - enabled=true 且系统存在 ffmpeg：自动转码为 amr 后再发送 voice
  // - 否则：降级为 file 发送（并可配合 caption 提示）
  voiceTranscode: z
    .object({
      enabled: z.boolean().optional(),
      prefer: z.enum(["amr"]).optional(),
    })
    .optional(),
  asr: z
    .object({
      enabled: z.boolean().optional(),
      appId: z.string().optional(),
      secretId: z.string().optional(),
      secretKey: z.string().optional(),
      engineType: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),

  // 其他字段
  welcomeText: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
});

export const WecomAppConfigSchema = WecomAppAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(WecomAppAccountSchema).optional(),
});

export type ParsedWecomAppConfig = z.infer<typeof WecomAppConfigSchema>;

export const WecomAppConfigJsonSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      webhookPath: { type: "string" },
      token: { type: "string" },
      encodingAESKey: { type: "string" },
      receiveId: { type: "string" },
      corpId: { type: "string" },
      corpSecret: { type: "string" },
      agentId: { type: "number" },
      apiBaseUrl: { type: "string" },
      inboundMedia: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          dir: { type: "string" },
          maxBytes: { type: "number" },
          keepDays: { type: "number" },
        },
      },
      voiceTranscode: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          prefer: { type: "string", enum: ["amr"] },
        },
      },
      asr: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          appId: { type: "string" },
          secretId: { type: "string" },
          secretKey: { type: "string" },
          engineType: { type: "string" },
          timeoutMs: { type: "number" },
        },
      },
      welcomeText: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
      allowFrom: { type: "array", items: { type: "string" } },
      maxFileSizeMB: { type: "number" },
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            webhookPath: { type: "string" },
            token: { type: "string" },
            encodingAESKey: { type: "string" },
            receiveId: { type: "string" },
            corpId: { type: "string" },
            corpSecret: { type: "string" },
            agentId: { type: "number" },
            apiBaseUrl: { type: "string" },
            inboundMedia: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                dir: { type: "string" },
                maxBytes: { type: "number" },
                keepDays: { type: "number" },
              },
            },
            asr: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                appId: { type: "string" },
                secretId: { type: "string" },
                secretKey: { type: "string" },
                engineType: { type: "string" },
                timeoutMs: { type: "number" },
              },
            },
            welcomeText: { type: "string" },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
            allowFrom: { type: "array", items: { type: "string" } },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            requireMention: { type: "boolean" },
            maxFileSizeMB: { type: "number" },
          },
        },
      },
    },
  },
};

export interface PluginConfig {
  session?: {
    store?: unknown;
  };
  channels?: {
    "wecom-app"?: WecomAppConfig;
  };
}

export function parseWecomAppConfig(raw: unknown): WecomAppConfig | undefined {
  const parsed = WecomAppConfigSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data as WecomAppConfig;
}

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.["wecom-app"]?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWecomAppAccountIds(cfg: PluginConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomAppAccountId(cfg: PluginConfig): string {
  const wecomAppConfig = cfg.channels?.["wecom-app"];
  if (wecomAppConfig?.defaultAccount?.trim()) return wecomAppConfig.defaultAccount.trim();
  const ids = listWecomAppAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): WecomAppAccountConfig | undefined {
  const accounts = cfg.channels?.["wecom-app"]?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WecomAppAccountConfig | undefined;
}

function mergeWecomAppAccountConfig(cfg: PluginConfig, accountId: string): WecomAppAccountConfig {
  const base = (cfg.channels?.["wecom-app"] ?? {}) as WecomAppConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...baseConfig, ...account };
}

export function resolveWecomAppAccount(params: { cfg: PluginConfig; accountId?: string | null }): ResolvedWecomAppAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["wecom-app"]?.enabled !== false;
  const merged = mergeWecomAppAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;

  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;

  // 回调配置
  const token = merged.token?.trim() || (isDefaultAccount ? process.env.WECOM_APP_TOKEN?.trim() : undefined) || undefined;
  const encodingAESKey =
    merged.encodingAESKey?.trim() ||
    (isDefaultAccount ? process.env.WECOM_APP_ENCODING_AES_KEY?.trim() : undefined) ||
    undefined;
  const receiveId = merged.receiveId?.trim() ?? "";

  // 自建应用配置 (用于主动发送)
  const corpId = merged.corpId?.trim() || (isDefaultAccount ? process.env.WECOM_APP_CORP_ID?.trim() : undefined) || undefined;
  const corpSecret =
    merged.corpSecret?.trim() || (isDefaultAccount ? process.env.WECOM_APP_CORP_SECRET?.trim() : undefined) || undefined;
  let envAgentId: number | undefined;
  if (isDefaultAccount && process.env.WECOM_APP_AGENT_ID) {
    const parsed = parseInt(process.env.WECOM_APP_AGENT_ID, 10);
    if (!Number.isNaN(parsed)) {
      envAgentId = parsed;
    }
  }

  const agentId = merged.agentId ?? envAgentId;
  const apiBaseUrl =
    merged.apiBaseUrl?.trim() ||
    (isDefaultAccount ? process.env.WECOM_APP_API_BASE_URL?.trim() : undefined) ||
    undefined;

  const configured = Boolean(token && encodingAESKey);
  const canSendActive = Boolean(corpId && corpSecret && agentId);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    canSendActive,
    config: { ...merged, apiBaseUrl },
  };
}

export function listEnabledWecomAppAccounts(cfg: PluginConfig): ResolvedWecomAppAccount[] {
  return listWecomAppAccountIds(cfg)
    .map((accountId) => resolveWecomAppAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveDmPolicy(config: WecomAppAccountConfig): WecomAppDmPolicy {
  return (config.dmPolicy ?? "pairing") as WecomAppDmPolicy;
}

export function resolveAllowFrom(config: WecomAppAccountConfig): string[] {
  return config.allowFrom ?? [];
}

export const DEFAULT_WECOM_APP_API_BASE_URL = "https://qyapi.weixin.qq.com";

export function resolveApiBaseUrl(config: WecomAppAccountConfig): string {
  const raw = (config.apiBaseUrl ?? "").trim();
  if (!raw) return DEFAULT_WECOM_APP_API_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体设置
// ─────────────────────────────────────────────────────────────────────────────

// Cross-platform default: ~/.openclaw/media/wecom-app/inbound
// - Linux/macOS: /home/<user>/.openclaw/...
// - Windows: C:\Users\<user>\.openclaw\...
const DEFAULT_INBOUND_MEDIA_DIR = join(homedir(), ".openclaw", "media", "wecom-app", "inbound");
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_INBOUND_MEDIA_KEEP_DAYS = 7;

export function resolveInboundMediaEnabled(config: WecomAppAccountConfig): boolean {
  // 默认启用（方便开箱即用的图片识别）
  if (typeof config.inboundMedia?.enabled === "boolean") return config.inboundMedia.enabled;
  return true;
}

export function resolveInboundMediaDir(config: WecomAppAccountConfig): string {
  return (config.inboundMedia?.dir ?? "").trim() || DEFAULT_INBOUND_MEDIA_DIR;
}

export function resolveInboundMediaMaxBytes(config: WecomAppAccountConfig): number {
  const v = config.inboundMedia?.maxBytes;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

export function resolveInboundMediaKeepDays(config: WecomAppAccountConfig): number {
  const v = config.inboundMedia?.keepDays;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_INBOUND_MEDIA_KEEP_DAYS;
}

export function resolveMaxFileSizeMB(config: WecomAppAccountConfig): number {
  const v = config.maxFileSizeMB;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 100;
}

export function resolveWecomAppASRCredentials(config: WecomAppAccountConfig): WecomAppASRCredentials | undefined {
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
