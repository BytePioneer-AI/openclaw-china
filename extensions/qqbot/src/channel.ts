import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedQQBotAccount } from "./types.js";
import { DEFAULT_ACCOUNT_ID, type PluginConfig } from "./config.js";
import { qqbotMessageActions } from "./actions.js";
import {
  normalizeQQBotMessagingTarget,
  qqbotPluginBase,
  qqbotSecurityOptions,
} from "./channel.shared.js";
import { qqbotOutbound } from "./outbound.js";
import { monitorQQBotProvider, stopQQBotMonitorForAccount } from "./monitor.js";
import { setQQBotRuntime } from "./runtime.js";

export { DEFAULT_ACCOUNT_ID } from "./config.js";

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = createChatChannelPlugin({
  base: {
    ...qqbotPluginBase,
    messaging: {
      ...qqbotPluginBase.messaging,
      normalizeTarget: (raw: string): string | undefined => normalizeQQBotMessagingTarget(raw),
    },
    actions: qqbotMessageActions,
    outbound: qqbotOutbound as NonNullable<ChannelPlugin<ResolvedQQBotAccount>["outbound"]>,
    gateway: {
      startAccount: async (ctx) => {
        ctx.setStatus?.({
          accountId: ctx.accountId,
        });
        ctx.log?.info?.(`[qqbot] starting gateway for account ${ctx.accountId}`);

        if (ctx.runtime) {
          const candidate = ctx.runtime as {
            channel?: {
              routing?: { resolveAgentRoute?: unknown };
              reply?: {
                dispatchReplyFromConfig?: unknown;
                dispatchReplyWithBufferedBlockDispatcher?: unknown;
                dispatchReplyWithDispatcher?: unknown;
              };
            };
          };
          const hasRouting = Boolean(candidate.channel?.routing?.resolveAgentRoute);
          const hasReply =
            Boolean(candidate.channel?.reply?.dispatchReplyWithDispatcher) ||
            Boolean(candidate.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) ||
            Boolean(candidate.channel?.reply?.dispatchReplyFromConfig);
          if (hasRouting && hasReply) {
            setQQBotRuntime(ctx.runtime as unknown as import("./runtime.js").PluginRuntime);
          }
        }

        await monitorQQBotProvider({
          config: ctx.cfg as PluginConfig,
          runtime:
            (ctx.runtime as { log?: (msg: string) => void; error?: (msg: string) => void }) ?? {
              log: (message) => ctx.log?.info?.(message),
              error: (message) => ctx.log?.error?.(message),
            },
          abortSignal: ctx.abortSignal,
          accountId: ctx.accountId,
          setStatus: ctx.setStatus
            ? (status) => ctx.setStatus?.(status as never)
            : undefined,
        });
      },
      stopAccount: async (ctx) => {
        stopQQBotMonitorForAccount(ctx.accountId);
      },
    },
  },
  security: qqbotSecurityOptions,
  pairing: {
    text: {
      idLabel: "qqbotOpenId",
      message: "Your pairing request has been approved.",
      normalizeAllowEntry: (entry) =>
        normalizeQQBotMessagingTarget(entry)?.replace(/^user:/i, "") ?? entry.trim(),
      notify: async ({ cfg, id, message, accountId }) => {
        const result = await qqbotOutbound.sendText({
          cfg: cfg as PluginConfig,
          to: id,
          text: message,
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        });
        if (result.error) {
          throw new Error(result.error);
        }
      },
    },
  },
});
