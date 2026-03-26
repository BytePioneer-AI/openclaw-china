import type { DingtalkAccountConfig, DingtalkConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  moveDingtalkSingleAccountConfigToDefaultAccount,
  normalizeAccountId,
  type PluginConfig,
} from "./config.js";

function canStoreDefaultAccountInAccounts(cfg: PluginConfig): boolean {
  return Boolean(cfg.channels?.dingtalk?.accounts?.[DEFAULT_ACCOUNT_ID]);
}

export function applyDingtalkAccountPatch(
  cfg: PluginConfig,
  accountId: string,
  patch: Partial<DingtalkAccountConfig>,
): PluginConfig {
  const seededCfg = moveDingtalkSingleAccountConfigToDefaultAccount(cfg);
  const existing = seededCfg.channels?.dingtalk ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID && !canStoreDefaultAccountInAccounts(seededCfg)) {
    return {
      ...seededCfg,
      channels: {
        ...seededCfg.channels,
        dingtalk: {
          ...existing,
          ...patch,
          enabled: true,
        } as DingtalkConfig,
      },
    };
  }

  const accounts = (existing as DingtalkConfig).accounts ?? {};
  return {
    ...seededCfg,
    channels: {
      ...seededCfg.channels,
      dingtalk: {
        ...existing,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...accounts[accountId],
            ...patch,
            enabled: true,
          },
        },
      } as DingtalkConfig,
    },
  };
}

export function buildDingtalkSetupPatch(
  input?: Record<string, unknown>,
): Partial<DingtalkAccountConfig> {
  const raw = input ?? {};
  const patch: Partial<DingtalkAccountConfig> = {};

  if (typeof raw.name === "string" && raw.name.trim()) {
    patch.name = raw.name.trim();
  }
  if (typeof raw.clientId === "string" && raw.clientId.trim()) {
    patch.clientId = raw.clientId.trim();
  }
  if (typeof raw.clientSecret === "string" && raw.clientSecret.trim()) {
    patch.clientSecret = raw.clientSecret.trim();
  }
  if (raw.connectionMode === "stream" || raw.connectionMode === "webhook") {
    patch.connectionMode = raw.connectionMode;
  }
  if (raw.dmPolicy === "open" || raw.dmPolicy === "pairing" || raw.dmPolicy === "allowlist") {
    patch.dmPolicy = raw.dmPolicy;
  }
  if (raw.groupPolicy === "open" || raw.groupPolicy === "allowlist" || raw.groupPolicy === "disabled") {
    patch.groupPolicy = raw.groupPolicy;
  }
  if (typeof raw.gatewayToken === "string" && raw.gatewayToken.trim()) {
    patch.gatewayToken = raw.gatewayToken.trim();
  }
  if (typeof raw.gatewayPassword === "string" && raw.gatewayPassword.trim()) {
    patch.gatewayPassword = raw.gatewayPassword.trim();
  }
  if (typeof raw.enabled === "boolean") {
    patch.enabled = raw.enabled;
  }
  if (typeof raw.requireMention === "boolean") {
    patch.requireMention = raw.requireMention;
  }
  if (typeof raw.enableAICard === "boolean") {
    patch.enableAICard = raw.enableAICard;
  }
  if (Array.isArray(raw.allowFrom)) {
    patch.allowFrom = raw.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (Array.isArray(raw.groupAllowFrom)) {
    patch.groupAllowFrom = raw.groupAllowFrom.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw.historyLimit === "number" && Number.isFinite(raw.historyLimit)) {
    patch.historyLimit = raw.historyLimit;
  }
  if (typeof raw.textChunkLimit === "number" && Number.isFinite(raw.textChunkLimit)) {
    patch.textChunkLimit = raw.textChunkLimit;
  }
  if (typeof raw.longTaskNoticeDelayMs === "number" && Number.isFinite(raw.longTaskNoticeDelayMs)) {
    patch.longTaskNoticeDelayMs = raw.longTaskNoticeDelayMs;
  }
  if (typeof raw.maxFileSizeMB === "number" && Number.isFinite(raw.maxFileSizeMB)) {
    patch.maxFileSizeMB = raw.maxFileSizeMB;
  }
  if (raw.inboundMedia && typeof raw.inboundMedia === "object") {
    patch.inboundMedia = raw.inboundMedia as DingtalkAccountConfig["inboundMedia"];
  }

  return patch;
}

export function resolveDingtalkDmConfigKeys(accountId?: string): {
  policyKey: string;
  allowFromKey: string;
} {
  const normalized = normalizeAccountId(accountId);
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return {
      policyKey: "channels.dingtalk.dmPolicy",
      allowFromKey: "channels.dingtalk.allowFrom",
    };
  }

  return {
    policyKey: `channels.dingtalk.accounts.${normalized}.dmPolicy`,
    allowFromKey: `channels.dingtalk.accounts.${normalized}.allowFrom`,
  };
}

export function setDingtalkDmPolicy(
  cfg: PluginConfig,
  accountId: string,
  dmPolicy: "open" | "pairing" | "allowlist",
): PluginConfig {
  return applyDingtalkAccountPatch(cfg, normalizeAccountId(accountId), { dmPolicy });
}

export function setDingtalkAllowFrom(
  cfg: PluginConfig,
  accountId: string,
  allowFrom: string[],
): PluginConfig {
  return applyDingtalkAccountPatch(cfg, normalizeAccountId(accountId), { allowFrom });
}

export function setDingtalkGroupPolicy(
  cfg: PluginConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): PluginConfig {
  return applyDingtalkAccountPatch(cfg, normalizeAccountId(accountId), { groupPolicy });
}
