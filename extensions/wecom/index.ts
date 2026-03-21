/**
 * @xuanyue202/wecom
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
import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

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

type WecomRouteConfig = {
  mode?: "webhook" | "ws";
  webhookPath?: string;
  accounts?: Record<
    string,
    {
      mode?: "webhook" | "ws";
      webhookPath?: string;
    }
  >;
};

export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpHandler?: (handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean) => void;
  registerHttpRoute?: (params: HttpRouteParams) => void;
  config?: {
    channels?: {
      wecom?: WecomRouteConfig;
    };
  };
  runtime?: unknown;
  [key: string]: unknown;
}

function normalizeRoutePath(path: string | undefined, fallback: string): string {
  const trimmed = path?.trim() ?? "";
  const candidate = trimmed || fallback;
  return candidate.startsWith("/") ? candidate : `/${candidate}`;
}

function collectWecomRoutePaths(config: WecomRouteConfig | undefined): string[] {
  const routes = new Set<string>(["/wecom-media"]);
  if ((config?.mode ?? "ws") !== "ws") {
    routes.add(normalizeRoutePath(config?.webhookPath, "/wecom"));
  }
  for (const accountConfig of Object.values(config?.accounts ?? {})) {
    if ((accountConfig?.mode ?? config?.mode ?? "ws") === "ws") continue;
    const customPath = accountConfig?.webhookPath?.trim();
    routes.add(normalizeRoutePath(customPath, "/wecom"));
  }
  return [...routes];
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
  description: "企业微信智能机器人渠道插件（Webhook / 长连接）",
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
      for (const path of collectWecomRoutePaths(api.config?.channels?.wecom)) {
        api.registerHttpRoute({
          path,
          auth: "plugin",
          match: "prefix",
          handler: handleWecomWebhookRequest,
        });
      }
    } else if (api.registerHttpHandler) {
      // Backward compatibility for older OpenClaw core
      api.registerHttpHandler(handleWecomWebhookRequest);
    }
  },
};

export default plugin;
