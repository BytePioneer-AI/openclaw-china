import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedQQBotAccount } from "./types.js";
import { qqbotPluginBase, qqbotSecurityOptions } from "./channel.shared.js";

export const qqbotSetupPlugin: ChannelPlugin<ResolvedQQBotAccount> = createChatChannelPlugin({
  base: qqbotPluginBase,
  security: qqbotSecurityOptions,
});
