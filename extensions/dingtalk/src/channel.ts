/**
 * 钉钉 ChannelPlugin 实现
 *
 * 实现 Moltbot ChannelPlugin 接口，提供:
 * - meta: 渠道元数据
 * - capabilities: 渠道能力声明
 * - config: 账户配置适配器
 * - outbound: 出站消息适配器
 * - gateway: 连接管理适配器
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1
 */

import type { ResolvedDingtalkAccount, DingtalkConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listDingtalkAccountIds,
  mergeDingtalkAccountConfig,
  moveDingtalkSingleAccountConfigToDefaultAccount,
  resolveDingtalkAccountId,
  resolveDefaultDingtalkAccountId,
  resolveDingtalkCredentials,
  type PluginConfig,
} from "./config.js";
import { dingtalkOutbound } from "./outbound.js";
import {
  monitorDingtalkProvider,
  stopDingtalkMonitorForAccount,
} from "./monitor.js";
import { sendMessageDingtalk } from "./send.js";
import { dingtalkMessageActions } from "./actions.js";
import { setDingtalkRuntime } from "./runtime.js";
import { dingtalkSetupWizard } from "./setup-wizard.js";
import {
  applyDingtalkAccountPatch,
  buildDingtalkSetupPatch,
  resolveDingtalkDmConfigKeys,
} from "./setup-helpers.js";
import {
  formatDingtalkTargetDisplay,
  inferDingtalkTargetChatType,
  looksLikeDingtalkTarget,
  normalizeDingtalkMessagingTarget,
} from "./targets.js";

/** 默认账户 ID */
export { DEFAULT_ACCOUNT_ID } from "./config.js";

/**
 * 渠道元数据
 */
const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "钉钉企业消息",
  aliases: ["ding"],
  order: 71,
} as const;

/**
 * 解析钉钉账户配置
 *
 * @param params 参数对象
 * @returns 解析后的账户配置
 */
function resolveDingtalkAccount(params: {
  cfg: PluginConfig;
  accountId?: string;
}): ResolvedDingtalkAccount {
  const { cfg } = params;
  const accountId = resolveDingtalkAccountId(cfg, params.accountId);
  const merged = mergeDingtalkAccountConfig(cfg, accountId);
  const baseEnabled = cfg.channels?.dingtalk?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;

  // 检查是否已配置凭证
  const credentials = resolveDingtalkCredentials(merged);
  const configured = Boolean(credentials);

  return {
    accountId,
    enabled,
    configured,
    name: merged.name,
    clientId: credentials?.clientId,
  };
}

