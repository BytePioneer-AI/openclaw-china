import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>(
  "Dingtalk runtime not initialized. Make sure the plugin is properly registered with OpenClaw.",
);

export type { PluginRuntime };

export const setDingtalkRuntime = runtimeStore.setRuntime;
export const getDingtalkRuntime = runtimeStore.getRuntime;
export const clearDingtalkRuntime = runtimeStore.clearRuntime;

export function isDingtalkRuntimeInitialized(): boolean {
  return runtimeStore.tryGetRuntime() !== null;
}
