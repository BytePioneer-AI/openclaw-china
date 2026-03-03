/**
 * @openclaw-china/wecom-app
 * 企业微信自建应用渠道插件入口
 *
 * 导出:
 * - wecomAppPlugin: ChannelPlugin 实现
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 * - setWecomAppRuntime: 设置 Moltbot 运行时
 * - sendWecomAppMessage: 主动发送消息
 * - getAccessToken: 获取 Access Token
 */

import type { IncomingMessage, ServerResponse } from "http";

import { wecomAppPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setWecomAppRuntime, getWecomAppRuntime } from "./src/runtime.js";
import { handleWecomAppWebhookRequest } from "./src/monitor.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";
import {
  sendWecomAppMessage,
  sendWecomAppMarkdownMessage,
  getAccessToken,
  stripMarkdown,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
} from "./src/api.js";

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
      "wecom-app"?: {
        webhookPath?: string;
      };
    };
  };
  runtime?: unknown;
  [key: string]: unknown;
}

// 导出 ChannelPlugin
export { wecomAppPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出 runtime 管理函数
export { setWecomAppRuntime, getWecomAppRuntime } from "./src/runtime.js";

// 导出 API 函数 (主动发送消息)
export {
  sendWecomAppMessage,
  sendWecomAppMarkdownMessage,
  getAccessToken,
  stripMarkdown,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  downloadAndSendImage,
  sendWecomAppImageMessage,
} from "./src/api.js";

// 导出封装发送函数 (业务层推荐使用)
export {
  sendWecomDM,
  sendWecom,
  normalizeTarget,
  parseTarget,
  type SendMessageOptions,
  type SendResult,
} from "./src/send.js";

// 导出类型
export type {
  WecomAppConfig,
  ResolvedWecomAppAccount,
  WecomAppInboundMessage,
  WecomAppDmPolicy,
  WecomAppSendTarget,
  AccessTokenCacheEntry,
} from "./src/types.js";

const plugin = {
  id: "wecom-app",
  name: "WeCom App",
  description: "企业微信自建应用插件，支持主动发送消息",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["wecom-app"] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setWecomAppRuntime(api.runtime as Record<string, unknown>);
    }

    api.registerChannel({ plugin: wecomAppPlugin });

    if (api.registerHttpRoute) {
      const webhookPath = (api.config?.channels?.["wecom-app"]?.webhookPath ?? "/wecom-app").trim() || "/wecom-app";
      api.registerHttpRoute({
        path: webhookPath,
        auth: "plugin",
        match: "prefix",
        handler: handleWecomAppWebhookRequest,
      });
    } else if (api.registerHttpHandler) {
      // Backward compatibility for older OpenClaw core
      api.registerHttpHandler(handleWecomAppWebhookRequest);
    }
  },
};

export default plugin;
