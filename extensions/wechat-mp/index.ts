import type { IncomingMessage, ServerResponse } from "http";

import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

import { wechatMpPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setWechatMpRuntime, getWechatMpRuntime } from "./src/runtime.js";
import { sendWechatMpActiveText } from "./src/send.js";
import { handleWechatMpWebhookRequest } from "./src/webhook.js";

// Import types for local use and re-export
import type {
  WechatMpConfig,
  WechatMpAccountConfig,
  ResolvedWechatMpAccount,
  WechatMpDmPolicy,
  WechatMpMessageMode,
  WechatMpReplyMode,
  WechatMpActiveDeliveryMode,
  PluginConfig,
  MoltbotPluginApi,
} from "./src/types.js";

// Re-export types from types.ts
export type {
  WechatMpConfig,
  WechatMpAccountConfig,
  ResolvedWechatMpAccount,
  WechatMpDmPolicy,
  WechatMpMessageMode,
  WechatMpReplyMode,
  WechatMpActiveDeliveryMode,
  PluginConfig,
  MoltbotPluginApi,
};

export { wechatMpPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
export { setWechatMpRuntime, getWechatMpRuntime } from "./src/runtime.js";
export { sendWechatMpActiveText } from "./src/send.js";

/**
 * Collect webhook paths for all configured accounts.
 * Used to register HTTP routes with the host.
 */
export function collectWechatMpRoutePaths(config: PluginConfig): string[] {
  const paths: string[] = [];
  const cfg = config?.channels?.["wechat-mp"] as WechatMpConfig | undefined;

  if (!cfg) return paths;

  const defaultPath = cfg.webhookPath ?? "/wechat-mp";
  paths.push(defaultPath);

  if (cfg.accounts) {
    for (const [accountId, account] of Object.entries(cfg.accounts)) {
      const accountPath = account.webhookPath ?? defaultPath;
      if (!paths.includes(accountPath)) {
        paths.push(accountPath);
      }
    }
  }

  return paths;
}


/**
 * Plugin register function - entry point for host integration.
 * Follows the thin entry pattern with setup CLI, install hint, runtime, and registerChannel.
 */
export function register(api: MoltbotPluginApi): void {
  const config = api.config;

  if (api.registerCli) {
    registerChinaSetupCli(api, { channels: ["wechat-mp"] });
  }

  showChinaInstallHint(api);

  if (api.runtime) {
    setWechatMpRuntime(api.runtime as Record<string, unknown>);
  }

  api.registerChannel({ plugin: wechatMpPlugin });

  const routePaths = collectWechatMpRoutePaths(config ?? {});

  for (const path of routePaths) {
    if (api.registerHttpRoute) {
      api.registerHttpRoute({
        path,
        auth: "plugin",
        match: "exact",
        handler: handleWechatMpWebhookRequest,
      });
    } else if (api.registerHttpHandler) {
      api.registerHttpHandler(handleWechatMpWebhookRequest);
    }
  }
}

export default { register };
