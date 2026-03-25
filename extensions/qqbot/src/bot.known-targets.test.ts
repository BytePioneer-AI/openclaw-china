import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQQBotRuntime, setQQBotRuntime } from "./runtime.js";
import { LONG_TASK_NOTICE_TEXT, handleQQBotDispatch } from "./bot.js";

const outboundMocks = vi.hoisted(() => ({
  sendTyping: vi.fn(),
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

const proactiveMocks = vi.hoisted(() => ({
  getKnownQQBotTarget: vi.fn(),
  upsertKnownQQBotTarget: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  qqbotOutbound: {
    sendTyping: outboundMocks.sendTyping,
    sendText: outboundMocks.sendText,
    sendMedia: outboundMocks.sendMedia,
  },
}));

vi.mock("./proactive.js", () => ({
  getKnownQQBotTarget: proactiveMocks.getKnownQQBotTarget,
  upsertKnownQQBotTarget: proactiveMocks.upsertKnownQQBotTarget,
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function setupSessionRuntime(params?: {
  routeResolver?: (input: {
    cfg: unknown;
    channel: string;
    accountId?: string | null;
    peer?: { kind: string; id: string } | null;
  }) => { sessionKey: string; accountId: string; agentId?: string };
  finalizeInboundContext?: (ctx: unknown) => unknown;
  dispatchReplyWithBufferedBlockDispatcher?: ReturnType<typeof vi.fn>;
}) {
  const readSessionUpdatedAt = vi.fn().mockReturnValue(null);
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
  const recordSessionMetaFromInbound = vi.fn().mockResolvedValue(undefined);
  const dispatchReplyWithBufferedBlockDispatcher =
    params?.dispatchReplyWithBufferedBlockDispatcher ?? vi.fn().mockResolvedValue(undefined);

  setQQBotRuntime({
    channel: {
      routing: {
        resolveAgentRoute:
          params?.routeResolver ??
          ((input) => {
            const peer = input.peer ?? { kind: "direct", id: "unknown" };
            const peerKind = peer.kind === "dm" ? "direct" : peer.kind;
            return {
              sessionKey: `agent:main:qqbot:${peerKind}:${String(peer.id).toLowerCase()}`,
              accountId: input.accountId ?? "default",
              agentId: "main",
            };
          }),
      },
      reply: {
        finalizeInboundContext: params?.finalizeInboundContext ?? ((ctx: unknown) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        resolveStorePath: () => "memory://qqbot",
        readSessionUpdatedAt,
        recordSessionMetaFromInbound,
        recordInboundSession,
      },
    },
  } as import("./runtime.js").PluginRuntime);

  return {
    readSessionUpdatedAt,
    recordSessionMetaFromInbound,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

const baseCfg = {
  channels: {
    qqbot: {
      enabled: true,
      appId: "app-1",
      clientSecret: "secret-1",
    },
  },
};

function routeSessionKeyForDirect(senderId: string): string {
  return `agent:main:qqbot:direct:${senderId.toLowerCase()}`;
}

function isolatedSessionKey(params: {
  routeSessionKey: string;
  accountId: string;
  senderId: string;
}): string {
  const { routeSessionKey, accountId, senderId } = params;
  const lowerAccountId = accountId.toLowerCase();
  const lowerSenderId = senderId.toLowerCase();
  if (/^agent:[^:]+:qqbot:(?:direct|dm):.+$/i.test(routeSessionKey)) {
    return routeSessionKey.replace(/:(?:direct|dm):.+$/i, `:dm:${lowerAccountId}:${lowerSenderId}`);
  }
  return `${routeSessionKey}:dm:${lowerAccountId}:${lowerSenderId}`;
}

describe("QQBot inbound known-target recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "m-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "m-2", timestamp: 2 });
    proactiveMocks.getKnownQQBotTarget.mockReturnValue(undefined);
    setQQBotRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "session-1",
            accountId: "default",
            agentId: "main",
          }),
        },
        reply: {},
      },
    } as import("./runtime.js").PluginRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearQQBotRuntime();
  });

  it("records canonical user targets for allowed C2C messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-1",
        content: "hello",
        timestamp: 1700000000000,
        author: {
          user_openid: "u-123",
          username: "Alice",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "user",
        target: "user:u-123",
        sourceChatType: "direct",
        firstSeenAt: 1700000000000,
        lastSeenAt: 1700000000000,
      },
    });
  });

  it("prefers known-target displayName over displayAliases for direct messages", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime();
    proactiveMocks.getKnownQQBotTarget.mockReturnValue({
      accountId: "default",
      kind: "user",
      target: "user:u-alias-1",
      displayName: "Manual Note",
      sourceChatType: "direct",
      firstSeenAt: 100,
      lastSeenAt: 200,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-alias-1",
        content: "hello alias",
        timestamp: 1700000000001,
        author: {
          user_openid: "u-alias-1",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            displayAliases: {
              "user:u-alias-1": "Global Alias",
            },
            accounts: {
              default: {
                displayAliases: {
                  "user:u-alias-1": "Account Alias",
                },
              },
            },
          },
        },
      },
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: expect.objectContaining({
        target: "user:u-alias-1",
        displayName: "Manual Note",
      }),
    });
    expect(sessionRuntime.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SenderName: "Manual Note",
        }),
      })
    );
    expect(sessionRuntime.recordSessionMetaFromInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.any(String),
        ctx: expect.objectContaining({
          SenderName: "Manual Note",
        }),
        createIfMissing: true,
      })
    );
  });

  it("uses account displayAliases when known-target displayName is missing", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-priority-1",
        content: "hello priority",
        timestamp: 1700000000002,
        author: {
          user_openid: "u-priority-1",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            displayAliases: {
              "user:u-priority-1": "Global Alias",
            },
            accounts: {
              default: {
                displayAliases: {
                  "user:u-priority-1": "Account Alias",
                },
              },
            },
          },
        },
      },
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: expect.objectContaining({
        target: "user:u-priority-1",
        displayName: "Account Alias",
      }),
    });
    expect(sessionRuntime.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SenderName: "Account Alias",
        }),
      })
    );
  });

  it("uses known-target displayName as the formal manual note source", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime();
    proactiveMocks.getKnownQQBotTarget.mockReturnValue({
      accountId: "default",
      kind: "user",
      target: "user:u-history-1",
      displayName: "Saved User",
      sourceChatType: "direct",
      firstSeenAt: 100,
      lastSeenAt: 200,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-history-1",
        content: "hello history",
        timestamp: 1700000000003,
        author: {
          user_openid: "u-history-1",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.getKnownQQBotTarget).toHaveBeenCalledWith({
      accountId: "default",
      target: "user:u-history-1",
    });
    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: expect.objectContaining({
        target: "user:u-history-1",
        displayName: "Saved User",
      }),
    });
    expect(sessionRuntime.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SenderName: "Saved User",
        }),
      })
    );
  });

  it("records canonical group targets for allowed group messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "GROUP_AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-2",
        content: "hello group",
        timestamp: 1700000000100,
        group_openid: "g-456",
        author: {
          member_openid: "member-1",
          nickname: "Team Owner",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "group",
        target: "group:g-456",
        sourceChatType: "group",
        firstSeenAt: 1700000000100,
        lastSeenAt: 1700000000100,
      },
    });
  });

  it("records canonical channel targets for allowed channel messages", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-3",
        content: "hello channel",
        timestamp: 1700000000200,
        channel_id: "channel-789",
        guild_id: "guild-1",
        author: {
          id: "author-1",
          username: "Channel Owner",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).toHaveBeenCalledWith({
      target: {
        accountId: "default",
        kind: "channel",
        target: "channel:channel-789",
        sourceChatType: "channel",
        firstSeenAt: 1700000000200,
        lastSeenAt: 1700000000200,
      },
    });
  });

  it("does not record targets when the inbound message is blocked by policy", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-4",
        content: "blocked",
        timestamp: 1700000000300,
        author: {
          user_openid: "u-blocked",
          username: "Blocked User",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            dmPolicy: "allowlist",
            allowFrom: ["u-allowed"],
          },
        },
      },
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).not.toHaveBeenCalled();
  });

  it("does not record DIRECT_MESSAGE_CREATE events into known targets", async () => {
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "DIRECT_MESSAGE_CREATE",
      eventData: {
        id: "msg-5",
        content: "dm hello",
        timestamp: 1700000000400,
        guild_id: "guild-2",
        author: {
          id: "dm-user-1",
          username: "DM User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(proactiveMocks.upsertKnownQQBotTarget).not.toHaveBeenCalled();
  });

  it("serializes concurrent dispatches for the same resolved session", async () => {
    const logger = createLogger();
    let activeDispatches = 0;
    let maxActiveDispatches = 0;
    let resolveFirstEntered: (() => void) | undefined;
    let releaseFirstDispatch: (() => void) | undefined;

    const firstEntered = new Promise<void>((resolve) => {
      resolveFirstEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {
      activeDispatches += 1;
      maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);

      if (dispatchReplyWithBufferedBlockDispatcher.mock.calls.length === 1) {
        resolveFirstEntered?.();
        await firstRelease;
      }

      activeDispatches -= 1;
    });

    setQQBotRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "shared-session",
            accountId: "default",
            agentId: "main",
          }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    });

    const firstDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-serial-1",
        content: "first",
        timestamp: 1700000000500,
        author: {
          user_openid: "u-serial",
          username: "Serial User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await firstEntered;

    const secondDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-serial-2",
        content: "second",
        timestamp: 1700000000600,
        author: {
          user_openid: "u-serial",
          username: "Serial User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `session busy; queueing inbound dispatch sessionKey=${isolatedSessionKey({
          routeSessionKey: "shared-session",
          accountId: "default",
          senderId: "u-serial",
        })}`
      )
    );

    releaseFirstDispatch?.();

    await Promise.all([firstDispatch, secondDispatch]);

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(maxActiveDispatches).toBe(1);
  });
});

describe("QQBot direct session isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "m-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "m-2", timestamp: 2 });
  });

  afterEach(() => {
    clearQQBotRuntime();
  });

  it("uses per-user direct session keys for different C2C users", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime();
    const routeSessionKeyOne = routeSessionKeyForDirect("u-100");
    const routeSessionKeyTwo = routeSessionKeyForDirect("u-200");
    const isolatedSessionKeyOne = isolatedSessionKey({
      routeSessionKey: routeSessionKeyOne,
      accountId: "default",
      senderId: "u-100",
    });
    const isolatedSessionKeyTwo = isolatedSessionKey({
      routeSessionKey: routeSessionKeyTwo,
      accountId: "default",
      senderId: "u-200",
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-user-1",
        content: "hello one",
        timestamp: 1700000001000,
        author: {
          user_openid: "u-100",
          username: "User One",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-user-2",
        content: "hello two",
        timestamp: 1700000002000,
        author: {
          user_openid: "u-200",
          username: "User Two",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(sessionRuntime.readSessionUpdatedAt).toHaveBeenNthCalledWith(1, {
      storePath: "memory://qqbot",
      sessionKey: isolatedSessionKeyOne,
    });
    expect(sessionRuntime.readSessionUpdatedAt).toHaveBeenNthCalledWith(2, {
      storePath: "memory://qqbot",
      sessionKey: isolatedSessionKeyTwo,
    });
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: isolatedSessionKeyOne,
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKeyOne,
        }),
      })
    );
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: isolatedSessionKeyTwo,
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKeyTwo,
        }),
      })
    );
    expect(
      sessionRuntime.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx?.SessionKey
    ).toBe(isolatedSessionKeyOne);
    expect(
      sessionRuntime.dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0]?.ctx?.SessionKey
    ).toBe(isolatedSessionKeyTwo);
  });

  it("keeps a stable direct session key for repeated messages from the same user", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime();
    const routeSessionKey = routeSessionKeyForDirect("u-stable");
    const stableSessionKey = isolatedSessionKey({
      routeSessionKey,
      accountId: "default",
      senderId: "u-stable",
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stable-1",
        content: "first",
        timestamp: 1700000003000,
        author: {
          user_openid: "u-stable",
          username: "Stable User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stable-2",
        content: "second",
        timestamp: 1700000004000,
        author: {
          user_openid: "u-stable",
          username: "Stable User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(sessionRuntime.readSessionUpdatedAt).toHaveBeenCalledTimes(2);
    expect(sessionRuntime.readSessionUpdatedAt).toHaveBeenNthCalledWith(1, {
      storePath: "memory://qqbot",
      sessionKey: stableSessionKey,
    });
    expect(sessionRuntime.readSessionUpdatedAt).toHaveBeenNthCalledWith(2, {
      storePath: "memory://qqbot",
      sessionKey: stableSessionKey,
    });
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: stableSessionKey,
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKey,
        }),
      })
    );
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: stableSessionKey,
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKey,
        }),
      })
    );
  });

  it("uses the routed qqbot account for direct typing and reply delivery", async () => {
    const logger = createLogger();
    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "reply from bot2" }, { kind: "final" });
      }),
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-bot2-account",
        event_id: "evt-bot2-account",
        content: "hello bot2",
        timestamp: 1700000004500,
        author: {
          user_openid: "u-bot2",
          username: "Bot Two User",
        },
      },
      cfg: baseCfg,
      accountId: "bot2",
      logger,
    });

    expect(outboundMocks.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u-bot2",
        accountId: "bot2",
      })
    );
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u-bot2",
        text: "reply from bot2",
        accountId: "bot2",
      })
    );
  });

  it("resumes direct typing during idle gaps between visible replies", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const multiAccountCfg = {
      channels: {
        qqbot: {
          ...baseCfg.channels.qqbot,
          accounts: {
            bot2: {
              enabled: true,
              appId: "app-2",
              clientSecret: "secret-2",
            },
          },
        },
      },
    };

    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await dispatcherOptions.deliver({ text: "reply chunk 1" }, { kind: "block" });
        await new Promise((resolve) => setTimeout(resolve, 10000));
        await dispatcherOptions.deliver({ text: "reply chunk 2" }, { kind: "final" });
      }),
    });

    const dispatchPromise = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-bot2-heartbeat",
        event_id: "evt-bot2-heartbeat",
        content: "hello delayed bot2",
        timestamp: 1700000004550,
        author: {
          user_openid: "u-bot2-heartbeat",
          username: "Bot Two Heartbeat User",
        },
      },
      cfg: multiAccountCfg,
      accountId: "bot2",
      logger,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(11000);

    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(2);
    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    for (const call of outboundMocks.sendTyping.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          to: "user:u-bot2-heartbeat",
          accountId: "bot2",
        })
      );
    }

    await vi.advanceTimersByTimeAsync(1000);
    await dispatchPromise;

    expect(outboundMocks.sendText).toHaveBeenCalledTimes(2);
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "user:u-bot2-heartbeat",
        text: "reply chunk 1",
        accountId: "bot2",
      })
    );
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "user:u-bot2-heartbeat",
        text: "reply chunk 2",
        accountId: "bot2",
      })
    );
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    ).toBeGreaterThan(outboundMocks.sendText.mock.invocationCallOrder[0] ?? 0);
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    ).toBeLessThan(outboundMocks.sendText.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY);

    await vi.advanceTimersByTimeAsync(10000);
    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(2);
  });

  it("keeps renewing direct typing on a fixed interval when mode is always", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const multiAccountCfg = {
      channels: {
        qqbot: {
          ...baseCfg.channels.qqbot,
          typingHeartbeatMode: "always" as const,
          typingHeartbeatIntervalMs: 3000,
          accounts: {
            bot2: {
              enabled: true,
              appId: "app-2",
              clientSecret: "secret-2",
            },
          },
        },
      },
    };

    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await dispatcherOptions.deliver({ text: "reply chunk 1" }, { kind: "block" });
        await new Promise((resolve) => setTimeout(resolve, 6000));
        await dispatcherOptions.deliver({ text: "reply chunk 2" }, { kind: "final" });
      }),
    });

    const dispatchPromise = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-bot2-heartbeat-always",
        event_id: "evt-bot2-heartbeat-always",
        content: "hello fixed interval bot2",
        timestamp: 1700000004575,
        author: {
          user_openid: "u-bot2-heartbeat-always",
          username: "Bot Two Always User",
        },
      },
      cfg: multiAccountCfg,
      accountId: "bot2",
      logger,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6000);

    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(3);
    for (const call of outboundMocks.sendTyping.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          to: "user:u-bot2-heartbeat-always",
          accountId: "bot2",
        })
      );
    }
    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "user:u-bot2-heartbeat-always",
        text: "reply chunk 1",
        accountId: "bot2",
      })
    );
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    ).toBeGreaterThan(outboundMocks.sendText.mock.invocationCallOrder[0] ?? 0);
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY
    ).toBeGreaterThan(outboundMocks.sendTyping.mock.invocationCallOrder[1] ?? 0);

    await vi.advanceTimersByTimeAsync(1000);
    await dispatchPromise;

    expect(outboundMocks.sendText).toHaveBeenCalledTimes(2);
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "user:u-bot2-heartbeat-always",
        text: "reply chunk 2",
        accountId: "bot2",
      })
    );

    await vi.advanceTimersByTimeAsync(10000);
    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(3);
  });

  it("disables typing renewals when mode is none", async () => {
    vi.useFakeTimers();
    const logger = createLogger();

    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
        await new Promise((resolve) => setTimeout(resolve, 11000));
        await dispatcherOptions.deliver({ text: "final only reply" }, { kind: "final" });
      }),
    });

    const dispatchPromise = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-no-heartbeat",
        event_id: "evt-no-heartbeat",
        content: "hello no heartbeat",
        timestamp: 1700000004585,
        author: {
          user_openid: "u-no-heartbeat",
          username: "No Heartbeat User",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            typingHeartbeatMode: "none" as const,
          },
        },
      },
      accountId: "default",
      logger,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(11000);
    await dispatchPromise;

    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u-no-heartbeat",
        accountId: "default",
      })
    );
    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u-no-heartbeat",
        text: "final only reply",
        accountId: "default",
      })
    );

    await vi.advanceTimersByTimeAsync(10000);
    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(1);
  });

  it("keeps typing heartbeat alive after long-task notice when the task is still running", async () => {
    vi.useFakeTimers();
    const logger = createLogger();

    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 22000));
      }),
    });

    const dispatchPromise = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-long-task-heartbeat",
        event_id: "evt-long-task-heartbeat",
        content: "hello slow task",
        timestamp: 1700000004600,
        author: {
          user_openid: "u-long-task",
          username: "Slow User",
        },
      },
      cfg: {
        channels: {
          qqbot: {
            ...baseCfg.channels.qqbot,
            longTaskNoticeDelayMs: 12000,
          },
        },
      },
      accountId: "default",
      logger,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(11000);

    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(3);
    expect(outboundMocks.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u-long-task",
        text: LONG_TASK_NOTICE_TEXT,
        accountId: "default",
      })
    );
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY
    ).toBeLessThan(outboundMocks.sendText.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

    await vi.advanceTimersByTimeAsync(8000);
    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(4);
    expect(
      outboundMocks.sendTyping.mock.invocationCallOrder[3] ?? 0
    ).toBeGreaterThan(outboundMocks.sendText.mock.invocationCallOrder[0] ?? 0);
    await vi.advanceTimersByTimeAsync(2000);
    await dispatchPromise;
    await vi.advanceTimersByTimeAsync(10000);
    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(4);
  });

  it("isolates the same direct sender across different qqbot accounts", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime({
      routeResolver: (input) => ({
        sessionKey: "shared-direct-session",
        accountId: input.accountId ?? "default",
        agentId: "main",
      }),
    });
    const multiAccountCfg = {
      channels: {
        qqbot: {
          ...baseCfg.channels.qqbot,
          accounts: {
            bot2: {
              enabled: true,
              appId: "app-2",
              clientSecret: "secret-2",
            },
          },
        },
      },
    };

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-account-1",
        content: "hello default",
        timestamp: 1700000005000,
        author: {
          user_openid: "u-same",
          username: "Same User",
        },
      },
      cfg: multiAccountCfg,
      accountId: "default",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-account-2",
        content: "hello bot2",
        timestamp: 1700000006000,
        author: {
          user_openid: "u-same",
          username: "Same User",
        },
      },
      cfg: multiAccountCfg,
      accountId: "bot2",
      logger,
    });

    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: isolatedSessionKey({
          routeSessionKey: "shared-direct-session",
          accountId: "default",
          senderId: "u-same",
        }),
        updateLastRoute: expect.objectContaining({
          sessionKey: "shared-direct-session",
        }),
      })
    );
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: isolatedSessionKey({
          routeSessionKey: "shared-direct-session",
          accountId: "bot2",
          senderId: "u-same",
        }),
        updateLastRoute: expect.objectContaining({
          sessionKey: "shared-direct-session",
        }),
      })
    );
  });

  it("keeps group and channel session keys from routing", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime({
      routeResolver: (input) => {
        const peerId = input.peer?.id ?? "";
        if (peerId.startsWith("group:")) {
          return { sessionKey: "route-group-session", accountId: input.accountId ?? "default", agentId: "main" };
        }
        if (peerId.startsWith("channel:")) {
          return { sessionKey: "route-channel-session", accountId: input.accountId ?? "default", agentId: "main" };
        }
        return { sessionKey: "route-direct-session", accountId: input.accountId ?? "default", agentId: "main" };
      },
    });

    await handleQQBotDispatch({
      eventType: "GROUP_AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-group-session",
        content: "hello group",
        timestamp: 1700000007000,
        group_openid: "g-route",
        author: {
          member_openid: "member-route",
          nickname: "Route Group User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-channel-session",
        content: "hello channel",
        timestamp: 1700000008000,
        channel_id: "channel-route",
        guild_id: "guild-route",
        author: {
          id: "channel-user",
          username: "Route Channel User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: "route-group-session",
      })
    );
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "route-channel-session",
      })
    );
  });

  it("allows concurrent direct dispatches for different users even when routing returns the same session", async () => {
    const logger = createLogger();
    let activeDispatches = 0;
    let maxActiveDispatches = 0;
    let enteredDispatches = 0;
    let resolveBothEntered: (() => void) | undefined;
    let releaseDispatches: (() => void) | undefined;

    const bothEntered = new Promise<void>((resolve) => {
      resolveBothEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDispatches = resolve;
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {
      activeDispatches += 1;
      enteredDispatches += 1;
      maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);

      if (enteredDispatches === 2) {
        resolveBothEntered?.();
      }

      await release;
      activeDispatches -= 1;
    });

    setupSessionRuntime({
      dispatchReplyWithBufferedBlockDispatcher,
    });

    const firstDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-parallel-1",
        content: "hello first user",
        timestamp: 1700000009000,
        author: {
          user_openid: "u-parallel-1",
          username: "Parallel User One",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    const secondDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-parallel-2",
        content: "hello second user",
        timestamp: 1700000010000,
        author: {
          user_openid: "u-parallel-2",
          username: "Parallel User Two",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await bothEntered;

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(activeDispatches).toBe(2);

    releaseDispatches?.();

    await Promise.all([firstDispatch, secondDispatch]);

    expect(maxActiveDispatches).toBe(2);
  });

  it("keeps canonical reply targets after finalization for direct sessions", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime({
      finalizeInboundContext: (ctx) => ({
        ...(ctx as Record<string, unknown>),
        To: "c2c:u-finalized",
        OriginatingTo: "qqbot:dm:default:u-finalized",
      }),
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-finalized-direct",
        content: "hello direct",
        timestamp: 1700000011000,
        author: {
          user_openid: "u-finalized",
          username: "Finalized User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    const dispatchCtx =
      sessionRuntime.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx ?? {};
    expect(dispatchCtx.To).toBe("user:u-finalized");
    expect(dispatchCtx.OriginatingTo).toBe("user:u-finalized");
    expect(sessionRuntime.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        updateLastRoute: expect.objectContaining({
          to: "user:u-finalized",
        }),
      })
    );
  });

  it("keeps canonical group reply targets after finalization", async () => {
    const logger = createLogger();
    const sessionRuntime = setupSessionRuntime({
      finalizeInboundContext: (ctx) => ({
        ...(ctx as Record<string, unknown>),
        To: "",
        OriginatingTo: "",
      }),
    });

    await handleQQBotDispatch({
      eventType: "GROUP_AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-finalized-group",
        content: "hello group",
        timestamp: 1700000012000,
        group_openid: "g-finalized",
        author: {
          member_openid: "member-finalized",
          nickname: "Finalized Group User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    const dispatchCtx =
      sessionRuntime.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0]?.ctx ?? {};
    expect(dispatchCtx.To).toBe("group:g-finalized");
    expect(dispatchCtx.OriginatingTo).toBe("group:g-finalized");
  });
});
