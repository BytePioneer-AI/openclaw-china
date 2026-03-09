/**
 * 企业微信 ChannelPlugin 实现
 */

import path from "node:path";
import { access } from "node:fs/promises";

import type { ResolvedWecomAccount, WecomConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWecomAccountIds,
  resolveDefaultWecomAccountId,
  resolveWecomAccount,
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveRequireMention,
  WecomConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { appendWecomActiveStreamChunk, registerWecomWebhookTarget } from "./monitor.js";
import { setWecomRuntime } from "./runtime.js";
import { normalizeChunkForWecomWsStream } from "./bot.js";
import {
  buildTempMediaUrl,
  consumeResponseUrl,
  getAccountPublicBaseUrl,
  registerTempLocalMedia,
  setAccountPublicBaseUrl,
} from "./outbound-reply.js";
import {
  appendWecomWsActiveStreamChunk,
  appendWecomWsActiveStreamReply,
  consumeWecomWsPendingAutoImagePaths,
  sendWecomWsActiveTemplateCard,
} from "./ws-reply-context.js";
import {
  sendWecomWsProactiveMarkdown,
  sendWecomWsProactiveTemplateCard,
  startWecomWsGateway,
  stopWecomWsGatewayForAccount,
} from "./ws-gateway.js";
import { buildWecomNativeReplyImageItem } from "./ws-media.js";

type ParsedDirectTarget = {
  accountId?: string;
  kind: "user" | "group";
  id: string;
};

// 裸目标默认按 userId 处理；仅接受“机器可投递 ID”风格，避免显示名歧义。
const BARE_USER_ID_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const EXPLICIT_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

function parseDirectTarget(rawTarget: string): ParsedDirectTarget | null {
  let raw = String(rawTarget ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("wecom:")) {
    raw = raw.slice("wecom:".length);
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

  if (raw.startsWith("chat:")) {
    raw = `group:${raw.slice(5)}`;
  }

  if (raw.startsWith("group:")) {
    const id = raw.slice(6).trim();
    if (!id || /\s/.test(id) || !GROUP_ID_RE.test(id)) return null;
    return { accountId, kind: "group", id };
  }

  const explicitUserPrefix = raw.startsWith("user:");
  if (explicitUserPrefix) raw = raw.slice(5);
  const id = raw.trim();
  if (!id || /\s/.test(id)) return null;
  if (!explicitUserPrefix && !BARE_USER_ID_RE.test(id)) return null;
  if (explicitUserPrefix && !EXPLICIT_USER_ID_RE.test(id)) return null;
  return { accountId, kind: "user", id };
}

type OutboundMediaType = "image" | "file";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeLocalPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("file://")) {
    return decodeURIComponent(trimmed.slice("file://".length));
  }
  return trimmed;
}

async function ensureReadableFile(filePath: string): Promise<void> {
  await access(filePath);
}

function detectOutboundMediaType(mediaUrl: string, mimeType?: string): OutboundMediaType {
  const mime = String(mimeType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mime.startsWith("image/")) return "image";

  const ext = path.extname(mediaUrl.split("?")[0] ?? "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
    return "image";
  }
  return "file";
}

function buildMediaMarkdown(params: {
  mediaUrl: string;
  mediaType: OutboundMediaType;
  caption?: string;
}): string {
  const parts: string[] = [];
  const caption = params.caption?.trim();
  if (caption) {
    parts.push(caption);
  }

  if (params.mediaType === "image") {
    parts.push(`![](${params.mediaUrl})`);
  } else {
    parts.push(`[下载文件](${params.mediaUrl})`);
  }

  return parts.join("\n\n").trim();
}

function resolveReplyTargetToken(parsed: ParsedDirectTarget): string {
  return `${parsed.kind}:${parsed.id}`;
}

function resolveStreamContext(params: unknown): { sessionKey?: string; runId?: string } {
  if (!params || typeof params !== "object") return {};
  const maybe = params as Record<string, unknown>;
  const sessionKey = typeof maybe.sessionKey === "string" ? maybe.sessionKey.trim() : "";
  const runId = typeof maybe.runId === "string" ? maybe.runId.trim() : "";
  return {
    sessionKey: sessionKey || undefined,
    runId: runId || undefined,
  };
}

