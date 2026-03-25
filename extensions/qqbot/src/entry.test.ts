import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openclaw-china/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw-china/shared")>();
  return {
    ...actual,
    registerChinaSetupCli: vi.fn(),
    showChinaInstallHint: vi.fn(),
  };
});

import pluginEntry from "../index.js";
import setupEntry from "../setup-entry.js";
import { registerChinaSetupCli, showChinaInstallHint } from "@openclaw-china/shared";
import { qqbotPlugin } from "./channel.js";
import { qqbotSetupPlugin } from "./channel.setup.js";
import {
  clearQQBotRuntime,
  getQQBotRuntime,
  isQQBotRuntimeInitialized,
} from "./runtime.js";

afterEach(() => {
  clearQQBotRuntime();
  vi.clearAllMocks();
});

describe("qqbot OpenClaw SDK entry", () => {
  it("registers the channel through defineChannelPluginEntry and stores runtime", () => {
    const runtime = {
      channel: {
        text: {
          chunkMarkdownText: vi.fn((text: string) => [text]),
        },
      },
    };
    const api = {
      registrationMode: "full",
      runtime,
      registerChannel: vi.fn(),
      registerCli: vi.fn(),
      logger: {
        info: vi.fn(),
      },
    } as unknown as Parameters<typeof pluginEntry.register>[0];

    pluginEntry.register(api);

    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: qqbotPlugin });
    expect(registerChinaSetupCli).toHaveBeenCalledWith(api, { channels: ["qqbot"] });
    expect(showChinaInstallHint).toHaveBeenCalledWith(api);
    expect(isQQBotRuntimeInitialized()).toBe(true);
    expect(getQQBotRuntime()).toBe(runtime);
  });

  it("exports setup-entry with the qqbot plugin surface", () => {
    expect(setupEntry.plugin).toBe(qqbotSetupPlugin);
    expect(setupEntry.plugin.id).toBe(qqbotPlugin.id);
    expect(setupEntry.plugin.gateway).toBeUndefined();
    expect(setupEntry.plugin.actions).toBeUndefined();
  });
});

describe("qqbot policy and pairing surfaces", () => {
  it("exposes pairing-aware DM security and pairing adapters", async () => {
    const cfg = {
      channels: {
        qqbot: {
          enabled: true,
          appId: "qq-app-id",
          clientSecret: "qq-app-secret",
          dmPolicy: "pairing",
          allowFrom: ["user-a"],
        },
      },
    };

    const account = qqbotPlugin.config.resolveAccount(cfg, undefined);
    const dmPolicy = qqbotPlugin.security?.resolveDmPolicy?.({
      cfg,
      account,
      accountId: account.accountId,
    });

    expect(dmPolicy?.policy).toBe("pairing");
    expect(dmPolicy?.allowFrom).toEqual(["user-a"]);
    expect(qqbotPlugin.pairing?.idLabel).toBe("qqbotOpenId");
    expect(typeof qqbotPlugin.pairing?.notifyApproval).toBe("function");
  });
});
