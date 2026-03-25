import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/setup";
import type { QQBotAccountConfig, QQBotConfig, ResolvedQQBotAccount } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  mergeQQBotAccountConfig,
  normalizeAccountId,
  resolveDefaultQQBotAccountId,
  resolveQQBotCredentials,
  type PluginConfig,
} from "./config.js";
import { qqbotSetupWizard } from "./onboarding.js";

const meta = {
  id: "qqbot",
  label: "QQ Bot",
  selectionLabel: "QQ Bot",
  docsPath: "/channels/qqbot",
  docsLabel: "qqbot",
  blurb: "QQ 开放平台机器人消息",
  aliases: ["qq"] as string[],
  order: 72,
};

export const qqbotChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      defaultAccount: { type: "string" },
      appId: { type: ["string", "number"] },
      clientSecret: { type: "string" },
      displayAliases: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      asr: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          appId: { type: ["string", "number"] },
          secretId: { type: "string" },
          secretKey: { type: "string" },
        },
      },
      markdownSupport: { type: "boolean" },
      c2cMarkdownDeliveryMode: {
        type: "string",
        enum: ["passive", "proactive-table-only", "proactive-all"],
      },
      c2cMarkdownChunkStrategy: {
        type: "string",
        enum: ["markdown-block", "length"],
      },
      c2cMarkdownSafeChunkByteLimit: { type: "integer", minimum: 1 },
      typingHeartbeatMode: {
        type: "string",
        enum: ["none", "idle", "always"],
      },
      typingHeartbeatIntervalMs: { type: "integer", minimum: 1 },
      typingInputSeconds: { type: "integer", minimum: 1 },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      requireMention: { type: "boolean" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      historyLimit: { type: "integer", minimum: 0 },
      textChunkLimit: { type: "integer", minimum: 1 },
      replyFinalOnly: { type: "boolean" },
      longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
      maxFileSizeMB: { type: "number", exclusiveMinimum: 0 },
      mediaTimeoutMs: { type: "integer", minimum: 1 },
      autoSendLocalPathMedia: { type: "boolean" },
      inboundMedia: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          keepDays: { type: "number", minimum: 0 },
        },
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            appId: { type: ["string", "number"] },
            clientSecret: { type: "string" },
            displayAliases: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            asr: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                appId: { type: ["string", "number"] },
                secretId: { type: "string" },
                secretKey: { type: "string" },
              },
            },
            markdownSupport: { type: "boolean" },
            c2cMarkdownDeliveryMode: {
              type: "string",
              enum: ["passive", "proactive-table-only", "proactive-all"],
            },
            c2cMarkdownChunkStrategy: {
              type: "string",
              enum: ["markdown-block", "length"],
            },
            c2cMarkdownSafeChunkByteLimit: { type: "integer", minimum: 1 },
            typingHeartbeatMode: {
              type: "string",
              enum: ["none", "idle", "always"],
            },
            typingHeartbeatIntervalMs: { type: "integer", minimum: 1 },
            typingInputSeconds: { type: "integer", minimum: 1 },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            requireMention: { type: "boolean" },
            allowFrom: { type: "array", items: { type: "string" } },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            historyLimit: { type: "integer", minimum: 0 },
            textChunkLimit: { type: "integer", minimum: 1 },
            replyFinalOnly: { type: "boolean" },
            longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
            maxFileSizeMB: { type: "number", exclusiveMinimum: 0 },
            mediaTimeoutMs: { type: "integer", minimum: 1 },
            autoSendLocalPathMedia: { type: "boolean" },
            inboundMedia: {
              type: "object",
              additionalProperties: false,
              properties: {
                dir: { type: "string" },
                keepDays: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
} as const;

type QQBotSetupPayload = ChannelSetupInput & Partial<QQBotAccountConfig>;

export function normalizeQQBotMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let value = trimmed;
  if (/^qqbot:/i.test(value)) {
    value = value.slice("qqbot:".length);
  }
  if (/^c2c:/i.test(value)) {
    const next = value.slice("c2c:".length).trim();
    return next ? `user:${next}` : undefined;
  }
  if (/^(user|group|channel):/i.test(value)) {
    return value;
  }
  if (value.startsWith("@")) {
    const next = value.slice(1).trim();
    return next ? `user:${next}` : undefined;
  }
  if (value.startsWith("#")) {
    const next = value.slice(1).trim();
    return next ? `group:${next}` : undefined;
  }
  const compact = value.replace(/\s+/g, "");
  if (/^[a-zA-Z0-9]{8,}$/.test(compact)) {
    return `user:${compact}`;
  }
  return value;
}

