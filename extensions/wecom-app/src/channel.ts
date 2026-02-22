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
  WecomAppConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { registerWecomAppWebhookTarget } from "./monitor.js";
import { setWecomAppRuntime } from "./runtime.js";
import { sendWecomAppMessage, stripMarkdown, downloadAndSendImage, downloadAndSendVoice, downloadAndSendFile, downloadAndSendVideo } from "./api.js";
import { hasFfmpeg, transcodeToAmr } from "./ffmpeg.js";

/**
 * 媒体类型
 */
type MediaType = "image" | "voice" | "file" | "video";

type ParsedDirectTarget = {
  accountId?: string;
  userId: string;
};

// 裸目标（不带 user: 前缀）仅接受“机器可投递 ID”风格，避免把显示名误当作投递目标。
const BARE_USER_ID_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
// 显式 user: 前缀时放宽大小写，兼容历史 UserID。
const EXPLICIT_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

/**
 * 统一解析 wecom-app 直发目标（仅用户）
 * 支持：
 * - wecom-app:user:<userId>
 * - user:<userId>
 * - <userId>
 * - 上述格式 + @accountId 后缀（email 场景不拆 account）
 */
function parseDirectTarget(rawTarget: string): ParsedDirectTarget | null {
  let raw = String(rawTarget ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("wecom-app:")) {
    raw = raw.slice("wecom-app:".length);
  }

  let accountId: string | undefined;
  if (!looksLikeEmail(raw)) {
    const atIdx = raw.lastIndexOf("@");
    if (atIdx > 0 && atIdx < raw.length - 1) {
      const candidate = raw.slice(atIdx + 1);
      if (!/[:/]/.test(candidate)) {
        accountId = candidate;
        raw = raw.slice(0, atIdx);
      }
    }
  }

  if (raw.startsWith("group:")) return null;
  const explicitUserPrefix = raw.startsWith("user:");
  if (explicitUserPrefix) raw = raw.slice(5);

  const userId = raw.trim();
  if (!userId) return null;
  if (/\s/.test(userId)) return null;
  if (!explicitUserPrefix && !BARE_USER_ID_RE.test(userId)) return null;
  if (explicitUserPrefix && !EXPLICIT_USER_ID_RE.test(userId)) return null;

  return { accountId, userId };
}

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

    if (mime.startsWith("video/") && (mime === "video/mp4" || mime === "video/mpeg")) {
      return "video";
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

  // 视频扩展名 - 只支持mp4
  if (ext === "mp4") {
    return "video";
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
    chatTypes: ["direct"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
    /** 自建应用支持主动发送 */
    activeSend: true,
  },

  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const parsed = parseDirectTarget(raw);
      if (!parsed) return undefined;
      return `user:${parsed.userId}${parsed.accountId ? `@${parsed.accountId}` : ""}`;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        return Boolean(parseDirectTarget(candidate));
      },
      hint: "Use WeCom UserID only: user:<userid> (optional @accountId). Do not use display names.",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return params.display?.trim() || params.target;
      return `user:${parsed.userId}`;
    },
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

  /**
   * 目录解析 - 用于将 wecom-app:XXX 格式的 target 解析为可投递目标
   *
   * 支持的输入格式：
   * - "wecom-app:user:xxx" → { channel: "wecom-app", to: "xxx" }
   * - "user:xxx" → { channel: "wecom-app", to: "xxx" }
   * - "xxx" (仅小写 ID 风格) → { channel: "wecom-app", to: "xxx" }
   * - 带 accountId: "user:xxx@account1" → { channel: "wecom-app", accountId: "account1", to: "xxx" }
   */
  directory: {
    /**
     * 检查此通道是否可以解析给定的目标格式
     * 用于框架层判断是否调用 resolveTarget
     */
    canResolve: (params: { target: string }): boolean => {
      return Boolean(parseDirectTarget(params.target));
    },

    /**
     * 解析单个目标地址
     * 将各种格式的 target 解析为可用的投递对象
     * 
     * IMPORTANT: 返回的 `to` 字段必须是纯 ID（不含 user:/group: 前缀），
     * 因为 OpenClaw 框架会用这个值来匹配 inbound context 中的 From/To 字段。
     * 
     * 例如：如果 inbound context 的 From 是 "wecom-app:user:CaiHongYu"，
     * 那么 resolveTarget 必须返回 { channel: "wecom-app", to: "CaiHongYu" }，
     * 而不是 { channel: "wecom-app", to: "user:CaiHongYu" }。
     */
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
      return { channel: "wecom-app", accountId: parsed.accountId, to: parsed.userId };
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
     * 
     * 注意：虽然支持多种输入格式，但 resolveTarget 返回的 `to` 字段
     * 始终是纯 ID（不含前缀），以便框架正确匹配 inbound context。
     */
    getTargetFormats: (): string[] => [
      "wecom-app:user:<userId>",
      "user:<userId>",
      "<userid-lowercase>",
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

      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom App: ${params.to}`),
        };
      }
      const target: { userId: string } = { userId: parsed.userId };

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

      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        return {
          channel: "wecom-app",
          ok: false,
          messageId: "",
          error: new Error(`Unsupported target for WeCom App: ${params.to}`),
        };
      }
      const target: { userId: string } = { userId: parsed.userId };

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
          // 策略：遇到 wav/mp3 这类企业微信 voice 不支持的格式时：
          // - voiceTranscode.enabled=true 且系统存在 ffmpeg：自动转码为 amr 后再发送 voice
          // - 否则：降级为 file 发送（保证可达）
          console.log(`[wecom-app] Routing to downloadAndSendVoice`);

          const voiceUrl = params.mediaUrl;
          const ext = (voiceUrl.split("?")[0].match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
          const likelyUnsupported = ext === "wav" || ext === "mp3";
          const transcodeEnabled = Boolean(account.config.voiceTranscode?.enabled);

          if (likelyUnsupported && transcodeEnabled) {
            const can = await hasFfmpeg();
            if (can) {
              try {
                if (!voiceUrl.startsWith("http://") && !voiceUrl.startsWith("https://")) {
                  const os = await import("node:os");
                  const path = await import("node:path");
                  const fs = await import("node:fs");
                  const out = path.join(os.tmpdir(), `wecom-app-voice-${Date.now()}.amr`);

                  console.log(`[wecom-app] voiceTranscode: ffmpeg available, transcoding ${voiceUrl} -> ${out}`);
                  await transcodeToAmr({ inputPath: voiceUrl, outputPath: out });

                  result = await downloadAndSendVoice(account, target, out);

                  try {
                    await fs.promises.unlink(out);
                  } catch {
                    // ignore
                  }
                } else {
                  console.warn(`[wecom-app] voiceTranscode enabled but mediaUrl is remote; fallback to file send (download once is not implemented yet)`);
                  result = await downloadAndSendFile(account, target, voiceUrl);
                }
              } catch (e) {
                console.warn(`[wecom-app] voiceTranscode failed; fallback to file send:`, e);
                result = await downloadAndSendFile(account, target, voiceUrl);
              }
            } else {
              console.warn(`[wecom-app] voiceTranscode enabled but ffmpeg not found; fallback to file send`);
              result = await downloadAndSendFile(account, target, voiceUrl);
            }
          } else if (likelyUnsupported) {
            console.log(`[wecom-app] Voice format .${ext} likely unsupported; fallback to file send`);
            result = await downloadAndSendFile(account, target, voiceUrl);
          } else {
            result = await downloadAndSendVoice(account, target, voiceUrl);
          }
        } else if (mediaType === "video") {
          // 视频: 下载 → 上传素材 → 发送
          console.log(`[wecom-app] Routing to downloadAndSendVideo`);
          result = await downloadAndSendVideo(account, target, params.mediaUrl);
        } else {
          // 文件/其他: 下载 → 上传素材 → 发送
          // NOTE: 企业微信“文件消息”接口只接收 media_id，客户端经常不展示真实文件名。
          // 我们在上传时会尽量带上 filename，但展示层可能仍固定为 file.<ext>。
          // 为了让用户看到真实文件名：如果上游提供了 text/caption，则先补发一条文本说明。
          if (params.text?.trim()) {
            try {
              console.log(`[wecom-app] Sending caption text before file: ${params.text}`);
              await sendWecomAppMessage(account, target, params.text);
            } catch (err) {
              console.warn(`[wecom-app] Failed to send caption before file:`, err);
            }
          }

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
