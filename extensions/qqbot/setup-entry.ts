import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";

import { qqbotPlugin } from "./src/channel.js";

export { qqbotPlugin as qqbotSetupPlugin };

export default defineSetupPluginEntry(qqbotPlugin);
