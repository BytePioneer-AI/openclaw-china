/**
 * 企业微信自建应用 ChannelPlugin 实现
 *
 * 与普通 wecom 智能机器人不同，自建应用支持主动发送消息
 */

import type { ResolvedWecomAppAccount, WecomAppConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWecomAppAccountIds,
  resolveDefaultWecomAppAccountId,
  resolveWecomAppAccount,
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveRequireMention,
  WecomAppConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { registerWecomAppWebhookTarget } from "./monitor.js";
import { setWecomAppRuntime } from "./runtime.js";
import { sendWecomAppMessage, stripMarkdown, downloadAndSendImage, downloadAndSendVoice, downloadAndSendFile } from "./api.js";

/**
 * 媒体类型
 */
type MediaType = "image" | "voice" | "file";

/**
 * 根据文件路径或 MIME 类型检测媒体类型
 */
function detectMediaType(filePath: string, mimeType?: string): MediaType {
  // 优先使用 MIME 类型
  if (mimeType) {
    const mime = mimeType.split(";")[0].trim().toLowerCase();

    // SVG 常见为 image/svg+xml，但企业微信通常不按“图片消息”展示/支持。
    // 这里强制当作文件发送，避免误走 image 上传/发送流程。
    if (mime.includes("svg")) {
      return "file";
    }

    if (mime.startsWith("image/")) {
      return "image";
    }
    // audio/wav：企业微信语音类型通常不支持，降级为文件发送更稳
    if (mime === "audio/wav" || mime === "audio/x-wav") {
      return "file";
    }

    if (mime.startsWith("audio/") || mime === "audio/amr") {
      return "voice";
    }
  }

  // 回退到文件扩展名
  const ext = filePath.toLowerCase().split("?")[0].split(".").pop();
  if (!ext) {
    return "file";
  }

  // 图片扩展名
  const imageExts = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];
  if (imageExts.includes(ext)) {
    return "image";
  }

  // SVG：多数情况下企业微信不按图片展示，改为文件
  if (ext === "svg") {
    return "file";
  }

  // 语音扩展名
  const voiceExts = ["amr", "speex", "mp3"];
  if (voiceExts.includes(ext)) {
    return "voice";
  }

  // wav：企业微信通常不支持作为 voice，按 file 发送更稳
  if (ext === "wav") {
    return "file";
  }

  // 默认作为文件处理
  return "file";
}

const meta = {
  id: "wecom-app",
  label: "WeCom App",
  selectionLabel: "WeCom Self-built App (企微自建应用)",
  docsPath: "/channels/wecom-app",
  docsLabel: "wecom-app",
  blurb: "企业微信自建应用，支持主动发送消息",
  aliases: ["qywx-app", "企微自建应用", "企业微信自建应用"],
  order: 84,
} as const;

const unregisterHooks = new Map<string, () => void>();

