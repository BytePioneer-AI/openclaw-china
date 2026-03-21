/**
 * @xuanyue202/dingtalk
 * 钉钉渠道插件入口
 *
 * 导出:
 * - dingtalkPlugin: ChannelPlugin 实现
 * - sendMessageDingtalk: 发送消息函数
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 *
 * Requirements: 1.1
 */

import { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

/**
 * Moltbot 插件 API 接口
 * 
 * 包含：
 * - registerChannel: 注册渠道插件
 * - runtime: 完整的 Moltbot 运行时（包含 core API）
 */
export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  /** Moltbot 运行时，包含 channel.routing、channel.reply 等核心 API */
  runtime?: unknown;
  [key: string]: unknown;
}

// 导出 ChannelPlugin
export { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出发送消息函数
export { sendMessageDingtalk } from "./src/send.js";

// 导出 runtime 管理函数（供外部设置）
export { setDingtalkRuntime, getDingtalkRuntime } from "./src/runtime.js";

// 导出类型
export type {
  DingtalkConfig,
  DingtalkAccountConfig,
  ResolvedDingtalkAccount,
  DingtalkSendResult,
} from "./src/types.js";

/**
 * 钉钉插件定义
 *
 * 包含:
 * - id: 插件标识符
 * - name: 插件名称
 * - description: 插件描述
 * - configSchema: 配置 JSON Schema
 * - register: 注册函数，调用 api.registerChannel 并设置 runtime
 *
 * Requirements: 1.1
 */
const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "钉钉消息渠道插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      defaultAccount: { type: "string" },
      clientId: { type: "string" },
      clientSecret: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      requireMention: { type: "boolean" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      historyLimit: { type: "integer", minimum: 0 },
      textChunkLimit: { type: "integer", minimum: 1 },
      longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
      connectionMode: { type: "string", enum: ["stream", "webhook"] },
      enableAICard: { type: "boolean" },
      gatewayToken: { type: "string" },
      gatewayPassword: { type: "string" },
      maxFileSizeMB: { type: "number", minimum: 1 },
      inboundMedia: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          keepDays: { type: "number", minimum: 0 },
        },
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            clientId: { type: "string" },
            clientSecret: { type: "string" },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            requireMention: { type: "boolean" },
            allowFrom: { type: "array", items: { type: "string" } },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            historyLimit: { type: "integer", minimum: 0 },
            textChunkLimit: { type: "integer", minimum: 1 },
            longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
            connectionMode: { type: "string", enum: ["stream", "webhook"] },
            enableAICard: { type: "boolean" },
            gatewayToken: { type: "string" },
            gatewayPassword: { type: "string" },
            maxFileSizeMB: { type: "number", minimum: 1 },
            inboundMedia: {
              type: "object",
              additionalProperties: false,
              properties: {
                dir: { type: "string" },
                keepDays: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
    },
  },

  /**
   * 注册钉钉渠道插件
   *
   * 1. 设置完整的 Moltbot 运行时（包含 core API）
   * 2. 调用 api.registerChannel 将 dingtalkPlugin 注册到 Moltbot
   *
   * Requirements: 1.1
   */
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["dingtalk"] });
    showChinaInstallHint(api);

    // 设置完整的运行时（包含 channel.routing、channel.reply 等 API）
    // 这是消息分发到 Agent 的关键
    if (api.runtime) {
      setDingtalkRuntime(api.runtime as Record<string, unknown>);
    }
    
    // 注册渠道插件
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
