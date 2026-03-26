import { beforeEach, describe, expect, it, vi } from "vitest";

import entry from "../index.js";
import setupEntry, { dingtalkSetupPlugin } from "../setup-entry.js";
import { dingtalkPlugin } from "./channel.js";
import { clearDingtalkRuntime, getDingtalkRuntime } from "./runtime.js";

describe("dingtalk plugin entry", () => {
  beforeEach(() => {
    clearDingtalkRuntime();
  });

  it("registers the channel plugin and stores runtime for setup-only loads", () => {
    const registerChannel = vi.fn();
    const runtime = {};

    entry.register({
      registerChannel,
      runtime,
      registrationMode: "setup-only",
    } as never);

    expect(registerChannel).toHaveBeenCalledWith({ plugin: dingtalkPlugin });
    expect(getDingtalkRuntime()).toBe(runtime);
  });

  it("exports a setup entry that points at the dingtalk plugin surface", () => {
    expect(setupEntry.plugin).toBe(dingtalkSetupPlugin);
    expect(dingtalkSetupPlugin).toBe(dingtalkPlugin);
  });
});