function normalizeQQBotAllowEntry(raw: string): string {
  const normalized = normalizeQQBotMessagingTarget(raw) ?? raw.trim();
  return normalized.replace(/^user:/i, "").replace(/^qqbot:/i, "").trim().toLowerCase();
}

function buildSetupPatch(
  input?: ChannelSetupInput | Record<string, unknown>,
): Partial<QQBotAccountConfig> {
  const raw = (input ?? {}) as QQBotSetupPayload;
  const patch: Partial<QQBotAccountConfig> = {};
  if (typeof raw.name === "string" && raw.name.trim()) {
    patch.name = raw.name.trim();
  }
  if (typeof raw.appId === "string" || typeof raw.appId === "number") {
    patch.appId = raw.appId;
  }
  if (typeof raw.clientSecret === "string" && raw.clientSecret.trim()) {
    patch.clientSecret = raw.clientSecret.trim();
  }
  if (raw.displayAliases && typeof raw.displayAliases === "object") {
    patch.displayAliases = raw.displayAliases;
  }
  if (raw.asr && typeof raw.asr === "object") {
    patch.asr = raw.asr;
  }
  if (typeof raw.markdownSupport === "boolean") {
    patch.markdownSupport = raw.markdownSupport;
  }
  if (
    raw.c2cMarkdownDeliveryMode === "passive" ||
    raw.c2cMarkdownDeliveryMode === "proactive-table-only" ||
    raw.c2cMarkdownDeliveryMode === "proactive-all"
  ) {
    patch.c2cMarkdownDeliveryMode = raw.c2cMarkdownDeliveryMode;
  }
  if (
    raw.c2cMarkdownChunkStrategy === "markdown-block" ||
    raw.c2cMarkdownChunkStrategy === "length"
  ) {
    patch.c2cMarkdownChunkStrategy = raw.c2cMarkdownChunkStrategy;
  }
  if (
    raw.typingHeartbeatMode === "none" ||
    raw.typingHeartbeatMode === "idle" ||
    raw.typingHeartbeatMode === "always"
  ) {
    patch.typingHeartbeatMode = raw.typingHeartbeatMode;
  }
  if (
    raw.dmPolicy === "open" ||
    raw.dmPolicy === "pairing" ||
    raw.dmPolicy === "allowlist"
  ) {
    patch.dmPolicy = raw.dmPolicy;
  }
  if (
    raw.groupPolicy === "open" ||
    raw.groupPolicy === "allowlist" ||
    raw.groupPolicy === "disabled"
  ) {
    patch.groupPolicy = raw.groupPolicy;
  }
  if (typeof raw.enabled === "boolean") {
    patch.enabled = raw.enabled;
  }
  if (typeof raw.requireMention === "boolean") {
    patch.requireMention = raw.requireMention;
  }
  if (Array.isArray(raw.allowFrom)) {
    patch.allowFrom = raw.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (Array.isArray(raw.groupAllowFrom)) {
    patch.groupAllowFrom = raw.groupAllowFrom.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (
    typeof raw.c2cMarkdownSafeChunkByteLimit === "number" &&
    Number.isFinite(raw.c2cMarkdownSafeChunkByteLimit)
  ) {
    patch.c2cMarkdownSafeChunkByteLimit = raw.c2cMarkdownSafeChunkByteLimit;
  }
  if (
    typeof raw.typingHeartbeatIntervalMs === "number" &&
    Number.isFinite(raw.typingHeartbeatIntervalMs)
  ) {
    patch.typingHeartbeatIntervalMs = raw.typingHeartbeatIntervalMs;
  }
  if (
    typeof raw.typingInputSeconds === "number" &&
    Number.isFinite(raw.typingInputSeconds)
  ) {
    patch.typingInputSeconds = raw.typingInputSeconds;
  }
  if (typeof raw.historyLimit === "number" && Number.isFinite(raw.historyLimit)) {
    patch.historyLimit = raw.historyLimit;
  }
  if (typeof raw.textChunkLimit === "number" && Number.isFinite(raw.textChunkLimit)) {
    patch.textChunkLimit = raw.textChunkLimit;
  }
  if (typeof raw.replyFinalOnly === "boolean") {
    patch.replyFinalOnly = raw.replyFinalOnly;
  }
  if (
    typeof raw.longTaskNoticeDelayMs === "number" &&
    Number.isFinite(raw.longTaskNoticeDelayMs)
  ) {
    patch.longTaskNoticeDelayMs = raw.longTaskNoticeDelayMs;
  }
  if (typeof raw.maxFileSizeMB === "number" && Number.isFinite(raw.maxFileSizeMB)) {
    patch.maxFileSizeMB = raw.maxFileSizeMB;
  }
  if (typeof raw.mediaTimeoutMs === "number" && Number.isFinite(raw.mediaTimeoutMs)) {
    patch.mediaTimeoutMs = raw.mediaTimeoutMs;
  }
  if (typeof raw.autoSendLocalPathMedia === "boolean") {
    patch.autoSendLocalPathMedia = raw.autoSendLocalPathMedia;
  }
  if (raw.inboundMedia && typeof raw.inboundMedia === "object") {
    patch.inboundMedia = raw.inboundMedia;
  }

  return patch;
}

export function applyQQBotAccountPatch(
  cfg: PluginConfig,
  accountId: string,
  patch: Partial<QQBotAccountConfig>,
): PluginConfig {
  const existing = cfg.channels?.qqbot ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        qqbot: {
          ...existing,
          ...patch,
          enabled: true,
        } as QQBotConfig,
      },
    };
  }

  const accounts = (existing as QQBotConfig).accounts ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qqbot: {
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
      } as QQBotConfig,
    },
  };
}

