import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  listQQBotAccountIds,
  mergeQQBotAccountConfig,
  resolveDefaultQQBotAccountId,
  resolveQQBotCredentials,
  type PluginConfig,
} from "./config.js";
import { qqbotOutbound } from "./outbound.js";

function listEnabledConfiguredAccounts(cfg: PluginConfig): string[] {
  return listQQBotAccountIds(cfg).filter((accountId) => {
    const account = mergeQQBotAccountConfig(cfg, accountId);
    return account.enabled !== false && Boolean(resolveQQBotCredentials(account));
  });
}

export const qqbotMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listEnabledConfiguredAccounts(cfg as PluginConfig);
    if (accounts.length === 0) {
      return null;
    }

    const actions = new Set<ChannelMessageActionName>(["send"]);
    return {
      actions: Array.from(actions),
      capabilities: [],
    };
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action !== "send") {
      throw new Error(`Action ${action} is not supported for QQ Bot.`);
    }

    const to = readStringParam(params, "to", { required: true });
    const text =
      readStringParam(params, "message", { allowEmpty: true }) ??
      readStringParam(params, "text", { allowEmpty: true });
    const caption = readStringParam(params, "caption", { allowEmpty: true });
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "mediaUrl", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false });

    const resolvedAccountId =
      typeof accountId === "string" && accountId.trim()
        ? accountId
        : resolveDefaultQQBotAccountId(cfg as PluginConfig);
    const content = caption ?? text ?? "";

    const result = mediaUrl
      ? await qqbotOutbound.sendMedia({
          cfg: cfg as PluginConfig,
          to,
          text: content,
          mediaUrl,
          accountId: resolvedAccountId,
        })
      : await qqbotOutbound.sendText({
          cfg: cfg as PluginConfig,
          to,
          text: content,
          accountId: resolvedAccountId,
        });

    if (result.error) {
      throw new Error(result.error);
    }

    return jsonResult({
      ok: true,
      channel: "qqbot",
      to,
      messageId: result.messageId,
      timestamp: result.timestamp,
      refIdx: result.refIdx,
    });
  },
};
