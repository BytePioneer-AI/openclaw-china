/**
 * @xuanyue202/channels
 * 统一渠道包入口
 *
 * 导出所有渠道插件，提供统一注册函数
 *
 * Requirements: Unified Package Entry, Unified Distribution
 */

// 导出 DingTalk 插件
import {
  dingtalkPlugin,
  DEFAULT_ACCOUNT_ID as DINGTALK_DEFAULT_ACCOUNT_ID,
  sendMessageDingtalk,
  setDingtalkRuntime,
  getDingtalkRuntime,
} from "@xuanyue202/dingtalk";
import dingtalkEntry from "@xuanyue202/dingtalk";
import {
  feishuPlugin,
  DEFAULT_ACCOUNT_ID as FEISHU_DEFAULT_ACCOUNT_ID,
  sendMessageFeishu,
  setFeishuRuntime,
  getFeishuRuntime,
} from "@xuanyue202/feishu-china";
import feishuEntry from "@xuanyue202/feishu-china";
import {
  wecomPlugin,
  DEFAULT_ACCOUNT_ID as WECOM_DEFAULT_ACCOUNT_ID,
  setWecomRuntime,
  getWecomRuntime,
} from "@xuanyue202/wecom";
import wecomEntry from "@xuanyue202/wecom";
import {
  wecomAppPlugin,
  DEFAULT_ACCOUNT_ID as WECOM_APP_DEFAULT_ACCOUNT_ID,
  setWecomAppRuntime,
  getWecomAppRuntime,
  sendWecomAppMessage,
  getAccessToken,
  sendWecomAppMarkdownMessage,
  stripMarkdown,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  downloadAndSendImage,
  sendWecomAppImageMessage,
} from "@xuanyue202/wecom-app";
import wecomAppEntry from "@xuanyue202/wecom-app";
import {
  wecomKfPlugin,
  DEFAULT_ACCOUNT_ID as WECOM_KF_DEFAULT_ACCOUNT_ID,
  setWecomKfRuntime,
  getWecomKfRuntime,
} from "@xuanyue202/wecom-kf";
import wecomKfEntry from "@xuanyue202/wecom-kf";
import {
  qqbotPlugin,
  DEFAULT_ACCOUNT_ID as QQBOT_DEFAULT_ACCOUNT_ID,
  setQQBotRuntime,
  getQQBotRuntime,
} from "@xuanyue202/qqbot";
import qqbotEntry from "@xuanyue202/qqbot";
import {
  wechatMpPlugin,
  DEFAULT_ACCOUNT_ID as WECHAT_MP_DEFAULT_ACCOUNT_ID,
  setWechatMpRuntime,
  getWechatMpRuntime,
  sendWechatMpActiveText,
} from "@xuanyue202/wechat-mp";
import wechatMpEntry from "@xuanyue202/wechat-mp";
import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

export {
  dingtalkPlugin,
  DINGTALK_DEFAULT_ACCOUNT_ID,
  sendMessageDingtalk,
  setDingtalkRuntime,
  getDingtalkRuntime,
  feishuPlugin,
  FEISHU_DEFAULT_ACCOUNT_ID,
  sendMessageFeishu,
  setFeishuRuntime,
  getFeishuRuntime,
  wecomPlugin,
  WECOM_DEFAULT_ACCOUNT_ID,
  setWecomRuntime,
  getWecomRuntime,
  wecomAppPlugin,
  WECOM_APP_DEFAULT_ACCOUNT_ID,
  setWecomAppRuntime,
  getWecomAppRuntime,
  sendWecomAppMessage,
  getAccessToken,
  sendWecomAppMarkdownMessage,
  stripMarkdown,
  clearAccessTokenCache,
  clearAllAccessTokenCache,
  downloadAndSendImage,
  sendWecomAppImageMessage,
  wecomKfPlugin,
  WECOM_KF_DEFAULT_ACCOUNT_ID,
  setWecomKfRuntime,
  getWecomKfRuntime,
  qqbotPlugin,
  QQBOT_DEFAULT_ACCOUNT_ID,
  setQQBotRuntime,
  getQQBotRuntime,
  wechatMpPlugin,
  WECHAT_MP_DEFAULT_ACCOUNT_ID,
  setWechatMpRuntime,
  getWechatMpRuntime,
  sendWechatMpActiveText,
};

export type {
  DingtalkConfig,
  ResolvedDingtalkAccount,
  DingtalkSendResult,
} from "@xuanyue202/dingtalk";
export type {
  FeishuConfig,
  ResolvedFeishuAccount,
  FeishuSendResult,
} from "@xuanyue202/feishu-china";
export type { WecomConfig, ResolvedWecomAccount, WecomInboundMessage } from "@xuanyue202/wecom";
export type {
  WecomAppConfig,
  ResolvedWecomAppAccount,
  WecomAppInboundMessage,
  WecomAppDmPolicy,
  WecomAppSendTarget,
  AccessTokenCacheEntry,
} from "@xuanyue202/wecom-app";
export type {
  WecomKfConfig,
  WecomKfAccountConfig,
  ResolvedWecomKfAccount,
  WecomKfDmPolicy,
  SyncMsgItem as WecomKfSyncMsgItem,
  SyncMsgResponse as WecomKfSyncMsgResponse,
} from "@xuanyue202/wecom-kf";
export type { QQBotConfig, ResolvedQQBotAccount, QQBotSendResult } from "@xuanyue202/qqbot";
export type {
  WechatMpConfig,
  WechatMpAccountConfig,
  ResolvedWechatMpAccount,
  WechatMpDmPolicy,
  WechatMpMessageMode,
  WechatMpReplyMode,
  WechatMpActiveDeliveryMode,
} from "@xuanyue202/wechat-mp";

