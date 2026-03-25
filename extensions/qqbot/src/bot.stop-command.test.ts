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

import { handleQQBotDispatch, isQQBotFastAbortCommandText } from "./bot.js";

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
  dispatchReplyWithBufferedBlockDispatcher?: ReturnType<typeof vi.fn>;
}) {
  const dispatchReplyWithBufferedBlockDispatcher =
    params?.dispatchReplyWithBufferedBlockDispatcher ?? vi.fn().mockResolvedValue(undefined);

  setQQBotRuntime({
    channel: {
      routing: {
        resolveAgentRoute:
          params?.routeResolver ??
          ((input) => ({
            sessionKey: `agent:main:qqbot:direct:${String((input.peer ?? { id: "unknown" }).id).toLowerCase()}`,
            accountId: input.accountId ?? "default",
            agentId: "main",
          })),
      },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  } as import("./runtime.js").PluginRuntime);

  return {
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

const baseCfg = {
  channels: {
    qqbot: {
      enabled: true,
    },
  },
};

describe("isQQBotFastAbortCommandText", () => {
  it("recognizes localized abort triggers and punctuation variants", () => {
    expect(isQQBotFastAbortCommandText("停止")).toBe(true);
    expect(isQQBotFastAbortCommandText("/stop")).toBe(true);
    expect(isQQBotFastAbortCommandText("Stop!")).toBe(true);
    expect(isQQBotFastAbortCommandText("interrupt。")).toBe(true);
    expect(isQQBotFastAbortCommandText("  stop please  ")).toBe(true);
  });

  it("does not treat regular slash commands as fast abort", () => {
    expect(isQQBotFastAbortCommandText("/verbose on")).toBe(false);
    expect(isQQBotFastAbortCommandText("/new")).toBe(false);
    expect(isQQBotFastAbortCommandText("继续处理")).toBe(false);
  });
});

describe("QQBot fast abort queue handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "m-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "m-2", timestamp: 2 });
  });

  afterEach(() => {
    clearQQBotRuntime();
  });

  it("executes fast abort immediately and drops queued messages for the same session", async () => {
    const logger = createLogger();
    let releaseFirstDispatch: (() => void) | undefined;
    let resolveFirstEntered: (() => void) | undefined;
    let resolveStopEntered: (() => void) | undefined;
    let executedSecondMessage = false;

    const firstEntered = new Promise<void>((resolve) => {
      resolveFirstEntered = resolve;
    });
    const stopEntered = new Promise<void>((resolve) => {
      resolveStopEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
      const rawBody = typeof ctx.RawBody === "string" ? ctx.RawBody : "";
      if (rawBody === "first") {
        resolveFirstEntered?.();
        await firstRelease;
        return;
      }
      if (rawBody === "停止") {
        resolveStopEntered?.();
        return;
      }
      if (rawBody === "second") {
        executedSecondMessage = true;
      }
    });

    setupRuntime({
      routeResolver: (input) => ({
        sessionKey: "shared-session",
        accountId: input.accountId ?? "default",
        agentId: "main",
      }),
      dispatchReplyWithBufferedBlockDispatcher,
    });

    const firstDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stop-1",
        content: "first",
        timestamp: 1700000000500,
        author: {
          user_openid: "u-stop",
          username: "Stop User",
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
        id: "msg-stop-2",
        content: "second",
        timestamp: 1700000000600,
        author: {
          user_openid: "u-stop",
          username: "Stop User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const stopDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stop-3",
        content: "停止",
        timestamp: 1700000000700,
        author: {
          user_openid: "u-stop",
          username: "Stop User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await stopEntered;

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("session fast-abort command detected; executing immediately")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("session fast-abort command dropped 1 queued messages")
    );

    releaseFirstDispatch?.();

    await Promise.all([firstDispatch, secondDispatch, stopDispatch]);

    expect(executedSecondMessage).toBe(false);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
  });

  it("suppresses stale reply payloads after stop and keeps the abort acknowledgement", async () => {
    const logger = createLogger();
    let releaseFirstDispatch: (() => void) | undefined;
    let resolveFirstEntered: (() => void) | undefined;
    let resolveStopEntered: (() => void) | undefined;

    const firstEntered = new Promise<void>((resolve) => {
      resolveFirstEntered = resolve;
    });
    const stopEntered = new Promise<void>((resolve) => {
      resolveStopEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async ({
        ctx,
        dispatcherOptions,
      }: {
        ctx: Record<string, unknown>;
        dispatcherOptions: {
          deliver: (payload: unknown, info?: { kind?: string }) => Promise<void>;
        };
      }) => {
        const rawBody = typeof ctx.RawBody === "string" ? ctx.RawBody : "";
        if (rawBody === "first") {
          resolveFirstEntered?.();
          await firstRelease;
          await dispatcherOptions.deliver({ text: "stale first reply" }, { kind: "final" });
          return;
        }
        if (rawBody === "停止") {
          resolveStopEntered?.();
          await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        }
      }
    );

    setupRuntime({
      routeResolver: (input) => ({
        sessionKey: "shared-session",
        accountId: input.accountId ?? "default",
        agentId: "main",
      }),
      dispatchReplyWithBufferedBlockDispatcher,
    });

    const firstDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stop-suppress-1",
        content: "first",
        timestamp: 1700000000750,
        author: {
          user_openid: "u-stop",
          username: "Stop User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await firstEntered;

    const stopDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stop-suppress-2",
        content: "停止",
        timestamp: 1700000000760,
        author: {
          user_openid: "u-stop",
          username: "Stop User",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await stopEntered;
    releaseFirstDispatch?.();

    await Promise.all([firstDispatch, stopDispatch]);

    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "⚙️ Agent was aborted.",
      })
    );
  });

  it("limits fast abort queue dropping to the current queue key", async () => {
    const logger = createLogger();
    let releaseFirstDispatch: (() => void) | undefined;
    let resolveFirstEntered: (() => void) | undefined;
    let resolveOtherUserStopEntered: (() => void) | undefined;
    let executedQueuedMessage = false;

    const firstEntered = new Promise<void>((resolve) => {
      resolveFirstEntered = resolve;
    });
    const otherUserStopEntered = new Promise<void>((resolve) => {
      resolveOtherUserStopEntered = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx }: { ctx: Record<string, unknown> }) => {
      const rawBody = typeof ctx.RawBody === "string" ? ctx.RawBody : "";
      const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : "";
      if (rawBody === "first-u1") {
        resolveFirstEntered?.();
        await firstRelease;
        return;
      }
      if (rawBody === "停止" && senderId === "u-2") {
        resolveOtherUserStopEntered?.();
        return;
      }
      if (rawBody === "second-u1") {
        executedQueuedMessage = true;
      }
    });

    setupRuntime({
      routeResolver: (input) => ({
        sessionKey: "shared-session",
        accountId: input.accountId ?? "default",
        agentId: "main",
      }),
      dispatchReplyWithBufferedBlockDispatcher,
    });

    const firstDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-scope-1",
        content: "first-u1",
        timestamp: 1700000000800,
        author: {
          user_openid: "u-1",
          username: "User One",
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
        id: "msg-scope-2",
        content: "second-u1",
        timestamp: 1700000000900,
        author: {
          user_openid: "u-1",
          username: "User One",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const stopDispatch = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-scope-3",
        content: "停止",
        timestamp: 1700000001000,
        author: {
          user_openid: "u-2",
          username: "User Two",
        },
      },
      cfg: baseCfg,
      accountId: "default",
      logger,
    });

    await otherUserStopEntered;
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);

    releaseFirstDispatch?.();

    await Promise.all([firstDispatch, secondDispatch, stopDispatch]);

    expect(executedQueuedMessage).toBe(true);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(3);
  });
});