export const wecomAppPlugin = {
  id: "wecom-app",

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    /** 自建应用支持主动发送 */
    activeSend: true,
  },

  configSchema: WecomAppConfigJsonSchema,

  reload: { configPrefixes: ["channels.wecom-app"] },

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listWecomAppAccountIds(cfg),

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedWecomAppAccount =>
      resolveWecomAppAccount({ cfg, accountId }),

    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultWecomAppAccountId(cfg),

    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(params.cfg.channels?.["wecom-app"]?.accounts?.[accountId]);
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            "wecom-app": {
              ...(params.cfg.channels?.["wecom-app"] ?? {}),
              enabled: params.enabled,
            } as WecomAppConfig,
          },
        };
      }

      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "wecom-app": {
            ...(params.cfg.channels?.["wecom-app"] ?? {}),
            accounts: {
              ...(params.cfg.channels?.["wecom-app"]?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.["wecom-app"]?.accounts?.[accountId] ?? {}),
                enabled: params.enabled,
              },
            },
          } as WecomAppConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.["wecom-app"];
      if (!current) return next;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } = current as WecomAppConfig;
        next.channels = {
          ...next.channels,
          "wecom-app": { ...(rest as WecomAppConfig), enabled: false },
        };
        return next;
      }

      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];

      next.channels = {
        ...next.channels,
        "wecom-app": {
          ...(current as WecomAppConfig),
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return next;
    },

    isConfigured: (account: ResolvedWecomAppAccount): boolean => account.configured,

    describeAccount: (account: ResolvedWecomAppAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      canSendActive: account.canSendActive,
      webhookPath: account.config.webhookPath ?? "/wecom-app",
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const account = resolveWecomAppAccount({ cfg: params.cfg, accountId: params.accountId });
      return resolveAllowFrom(account.config);
    },

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  groups: {
    resolveRequireMention: (params: {
      cfg: PluginConfig;
      accountId?: string;
      account?: ResolvedWecomAppAccount;
    }): boolean => {
      const account = params.account ?? resolveWecomAppAccount({ cfg: params.cfg ?? {}, accountId: params.accountId });
      return resolveRequireMention(account.config);
    },
  },

  /**
   * 目录解析 - 用于将 wecom-app:XXX 格式的 target 解析为可投递目标
   *
   * 支持的输入格式：
   * - "wecom-app:user:xxx" → { channel: "wecom-app", to: "user:xxx" }
   * - "wecom-app:group:xxx" → { channel: "wecom-app", to: "group:xxx" }
   * - "wecom-app:xxx" → { channel: "wecom-app", to: "user:xxx" }
   * - "user:xxx" → { channel: "wecom-app", to: "user:xxx" }
   * - "group:xxx" → { channel: "wecom-app", to: "group:xxx" }
   * - "xxx" (裸ID) → { channel: "wecom-app", to: "user:xxx" }
   * - 带 accountId: "user:xxx@account1" → { channel: "wecom-app", accountId: "account1", to: "user:xxx" }
   */
  directory: {
    /**
     * 检查此通道是否可以解析给定的目标格式
     * 用于框架层判断是否调用 resolveTarget
     */
    canResolve: (params: { target: string }): boolean => {
      const raw = (params.target ?? "").trim();
      if (!raw) return false;

      // 明确以 wecom-app: 开头的目标
      if (raw.startsWith("wecom-app:")) return true;

      // 不以其他 channel 前缀开头（如 dingtalk:, feishu: 等）
      // 只接受 wecom-app 专有目标或裸 ID
      const knownChannelPrefixes = ["dingtalk:", "feishu:", "wecom:", "qq:", "telegram:", "discord:", "slack:"];
      for (const prefix of knownChannelPrefixes) {
        if (raw.startsWith(prefix)) return false;
      }

      // user:/group: 前缀或裸 ID 都可以处理
      return true;
    },

    /**
     * 解析单个目标地址
     * 将各种格式的 target 解析为可用的投递对象
     */
    resolveTarget: (params: {
      cfg: PluginConfig;
      target: string;
    }): {
      channel: string;
      accountId?: string;
      to: string;
    } | null => {
      // NOTE:
      // The OpenClaw message routing layer may pass targets in different shapes:
      // - "wecom-app:user:xxx" or "wecom-app:group:xxx" (fully-qualified with type)
      // - "wecom-app:xxx" (fully-qualified, default to user)
      // - "user:xxx" or "group:xxx" (type-prefixed, bare)
      // - "xxx" (bare ID, default to user)
      // - "xxx@accountId" (with account selector)
      // We accept all to avoid "Unknown target" for media sends.

      let raw = (params.target ?? "").trim();
      if (!raw) return null;

      // 1. 剥离 channel 前缀 "wecom-app:"
      const channelPrefix = "wecom-app:";
      if (raw.startsWith(channelPrefix)) {
        raw = raw.slice(channelPrefix.length);
      }

      // 2. 解析 accountId（如果末尾包含 @accountId）
      let accountId: string | undefined;
      let to = raw;

      // 只在末尾查找 @，避免误解析 email 格式
      const atIdx = raw.lastIndexOf("@");
      if (atIdx > 0 && atIdx < raw.length - 1) {
        // 检查 @ 之后是否是有效的 accountId（不含 : 或 /）
        const potentialAccountId = raw.slice(atIdx + 1);
        if (!/[:/]/.test(potentialAccountId)) {
          to = raw.slice(0, atIdx);
          accountId = potentialAccountId;
        }
      }

      // 3. 标准化目标格式
      if (to.startsWith("group:")) {
        return { channel: "wecom-app", accountId, to };
      }
      if (to.startsWith("user:")) {
        return { channel: "wecom-app", accountId, to };
      }

      // 4. 默认为用户ID，添加 user: 前缀
      return { channel: "wecom-app", accountId, to: `user:${to}` };
    },

    /**
     * 批量解析多个目标地址
     * 用于框架层批量发送消息
     */
    resolveTargets: (params: {
      cfg: PluginConfig;
      targets: string[];
    }): Array<{
      channel: string;
      accountId?: string;
      to: string;
    }> => {
      const results: Array<{
        channel: string;
        accountId?: string;
        to: string;
      }> = [];

      for (const target of params.targets) {
        const resolved = wecomAppPlugin.directory.resolveTarget({
          cfg: params.cfg,
          target,
        });
        if (resolved) {
          results.push(resolved);
        }
      }

      return results;
    },

    /**
     * 获取此通道支持的目标格式说明
     * 用于帮助信息和错误提示
     */
    getTargetFormats: (): string[] => [
      "wecom-app:user:<userId>",
      "wecom-app:group:<chatId>",
      "wecom-app:<userId>",
      "user:<userId>",
      "group:<chatId>",
      "<userId>",
    ],
  },

  /**
   * 主动发送消息 (自建应用特有功能)
   */
  outbound: {
    deliveryMode: "direct",

    /**
     * 主动发送文本消息
     */
    sendText: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      text: string;
      options?: { markdown?: boolean };
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      const account = resolveWecomAppAccount({ cfg: params.cfg, accountId: params.accountId });

      if (!account.canSendActive) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: new Error("Account not configured for active sending (missing corpId, corpSecret, or agentId)"),
        };
      }

      // 解析 to: 支持格式 "wecom-app:user:xxx" / "wecom-app:group:xxx" / "wecom-app:xxx" / "user:xxx" / "group:xxx" / "xxx"
      let to = params.to;

      // 1. 先剥离 channel 前缀 "wecom-app:"
      const channelPrefix = "wecom-app:";
      if (to.startsWith(channelPrefix)) {
        to = to.slice(channelPrefix.length);
      }

      // 2. 解析剩余部分: "group:xxx" / "user:xxx" / "xxx"
      let target: { userId?: string; chatid?: string } = {};
      if (to.startsWith("group:")) {
        target = { chatid: to.slice(6) };
      } else if (to.startsWith("user:")) {
        target = { userId: to.slice(5) };
      } else {
        target = { userId: to };
      }

      try {
        const result = await sendWecomAppMessage(account, target, params.text);
        return {
          channel: "wecom-app",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    /**
     * 发送媒体消息（支持图片、语音、文件）
     * OpenClaw outbound 适配器要求的接口
     */
    sendMedia: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      mediaUrl: string;
      text?: string;
      mimeType?: string;
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      console.log(`[wecom-app] sendMedia called: to=${params.to}, mediaUrl=${params.mediaUrl}`);

      const account = resolveWecomAppAccount({
        cfg: params.cfg,
        accountId: params.accountId,
      });

      console.log(`[wecom-app] Account resolved: canSendActive=${account.canSendActive}`);

      if (!account.canSendActive) {
        const error = new Error("Account not configured for active sending (missing corpId, corpSecret, or agentId)");
        console.error(`[wecom-app] sendMedia error:`, error.message);
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error,
        };
      }

      // 解析 to: 支持格式 "wecom-app:user:xxx" / "wecom-app:group:xxx" / "wecom-app:xxx" / "user:xxx" / "group:xxx" / "xxx"
      let to = params.to;

      //1. 先剥离 channel 前缀 "wecom-app:"
      const channelPrefix = "wecom-app:";
      if (to.startsWith(channelPrefix)) {
        to = to.slice(channelPrefix.length);
      }

      //2. 解析剩余部分: "group:xxx" / "user:xxx" / "xxx"
      let target: { userId?: string; chatid?: string } = {};
      if (to.startsWith("group:")) {
        target = { chatid: to.slice(6) };
      } else if (to.startsWith("user:")) {
        target = { userId: to.slice(5) };
      } else {
        target = { userId: to };
      }

      console.log(`[wecom-app] Target parsed:`, target);

      // 3. 检测媒体类型并路由到对应的发送函数
      const mediaType = detectMediaType(params.mediaUrl, params.mimeType);
      console.log(`[wecom-app] Detected media type: ${mediaType}, file: ${params.mediaUrl}`);

      try {
        let result;

        if (mediaType === "image") {
          // 图片: 下载 → 上传素材 → 发送
          console.log(`[wecom-app] Routing to downloadAndSendImage`);
          result = await downloadAndSendImage(account, target, params.mediaUrl);
        } else if (mediaType === "voice") {
          // 语音: 下载 → 上传素材 → 发送
          console.log(`[wecom-app] Routing to downloadAndSendVoice`);
          result = await downloadAndSendVoice(account, target, params.mediaUrl);
        } else {
          // 文件/其他: 下载 → 上传素材 → 发送
          console.log(`[wecom-app] Routing to downloadAndSendFile`);
          result = await downloadAndSendFile(account, target, params.mediaUrl);
        }

        console.log(`[wecom-app] Media send returned: ok=${result.ok}, msgid=${result.msgid}, errcode=${result.errcode}, errmsg=${result.errmsg}`);

        return {
          channel: "wecom-app",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        console.error(`[wecom-app] sendMedia catch error:`, err);
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (candidate.channel?.routing?.resolveAgentRoute && candidate.channel?.reply?.dispatchReplyFromConfig) {
          setWecomAppRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      const account = resolveWecomAppAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (!account.configured) {
        ctx.log?.info(`[wecom-app] account ${ctx.accountId} not configured; webhook not registered`);
        ctx.setStatus?.({ accountId: ctx.accountId, running: false, configured: false });
        return;
      }

      const path = (account.config.webhookPath ?? "/wecom-app").trim();
      const unregister = registerWecomAppWebhookTarget({
        account,
        config: (ctx.cfg ?? {}) as PluginConfig,
        runtime: {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        path,
        statusSink: (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
      });

      const existing = unregisterHooks.get(ctx.accountId);
      if (existing) existing();
      unregisterHooks.set(ctx.accountId, unregister);

      ctx.log?.info(`[wecom-app] webhook registered at ${path} for account ${ctx.accountId} (canSendActive=${account.canSendActive})`);
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: true,
        configured: true,
        canSendActive: account.canSendActive,
        webhookPath: path,
        lastStartAt: Date.now(),
      });
    },

    stopAccount: async (ctx: { accountId: string; setStatus?: (status: Record<string, unknown>) => void }): Promise<void> => {
      const unregister = unregisterHooks.get(ctx.accountId);
      if (unregister) {
        unregister();
        unregisterHooks.delete(ctx.accountId);
      }
      ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};

export { DEFAULT_ACCOUNT_ID } from "./config.js";