// TODO: 后续添加其他渠道
// export { qqPlugin } from "@xuanyue202/qq";

/**
 * 渠道配置接口
 */
export interface ChannelConfig {
  /** 是否启用该渠道 */
  enabled?: boolean;
  [key: string]: unknown;
}

export interface WecomRouteConfig extends ChannelConfig {
  webhookPath?: string;
  accounts?: Record<
    string,
    {
      webhookPath?: string;
    }
  >;
}

export interface WecomAppRouteConfig extends ChannelConfig {
  webhookPath?: string;
  accounts?: Record<
    string,
    {
      webhookPath?: string;
    }
  >;
}

export interface WecomKfRouteConfig extends ChannelConfig {
  webhookPath?: string;
  accounts?: Record<
    string,
    {
      webhookPath?: string;
    }
  >;
}

export interface WechatMpRouteConfig extends ChannelConfig {
  webhookPath?: string;
  accounts?: Record<
    string,
    {
      webhookPath?: string;
    }
  >;
}

/**
 * Moltbot 配置接口（符合官方约定）
 * 配置路径: channels.<id>.enabled
 */
export interface MoltbotConfig {
  channels?: {
    dingtalk?: ChannelConfig;
    "feishu-china"?: ChannelConfig;
    wecom?: WecomRouteConfig;
    "wecom-app"?: WecomAppRouteConfig;
    "wecom-kf"?: WecomKfRouteConfig;
    "wechat-mp"?: WechatMpRouteConfig;
    qqbot?: ChannelConfig;
    qq?: ChannelConfig;
    [key: string]: ChannelConfig | undefined;
  };
  [key: string]: unknown;
}

/**
 * Moltbot 插件 API 接口
 */
export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  registerCli?: (
    registrar: (ctx: { program: unknown; config?: MoltbotConfig }) => void | Promise<void>,
    opts?: { commands?: string[] }
  ) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  runtime?: {
    config?: {
      writeConfigFile?: (cfg: unknown) => Promise<void>;
    };
  };
  config?: MoltbotConfig;
  [key: string]: unknown;
}

/**
 * 支持的渠道列表
 */
export const SUPPORTED_CHANNELS = ["dingtalk", "feishu-china", "wecom", "wecom-app", "wecom-kf", "wechat-mp", "qqbot"] as const;
// TODO: 鍚庣画娣诲姞 "qq"

export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

const channelPlugins: Record<SupportedChannel, { register: (api: MoltbotPluginApi) => void }> = {
  dingtalk: {
    register: (api: MoltbotPluginApi) => {
      dingtalkEntry.register(api);
    },
  },
  "feishu-china": {
    register: (api: MoltbotPluginApi) => {
      feishuEntry.register(api);
    },
  },
  wecom: {
    register: (api: MoltbotPluginApi) => {
      wecomEntry.register(api);
    },
  },
  "wecom-app": {
    register: (api: MoltbotPluginApi) => {
      wecomAppEntry.register(api);
    },
  },
  "wecom-kf": {
    register: (api: MoltbotPluginApi) => {
      wecomKfEntry.register(api);
    },
  },
  "wechat-mp": {
    register: (api: MoltbotPluginApi) => {
      wechatMpEntry.register(api);
    },
  },
  qqbot: {
    register: (api: MoltbotPluginApi) => {
      qqbotEntry.register(api);
    },
  },
};

/**
 * 根据 Moltbot 配置注册启用的渠道
 *
 * 符合 Moltbot 官方约定：从 cfg.channels.<id>.enabled 读取配置
 *
 * @param api Moltbot 鎻掍欢 API
 * @param cfg Moltbot 配置（可选，默认从 api.config 读取）
 *
 * @example
 * ```ts
 * // moltbot.json 配置
 * {
 *   "channels": {
 *     "dingtalk": {
 *       "enabled": true,
 *       "clientId": "...",
 *       "clientSecret": "..."
 *     }
 *   }
 * }
 * ```
 */
export function registerChannelsByConfig(
  api: MoltbotPluginApi,
  cfg?: MoltbotConfig
): void {
  // 从 api.config 或传入的 cfg 获取配置
  const config = cfg ?? api.config;
  const channelsConfig = config?.channels;

  if (!channelsConfig) {
    return;
  }

  for (const channelId of SUPPORTED_CHANNELS) {
    // 符合官方约定：从 channels.<id>.enabled 读取
    const channelConfig = channelsConfig[channelId];

    // 跳过未启用的渠道
    if (!channelConfig?.enabled) {
      continue;
    }

    const plugin = channelPlugins[channelId];
    plugin.register(api);
  }
}

/**
 * 统一渠道插件定义
 *
 * 包含所有支持的渠道，通过配置启用
 * 配置路径符合 Moltbot 官方约定: channels.<id>
 */
const channelsPlugin = {
  id: "channels",
  name: "Moltbot China Channels",
  description: "统一渠道包，支持钉钉、飞书、企业微信、微信公众号、QQ Bot",

  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },

  /**
   * 注册所有启用的渠道
   *
   * 从 api.config.channels.<id>.enabled 读取配置
   */
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: SUPPORTED_CHANNELS });
    showChinaInstallHint(api);
    registerChannelsByConfig(api);
  },
};

export default channelsPlugin;
