/**
 * 微信客服渠道配置 schema
 */
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ResolvedWecomKfAccount,
  WecomKfAccountConfig,
  WecomKfConfig,
  WecomKfDmPolicy,
  WecomKfASRCredentials,
} from "./types.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

const WecomKfAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  webhookPath: z.string().optional(),
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),
  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  openKfid: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  welcomeText: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  inboundMedia: z
    .object({
      enabled: z.boolean().optional(),
      dir: z.string().optional(),
      maxBytes: z.number().optional(),
      keepDays: z.number().optional(),
    })
    .optional(),
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
      timeoutMs: z.number().optional(),
    })
    .optional(),
});

export const WecomKfConfigSchema = WecomKfAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(WecomKfAccountSchema).optional(),
});

export type ParsedWecomKfConfig = z.infer<typeof WecomKfConfigSchema>;

const MEDIA_SCHEMA_PROPERTIES = {
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
} as const;

const BASE_ACCOUNT_PROPERTIES = {
  name: { type: "string" },
  enabled: { type: "boolean" },
  webhookPath: { type: "string" },
  token: { type: "string" },
  encodingAESKey: { type: "string" },
  receiveId: { type: "string" },
  corpId: { type: "string" },
  corpSecret: { type: "string" },
  openKfid: { type: "string" },
  apiBaseUrl: { type: "string" },
  welcomeText: { type: "string" },
  dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
  allowFrom: { type: "array", items: { type: "string" } },
  ...MEDIA_SCHEMA_PROPERTIES,
} as const;

export const WecomKfConfigJsonSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...BASE_ACCOUNT_PROPERTIES,
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...BASE_ACCOUNT_PROPERTIES,
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
    "wecom-kf"?: WecomKfConfig;
  };
}

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.["wecom-kf"]?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWecomKfAccountIds(cfg: PluginConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomKfAccountId(cfg: PluginConfig): string {
  const kfConfig = cfg.channels?.["wecom-kf"];
  if (kfConfig?.defaultAccount?.trim()) return kfConfig.defaultAccount.trim();
  const ids = listWecomKfAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): WecomKfAccountConfig | undefined {
  const accounts = cfg.channels?.["wecom-kf"]?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WecomKfAccountConfig | undefined;
}

function mergeWecomKfAccountConfig(cfg: PluginConfig, accountId: string): WecomKfAccountConfig {
  const base = (cfg.channels?.["wecom-kf"] ?? {}) as WecomKfConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...baseConfig, ...account };
}

export function resolveWecomKfAccount(params: { cfg: PluginConfig; accountId?: string | null }): ResolvedWecomKfAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["wecom-kf"]?.enabled !== false;
  const merged = mergeWecomKfAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;
  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;

  const resolveEnv = (primary: string, legacy?: string): string | undefined => {
    if (!isDefaultAccount) return undefined;
    const next =
      process.env[primary]?.trim() ||
      (legacy ? process.env[legacy]?.trim() : undefined) ||
      undefined;
    return next || undefined;
  };

  // 回调配置
  const token = merged.token?.trim() || resolveEnv("WECOM_KF_TOKEN");
  const encodingAESKey = merged.encodingAESKey?.trim() || resolveEnv("WECOM_KF_ENCODING_AES_KEY");

  // 微信客服接口配置
  const corpId = merged.corpId?.trim() || resolveEnv("WECOM_KF_CORP_ID");
  const corpSecret = merged.corpSecret?.trim() || resolveEnv("WECOM_KF_CORP_SECRET");
  const openKfid = merged.openKfid?.trim() || resolveEnv("WECOM_KF_OPEN_KFID");
  const receiveId = merged.receiveId?.trim() || corpId || "";
  const apiBaseUrl = merged.apiBaseUrl?.trim() || resolveEnv("WECOM_KF_API_BASE_URL");

  const configured = Boolean(token && encodingAESKey);
  const canSend = Boolean(corpId && corpSecret && openKfid);

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
    openKfid,
    canSend,
    config: { ...merged, corpSecret, openKfid, apiBaseUrl, receiveId },
  };
}

export function listEnabledWecomKfAccounts(cfg: PluginConfig): ResolvedWecomKfAccount[] {
  return listWecomKfAccountIds(cfg)
    .map((accountId) => resolveWecomKfAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveDmPolicy(config: WecomKfAccountConfig): WecomKfDmPolicy {
  return (config.dmPolicy ?? "open") as WecomKfDmPolicy;
}

export function resolveAllowFrom(config: WecomKfAccountConfig): string[] {
  return config.allowFrom ?? [];
}

export const DEFAULT_WECOM_KF_API_BASE_URL = "https://qyapi.weixin.qq.com";

export function resolveApiBaseUrl(config: WecomKfAccountConfig): string {
  const raw = (config.apiBaseUrl ?? "").trim();
  if (!raw) return DEFAULT_WECOM_KF_API_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 入站媒体配置解析
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_INBOUND_MEDIA_DIR = join(homedir(), ".openclaw", "media", "wecom-kf", "inbound");
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_INBOUND_MEDIA_KEEP_DAYS = 7;

export function resolveInboundMediaEnabled(config: WecomKfAccountConfig): boolean {
  if (typeof config.inboundMedia?.enabled === "boolean") return config.inboundMedia.enabled;
  return true;
}

export function resolveInboundMediaDir(config: WecomKfAccountConfig): string {
  return (config.inboundMedia?.dir ?? "").trim() || DEFAULT_INBOUND_MEDIA_DIR;
}

export function resolveInboundMediaMaxBytes(config: WecomKfAccountConfig): number {
  const v = config.inboundMedia?.maxBytes;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

export function resolveInboundMediaKeepDays(config: WecomKfAccountConfig): number {
  const v = config.inboundMedia?.keepDays;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_INBOUND_MEDIA_KEEP_DAYS;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASR 配置解析
// ─────────────────────────────────────────────────────────────────────────────

export function resolveWecomKfASRCredentials(config: WecomKfAccountConfig): WecomKfASRCredentials | undefined {
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