function resolveQQBotAccount(params: {
  cfg: PluginConfig;
  accountId?: string | null;
}): ResolvedQQBotAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeQQBotAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.qqbot?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const credentials = resolveQQBotCredentials(merged);

  return {
    accountId,
    name: merged.name,
    enabled,
    configured: Boolean(credentials),
    appId: credentials?.appId,
    config: merged,
    markdownSupport: merged.markdownSupport ?? true,
    c2cMarkdownDeliveryMode: merged.c2cMarkdownDeliveryMode ?? "proactive-table-only",
    c2cMarkdownChunkStrategy: merged.c2cMarkdownChunkStrategy ?? "markdown-block",
    typingHeartbeatMode: merged.typingHeartbeatMode ?? "idle",
  };
}

function collectQQBotSecurityWarnings(account: ResolvedQQBotAccount): string[] {
  if (account.config.groupPolicy !== "open") {
    return [];
  }
  return [
    '- QQ groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.qqbot.groupPolicy="allowlist" + channels.qqbot.groupAllowFrom to restrict senders.',
  ];
}

export const qqbotSecurityOptions = {
  dm: {
    channelKey: "qqbot",
    resolvePolicy: (account: ResolvedQQBotAccount) => account.config.dmPolicy,
    resolveAllowFrom: (account: ResolvedQQBotAccount) => account.config.allowFrom,
    defaultPolicy: "open",
    normalizeEntry: (entry: string) => normalizeQQBotAllowEntry(entry),
  },
  collectWarnings: ({ account }: { account: ResolvedQQBotAccount }) =>
    collectQQBotSecurityWarnings(account),
};

