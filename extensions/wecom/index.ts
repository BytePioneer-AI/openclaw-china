/**
 * @openclaw-china/wecom
 * 企业微信渠道插件入口
 *
 * 导出:
 * - wecomPlugin: ChannelPlugin 实现
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 * - setWecomRuntime: 设置 Moltbot 运行时
 */

import type { IncomingMessage, ServerResponse } from "http";

import { wecomPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setWecomRuntime, getWecomRuntime } from "./src/runtime.js";
import { handleWecomWebhookRequest } from "./src/monitor.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";

/**
 * Moltbot 插件 API 接口
 */
type HttpRouteMatch = "exact" | "prefix";
type HttpRouteAuth = "gateway" | "plugin";

type HttpRouteParams = {
  path: string;
  auth: HttpRouteAuth;
  match?: HttpRouteMatch;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
};

export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpHandler?: (handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean) => void;
  registerHttpRoute?: (params: HttpRouteParams) => void;
  config?: {
    channels?: {
      wecom?: {
        webhookPath?: string;
      };
    };
  };
  runtime?: unknown;
  [key: string]: unknown;
}

// 导出 ChannelPlugin
export { wecomPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出 runtime 管理函数
export { setWecomRuntime, getWecomRuntime } from "./src/runtime.js";

// 导出类型
export type { WecomConfig, ResolvedWecomAccount, WecomInboundMessage } from "./src/types.js";

const plugin = {
  id: "wecom",
  name: "WeCom",
  description: "企业微信智能机器人回调插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["wecom"] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setWecomRuntime(api.runtime as Record<string, unknown>);
    }

    api.registerChannel({ plugin: wecomPlugin });

    if (api.registerHttpRoute) {
      const webhookPath = (api.config?.channels?.wecom?.webhookPath ?? "/wecom").trim() || "/wecom";
      api.registerHttpRoute({
        path: webhookPath,
        auth: "plugin",
        match: "prefix",
        handler: handleWecomWebhookRequest,
      });
      api.registerHttpRoute({
        path: "/wecom-media",
        auth: "plugin",
        match: "prefix",
        handler: handleWecomWebhookRequest,
      });
    } else if (api.registerHttpHandler) {
      // Backward compatibility for older OpenClaw core
      api.registerHttpHandler(handleWecomWebhookRequest);
    }
  },
};

export default plugin;
