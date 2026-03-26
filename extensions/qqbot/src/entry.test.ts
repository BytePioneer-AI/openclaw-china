import { beforeEach, describe, expect, it, vi } from "vitest";

import entry from "../index.js";
import setupEntry, { qqbotSetupPlugin } from "../setup-entry.js";
import { qqbotPlugin } from "./channel.js";
import { clearQQBotRuntime, getQQBotRuntime } from "./runtime.js";

describe("qqbot plugin entry", () => {
  beforeEach(() => {
    clearQQBotRuntime();
  });

  it("registers the channel plugin and stores runtime for setup-only loads", () => {
    const registerChannel = vi.fn();
    const runtime = {};

    entry.register({
      registerChannel,
      runtime,
      registrationMode: "setup-only",
    } as never);

    expect(registerChannel).toHaveBeenCalledWith({ plugin: qqbotPlugin });
    expect(getQQBotRuntime()).toBe(runtime);
  });

  it("exports a setup entry that points at the qqbot plugin surface", () => {
    expect(setupEntry.plugin).toBe(qqbotSetupPlugin);
    expect(qqbotSetupPlugin).toBe(qqbotPlugin);
  });
});
