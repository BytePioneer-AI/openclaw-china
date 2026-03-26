import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";

import { dingtalkPlugin } from "./src/channel.js";

export { dingtalkPlugin as dingtalkSetupPlugin };

export default defineSetupPluginEntry(dingtalkPlugin);
