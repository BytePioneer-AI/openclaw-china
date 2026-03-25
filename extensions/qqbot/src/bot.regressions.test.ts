import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQQBotRuntime, setQQBotRuntime } from "./runtime.js";

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

import { handleQQBotDispatch, resolveQQBotTextReplyRefs } from "./bot.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function setupRuntime(params?: {
  routeResolver?: (input: {
    cfg: unknown;
    channel: string;
    accountId?: string | null;
    peer?: { kind: string; id: string } | null;
  }) => { sessionKey: string; accountId: string; agentId?: string };
  dispatchReplyWithDispatcher?: ReturnType<typeof vi.fn>;
  dispatchReplyWithBufferedBlockDispatcher?: ReturnType<typeof vi.fn>;
}) {
  const readSessionUpdatedAt = vi.fn().mockReturnValue(null);
  const recordInboundSession = vi.fn().mockResolvedValue(undefined);
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
        finalizeInboundContext: (ctx: unknown) => ctx,
        ...(params?.dispatchReplyWithDispatcher
          ? {
              dispatchReplyWithDispatcher: params.dispatchReplyWithDispatcher,
            }
          : {}),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        resolveStorePath: () => "memory://qqbot",
        readSessionUpdatedAt,
        recordInboundSession,
      },
    },
  } as import("./runtime.js").PluginRuntime);

  return {
    readSessionUpdatedAt,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

const baseCfg = {
  channels: {
    qqbot: {
      enabled: true,
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "passive" as const,
      accounts: {
        dragon: {
          appId: "dragon-app",
          clientSecret: "dragon-secret",
        },
        snake: {
          appId: "snake-app",
          clientSecret: "snake-secret",
        },
      },
    },
  },
};

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

describe("QQBot reported regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "m-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "m-2", timestamp: 2 });
  });

  afterEach(() => {
    clearQQBotRuntime();
  });

  it("keeps routed accountIds for direct replies across multiple qqbot accounts", async () => {
    setupRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ ctx, dispatcherOptions }) => {
        const ctxRecord = ctx as Record<string, unknown>;
        const rawBody = typeof ctxRecord.RawBody === "string" ? ctxRecord.RawBody : "";
        const accountId = typeof ctxRecord.AccountId === "string" ? ctxRecord.AccountId : "unknown";
        const text =
          rawBody === "/verbose on" ? "⚙️ Verbose logging enabled." : `reply from ${accountId}`;
        await dispatcherOptions.deliver({ text }, { kind: "final" });
      }),
    });
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-dragon-1",
        event_id: "evt-dragon-1",
        content: "你怎么知道",
        timestamp: 1700000100000,
        author: {
          user_openid: "U-DRAGON",
          username: "Dragon User",
        },
      },
      cfg: baseCfg,
      accountId: "dragon",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-snake-1",
        event_id: "evt-snake-1",
        content: "/verbose on",
        timestamp: 1700000101000,
        author: {
          user_openid: "U-SNAKE",
          username: "Snake User",
        },
      },
      cfg: baseCfg,
      accountId: "snake",
      logger,
    });

    expect(outboundMocks.sendTyping).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "user:U-DRAGON",
        accountId: "dragon",
      })
    );
    expect(outboundMocks.sendTyping).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "user:U-SNAKE",
        accountId: "snake",
      })
    );
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "user:U-DRAGON",
        text: "reply from dragon",
        accountId: "dragon",
      })
    );
    expect(outboundMocks.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "user:U-SNAKE",
        text: "⚙️ Verbose logging enabled.",
        accountId: "snake",
      })
    );
  });

  it("prefers the direct c2c dispatcher so assistant notes stay interleaved with tool logs", async () => {
    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "先说明一下当前步骤。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "exec: listing files" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "我再继续检查配置。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "exec: reading monitor.ts" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "检查完了。" }, { kind: "final" });
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "exec: listing files" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "exec: reading monitor.ts" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "先说明一下当前步骤。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "我再继续检查配置。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "检查完了。" }, { kind: "final" });
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
      dispatchReplyWithBufferedBlockDispatcher,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-interleave-1",
        event_id: "evt-interleave-1",
        content: "show progress",
        timestamp: 1700000100500,
        author: {
          user_openid: "U-INTERLEAVE",
          username: "Interleave User",
        },
      },
      cfg: baseCfg,
      accountId: "dragon",
      logger,
    });

    expect(dispatchReplyWithDispatcher).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(dispatchReplyWithDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: {
          disableBlockStreaming: false,
        },
      })
    );
    expect(outboundMocks.sendText.mock.calls.map((call) => call[0]?.text)).toEqual([
      "先说明一下当前步骤。",
      "exec: listing files",
      "我再继续检查配置。",
      "exec: reading monitor.ts",
      "检查完了。",
    ]);
  });

  it("keeps isolated direct sessions linked back to the main route for history across accounts", async () => {
    const routeSessionKey = "agent:main:qqbot:direct:user:shared";
    const sessionRuntime = setupRuntime({
      routeResolver: (input) => ({
        sessionKey: routeSessionKey,
        accountId: input.accountId ?? "default",
        agentId: "main",
      }),
    });
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-history-dragon",
        content: "history one",
        timestamp: 1700000102000,
        author: {
          user_openid: "U-HISTORY",
          username: "History User",
        },
      },
      cfg: baseCfg,
      accountId: "dragon",
      logger,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-history-snake",
        content: "history two",
        timestamp: 1700000103000,
        author: {
          user_openid: "U-HISTORY",
          username: "History User",
        },
      },
      cfg: baseCfg,
      accountId: "snake",
      logger,
    });

    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: isolatedSessionKey({
          routeSessionKey,
          accountId: "dragon",
          senderId: "U-HISTORY",
        }),
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKey,
          accountId: "dragon",
        }),
      })
    );
    expect(sessionRuntime.recordInboundSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: isolatedSessionKey({
          routeSessionKey,
          accountId: "snake",
          senderId: "U-HISTORY",
        }),
        updateLastRoute: expect.objectContaining({
          sessionKey: routeSessionKey,
          accountId: "snake",
        }),
      })
    );
  });

  it("does not treat mixed-case group targets as c2c markdown deliveries", () => {
    expect(
      resolveQQBotTextReplyRefs({
        to: "QQBOT:GROUP:g-upcase-1",
        text: "| col1 | col2 |\n| --- | --- |\n| a | b |",
        markdownSupport: true,
        c2cMarkdownDeliveryMode: "proactive-table-only",
        replyToId: "msg-upcase-1",
        replyEventId: "evt-upcase-1",
      })
    ).toEqual({
      forceProactive: false,
      replyToId: "msg-upcase-1",
      replyEventId: "evt-upcase-1",
    });
  });

  it("sends visible group mention replies through the routed account", async () => {
    setupRuntime({
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "group reply ok" }, { kind: "final" });
      }),
    });
    const logger = createLogger();

    await handleQQBotDispatch({
      eventType: "GROUP_AT_MESSAGE_CREATE",
      eventData: {
        id: "msg-group-dragon",
        content: "机器人在吗",
        timestamp: 1700000104000,
        group_openid: "G-DRAGON",
        author: {
          member_openid: "member-1",
          nickname: "Dragon Group User",
        },
      },
      cfg: baseCfg,
      accountId: "dragon",
      logger,
    });

    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "group:G-DRAGON",
        text: "group reply ok",
        replyToId: "msg-group-dragon",
        accountId: "dragon",
      })
    );
  });
});