async function appendActiveChunk(params: {
  account: ResolvedWecomAccount;
  to: string;
  chunk: string;
  sessionKey?: string;
  runId?: string;
}): Promise<boolean> {
  const result = await appendActiveReply({
    account: params.account,
    to: params.to,
    chunk: params.chunk,
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
  return result.accepted;
}

async function appendActiveReply(params: {
  account: ResolvedWecomAccount;
  to: string;
  chunk?: string;
  msgItems?: import("./ws-media.js").WecomReplyMsgItem[];
  sessionKey?: string;
  runId?: string;
}): Promise<{ accepted: boolean; appendedMsgItems: number }> {
  if (params.account.mode === "ws") {
    return appendWecomWsActiveStreamReply({
      accountId: params.account.accountId,
      to: params.to,
      chunk: params.chunk,
      msgItems: params.msgItems,
      sessionKey: params.sessionKey,
      runId: params.runId,
    });
  }
  const chunk = String(params.chunk ?? "");
  if (!chunk.trim()) {
    return {
      accepted: false,
      appendedMsgItems: 0,
    };
  }
  const accepted = appendWecomActiveStreamChunk({
    accountId: params.account.accountId,
    to: params.to,
    chunk,
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
  return {
    accepted,
    appendedMsgItems: 0,
  };
}

async function postWecomResponse(responseUrl: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WeCom response_url send failed: HTTP ${response.status} ${text}`.trim());
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const meta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信智能机器人回调",
  aliases: ["wechatwork", "wework", "qywx", "企微", "企业微信"],
  order: 85,
} as const;

const unregisterHooks = new Map<string, () => void>();

export const wecomPlugin = {
  id: "wecom",

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
  },

  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const parsed = parseDirectTarget(raw);
      if (!parsed) return undefined;
      return `${parsed.kind}:${parsed.id}${parsed.accountId ? `@${parsed.accountId}` : ""}`;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        return Boolean(parseDirectTarget(candidate));
      },
      hint: "Use WeCom ids only: user:<userid> for DM, group:<chatid> for groups (optional @accountId).",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return params.display?.trim() || params.target;
      return `${parsed.kind}:${parsed.id}`;
    },
  },

  configSchema: WecomConfigJsonSchema,

  reload: { configPrefixes: ["channels.wecom"] },

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listWecomAccountIds(cfg),

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedWecomAccount =>
      resolveWecomAccount({ cfg, accountId }),

    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultWecomAccountId(cfg),

    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(params.cfg.channels?.wecom?.accounts?.[accountId]);
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            wecom: {
              ...(params.cfg.channels?.wecom ?? {}),
              enabled: params.enabled,
            } as WecomConfig,
          },
        };
      }

      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          wecom: {
            ...(params.cfg.channels?.wecom ?? {}),
            accounts: {
              ...(params.cfg.channels?.wecom?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.wecom?.accounts?.[accountId] ?? {}),
                enabled: params.enabled,
              },
            },
          } as WecomConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.wecom;
      if (!current) return next;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } = current as WecomConfig;
        next.channels = {
          ...next.channels,
          wecom: { ...(rest as WecomConfig), enabled: false },
        };
        return next;
      }

      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];

      next.channels = {
        ...next.channels,
        wecom: {
          ...(current as WecomConfig),
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return next;
    },

    isConfigured: (account: ResolvedWecomAccount): boolean => account.configured,

    describeAccount: (account: ResolvedWecomAccount) => ({
      accountId: account.accountId,
      name: account.name,
      mode: account.mode,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.mode === "webhook" ? account.config.webhookPath ?? "/wecom" : undefined,
      wsUrl: account.mode === "ws" ? account.wsUrl : undefined,
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const account = resolveWecomAccount({ cfg: params.cfg, accountId: params.accountId });
      return resolveAllowFrom(account.config);
    },

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  groups: {
    resolveRequireMention: (params: { cfg: PluginConfig; accountId?: string; account?: ResolvedWecomAccount }): boolean => {
      const account = params.account ?? resolveWecomAccount({ cfg: params.cfg ?? {}, accountId: params.accountId });
      return resolveRequireMention(account.config);
    },
  },

  directory: {
    canResolve: (params: { target: string }): boolean => Boolean(parseDirectTarget(params.target)),
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
      return { channel: "wecom", accountId: parsed.accountId, to: parsed.id };
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
        const resolved = wecomPlugin.directory.resolveTarget({ cfg: params.cfg, target });
        if (resolved) results.push(resolved);
      }
      return results;
    },
    getTargetFormats: (): string[] => [
      "wecom:user:<userId>",
      "user:<userId>",
      "group:<chatId>",
      "<userid-lowercase>",
    ],
  },

  outbound: {
    deliveryMode: "direct",

    sendText: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      text: string;
      sessionKey?: string;
      runId?: string;
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      console.log(`[wecom] sendText called: to=${params.to}, textLen=${params.text.length}`);
      const account = resolveWecomAccount({ cfg: params.cfg, accountId: params.accountId });
      const parsed = parseDirectTarget(params.to);
      const streamContext = resolveStreamContext(params);
      if (!parsed) {
        const error = new Error(`Unsupported target for WeCom: ${params.to}`);
        console.error(`[wecom] sendText failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      }
      console.log(
        `[wecom] sendText stream context: runId=${streamContext.runId ?? "-"}, sessionKey=${streamContext.sessionKey ?? "-"}`
      );
      const replyTarget = resolveReplyTargetToken(parsed);
      const autoImagePaths =
        account.mode === "ws"
          ? consumeWecomWsPendingAutoImagePaths({
              accountId: account.accountId,
              to: replyTarget,
              sessionKey: streamContext.sessionKey,
              runId: streamContext.runId,
            })
          : [];
      if (account.mode === "ws" && autoImagePaths.length > 0) {
        const normalized = await normalizeChunkForWecomWsStream({
          accountId: account.accountId,
          text: params.text,
          payloadMediaUrls: autoImagePaths,
        });
        const streamAccepted = await appendActiveReply({
          account,
          to: replyTarget,
          chunk: normalized.text,
          msgItems: normalized.msgItems,
          sessionKey: streamContext.sessionKey,
          runId: streamContext.runId,
        });
        if (streamAccepted.accepted && (normalized.text.trim() || streamAccepted.appendedMsgItems > 0)) {
          console.log(
            `[wecom] sendText success (auto media attach): to=${replyTarget}, msgItems=${streamAccepted.appendedMsgItems}`
          );
          return {
            channel: "wecom",
            ok: true,
            messageId: `stream:${Date.now()}`,
          };
        }
      }
      const streamAccepted = await appendActiveChunk({
        account,
        to: replyTarget,
        chunk: params.text,
        sessionKey: streamContext.sessionKey,
        runId: streamContext.runId,
      });
      if (streamAccepted) {
        return {
          channel: "wecom",
          ok: true,
          messageId: `stream:${Date.now()}`,
        };
      }
      if (account.mode === "ws") {
        try {
          await sendWecomWsProactiveMarkdown({
            accountId: account.accountId,
            to: replyTarget,
            content: params.text,
          });
          return {
            channel: "wecom",
            ok: true,
            messageId: `proactive:${Date.now()}`,
          };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(`[wecom] sendText failed: ${error.message}`);
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error,
          };
        }
      }
      const error = new Error(
        `No active stream available for ${replyTarget}. WeCom message tool is stream-only in current mode.`
      );
      console.error(`[wecom] sendText failed: ${error.message}`);
      return {
        channel: "wecom",
        ok: false,
        messageId: "",
        error,
      };
    },

    sendMedia: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      mediaUrl: string;
      text?: string;
      mimeType?: string;
      sessionKey?: string;
      runId?: string;
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      console.log(`[wecom] sendMedia called: to=${params.to}, mediaUrl=${params.mediaUrl}`);
      const account = resolveWecomAccount({ cfg: params.cfg, accountId: params.accountId });
      const parsed = parseDirectTarget(params.to);
      const streamContext = resolveStreamContext(params);
      if (!parsed) {
        const error = new Error(`Unsupported target for WeCom: ${params.to}`);
        console.error(`[wecom] sendMedia failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      }
      console.log(
        `[wecom] sendMedia stream context: runId=${streamContext.runId ?? "-"}, sessionKey=${streamContext.sessionKey ?? "-"}, wsImageReplyMode=${account.wsImageReplyMode}`
      );

      try {
        const replyTarget = resolveReplyTargetToken(parsed);
        if (account.mode === "ws") {
          consumeWecomWsPendingAutoImagePaths({
            accountId: account.accountId,
            to: replyTarget,
            sessionKey: streamContext.sessionKey,
            runId: streamContext.runId,
          });
        }
        if (account.mode === "ws" && account.wsImageReplyMode === "native" && !isHttpUrl(params.mediaUrl)) {
          const localPath = normalizeLocalPath(params.mediaUrl);
          await ensureReadableFile(localPath);
          const nativeMsgItem = await buildWecomNativeReplyImageItem({ source: localPath });
          if (nativeMsgItem) {
            const nativeAccepted = await appendActiveReply({
              account,
              to: replyTarget,
              msgItems: [nativeMsgItem],
              sessionKey: streamContext.sessionKey,
              runId: streamContext.runId,
            });
            if (nativeAccepted.accepted && nativeAccepted.appendedMsgItems > 0) {
              const caption = params.text?.trim();
              if (caption) {
                await appendActiveChunk({
                  account,
                  to: replyTarget,
                  chunk: caption,
                  sessionKey: streamContext.sessionKey,
                  runId: streamContext.runId,
                });
              }
              console.log(`[wecom] sendMedia success (native ws image): to=${replyTarget}`);
              return {
                channel: "wecom",
                ok: true,
                messageId: `stream:${Date.now()}`,
              };
            }
          }
        }

        let publicMediaUrl = params.mediaUrl.trim();
        if (!isHttpUrl(publicMediaUrl)) {
          const localPath = normalizeLocalPath(publicMediaUrl);
          await ensureReadableFile(localPath);
          const baseUrl = getAccountPublicBaseUrl(account.accountId);
          if (!baseUrl) {
            throw new Error(
              account.mode === "ws"
                ? "No public base URL configured for this account. Set channels.wecom.publicBaseUrl (or account-level publicBaseUrl) before sending local media in ws mode."
                : "No public base URL captured yet for this account. Send one inbound message first, then retry media reply."
            );
          }
          const temp = await registerTempLocalMedia({
            filePath: localPath,
            fileName: path.basename(localPath),
          });
          publicMediaUrl = buildTempMediaUrl({
            baseUrl,
            id: temp.id,
            token: temp.token,
            fileName: temp.fileName,
          });
        }

        const mediaType = detectOutboundMediaType(publicMediaUrl, params.mimeType);
        const markdown = buildMediaMarkdown({
          mediaUrl: publicMediaUrl,
          mediaType,
          caption: params.text,
        });
        const streamAccepted = await appendActiveChunk({
          account,
          to: replyTarget,
          chunk: markdown,
          sessionKey: streamContext.sessionKey,
          runId: streamContext.runId,
        });
        if (streamAccepted) {
          console.log(
            `[wecom] sendMedia success (stream append): type=${mediaType}, to=${replyTarget}`
          );
          return {
            channel: "wecom",
            ok: true,
            messageId: `stream:${Date.now()}`,
          };
        }
        if (account.mode === "ws") {
          await sendWecomWsProactiveMarkdown({
            accountId: account.accountId,
            to: replyTarget,
            content: markdown,
          });
          return {
            channel: "wecom",
            ok: true,
            messageId: `proactive:${Date.now()}`,
          };
        }

        const error = new Error(
          `No active stream available for ${replyTarget}. WeCom message tool is stream-only in current mode.`
        );
        console.error(`[wecom] sendMedia failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      } catch (err) {
        console.error(`[wecom] sendMedia failed: ${formatError(err)}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    sendTemplateCard: async (params: {
      cfg: PluginConfig;
      accountId?: string;
      to: string;
      templateCard: Record<string, unknown>;
    }): Promise<{
      channel: string;
      ok: boolean;
      messageId: string;
      error?: Error;
    }> => {
      console.log(`[wecom] sendTemplateCard called: to=${params.to}`);
      const account = resolveWecomAccount({ cfg: params.cfg, accountId: params.accountId });
      const parsed = parseDirectTarget(params.to);
      if (!parsed) {
        const error = new Error(`Unsupported target for WeCom: ${params.to}`);
        console.error(`[wecom] sendTemplateCard failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      }
      if (parsed.kind !== "user") {
        const error = new Error("WeCom active template_card reply is only supported in single chat targets (user:<userid>).");
        console.error(`[wecom] sendTemplateCard failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      }

      if (account.mode === "ws") {
        const replyTarget = resolveReplyTargetToken(parsed);
        try {
          const updated = await sendWecomWsActiveTemplateCard({
            accountId: account.accountId,
            to: replyTarget,
            templateCard: params.templateCard ?? {},
          });
          if (updated) {
            return {
              channel: "wecom",
              ok: true,
              messageId: `ws-template-card:${Date.now()}`,
            };
          }
          await sendWecomWsProactiveTemplateCard({
            accountId: account.accountId,
            to: replyTarget,
            templateCard: params.templateCard ?? {},
          });
          return {
            channel: "wecom",
            ok: true,
            messageId: `proactive-template-card:${Date.now()}`,
          };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(`[wecom] sendTemplateCard failed: ${error.message}`);
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error,
          };
        }
      }

      const responseUrl = consumeResponseUrl({
        accountId: account.accountId,
        to: resolveReplyTargetToken(parsed),
      });
      if (!responseUrl) {
        const error = new Error(
          `No response_url available for ${resolveReplyTargetToken(parsed)}. WeCom smart bot can only reply after inbound messages.`
        );
        console.error(`[wecom] sendTemplateCard failed: ${error.message}`);
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error,
        };
      }

      try {
        await postWecomResponse(responseUrl, {
          msgtype: "template_card",
          template_card: params.templateCard ?? {},
        });
        return {
          channel: "wecom",
          ok: true,
          messageId: `response:${Date.now()}`,
        };
      } catch (err) {
        console.error(`[wecom] sendTemplateCard failed: ${formatError(err)}`);
        return {
          channel: "wecom",
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
            reply?: {
              dispatchReplyFromConfig?: unknown;
              dispatchReplyWithBufferedBlockDispatcher?: unknown;
            };
          };
        };
        const hasRouting = Boolean(candidate.channel?.routing?.resolveAgentRoute);
        const hasReply =
          Boolean(candidate.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) ||
          Boolean(candidate.channel?.reply?.dispatchReplyFromConfig);
        if (hasRouting && hasReply) {
          setWecomRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      const account = resolveWecomAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (account.publicBaseUrl) {
        setAccountPublicBaseUrl(account.accountId, account.publicBaseUrl);
      }
      if (!account.configured) {
        ctx.log?.info(`[wecom] account ${ctx.accountId} not configured for mode=${account.mode}`);
        ctx.setStatus?.({ accountId: ctx.accountId, mode: account.mode, running: false, configured: false });
        return;
      }

      const existing = unregisterHooks.get(ctx.accountId);
      if (existing) {
        existing();
        unregisterHooks.delete(ctx.accountId);
      }

      if (account.mode === "ws") {
        await startWecomWsGateway({
          cfg: (ctx.cfg ?? {}) as PluginConfig,
          account,
          runtime: {
            log: ctx.log?.info ?? console.log,
            error: ctx.log?.error ?? console.error,
          },
          abortSignal: ctx.abortSignal,
          setStatus: (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
        });
        return;
      }

      const path = (account.config.webhookPath ?? "/wecom").trim();
      const unregister = registerWecomWebhookTarget({
        account,
        config: (ctx.cfg ?? {}) as PluginConfig,
        runtime: {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        path,
        statusSink: (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
      });

      unregisterHooks.set(ctx.accountId, unregister);

      ctx.log?.info(`[wecom] webhook registered at ${path} for account ${ctx.accountId}`);
      ctx.setStatus?.({
        accountId: ctx.accountId,
        mode: account.mode,
        running: true,
        configured: true,
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
            // Keep webhook mode alive to avoid immediate exit/restart loops.
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
        ctx.setStatus?.({ accountId: ctx.accountId, mode: account.mode, running: false, lastStopAt: Date.now() });
      }
    },

    stopAccount: async (ctx: { accountId: string; setStatus?: (status: Record<string, unknown>) => void }): Promise<void> => {
      const unregister = unregisterHooks.get(ctx.accountId);
      if (unregister) {
        unregister();
        unregisterHooks.delete(ctx.accountId);
      }
      stopWecomWsGatewayForAccount(ctx.accountId);
      ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};

export { DEFAULT_ACCOUNT_ID } from "./config.js";