export const qqbotPluginBase = {
  id: "qqbot",
  meta,
  setupWizard: qqbotSetupWizard,
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  configSchema: qqbotChannelConfigSchema,
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => listQQBotAccountIds(cfg as PluginConfig),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedQQBotAccount =>
      resolveQQBotAccount({ cfg: cfg as PluginConfig, accountId }),
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const account = resolveQQBotAccount({ cfg: cfg as PluginConfig, accountId });
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
      };
    },
    defaultAccountId: (cfg: OpenClawConfig): string =>
      resolveDefaultQQBotAccountId(cfg as PluginConfig),
    setAccountEnabled: ({
      cfg,
      accountId,
      enabled,
    }: {
      cfg: OpenClawConfig;
      accountId: string;
      enabled: boolean;
    }): OpenClawConfig => {
      const resolvedAccountId = normalizeAccountId(accountId);
      const existing = (cfg as PluginConfig).channels?.qqbot ?? {};
      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            qqbot: { ...existing, enabled } as QQBotConfig,
          },
        };
      }

      const accounts = (existing as QQBotConfig).accounts ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          qqbot: {
            ...existing,
            accounts: {
              ...accounts,
              [resolvedAccountId]: { ...accounts[resolvedAccountId], enabled },
            },
          } as QQBotConfig,
        },
      };
    },
    deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }): OpenClawConfig => {
      const resolvedAccountId = normalizeAccountId(accountId);
      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        const next = { ...(cfg as PluginConfig) };
        const nextChannels = { ...(cfg.channels ?? {}) };
        delete (nextChannels as Record<string, unknown>).qqbot;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels as PluginConfig["channels"];
        } else {
          delete next.channels;
        }
        return next as OpenClawConfig;
      }

      const existing = (cfg as PluginConfig).channels?.qqbot;
      if (!existing?.accounts?.[resolvedAccountId]) {
        return cfg;
      }

      const { [resolvedAccountId]: _removed, ...remainingAccounts } = existing.accounts;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          qqbot: {
            ...existing,
            accounts: Object.keys(remainingAccounts).length > 0 ? remainingAccounts : undefined,
          } as QQBotConfig,
        },
      };
    },
    isEnabled: (account: ResolvedQQBotAccount) => account.enabled,
    isConfigured: (account: ResolvedQQBotAccount) => account.configured,
    describeAccount: (account: ResolvedQQBotAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }): string[] => {
      const resolved = resolveQQBotAccount({
        cfg: cfg as PluginConfig,
        accountId: accountId ?? undefined,
      });
      return resolved.config.allowFrom ?? [];
    },
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry) => normalizeQQBotAllowEntry(String(entry)))
        .filter(Boolean),
  },
  setup: {
    resolveAccountId: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
      normalizeAccountId(accountId ?? resolveDefaultQQBotAccountId(cfg as PluginConfig)),
    applyAccountConfig: ({
      cfg,
      accountId,
      input,
      ...legacy
    }: {
      cfg: OpenClawConfig;
      accountId: string;
      input?: ChannelSetupInput;
      config?: Record<string, unknown>;
    }): OpenClawConfig => {
      const resolvedAccountId = normalizeAccountId(accountId);
      const patch = buildSetupPatch(input ?? legacy.config);
      return applyQQBotAccountPatch(cfg as PluginConfig, resolvedAccountId, patch) as OpenClawConfig;
    },
  },
  groups: {
    resolveRequireMention: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) => {
      const resolved = resolveQQBotAccount({
        cfg: cfg as PluginConfig,
        accountId: accountId ?? undefined,
      });
      return resolved.config.requireMention ?? true;
    },
  },
  messaging: {
    normalizeTarget: (raw: string): string | undefined => normalizeQQBotMessagingTarget(raw),
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        if (!candidate) return false;
        if (/^(user|group|channel):/i.test(candidate)) return true;
        if (/^[@#]/.test(raw.trim())) return true;
        return /^[a-zA-Z0-9]{8,}$/.test(candidate);
      },
      hint: "Use user:<openid> for C2C, group:<group_openid> for groups, channel:<channel_id> for QQ channels.",
    },
    formatTargetDisplay: (params: {
      target: string;
      display?: string;
      kind?: "user" | "group" | "channel";
    }) => {
      const { target, display, kind } = params;
      if (display?.trim()) {
        const trimmed = display.trim();
        if (trimmed.startsWith("@") || trimmed.startsWith("#")) {
          return trimmed;
        }
        if (kind === "user") return `@${trimmed}`;
        if (kind === "group" || kind === "channel") return `#${trimmed}`;
        return trimmed;
      }
      return target;
    },
  },
} satisfies Pick<
  ChannelPlugin<ResolvedQQBotAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
  | "groups"
  | "messaging"
>;
