/**
 * 微信客服渠道 ChannelPlugin 实现
 *
 * 面向外部微信用户的客户聊天场景
 */

import type { ResolvedWecomKfAccount, WecomKfConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWecomKfAccountIds,
  resolveDefaultWecomKfAccountId,
  resolveWecomKfAccount,
  resolveAllowFrom,
  WecomKfConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { registerWecomKfWebhookTarget } from "./monitor.js";
import { setWecomKfRuntime } from "./runtime.js";
import {
  sendKfMessage,
  downloadAndSendKfImage,
  downloadAndSendKfVoice,
  downloadAndSendKfFile,
  downloadAndSendKfVideo,
  stripMarkdown,
} from "./api.js";
import {
  isWecomAudioMimeType,
  isWecomAudioSource,
  shouldTranscodeWecomVoice,
  extractSourceExtension,
} from "./voice.js";

type ParsedDirectTarget = {
  accountId?: string;
  externalUserId: string;
};

const EXTERNAL_USERID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * 统一解析 wecom-kf 直发目标
 * 支持：
 * - wecom-kf:user:<externalUserId>
 * - user:<externalUserId>
 * - <externalUserId>
 * - 上述格式 + @accountId 后缀
 */
function parseDirectTarget(rawTarget: string): ParsedDirectTarget | null {
  let raw = String(rawTarget ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("wecom-kf:")) {
    raw = raw.slice("wecom-kf:".length);
  }

  let accountId: string | undefined;
  const atIdx = raw.lastIndexOf("@");
  if (atIdx > 0 && atIdx < raw.length - 1) {
    const candidate = raw.slice(atIdx + 1);
    if (!/[:/]/.test(candidate)) {
      accountId = candidate;
      raw = raw.slice(0, atIdx);
    }
  }

  if (raw.startsWith("group:")) return null;
  const explicitUserPrefix = raw.startsWith("user:");
  if (explicitUserPrefix) raw = raw.slice(5);

  const externalUserId = raw.trim();
  if (!externalUserId) return null;
  if (/\s/.test(externalUserId)) return null;
  if (!EXTERNAL_USERID_RE.test(externalUserId)) return null;

  return { accountId, externalUserId };
}

type MediaType = "image" | "voice" | "video" | "file";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "avi", "mov", "wmv", "mkv", "flv", "webm", "m4v"]);

function detectMediaType(mediaUrl: string, mimeType?: string): MediaType {
  const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase();

  if (normalizedMime) {
    if (normalizedMime === "image/svg+xml") return "file";
    if (normalizedMime.startsWith("image/")) return "image";
    if (isWecomAudioMimeType(mimeType)) return "voice";
    if (normalizedMime.startsWith("video/")) return "video";
  }

  if (isWecomAudioSource(mediaUrl, mimeType)) return "voice";

  const ext = extractSourceExtension(mediaUrl);
  if (ext) {
    if (ext === "svg") return "file";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
  }

  if (normalizedMime && !normalizedMime.startsWith("image/")) return "file";

  return "image";
}

const meta = {
  id: "wecom-kf",
  label: "WeCom KF",
  selectionLabel: "WeCom KF (微信客服)",
  docsPath: "/channels/wecom-kf",
  docsLabel: "wecom-kf",
  blurb: "微信客服渠道，支持外部微信用户聊天",
  aliases: ["qywx-kf", "wecom-kf", "微信客服"],
  order: 85,
} as const;

const unregisterHooks = new Map<string, () => void>();

