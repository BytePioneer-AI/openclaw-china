import type { IncomingMessage, ServerResponse } from "http";

import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

import { wecomKfPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setWecomKfRuntime, getWecomKfRuntime, tryGetWecomKfRuntime } from "./src/runtime.js";
import { handleWecomKfWebhookRequest } from "./src/webhook.js";

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
  accounts?: Record<string, { webhookPath?: string }>;
};

export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerHttpHandler?: (
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean
  ) => void;
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

export { wecomKfPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
export { setWecomKfRuntime, getWecomKfRuntime, tryGetWecomKfRuntime } from "./src/runtime.js";
export {
  getAccessToken,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  sendKfMessage,
  sendKfWelcomeMessage,
  sendKfTextMessage,
  splitMessageByBytes,
  stripMarkdown,
  summarizeSendResults,
  syncMessages,
} from "./src/api.js";
export { sendWecomKfDM, type SendMessageOptions, type SendResult } from "./src/send.js";
export { probeWecomKfAccount } from "./src/probe.js";
export type {
  AccessTokenCacheEntry,
  KfSendMsgParams,
  KfSendMsgResult,
  PluginConfig,
  ResolvedWecomKfAccount,
  SyncMsgItem,
  SyncMsgResponse,
  WecomKfAccountConfig,
  WecomKfConfig,
  WecomKfDmPolicy,
} from "./src/types.js";

const plugin = {
  id: "wecom-kf",
  name: "WeCom KF",
  description: "微信客服渠道插件，支持外部微信用户通过客服系统与 AI 交互",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["wecom-kf"] });
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
