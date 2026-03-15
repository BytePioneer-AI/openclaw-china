/**
 * @openclaw-china/wecom-kf
 * 微信客服渠道插件入口
 */

import type { IncomingMessage, ServerResponse } from "http";

import { wecomKfPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setWecomKfRuntime, getWecomKfRuntime } from "./src/runtime.js";
import { handleWecomKfWebhookRequest } from "./src/monitor.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";

type HttpRouteMatch = "exact" | "prefix";
type HttpRouteAuth = "gateway" | "plugin";

type HttpRouteParams = {
  path: string;
  auth: HttpRouteAuth;
  match?: HttpRouteMatch;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
};

type WecomKfRouteConfig = {
  webhookPath?: string;
  accounts?: Record<
    string,
    {
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
      "wecom-kf"?: WecomKfRouteConfig;
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

function collectWecomKfRoutePaths(config: WecomKfRouteConfig | undefined): string[] {
  const routes = new Set<string>([normalizeRoutePath(config?.webhookPath, "/wecom-kf")]);
  for (const accountConfig of Object.values(config?.accounts ?? {})) {
    const customPath = accountConfig?.webhookPath?.trim();
    if (!customPath) continue;
    routes.add(normalizeRoutePath(customPath, "/wecom-kf"));
  }
  return [...routes];
}

// 导出 ChannelPlugin
export { wecomKfPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出 runtime 管理函数
export { setWecomKfRuntime, getWecomKfRuntime } from "./src/runtime.js";

// 导出 API 函数
export {
  sendKfMessage,
  sendKfImageMessage,
  sendKfFileMessage,
  sendKfVoiceMessage,
  sendKfVideoMessage,
  sendKfEventMessage,
  getAccessToken,
  syncMessages,
  stripMarkdown,
  uploadMedia,
  downloadWecomMediaToFile,
  finalizeInboundMedia,
  pruneInboundMediaDir,
  downloadAndSendKfImage,
  downloadAndSendKfVoice,
  downloadAndSendKfFile,
  downloadAndSendKfVideo,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
} from "./src/api.js";

// 导出类型
export type {
  WecomKfConfig,
  ResolvedWecomKfAccount,
  WecomKfInboundMessage,
  WecomKfSendTarget,
  WecomKfASRCredentials,
} from "./src/types.js";

const plugin = {
  id: "wecom-kf",
  name: "WeCom KF",
  description: "微信客服渠道插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["wecom-app", "wecom-kf"] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setWecomKfRuntime(api.runtime as Record<string, unknown>);
    }

    api.registerChannel({ plugin: wecomKfPlugin });

    if (api.registerHttpRoute) {
      for (const path of collectWecomKfRoutePaths(api.config?.channels?.["wecom-kf"])) {
        api.registerHttpRoute({
          path,
          auth: "plugin",
          match: "prefix",
          handler: handleWecomKfWebhookRequest,
        });
      }
    } else if (api.registerHttpHandler) {
      api.registerHttpHandler(handleWecomKfWebhookRequest);
    }
  },
};

export default plugin;
