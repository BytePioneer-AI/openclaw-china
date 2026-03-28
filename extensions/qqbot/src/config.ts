import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

function toTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const next = String(value).trim();
  return next ? next : undefined;
}

const optionalCoercedString = z.preprocess(
  (value) => toTrimmedString(value),
  z.string().min(1).optional()
);

const displayAliasesSchema = z
  .record(
    z.preprocess((value) => toTrimmedString(value), z.string().min(1))
  )
  .optional();

export const QQBotC2CMarkdownDeliveryModeSchema = z
  .enum(["passive", "proactive-table-only", "proactive-all"])
  .optional()
  .default("proactive-table-only");

export type QQBotC2CMarkdownDeliveryMode = z.input<typeof QQBotC2CMarkdownDeliveryModeSchema>;

export const QQBotC2CMarkdownChunkStrategySchema = z
  .enum(["markdown-block", "length"])
  .optional()
  .default("markdown-block");

export type QQBotC2CMarkdownChunkStrategy = z.input<typeof QQBotC2CMarkdownChunkStrategySchema>;

export const QQBotTypingHeartbeatModeSchema = z
  .enum(["none", "idle", "always"])
  .optional()
  .default("idle");

export type QQBotTypingHeartbeatMode = z.input<typeof QQBotTypingHeartbeatModeSchema>;

export const DEFAULT_QQBOT_TYPING_HEARTBEAT_MODE = "idle";
export const DEFAULT_QQBOT_TYPING_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_QQBOT_TYPING_INPUT_SECONDS = 60;
export const DEFAULT_QQBOT_C2C_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT = 1200;

// ── Account-level Schema ──────────────────────────────────────────────────────

const QQBotAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  appId: optionalCoercedString,
  clientSecret: optionalCoercedString,
  streaming: z.boolean().optional().default(false),
  displayAliases: displayAliasesSchema,
  asr: z
    .object({
      enabled: z.boolean().optional().default(false),
      appId: optionalCoercedString,
      secretId: optionalCoercedString,
      secretKey: optionalCoercedString,
    })
    .optional(),
  markdownSupport: z.boolean().optional().default(true),
  c2cMarkdownDeliveryMode: QQBotC2CMarkdownDeliveryModeSchema,
  c2cMarkdownChunkStrategy: QQBotC2CMarkdownChunkStrategySchema,
  c2cMarkdownSafeChunkByteLimit: z.number().int().positive().optional(),
  typingHeartbeatMode: QQBotTypingHeartbeatModeSchema,
  typingHeartbeatIntervalMs: z.number().int().positive().optional().default(
    DEFAULT_QQBOT_TYPING_HEARTBEAT_INTERVAL_MS
  ),
  typingInputSeconds: z.number().int().positive().optional().default(
    DEFAULT_QQBOT_TYPING_INPUT_SECONDS
  ),
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),
  requireMention: z.boolean().optional().default(true),
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  historyLimit: z.number().int().min(0).optional().default(10),
  textChunkLimit: z.number().int().positive().optional().default(1500),
  replyFinalOnly: z.boolean().optional().default(false),
  longTaskNoticeDelayMs: z.number().int().min(0).optional().default(30000),
  maxFileSizeMB: z.number().positive().optional().default(100),
  mediaTimeoutMs: z.number().int().positive().optional().default(30000),
  autoSendLocalPathMedia: z.boolean().optional().default(true),
  inboundMedia: z
    .object({
      dir: z.string().optional(),
      keepDays: z.number().optional(),
    })
    .optional(),
});

// ── Top-level Schema (extends account with multi-account fields) ─────────────

export const QQBotConfigSchema = QQBotAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(QQBotAccountSchema).optional(),
});

export type QQBotConfig = z.input<typeof QQBotConfigSchema>;
export type QQBotAccountConfig = z.input<typeof QQBotAccountSchema>;

const DEFAULT_INBOUND_MEDIA_DIR = join(homedir(), ".openclaw", "media", "qqbot", "inbound");
const DEFAULT_INBOUND_MEDIA_KEEP_DAYS = 7;
const DEFAULT_INBOUND_MEDIA_TEMP_DIR = join(tmpdir(), "qqbot-media");

function normalizeDisplayAliasesMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim();
    const value = toTrimmedString(rawValue);
    if (!key || !value) {
      continue;
    }
    aliases[key] = value;
  }
  return aliases;
}