function canStoreDefaultAccountInAccounts(cfg: PluginConfig): boolean {
  return Boolean(cfg.channels?.dingtalk?.accounts?.[DEFAULT_ACCOUNT_ID]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function hasRealtimeReplyApi(reply: Record<string, unknown> | undefined): boolean {
  return Boolean(
    reply?.dispatchReplyWithDispatcher ||
      reply?.dispatchReplyWithBufferedBlockDispatcher
  );
}

function resolveRuntimeCandidate(params: {
  runtime?: unknown;
  channelRuntime?: unknown;
}): Record<string, unknown> | undefined {
  const runtimeRecord = asRecord(params.runtime);
  const runtimeChannel = asRecord(runtimeRecord?.channel);
  const channelRuntime = asRecord(params.channelRuntime);

  if (!runtimeRecord && !channelRuntime) {
    return undefined;
  }

  if (!runtimeChannel && !channelRuntime) {
    return runtimeRecord;
  }

  const resolvedChannel = {
    ...(runtimeChannel ?? {}),
    ...(channelRuntime ?? {}),
  } as Record<string, unknown>;

  for (const key of ["routing", "reply", "session", "text"] as const) {
    const mergedSection = {
      ...(asRecord(runtimeChannel?.[key]) ?? {}),
      ...(asRecord(channelRuntime?.[key]) ?? {}),
    };
    if (Object.keys(mergedSection).length > 0) {
      resolvedChannel[key] = mergedSection;
    }
  }

  return {
    ...(runtimeRecord ?? {}),
    channel: resolvedChannel,
  };
}

/**
 * 钉钉渠道插件
 *
 * 实现 ChannelPlugin 接口，提供完整的钉钉消息渠道功能
 */
export const dingtalkPlugin = {
  id: "dingtalk",

  /**
   * 渠道元数据
   * Requirements: 1.2
   */
  meta: {
    ...meta,
  },

  /**
   * 渠道能力声明
   * Requirements: 1.3
   */
  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    blockStreaming: false,
  },

  /**
   * 配置 Schema
   * Requirements: 1.4
   */
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        defaultAccount: { type: "string" },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        connectionMode: { type: "string", enum: ["stream", "webhook"] },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        requireMention: { type: "boolean" },
        allowFrom: { type: "array", items: { type: "string" } },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        historyLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
        longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
        enableAICard: { type: "boolean" },
        gatewayToken: { type: "string" },
        gatewayPassword: { type: "string" },
        maxFileSizeMB: { type: "number", minimum: 0 },
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
              clientId: { type: "string" },
              clientSecret: { type: "string" },
              connectionMode: { type: "string", enum: ["stream", "webhook"] },
              dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
              groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
              requireMention: { type: "boolean" },
              allowFrom: { type: "array", items: { type: "string" } },
              groupAllowFrom: { type: "array", items: { type: "string" } },
              historyLimit: { type: "integer", minimum: 0 },
              textChunkLimit: { type: "integer", minimum: 1 },
              longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
              enableAICard: { type: "boolean" },
              gatewayToken: { type: "string" },
              gatewayPassword: { type: "string" },
              maxFileSizeMB: { type: "number", minimum: 0 },
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
  },

  /**
   * 配置重载触发器
   */
  reload: { configPrefixes: ["channels.dingtalk"] },

  /**
   * 新版 setup surface
   */
  setupWizard: dingtalkSetupWizard,

  /**
   * 账户配置适配器
   * Requirements: 2.1, 2.2, 2.3
   */
  config: {
    /**
     * 列出所有账户 ID
     * Requirements: 2.1
     */
    listAccountIds: (cfg: PluginConfig): string[] => listDingtalkAccountIds(cfg),

    /**
     * 解析账户配置
     * Requirements: 2.2
     */
    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedDingtalkAccount =>
      resolveDingtalkAccount({ cfg, accountId }),

    /**
     * 获取默认账户 ID
     */
    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultDingtalkAccountId(cfg),

    /**
     * 检查账户是否启用
     */
    isEnabled: (account: ResolvedDingtalkAccount): boolean => account.enabled,

    /**
     * 设置账户启用状态
     */
    setAccountEnabled: (params: {
      cfg: PluginConfig;
      accountId?: string;
      enabled: boolean;
    }): PluginConfig => {
      const accountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const seededCfg = moveDingtalkSingleAccountConfigToDefaultAccount(params.cfg);
      const existing = seededCfg.channels?.dingtalk ?? {};

      if (accountId === DEFAULT_ACCOUNT_ID && !canStoreDefaultAccountInAccounts(seededCfg)) {
        return {
          ...seededCfg,
          channels: {
            ...seededCfg.channels,
            dingtalk: {
              ...existing,
              enabled: params.enabled,
            } as DingtalkConfig,
          },
        };
      }

      const accounts = (existing as DingtalkConfig).accounts ?? {};
      const account = accounts[accountId] ?? {};
      return {
        ...seededCfg,
        channels: {
          ...seededCfg.channels,
          dingtalk: {
            ...existing,
            accounts: {
              ...accounts,
              [accountId]: { ...account, enabled: params.enabled },
            },
          } as DingtalkConfig,
        },
      };
    },

    /**
     * 删除账户配置
     */
    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const seededCfg = moveDingtalkSingleAccountConfigToDefaultAccount(params.cfg);
      const existing = seededCfg.channels?.dingtalk;
      if (!existing) return seededCfg;

      const accounts = existing.accounts ?? {};
      if (!accounts[accountId]) {
        if (
          accountId === DEFAULT_ACCOUNT_ID &&
          Object.keys(accounts).length === 0 &&
          !canStoreDefaultAccountInAccounts(seededCfg)
        ) {
          const next = { ...seededCfg };
          const nextChannels = { ...seededCfg.channels };
          delete (nextChannels as Record<string, unknown>).dingtalk;
          if (Object.keys(nextChannels).length > 0) {
            next.channels = nextChannels;
          } else {
            delete next.channels;
          }
          return next;
        }
        return seededCfg;
      }

      const { [accountId]: _removed, ...remainingAccounts } = accounts;
      const remainingIds = Object.keys(remainingAccounts).sort((a, b) => a.localeCompare(b));
      const preferred = existing.defaultAccount?.trim();
      let nextDefaultAccount = preferred;
      if (preferred && !remainingAccounts[preferred]) {
        nextDefaultAccount =
          remainingIds.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (remainingIds[0] ?? "");
      }

      const nextChannel = {
        ...existing,
        accounts: remainingIds.length > 0 ? remainingAccounts : undefined,
        defaultAccount: nextDefaultAccount || undefined,
      } as DingtalkConfig;
      const hasNonTrivialRootConfig = Object.entries(nextChannel).some(
        ([key, value]) =>
          key !== "enabled" &&
          key !== "accounts" &&
          key !== "defaultAccount" &&
          value !== undefined,
      );

      if (remainingIds.length === 0 && !hasNonTrivialRootConfig) {
        const next = { ...seededCfg };
        const nextChannels = { ...seededCfg.channels };
        delete (nextChannels as Record<string, unknown>).dingtalk;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      return {
        ...seededCfg,
        channels: {
          ...seededCfg.channels,
          dingtalk: nextChannel,
        },
      };
    },

    /**
     * 检查账户是否已配置
     * Requirements: 2.3
     */
    isConfigured: (_account: ResolvedDingtalkAccount, cfg: PluginConfig, accountId?: string): boolean => {
      const id = accountId ?? _account.accountId;
      const merged = mergeDingtalkAccountConfig(cfg, id);
      return Boolean(merged.clientId && merged.clientSecret);
    },

    /**
     * 描述账户信息
     */
    describeAccount: (account: ResolvedDingtalkAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),

    /**
     * 解析白名单
     */
    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const accountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const merged = mergeDingtalkAccountConfig(params.cfg, accountId);
      return merged.allowFrom ?? [];
    },

    /**
     * 格式化白名单条目
     */
    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  /**
   * 安全警告收集器
   */
  security: {
    resolveDmPolicy: (params: {
      cfg: PluginConfig;
      accountId?: string;
    }) => {
      const resolvedAccountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const merged = mergeDingtalkAccountConfig(params.cfg, resolvedAccountId);
      const keys = resolveDingtalkDmConfigKeys(resolvedAccountId);

      return {
        policy: merged.dmPolicy ?? "open",
        allowFrom: merged.allowFrom ?? [],
        policyPath: keys.policyKey,
        allowFromPath: keys.allowFromKey,
        approveHint:
          'Add the sender to channels.dingtalk.allowFrom or set channels.dingtalk.dmPolicy="open".',
        normalizeEntry: (entry: string) => entry.trim().toLowerCase(),
      };
    },
    collectWarnings: (params: { cfg: PluginConfig }): string[] => {
      const dingtalkCfg = params.cfg.channels?.dingtalk;
      const groupPolicy = dingtalkCfg?.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.dingtalk.groupPolicy="allowlist" + channels.dingtalk.groupAllowFrom to restrict senders.`,
      ];
    },
  },

  /**
   * 设置向导适配器
   */
  setup: {
    resolveAccountId: (params: { cfg: PluginConfig; accountId?: string }): string =>
      resolveDingtalkAccountId(params.cfg, params.accountId),
    applyAccountConfig: (params: {
      cfg: PluginConfig;
      accountId?: string;
      input?: Record<string, unknown>;
      config?: Record<string, unknown>;
    }): PluginConfig => {
      const accountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const patch = buildDingtalkSetupPatch(params.input ?? params.config);
      return applyDingtalkAccountPatch(params.cfg, accountId, patch);
    },
  },

  /**
   * 配对适配器
   */
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (entry: string) => entry.trim().toLowerCase(),
    notifyApproval: async (params: {
      cfg: PluginConfig;
      id: string;
      accountId?: string;
    }) => {
      const accountId = resolveDingtalkAccountId(params.cfg, params.accountId);
      const dingtalkCfg = mergeDingtalkAccountConfig(params.cfg, accountId);
      await sendMessageDingtalk({
        cfg: dingtalkCfg,
        to: params.id,
        text: "Your pairing request has been approved.",
        chatType: "direct",
      });
    },
  },

  /**
   * message tool actions
   */
  actions: dingtalkMessageActions,

  /**
   * 目标解析与展示
   */
  messaging: {
    normalizeTarget: (raw: string) => normalizeDingtalkMessagingTarget(raw),
    inferTargetChatType: (params: { to: string }) => inferDingtalkTargetChatType(params.to),
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => looksLikeDingtalkTarget(raw, normalized),
      hint: "Use user:<userid> for DMs or group:<conversationId> for DingTalk groups.",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) =>
      formatDingtalkTargetDisplay(params),
  },

  /**
   * 出站消息适配器
   * Requirements: 7.1, 7.6
   */
  outbound: dingtalkOutbound,

  /**
   * Gateway 连接管理适配器
   * Requirements: 3.1
   */
  gateway: {
    /**
     * 启动账户连接
     * Requirements: 3.1
     */
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      channelRuntime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });
      ctx.log?.info(`[dingtalk] starting provider for account ${ctx.accountId}`);

      const runtimeCandidate = resolveRuntimeCandidate({
        runtime: ctx.runtime,
        channelRuntime: ctx.channelRuntime,
      });
      const candidate = runtimeCandidate as
        | {
            channel?: {
              routing?: { resolveAgentRoute?: unknown };
              reply?: {
                dispatchReplyWithDispatcher?: unknown;
                dispatchReplyWithBufferedBlockDispatcher?: unknown;
              };
            };
          }
        | undefined;
      if (
        candidate?.channel?.routing?.resolveAgentRoute &&
        hasRealtimeReplyApi(candidate.channel?.reply as Record<string, unknown> | undefined)
      ) {
        setDingtalkRuntime(runtimeCandidate as Parameters<typeof setDingtalkRuntime>[0]);
      }

      return monitorDingtalkProvider({
        config: ctx.cfg,
        runtime:
          (ctx.runtime as { log?: (msg: string) => void; error?: (msg: string) => void }) ?? {
            log: ctx.log?.info ?? console.log,
            error: ctx.log?.error ?? console.error,
          },
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
    },
    stopAccount: async (ctx: { accountId: string }): Promise<void> => {
      stopDingtalkMonitorForAccount(ctx.accountId);
    },
    getStatus: () => ({ connected: true }),
  },
};
