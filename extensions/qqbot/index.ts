/**
 * @xuanyue202/qqbot
 * QQ Bot 渠道插件入口
 */

import { qqbotPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@xuanyue202/shared";

export interface MoltbotPluginApi {
  registerChannel: (opts: { plugin: unknown }) => void;
  runtime?: unknown;
  [key: string]: unknown;
}

export { qqbotPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export {
  listKnownQQBotTargets,
  getKnownQQBotTarget,
  removeKnownQQBotTarget,
  clearKnownQQBotTargets,
  sendProactiveQQBotMessage,
} from "./src/proactive.js";
export type { QQBotConfig, QQBotAccountConfig, ResolvedQQBotAccount, QQBotSendResult } from "./src/types.js";
export type { KnownQQBotTarget } from "./src/proactive.js";

const plugin = {
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ 开放平台机器人消息渠道插件",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      defaultAccount: { type: "string" },
      appId: { type: ["string", "number"] },
      clientSecret: { type: "string" },
      displayAliases: {
        type: "object",
        additionalProperties: { type: "string" }
      },
      asr: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          appId: { type: ["string", "number"] },
          secretId: { type: "string" },
          secretKey: { type: "string" }
        }
      },
      markdownSupport: { type: "boolean" },
      c2cMarkdownDeliveryMode: {
        type: "string",
        enum: ["passive", "proactive-table-only", "proactive-all"],
      },
      c2cMarkdownChunkStrategy: {
        type: "string",
        enum: ["markdown-block", "length"],
      },
      c2cMarkdownSafeChunkByteLimit: { type: "integer", minimum: 1 },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      requireMention: { type: "boolean" },
      allowFrom: { type: "array", items: { type: "string" } },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      historyLimit: { type: "integer", minimum: 0 },
      textChunkLimit: { type: "integer", minimum: 1 },
      replyFinalOnly: { type: "boolean" },
      longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
      maxFileSizeMB: { type: "number" },
      mediaTimeoutMs: { type: "number" },
      autoSendLocalPathMedia: { type: "boolean" },
      inboundMedia: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          keepDays: { type: "number", minimum: 0 }
        }
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            appId: { type: ["string", "number"] },
            clientSecret: { type: "string" },
            displayAliases: {
              type: "object",
              additionalProperties: { type: "string" }
            },
            asr: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                appId: { type: ["string", "number"] },
                secretId: { type: "string" },
                secretKey: { type: "string" }
            }
            },
            markdownSupport: { type: "boolean" },
            c2cMarkdownDeliveryMode: {
              type: "string",
              enum: ["passive", "proactive-table-only", "proactive-all"],
            },
            c2cMarkdownChunkStrategy: {
              type: "string",
              enum: ["markdown-block", "length"],
            },
            c2cMarkdownSafeChunkByteLimit: { type: "integer", minimum: 1 },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            requireMention: { type: "boolean" },
            allowFrom: { type: "array", items: { type: "string" } },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            historyLimit: { type: "integer", minimum: 0 },
            textChunkLimit: { type: "integer", minimum: 1 },
            replyFinalOnly: { type: "boolean" },
            longTaskNoticeDelayMs: { type: "integer", minimum: 0 },
            maxFileSizeMB: { type: "number" },
            mediaTimeoutMs: { type: "number" },
            autoSendLocalPathMedia: { type: "boolean" },
            inboundMedia: {
              type: "object",
              additionalProperties: false,
              properties: {
                dir: { type: "string" },
                keepDays: { type: "number", minimum: 0 }
              }
            }
          }
        }
      }
    },
  },

  register(api: MoltbotPluginApi) {
    registerChinaSetupCli(api, { channels: ["qqbot"] });
    showChinaInstallHint(api);

    if (api.runtime) {
      setQQBotRuntime(api.runtime as Record<string, unknown>);
    }
    api.registerChannel({ plugin: qqbotPlugin });
  },
};

export default plugin;