export function resolveInboundMediaDir(config: QQBotAccountConfig | undefined): string {
  return String(config?.inboundMedia?.dir ?? "").trim() || DEFAULT_INBOUND_MEDIA_DIR;
}

export function resolveInboundMediaKeepDays(config: QQBotAccountConfig | undefined): number {
  const value = config?.inboundMedia?.keepDays;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_INBOUND_MEDIA_KEEP_DAYS;
}

export function resolveQQBotAutoSendLocalPathMedia(
  config: QQBotAccountConfig | undefined
): boolean {
  return config?.autoSendLocalPathMedia ?? true;
}

export function resolveQQBotC2CMarkdownSafeChunkByteLimit(
  config: QQBotAccountConfig | undefined
): number | undefined {
  const value = config?.c2cMarkdownSafeChunkByteLimit;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolveQQBotTypingHeartbeatMode(
  config: QQBotAccountConfig | undefined
): QQBotTypingHeartbeatMode {
  return config?.typingHeartbeatMode ?? DEFAULT_QQBOT_TYPING_HEARTBEAT_MODE;
}

export function resolveQQBotTypingHeartbeatIntervalMs(
  config: QQBotAccountConfig | undefined
): number {
  return config?.typingHeartbeatIntervalMs ?? DEFAULT_QQBOT_TYPING_HEARTBEAT_INTERVAL_MS;
}

export function resolveQQBotTypingInputSeconds(
  config: QQBotAccountConfig | undefined
): number {
  return config?.typingInputSeconds ?? DEFAULT_QQBOT_TYPING_INPUT_SECONDS;
}

export function resolveQQBotStreaming(config: QQBotAccountConfig | undefined): boolean {
  return config?.streaming === true;
}

export function resolveInboundMediaTempDir(): string {
  return DEFAULT_INBOUND_MEDIA_TEMP_DIR;
}

// ── PluginConfig interface ────────────────────────────────────────────────────

export interface PluginConfig {
  channels?: {
    qqbot?: QQBotConfig;
  };
}

// ── Multi-account helpers ─────────────────────────────────────────────────────

export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.qqbot?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listQQBotAccountIds(cfg: PluginConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultQQBotAccountId(cfg: PluginConfig): string {
  const qqbotConfig = cfg.channels?.qqbot;
  if (qqbotConfig?.defaultAccount?.trim()) return qqbotConfig.defaultAccount.trim();
  const ids = listQQBotAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): QQBotAccountConfig | undefined {
  const accounts = cfg.channels?.qqbot?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as QQBotAccountConfig | undefined;
}

export function mergeQQBotAccountConfig(cfg: PluginConfig, accountId: string): QQBotAccountConfig {
  const base = (cfg.channels?.qqbot ?? {}) as QQBotConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const mergedDisplayAliases = {
    ...normalizeDisplayAliasesMap(baseConfig.displayAliases),
    ...normalizeDisplayAliasesMap(account.displayAliases),
  };
  return {
    ...baseConfig,
    ...account,
    ...(Object.keys(mergedDisplayAliases).length > 0
      ? { displayAliases: mergedDisplayAliases }
      : {}),
  };
}

// ── Credential helpers ────────────────────────────────────────────────────────

export function isConfigured(config: QQBotAccountConfig | undefined): boolean {
  const appId = toTrimmedString(config?.appId);
  const clientSecret = toTrimmedString(config?.clientSecret);
  return Boolean(appId && clientSecret);
}

export function resolveQQBotCredentials(
  config: QQBotAccountConfig | undefined
): { appId: string; clientSecret: string } | undefined {
  const appId = toTrimmedString(config?.appId);
  const clientSecret = toTrimmedString(config?.clientSecret);
  if (!appId || !clientSecret) return undefined;
  return { appId, clientSecret };
}

export function resolveQQBotASRCredentials(
  config: QQBotAccountConfig | undefined
): { appId: string; secretId: string; secretKey: string } | undefined {
  const asr = config?.asr;
  if (!asr?.enabled) return undefined;
  const appId = toTrimmedString(asr.appId);
  const secretId = toTrimmedString(asr.secretId);
  const secretKey = toTrimmedString(asr.secretKey);
  if (!appId || !secretId || !secretKey) return undefined;
  return {
    appId,
    secretId,
    secretKey,
  };
}
