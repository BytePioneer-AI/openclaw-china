/**
 * @xuanyue202/feishu-china
 * 飞书渠道插件入口
 *
 * 导出:
 * - feishuPlugin: ChannelPlugin 实现
 * - sendMessageFeishu: 发送消息函数
 * - DEFAULT_ACCOUNT_ID: 默认账户 ID
 */

import { feishuPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";
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
export { feishuPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";

// 导出发送消息函数
export { sendMessageFeishu } from "./src/send.js";

// 导出 runtime 管理函数（供外部设置）
export { setFeishuRuntime, getFeishuRuntime } from "./src/runtime.js";

// 导出类型
export type { FeishuConfig, ResolvedFeishuAccount, FeishuSendResult } from "./src/types.js";

/**
 * 飞书插件定义
 *
 * 包含:
 * - id: 插件标识符
 * - name: 插件名称
 * - description: 插件描述
 * - configSchema: 配置 JSON Schema
 * - register: 注册函数，调用 api.registerChannel 并设置 runtime
 */
const plugin = {
  id: "feishu-china",
  name: "Feishu",
  description: "飞书/Lark 消息渠道插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      appId: { type: "string" },
      appSecret: { type: "string" },
      connectionMode: { type: "string", enum: ["websocket"] },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      requireMention: { type: "boolean" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      sendMarkdownAsCard: { type: "boolean" },
      historyLimit: { type: "integer", minimum: 0 },
      textChunkLimit: { type: "integer", minimum: 1 },
    },
  },

  /**
   * 注册飞书渠道插件
   *
   * 1. 设置完整的 Moltbot 运行时（包含 core API）
   * 2. 调用 api.registerChannel 将 feishuPlugin 注册到 Moltbot
   */
  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["feishu-china"] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setFeishuRuntime(api.runtime as Record<string, unknown>);
    }

    api.registerChannel({ plugin: feishuPlugin });
  },
};

export default plugin;
