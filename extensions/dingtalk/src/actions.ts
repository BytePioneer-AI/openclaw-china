import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";

import {
  listDingtalkAccountIds,
  mergeDingtalkAccountConfig,
  resolveDingtalkAccountId,
  resolveDingtalkCredentials,
  type PluginConfig,
} from "./config.js";
import { sendMediaDingtalk } from "./media.js";
import { sendMessageDingtalk } from "./send.js";
import { parseDingtalkSendTarget } from "./targets.js";

function listEnabledConfiguredAccounts(cfg: PluginConfig): string[] {
  return listDingtalkAccountIds(cfg).filter((accountId) => {
    const account = mergeDingtalkAccountConfig(cfg, accountId);
    return account.enabled !== false && Boolean(resolveDingtalkCredentials(account));
  });
}

export const dingtalkMessageActions = {
  describeMessageTool: ({ cfg }: { cfg: PluginConfig }) => {
    if (listEnabledConfiguredAccounts(cfg).length === 0) {
      return null;
    }

    return {
      actions: ["send"] as const,
      capabilities: [] as const,
    };
  },
  extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
    extractToolSend(args, "sendMessage"),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
  }: {
    action: string;
    params: Record<string, unknown>;
    cfg: PluginConfig;
    accountId?: string | null;
  }) => {
    if (action !== "send") {
      throw new Error(`Action ${action} is not supported for DingTalk.`);
    }

    const to = readStringParam(params, "to", { required: true });
    const text =
      readStringParam(params, "message", { allowEmpty: true }) ??
      readStringParam(params, "text", { allowEmpty: true }) ??
      "";
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "mediaUrl", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false });
    const base64Buffer = readStringParam(params, "buffer", { trim: false });
    const fileName =
      readStringParam(params, "filename", { trim: false }) ??
      readStringParam(params, "fileName", { trim: false });

    const resolvedAccountId = resolveDingtalkAccountId(cfg, accountId);
    const dingtalkCfg = mergeDingtalkAccountConfig(cfg, resolvedAccountId);
    const resolvedTarget = parseDingtalkSendTarget(to);
    if (!resolvedTarget) {
      throw new Error(`Invalid DingTalk target: ${to}`);
    }

    if (mediaUrl || base64Buffer) {
      if (text.trim()) {
        await sendMessageDingtalk({
          cfg: dingtalkCfg,
          to: resolvedTarget.targetId,
          text,
          chatType: resolvedTarget.chatType,
        });
      }

      const result = await sendMediaDingtalk({
        cfg: dingtalkCfg,
        to: resolvedTarget.targetId,
        mediaUrl: mediaUrl ?? "",
        chatType: resolvedTarget.chatType,
        mediaBuffer: base64Buffer ? Buffer.from(base64Buffer, "base64") : undefined,
        fileName: fileName ?? undefined,
      });

      return jsonResult({
        ok: true,
        to: resolvedTarget.normalized,
        messageId: result.messageId,
      });
    }

    if (!text.trim()) {
      throw new Error("DingTalk send action requires message text when no media is provided.");
    }

    const result = await sendMessageDingtalk({
      cfg: dingtalkCfg,
      to: resolvedTarget.targetId,
      text,
      chatType: resolvedTarget.chatType,
    });

    return jsonResult({
      ok: true,
      to: resolvedTarget.normalized,
      messageId: result.messageId,
    });
  },
};
