import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  monitorQQBotProvider: vi.fn().mockResolvedValue(undefined),
  stopQQBotMonitorForAccount: vi.fn(),
  setQQBotRuntime: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  monitorQQBotProvider: mocks.monitorQQBotProvider,
  stopQQBotMonitorForAccount: mocks.stopQQBotMonitorForAccount,
}));

vi.mock("./runtime.js", () => ({
  setQQBotRuntime: mocks.setQQBotRuntime,
}));

import { qqbotPlugin } from "./channel.js";

describe("qqbotPlugin capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares direct, group, and channel chat types", () => {
    expect(qqbotPlugin.capabilities.chatTypes).toEqual(["direct", "group", "channel"]);
  });

  it("advertises shared message send support when configured", () => {
    const discovery = qqbotPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: {
          qqbot: {
            appId: "app-1",
            clientSecret: "secret-1",
          },
        },
      },
    } as never);

    expect(discovery).toEqual({
      actions: ["send"],
      capabilities: [],
    });
  });

  it("accepts runtimes that only expose the direct reply dispatcher", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(),
        },
        reply: {
          dispatchReplyWithDispatcher: vi.fn(),
        },
      },
    };

    await qqbotPlugin.gateway!.startAccount!({
      cfg: {
        channels: {
          qqbot: {
            appId: "app-1",
            clientSecret: "secret-1",
          },
        },
      },
      runtime,
      accountId: "default",
      setStatus: vi.fn(),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as never);

    expect(mocks.setQQBotRuntime).toHaveBeenCalledWith(runtime);
    expect(mocks.monitorQQBotProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          channels: {
            qqbot: {
              appId: "app-1",
              clientSecret: "secret-1",
            },
          },
        },
        runtime,
        accountId: "default",
      })
    );
  });
});
