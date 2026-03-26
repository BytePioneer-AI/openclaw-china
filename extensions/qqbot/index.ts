import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";

import { qqbotPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";

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

export default defineChannelPluginEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ 开放平台机器人消息渠道插件",
  plugin: qqbotPlugin,
  setRuntime: setQQBotRuntime,
  registerFull(api) {
    registerChinaSetupCli(api, { channels: ["qqbot"] });
    showChinaInstallHint(api);
  },
});
