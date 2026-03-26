// 钉钉配置 schema
import { z } from "zod";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function toTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const next = String(value).trim();
  return next ? next : undefined;
}

const optionalCoercedString = z.preprocess(
  (value) => toTrimmedString(value),
  z.string().min(1).optional()
);

/**
 * 钉钉账户级配置 Schema
 * 
 * 配置字段说明:
 * - enabled: 是否启用该渠道
 * - clientId: 钉钉应用的 AppKey
 * - clientSecret: 钉钉应用的 AppSecret
 * - dmPolicy: 单聊策略 (open=开放, pairing=配对, allowlist=白名单)
 * - groupPolicy: 群聊策略 (open=开放, allowlist=白名单, disabled=禁用)
 * - requireMention: 群聊是否需要 @机器人
 * - allowFrom: 单聊白名单用户 ID 列表
 * - groupAllowFrom: 群聊白名单会话 ID 列表
 * - historyLimit: 历史消息数量限制
 * - textChunkLimit: 文本分块大小限制
 * - longTaskNoticeDelayMs: 长任务提醒延迟（毫秒，0 表示关闭）
 * - enableAICard: 是否启用 AI Card 流式响应
 * - maxFileSizeMB: 媒体文件大小限制 (MB)
 * - inboundMedia: 入站媒体归档与保留策略
 */
const DingtalkAccountSchema = z.object({
  /** 账户显示名 */
  name: z.string().optional(),

  /** 是否启用钉钉渠道 */
  enabled: z.boolean().optional().default(true),
  
  /** 钉钉应用 AppKey (clientId) */
  clientId: optionalCoercedString,
  
  /** 钉钉应用 AppSecret (clientSecret) */
  clientSecret: optionalCoercedString,

  /** 连接模式: stream = 长连接, webhook = Webhook */
  connectionMode: z.enum(["stream", "webhook"]).optional().default("stream"),
  
  /** 单聊策略: open=开放, pairing=配对, allowlist=白名单 */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),
  
  /** 群聊策略: open=开放, allowlist=白名单, disabled=禁用 */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),
  
  /** 群聊是否需要 @机器人才响应 */
  requireMention: z.boolean().optional().default(true),
  
  /** 单聊白名单: 允许的用户 ID 列表 */
  allowFrom: z.array(z.string()).optional(),
  
  /** 群聊白名单: 允许的会话 ID 列表 */
  groupAllowFrom: z.array(z.string()).optional(),
  
  /** 历史消息数量限制 */
  historyLimit: z.number().int().min(0).optional().default(10),
  
  /** 文本分块大小限制 (钉钉单条消息最大 4000 字符) */
  textChunkLimit: z.number().int().positive().optional().default(4000),

  /** 长任务提醒延迟（毫秒），0 表示关闭 */
  longTaskNoticeDelayMs: z.number().int().min(0).optional().default(30000),
  
  /** 是否启用 AI Card 流式响应 */
  enableAICard: z.boolean().optional().default(false),

  /** Gateway auth token（Bearer） */
  gatewayToken: z.string().optional(),

  /** Gateway auth password（替代 gatewayToken） */
  gatewayPassword: z.string().optional(),

  /** 媒体文件大小限制 (MB)，默认 100MB */
  maxFileSizeMB: z.number().positive().optional().default(100),

  /** 入站媒体归档策略 */
  inboundMedia: z
    .object({
      dir: z.string().optional(),
      keepDays: z.number().optional(),
    })
    .optional(),
  
});

/**
 * 钉钉渠道配置 Schema（支持多账户）
 */
export const DingtalkConfigSchema = DingtalkAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(DingtalkAccountSchema).optional(),
});

export type DingtalkConfig = z.output<typeof DingtalkConfigSchema>;
export type DingtalkAccountConfig = z.output<typeof DingtalkAccountSchema>;

type PartialDingtalkAccountConfig = Partial<DingtalkAccountConfig>;
type PartialDingtalkConfig = Partial<Omit<DingtalkConfig, "accounts">> & {
  accounts?: Record<string, PartialDingtalkAccountConfig>;
};

export interface PluginConfig {
  channels?: {
    dingtalk?: PartialDingtalkConfig;
  };
}

export const DEFAULT_ACCOUNT_ID = "default";

const DINGTALK_ACCOUNT_KEYS = [
  "name",
  "clientId",
  "clientSecret",
  "connectionMode",
  "dmPolicy",
  "groupPolicy",
  "requireMention",
  "allowFrom",
  "groupAllowFrom",
  "historyLimit",
  "textChunkLimit",
  "longTaskNoticeDelayMs",
  "enableAICard",
  "gatewayToken",
  "gatewayPassword",
  "maxFileSizeMB",
  "inboundMedia",
] as const;

type DingtalkAccountKey = (typeof DINGTALK_ACCOUNT_KEYS)[number];

