import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { qqbotSetupWizard } from "./onboarding.js";

const wizard = qqbotSetupWizard as any;

function createPrompter() {
  return {
    intro: vi.fn().mockResolvedValue(undefined),
    note: vi.fn().mockResolvedValue(undefined),
    outro: vi.fn().mockResolvedValue(undefined),
    text: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    progress: vi.fn(),
  };
}

describe("qqbotSetupWizard.status", () => {
  it("returns unconfigured status when credentials are missing", () => {
    expect(wizard.status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(wizard.status.resolveStatusLines({ cfg: {}, configured: false })).toEqual([
      "QQ Bot: 需要 AppID 和 ClientSecret",
    ]);
    expect(wizard.status.unconfiguredHint).toBe("需要 AppID 和 ClientSecret");
    expect(wizard.status.unconfiguredScore).toBe(0);
  });

  it("returns configured status for the default account", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "app-1",
          clientSecret: "secret-1",
        },
      },
    };

    expect(wizard.status.resolveConfigured({ cfg })).toBe(true);
    expect(wizard.status.resolveStatusLines({ cfg, configured: true })).toEqual([
      "QQ Bot: 已配置",
    ]);
    expect(wizard.status.configuredHint).toBe("已配置");
    expect(wizard.status.configuredScore).toBe(2);
  });

  it("reports the configured account in multi-account mode", () => {
    const cfg = {
      channels: {
        qqbot: {
          defaultAccount: "bot-b",
          accounts: {
            "bot-a": {
              enabled: true,
            },
            "bot-b": {
              enabled: true,
              appId: "app-b",
              clientSecret: "secret-b",
            },
          },
        },
      },
    };

    expect(wizard.status.resolveConfigured({ cfg })).toBe(true);
    expect(wizard.status.resolveStatusLines({ cfg, configured: true })).toEqual([
      "QQ Bot: 已配置 (bot-b)",
    ]);
  });
});

describe("qqbotSetupWizard.resolveAccountIdForConfigure", () => {
  it("defaults to the configured default account", () => {
    const accountId = wizard.resolveAccountIdForConfigure({
      cfg: {
        channels: {
          qqbot: {
            defaultAccount: "bot-b",
          },
        },
      },
      prompter: createPrompter(),
      shouldPromptAccountIds: false,
      listAccountIds: () => ["bot-b"],
      defaultAccountId: "bot-b",
    });

    expect(accountId).toBe("bot-b");
  });

  it("honors an explicit account override", () => {
    const accountId = wizard.resolveAccountIdForConfigure({
      cfg: {},
      accountOverride: "sidecar",
      prompter: createPrompter(),
      shouldPromptAccountIds: false,
      listAccountIds: () => ["default"],
      defaultAccountId: "default",
    });

    expect(accountId).toBe("sidecar");
  });
});

describe("qqbotSetupWizard.finalize", () => {
  it("keeps existing credentials when the user confirms reuse", async () => {
    const prompter = createPrompter();
    prompter.confirm.mockResolvedValue(true);

    const initialCfg = {
      channels: {
        qqbot: {
          enabled: true,
          appId: "app-1",
          clientSecret: "secret-1",
          markdownSupport: false,
        },
      },
    };

    const result = await wizard.finalize({
      cfg: initialCfg,
      accountId: DEFAULT_ACCOUNT_ID,
      prompter,
    });

    expect(result).toEqual({ cfg: initialCfg });
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("writes new credentials for a non-default account", async () => {
    const prompter = createPrompter();
    prompter.text
      .mockResolvedValueOnce("new-app-id")
      .mockResolvedValueOnce("new-client-secret");

    const result = await wizard.finalize({
      cfg: {
        channels: {
          qqbot: {
            enabled: true,
            markdownSupport: false,
            accounts: {
              "bot-a": {
                enabled: true,
                appId: "app-a",
                clientSecret: "secret-a",
              },
              "bot-b": {
                enabled: true,
              },
            },
          },
        },
      },
      accountId: "bot-b",
      prompter,
    });

    expect(prompter.note).toHaveBeenCalledTimes(1);
    expect(result.cfg.channels?.qqbot?.markdownSupport).toBe(false);
    expect(result.cfg.channels?.qqbot?.accounts?.["bot-b"]).toMatchObject({
      enabled: true,
      appId: "new-app-id",
      clientSecret: "new-client-secret",
    });
  });
});

describe("qqbotSetupWizard.disable", () => {
  it("only flips qqbot.enabled to false", () => {
    const initialCfg = {
      channels: {
        qqbot: {
          enabled: true,
          appId: "app-1",
          clientSecret: "secret-1",
          markdownSupport: false,
          accounts: {
            sidecar: {
              enabled: true,
              appId: "side-app",
              clientSecret: "side-secret",
            },
          },
        },
      },
    };

    const disabled = wizard.disable(initialCfg);

    expect(disabled.channels?.qqbot).toMatchObject({
      enabled: false,
      appId: "app-1",
      clientSecret: "secret-1",
      markdownSupport: false,
      accounts: {
        sidecar: {
          enabled: true,
          appId: "side-app",
          clientSecret: "side-secret",
        },
      },
    });
  });
});
