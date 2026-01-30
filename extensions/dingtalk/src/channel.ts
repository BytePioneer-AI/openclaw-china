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
import { DingtalkConfigSchema, isConfigured, resolveDingtalkCredentials } from "./config.js";
import { dingtalkOutbound } from "./outbound.js";
import { monitorDingtalkProvider } from "./monitor.js";
import { setDingtalkRuntime } from "./runtime.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

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
 * 配置接口类型（简化版）
 */
interface PluginConfig {
  channels?: {
    dingtalk?: DingtalkConfig;
  };
}

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
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const dingtalkCfg = cfg.channels?.dingtalk;

  // 解析配置
  const parsed = dingtalkCfg ? DingtalkConfigSchema.safeParse(dingtalkCfg) : null;
  const config = parsed?.success ? parsed.data : undefined;

  // 检查是否已配置凭证
  const credentials = resolveDingtalkCredentials(config);
  const configured = Boolean(credentials);

  return {
    accountId,
    enabled: config?.enabled ?? true,
    configured,
    clientId: credentials?.clientId,
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
    chatTypes: ["direct", "channel"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
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
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        requireMention: { type: "boolean" },
        allowFrom: { type: "array", items: { type: "string" } },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        historyLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
        enableAICard: { type: "boolean" },
      },
    },
  },

  /**
   * 配置重载触发器
   */
  reload: { configPrefixes: ["channels.dingtalk"] },

  /**
   * 账户配置适配器
   * Requirements: 2.1, 2.2, 2.3
   */
  config: {
    /**
     * 列出所有账户 ID
     * Requirements: 2.1
     */
    listAccountIds: (_cfg: PluginConfig): string[] => [DEFAULT_ACCOUNT_ID],

    /**
     * 解析账户配置
     * Requirements: 2.2
     */
    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedDingtalkAccount =>
      resolveDingtalkAccount({ cfg, accountId }),

    /**
     * 获取默认账户 ID
     */
    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    /**
     * 设置账户启用状态
     */
    setAccountEnabled: (params: { cfg: PluginConfig; enabled: boolean }): PluginConfig => {
      const existingConfig = params.cfg.channels?.dingtalk ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          dingtalk: {
            ...existingConfig,
            enabled: params.enabled,
          } as DingtalkConfig,
        },
      };
    },

    /**
     * 删除账户配置
     */
    deleteAccount: (params: { cfg: PluginConfig }): PluginConfig => {
      const next = { ...params.cfg };
      const nextChannels = { ...params.cfg.channels };
      delete (nextChannels as Record<string, unknown>).dingtalk;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },

    /**
     * 检查账户是否已配置
     * Requirements: 2.3
     */
    isConfigured: (_account: ResolvedDingtalkAccount, cfg: PluginConfig): boolean =>
      isConfigured(cfg.channels?.dingtalk),

    /**
     * 描述账户信息
     */
    describeAccount: (account: ResolvedDingtalkAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),

    /**
     * 解析白名单
     */
    resolveAllowFrom: (params: { cfg: PluginConfig }): string[] =>
      params.cfg.channels?.dingtalk?.allowFrom ?? [],

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
    resolveAccountId: (): string => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: (params: { cfg: PluginConfig }): PluginConfig => {
      const existingConfig = params.cfg.channels?.dingtalk ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          dingtalk: {
            ...existingConfig,
            enabled: true,
          } as DingtalkConfig,
        },
      };
    },
  },

  /**
   * Onboarding 适配器
   */
  onboarding: dingtalkOnboardingAdapter,

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
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });
      ctx.log?.info(`[dingtalk] starting provider for account ${ctx.accountId}`);

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (
          candidate.channel?.routing?.resolveAgentRoute &&
          candidate.channel?.reply?.dispatchReplyFromConfig
        ) {
          setDingtalkRuntime(ctx.runtime as Record<string, unknown>);
        }
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
      });
    },
  },
};
