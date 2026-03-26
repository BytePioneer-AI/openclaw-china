import { describe, expect, it } from "vitest";
import { dingtalkPlugin } from "./channel.js";
import type { PluginConfig } from "./config.js";

function asConfig(value: PluginConfig): PluginConfig {
  return value;
}

describe("dingtalk multi-account setup", () => {
  it("migrates legacy root credentials into accounts.default before adding a named account", () => {
    const next = dingtalkPlugin.setup.applyAccountConfig({
      cfg: asConfig({
        channels: {
          dingtalk: {
            enabled: true,
            clientId: "default-id",
            clientSecret: "default-secret",
            enableAICard: false,
          },
        },
      }),
      accountId: "work",
      config: {
        clientId: "work-id",
        clientSecret: "work-secret",
      },
    }) as PluginConfig;

    expect(next.channels?.dingtalk).toEqual({
      enabled: true,
      accounts: {
        default: {
          clientId: "default-id",
          clientSecret: "default-secret",
          enableAICard: false,
        },
        work: {
          enabled: true,
          clientId: "work-id",
          clientSecret: "work-secret",
        },
      },
    });
  });

  it("applies omitted setup updates to the resolved default account", () => {
    const next = dingtalkPlugin.setup.applyAccountConfig({
      cfg: asConfig({
        channels: {
          dingtalk: {
            defaultAccount: "main",
            accounts: {
              main: {
                clientId: "main-id",
                clientSecret: "main-secret",
              },
            },
          },
        },
      }),
      config: {
        name: "Main Bot",
      },
    }) as PluginConfig;

    expect(next.channels?.dingtalk).toMatchObject({
      defaultAccount: "main",
      enabled: true,
      accounts: {
        main: {
          enabled: true,
          clientId: "main-id",
          clientSecret: "main-secret",
          name: "Main Bot",
        },
      },
    });
  });

  it("accepts the new setup input bag without changing existing patch semantics", () => {
    const next = dingtalkPlugin.setup.applyAccountConfig({
      cfg: asConfig({
        channels: {
          dingtalk: {},
        },
      }),
      accountId: "ops",
      input: {
        clientId: "ops-id",
        clientSecret: "ops-secret",
        connectionMode: "webhook",
      },
    }) as PluginConfig;

    expect(next.channels?.dingtalk).toEqual({
      enabled: true,
      accounts: {
        ops: {
          enabled: true,
          clientId: "ops-id",
          clientSecret: "ops-secret",
          connectionMode: "webhook",
        },
      },
    });
  });
});

describe("dingtalk multi-account deletion", () => {
  it("deletes the resolved default account without dropping sibling accounts", () => {
    const next = dingtalkPlugin.config.deleteAccount({
      cfg: asConfig({
        channels: {
          dingtalk: {
            defaultAccount: "main",
            accounts: {
              main: {
                clientId: "main-id",
                clientSecret: "main-secret",
              },
              work: {
                clientId: "work-id",
                clientSecret: "work-secret",
              },
            },
          },
        },
      }),
    }) as PluginConfig;

    expect(next.channels?.dingtalk).toEqual({
      defaultAccount: "work",
      accounts: {
        work: {
          clientId: "work-id",
          clientSecret: "work-secret",
        },
      },
    });
  });

  it("removes only accounts.default when deleting a promoted default account", () => {
    const next = dingtalkPlugin.config.deleteAccount({
      cfg: asConfig({
        channels: {
          dingtalk: {
            enabled: true,
            accounts: {
              default: {
                clientId: "default-id",
                clientSecret: "default-secret",
              },
              work: {
                clientId: "work-id",
                clientSecret: "work-secret",
              },
            },
          },
        },
      }),
      accountId: "default",
    }) as PluginConfig;

    expect(next.channels?.dingtalk).toEqual({
      enabled: true,
      accounts: {
        work: {
          clientId: "work-id",
          clientSecret: "work-secret",
        },
      },
    });
  });
});
