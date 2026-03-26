import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";

import { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";

export { dingtalkPlugin, DEFAULT_ACCOUNT_ID } from "./src/channel.js";
export { sendMessageDingtalk } from "./src/send.js";
export { setDingtalkRuntime, getDingtalkRuntime } from "./src/runtime.js";

export type {
  DingtalkConfig,
  DingtalkAccountConfig,
  ResolvedDingtalkAccount,
  DingtalkSendResult,
} from "./src/types.js";

export default defineChannelPluginEntry({
  id: "dingtalk",
  name: "DingTalk",
  description: "钉钉消息渠道插件",
  plugin: dingtalkPlugin,
  setRuntime: setDingtalkRuntime,
  registerFull(api) {
    registerChinaSetupCli(api, { channels: ["dingtalk"] });
    showChinaInstallHint(api);
  },
});