export const wecomKfPlugin = {
  id: "wecom-kf",

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: false,
    polls: false,
    /** 支持主动发送（48小时窗口内） */
    activeSend: true,
  },

  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const parsed = parseDirectTarget(raw);
      if (!parsed) return undefined;
      return `user:${parsed.externalUserId}${parsed.accountId ? `@${parsed.accountId}` : ""}`;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        return Boolean(parseDirectTarget(candidate));
      },
      hint: "Use external_userid only: user:<external_userid> (optional @accountId). Do not use display names.",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return params.display?.trim() || params.target;
      return `user:${parsed.externalUserId}`;
    },
  },

  configSchema: WecomKfConfigJsonSchema,

  reload: { configPrefixes: ["channels.wecom-kf"] },

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listWecomKfAccountIds(cfg),

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedWecomKfAccount =>
      resolveWecomKfAccount({ cfg, accountId }),

    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultWecomKfAccountId(cfg),

    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(params.cfg.channels?.["wecom-kf"]?.accounts?.[accountId]);
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            "wecom-kf": {
              ...(params.cfg.channels?.["wecom-kf"] ?? {}),
              enabled: params.enabled,
            } as WecomKfConfig,
          },
        };
      }

      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "wecom-kf": {
            ...(params.cfg.channels?.["wecom-kf"] ?? {}),
            accounts: {
              ...(params.cfg.channels?.["wecom-kf"]?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.["wecom-kf"]?.accounts?.[accountId] ?? {}),
                enabled: params.enabled,
              },
            },
          } as WecomKfConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.["wecom-kf"];
      if (!current) return next;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } = current as WecomKfConfig;
        next.channels = {
          ...next.channels,
          "wecom-kf": { ...(rest as WecomKfConfig), enabled: false },
        };
        return next;
      }

      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];

      next.channels = {
        ...next.channels,
        "wecom-kf": {
          ...(current as WecomKfConfig),
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return next;
    },

    isConfigured: (account: ResolvedWecomKfAccount): boolean => account.configured,

    describeAccount: (account: ResolvedWecomKfAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      canSend: account.canSend,
      openKfid: account.openKfid,
      webhookPath: account.config.webhookPath ?? "/wecom-kf",
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const account = resolveWecomKfAccount({ cfg: params.cfg, accountId: params.accountId });
      return resolveAllowFrom(account.config);
    },

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },

  directory: {
    canResolve: (params: { target: string }): boolean => {
      return Boolean(parseDirectTarget(params.target));
    },

    resolveTarget: (params: {
      cfg: PluginConfig;
      target: string;
    }): {
      channel: string;
      accountId?: string;
      to: string;
    } | null => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return null;
      return { channel: "wecom-kf", accountId: parsed.accountId, to: parsed.externalUserId };
    },

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
        const resolved = wecomKfPlugin.directory.resolveTarget({
          cfg: params.cfg,
          target,
        });
        if (resolved) {
          results.push(resolved);
        }
      }

      return results;
    },

    getTargetFormats: (): string[] => [
      "wecom-kf:user:<externalUserId>",
      "user:<externalUserId>",
      "<externalUserId>",
    ],
  },

  outbound: {
    deliveryMode: "direct",

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
      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom KF: ${params.to}`),
        };
      }

      const accountId = parsed.accountId ?? params.accountId;
      const account = resolveWecomKfAccount({ cfg: params.cfg, accountId });

      if (!account.canSend) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error("Account not configured for sending (missing corpId, corpSecret, or openKfid)"),
        };
      }

      try {
        const text = stripMarkdown(params.text);
        const result = await sendKfMessage(account, { externalUserId: parsed.externalUserId }, text);
        return {
          channel: "wecom-kf",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

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
      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom KF: ${params.to}`),
        };
      }

      const accountId = parsed.accountId ?? params.accountId;
      const account = resolveWecomKfAccount({ cfg: params.cfg, accountId });

      if (!account.canSend) {
        return {
          channel: "wecom-kf",
          ok: false,
          messageId: "",
          error: new Error("Account not configured for sending"),
        };
      }

      const target = { externalUserId: parsed.externalUserId };
      const mediaType = detectMediaType(params.mediaUrl, params.mimeType);

      try {
        let result;

        if (mediaType === "voice") {
          const voiceTranscodeEnabled = account.config?.voiceTranscode?.enabled !== false;
          const needsTranscode = voiceTranscodeEnabled && shouldTranscodeWecomVoice(params.mediaUrl, params.mimeType);

          try {
            result = await downloadAndSendKfVoice(account, target, params.mediaUrl, {
              contentType: params.mimeType,
              transcode: voiceTranscodeEnabled,
            });
          } catch {
            result = await downloadAndSendKfFile(account, target, params.mediaUrl);
          }

          if (!result.ok && needsTranscode) {
            result = await downloadAndSendKfFile(account, target, params.mediaUrl);
          }
        } else if (mediaType === "video") {
          result = await downloadAndSendKfVideo(account, target, params.mediaUrl);
        } else if (mediaType === "file") {
          if (params.text?.trim()) {
            await sendKfMessage(account, target, stripMarkdown(params.text));
          }
          result = await downloadAndSendKfFile(account, target, params.mediaUrl);
        } else {
          result = await downloadAndSendKfImage(account, target, params.mediaUrl);
        }

        return {
          channel: "wecom-kf",
          ok: result.ok,
          messageId: result.msgid ?? "",
          error: result.ok ? undefined : new Error(result.errmsg ?? "send failed"),
        };
      } catch (err) {
        return {
          channel: "wecom-kf",
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
          setWecomKfRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      const account = resolveWecomKfAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (!account.configured) {
        ctx.log?.info(`[wecom-kf] account ${ctx.accountId} not configured; webhook not registered`);
        ctx.setStatus?.({ accountId: ctx.accountId, running: false, configured: false });
        return;
      }

      const path = (account.config.webhookPath ?? "/wecom-kf").trim();
      const unregister = registerWecomKfWebhookTarget({
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

      ctx.log?.info(`[wecom-kf] webhook registered at ${path} for account ${ctx.accountId} (canSend=${account.canSend})`);
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: true,
        configured: true,
        canSend: account.canSend,
        openKfid: account.openKfid,
        webhookPath: path,
        lastStartAt: Date.now(),
      });

      try {
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal?.aborted) {
            resolve();
            return;
          }
          if (!ctx.abortSignal) {
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        const current = unregisterHooks.get(ctx.accountId);
        if (current === unregister) {
          unregisterHooks.delete(ctx.accountId);
        }
        unregister();
        ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
      }
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