const DEFAULT_INBOUND_MEDIA_DIR = join(homedir(), ".openclaw", "media", "dingtalk", "inbound");
const DEFAULT_INBOUND_MEDIA_KEEP_DAYS = 7;
const DEFAULT_INBOUND_MEDIA_TEMP_DIR = join(tmpdir(), "dingtalk-media");

export function resolveInboundMediaDir(config: DingtalkAccountConfig | undefined): string {
  return String(config?.inboundMedia?.dir ?? "").trim() || DEFAULT_INBOUND_MEDIA_DIR;
}

export function resolveInboundMediaKeepDays(config: DingtalkAccountConfig | undefined): number {
  const value = config?.inboundMedia?.keepDays;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_INBOUND_MEDIA_KEEP_DAYS;
}

export function resolveInboundMediaTempDir(): string {
  return DEFAULT_INBOUND_MEDIA_TEMP_DIR;
}

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function baseLooksLikeConcreteAccount(cfg: PartialDingtalkConfig | undefined): boolean {
  if (!cfg) return false;
  return Boolean(
    toTrimmedString(cfg.clientId) ||
      toTrimmedString(cfg.clientSecret) ||
      toTrimmedString(cfg.gatewayToken) ||
      toTrimmedString(cfg.gatewayPassword) ||
      toTrimmedString(cfg.name)
  );
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.dingtalk?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listDingtalkAccountIds(cfg: PluginConfig): string[] {
  const ids = new Set(listConfiguredAccountIds(cfg));
  if (ids.size === 0) return [DEFAULT_ACCOUNT_ID];
  if (baseLooksLikeConcreteAccount(cfg.channels?.dingtalk) && !ids.has(DEFAULT_ACCOUNT_ID)) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultDingtalkAccountId(cfg: PluginConfig): string {
  const dingtalkConfig = cfg.channels?.dingtalk;
  const preferred = toTrimmedString(dingtalkConfig?.defaultAccount);
  if (preferred && listDingtalkAccountIds(cfg).includes(preferred)) {
    return preferred;
  }
  const ids = listDingtalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveDingtalkAccountId(
  cfg: PluginConfig,
  rawAccountId?: string | null
): string {
  return toTrimmedString(rawAccountId) ?? resolveDefaultDingtalkAccountId(cfg);
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): DingtalkAccountConfig | undefined {
  const accounts = cfg.channels?.dingtalk?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as DingtalkAccountConfig | undefined;
}

function extractBaseAccountPatch(
  cfg: PartialDingtalkConfig | undefined
): PartialDingtalkAccountConfig {
  const patch: PartialDingtalkAccountConfig = {};
  const patchRecord = patch as Record<
    DingtalkAccountKey,
    DingtalkAccountConfig[DingtalkAccountKey] | undefined
  >;
  if (!cfg) return patch;

  for (const key of DINGTALK_ACCOUNT_KEYS) {
    const value = cfg[key];
    if (value !== undefined) {
      patchRecord[key] = cloneIfObject(value) as DingtalkAccountConfig[DingtalkAccountKey];
    }
  }

  return patch;
}

export function moveDingtalkSingleAccountConfigToDefaultAccount(
  cfg: PluginConfig
): PluginConfig {
  const dingtalkConfig = cfg.channels?.dingtalk;
  if (!dingtalkConfig) {
    return cfg;
  }

  const accounts = dingtalkConfig.accounts ?? {};
  if (accounts[DEFAULT_ACCOUNT_ID]) {
    return cfg;
  }
  if (!baseLooksLikeConcreteAccount(dingtalkConfig)) {
    return cfg;
  }

  const patch = extractBaseAccountPatch(dingtalkConfig);
  if (Object.keys(patch).length === 0) {
    return cfg;
  }

  const nextChannel = { ...dingtalkConfig } as PartialDingtalkConfig;
  for (const key of DINGTALK_ACCOUNT_KEYS) {
    delete nextChannel[key];
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...nextChannel,
        accounts: {
          ...accounts,
          [DEFAULT_ACCOUNT_ID]: {
            ...patch,
          },
        },
      },
    },
  };
}

export function mergeDingtalkAccountConfig(
  cfg: PluginConfig,
  accountId: string
): DingtalkAccountConfig {
  const base = (cfg.channels?.dingtalk ?? {}) as DingtalkConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...baseConfig, ...account };
}

/**
 * 检查钉钉配置是否已配置凭证
 * @param config 钉钉配置对象
 * @returns 是否已配置 clientId 和 clientSecret
 */
export function isConfigured(config: DingtalkAccountConfig | undefined): boolean {
  const credentials = resolveDingtalkCredentials(config);
  return Boolean(credentials);
}

/**
 * 解析钉钉凭证
 * @param config 钉钉配置对象
 * @returns 凭证对象或 undefined
 */
export function resolveDingtalkCredentials(
  config: DingtalkAccountConfig | undefined
): { clientId: string; clientSecret: string } | undefined {
  const clientId = toTrimmedString(config?.clientId);
  const clientSecret = toTrimmedString(config?.clientSecret);
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return {
    clientId,
    clientSecret,
  };
}
