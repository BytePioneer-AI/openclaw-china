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

const clientMocks = vi.hoisted(() => {
  let seq = 1000;
  return {
    getAccessToken: vi.fn(),
    sendC2CStreamMessage: vi.fn(),
    allocateMsgSeq: vi.fn(() => {
      seq += 1;
      return seq;
    }),
  };
});

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

vi.mock("./client.js", () => ({
  getAccessToken: clientMocks.getAccessToken,
  sendC2CStreamMessage: clientMocks.sendC2CStreamMessage,
  allocateMsgSeq: clientMocks.allocateMsgSeq,
  QQBotStreamInputMode: {
    REPLACE: "replace",
  },
  QQBotStreamInputState: {
    GENERATING: 1,
    DONE: 10,
  },
  QQBotStreamContentType: {
    MARKDOWN: "markdown",
  },
}));

import { handleQQBotDispatch } from "./bot.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createBaseCfg(overrides?: Record<string, unknown>) {
  return {
    channels: {
      qqbot: {
        enabled: true,
        appId: "app-1",
        clientSecret: "secret-1",
        markdownSupport: true,
        streaming: true,
        ...overrides,
      },
    },
  };
}

function setupRuntime(params: {
  dispatchReplyWithDispatcher?: ReturnType<typeof vi.fn>;
  dispatchReplyWithBufferedBlockDispatcher?: ReturnType<typeof vi.fn>;
}) {
  const dispatchReplyWithBufferedBlockDispatcher =
    params.dispatchReplyWithBufferedBlockDispatcher ?? vi.fn().mockResolvedValue(undefined);

  setQQBotRuntime({
    channel: {
      routing: {
        resolveAgentRoute: (input) => ({
          sessionKey: `agent:main:qqbot:${input.peer.kind}:${String(input.peer.id).toLowerCase()}`,
          accountId: input.accountId ?? "default",
          agentId: "main",
        }),
      },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        ...(params.dispatchReplyWithDispatcher
          ? {
              dispatchReplyWithDispatcher: params.dispatchReplyWithDispatcher,
            }
          : {}),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      session: {
        resolveStorePath: () => "memory://qqbot",
        readSessionUpdatedAt: () => null,
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
    },
  });

  return {
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

describe("QQBot streaming replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    outboundMocks.sendTyping.mockResolvedValue({ channel: "qqbot", refIdx: "REFIDX-typing-1" });
    outboundMocks.sendText.mockResolvedValue({ channel: "qqbot", messageId: "text-1", timestamp: 1 });
    outboundMocks.sendMedia.mockResolvedValue({ channel: "qqbot", messageId: "media-1", timestamp: 2 });
    clientMocks.getAccessToken.mockResolvedValue("token-1");
    clientMocks.sendC2CStreamMessage.mockResolvedValue({
      id: "stream-session-1",
      timestamp: 1,
    });
  });

  afterEach(() => {
    clearQQBotRuntime();
    vi.useRealTimers();
  });

  it("streams assistant partials while keeping tool messages visible", async () => {
    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions.onPartialReply?.({ text: "先说明一下当前步骤。" });
      await dispatcherOptions.deliver({ text: "exec: listing files" }, { kind: "tool" });
      await replyOptions.onPartialReply?.({ text: "先说明一下当前步骤。\n我再继续检查配置。" });
      await dispatcherOptions.deliver(
        { text: "先说明一下当前步骤。\n我再继续检查配置。" },
        { kind: "final" }
      );
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stream-1",
        event_id: "evt-stream-1",
        content: "show progress",
        timestamp: 1700000200000,
        author: {
          user_openid: "U-STREAM-1",
          username: "Stream User",
        },
      },
      cfg: createBaseCfg(),
      accountId: "default",
      logger,
    });

    expect(dispatchReplyWithDispatcher).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:U-STREAM-1",
        text: "exec: listing files",
      })
    );
    expect(clientMocks.sendC2CStreamMessage).toHaveBeenCalledTimes(2);
    expect(clientMocks.sendC2CStreamMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        openid: "U-STREAM-1",
        request: expect.objectContaining({
          input_state: 1,
          content_raw: "先说明一下当前步骤。",
        }),
      })
    );
    expect(clientMocks.sendC2CStreamMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        openid: "U-STREAM-1",
        request: expect.objectContaining({
          input_state: 10,
          content_raw: "先说明一下当前步骤。\n我再继续检查配置。",
          stream_msg_id: "stream-session-1",
        }),
      })
    );
  });

  it("finalizes the previous stream and starts a new one when partial text shrinks", async () => {
    clientMocks.sendC2CStreamMessage
      .mockResolvedValueOnce({
        id: "stream-session-1",
        timestamp: 1,
      })
      .mockResolvedValueOnce({
        id: "stream-session-1",
        timestamp: 2,
      })
      .mockResolvedValueOnce({
        id: "stream-session-2",
        timestamp: 3,
      })
      .mockResolvedValueOnce({
        id: "stream-session-2",
        timestamp: 4,
      });

    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions.onPartialReply?.({ text: "第一条消息" });
      await replyOptions.onPartialReply?.({ text: "第一条消息，继续补充" });
      await replyOptions.onPartialReply?.({ text: "第二条消息" });
      await dispatcherOptions.deliver({ text: "第二条消息" }, { kind: "final" });
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stream-boundary-1",
        event_id: "evt-stream-boundary-1",
        content: "boundary test",
        timestamp: 1700000201000,
        author: {
          user_openid: "U-STREAM-2",
          username: "Boundary User",
        },
      },
      cfg: createBaseCfg(),
      accountId: "default",
      logger,
    });

    expect(clientMocks.sendC2CStreamMessage).toHaveBeenCalledTimes(4);
    const calls = clientMocks.sendC2CStreamMessage.mock.calls.map((call) => call[0]?.request);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        input_state: 1,
        content_raw: "第一条消息",
      })
    );
    expect(calls[1]).toEqual(
      expect.objectContaining({
        input_state: 10,
        content_raw: "第一条消息，继续补充",
        stream_msg_id: "stream-session-1",
      })
    );
    expect(calls[2]).toEqual(
      expect.objectContaining({
        input_state: 1,
        content_raw: "第二条消息",
      })
    );
    expect(calls[3]).toEqual(
      expect.objectContaining({
        input_state: 10,
        content_raw: "第二条消息",
        stream_msg_id: "stream-session-2",
      })
    );
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it("falls back to static delivery when the stream session cannot start", async () => {
    clientMocks.sendC2CStreamMessage.mockRejectedValueOnce(new Error("stream unavailable"));

    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions.onPartialReply?.({ text: "流式启动失败后应回退。" });
      await dispatcherOptions.deliver({ text: "流式启动失败后应回退。" }, { kind: "final" });
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stream-fallback-1",
        event_id: "evt-stream-fallback-1",
        content: "fallback test",
        timestamp: 1700000202000,
        author: {
          user_openid: "U-STREAM-3",
          username: "Fallback User",
        },
      },
      cfg: createBaseCfg(),
      accountId: "default",
      logger,
    });

    expect(clientMocks.sendC2CStreamMessage).toHaveBeenCalledTimes(1);
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:U-STREAM-3",
        text: "流式启动失败后应回退。",
      })
    );
  });

  it("keeps structured markdown on the legacy transport when streaming is enabled", async () => {
    const tableText = "| col1 | col2 |\n| --- | --- |\n| a | b |";
    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions.onPartialReply?.({ text: tableText });
      await dispatcherOptions.deliver({ text: tableText }, { kind: "final" });
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
    });

    await handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stream-markdown-1",
        event_id: "evt-stream-markdown-1",
        content: "markdown test",
        timestamp: 1700000203000,
        author: {
          user_openid: "U-STREAM-4",
          username: "Markdown User",
        },
      },
      cfg: createBaseCfg({
        c2cMarkdownDeliveryMode: "passive",
      }),
      accountId: "default",
      logger,
    });

    expect(clientMocks.sendC2CStreamMessage).not.toHaveBeenCalled();
    expect(outboundMocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:U-STREAM-4",
        text: tableText,
      })
    );
  });

  it("stops typing heartbeat after the first streamed chunk", async () => {
    vi.useFakeTimers();
    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await replyOptions.onPartialReply?.({ text: "第一段流式文本" });
      await new Promise((resolve) => setTimeout(resolve, 7000));
      await dispatcherOptions.deliver({ text: "第一段流式文本" }, { kind: "final" });
    });
    const logger = createLogger();

    setupRuntime({
      dispatchReplyWithDispatcher,
    });

    const dispatchPromise = handleQQBotDispatch({
      eventType: "C2C_MESSAGE_CREATE",
      eventData: {
        id: "msg-stream-typing-1",
        event_id: "evt-stream-typing-1",
        content: "typing test",
        timestamp: 1700000204000,
        author: {
          user_openid: "U-STREAM-5",
          username: "Typing User",
        },
      },
      cfg: createBaseCfg({
        typingHeartbeatMode: "always",
        typingHeartbeatIntervalMs: 3000,
      }),
      accountId: "default",
      logger,
    });

    await vi.advanceTimersByTimeAsync(9000);
    await dispatchPromise;

    expect(outboundMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(clientMocks.sendC2CStreamMessage).toHaveBeenCalledTimes(2);
  });
});
