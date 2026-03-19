import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./send.js", () => ({
  sendMessageDingtalk: vi.fn(async (params: { to: string }) => ({
    messageId: `msg-${Date.now()}`,
    conversationId: params.to,
  })),
}));

import { handleDingtalkMessage } from "./bot-handler.js";
import { clearDingtalkRuntime, setDingtalkRuntime } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
import type { DingtalkRawMessage } from "./types.js";

const sendMessageMock = vi.mocked(sendMessageDingtalk);
type DingtalkRuntime = Parameters<typeof setDingtalkRuntime>[0];

const baseCfg = {
  channels: {
    dingtalk: {
      clientId: "app-key",
      clientSecret: "app-secret",
      dmPolicy: "open",
      longTaskNoticeDelayMs: 0,
    },
  },
};

const baseRaw: DingtalkRawMessage = {
  senderId: "U-1",
  senderNick: "Tester",
  conversationType: "1",
  conversationId: "C-1",
  msgtype: "text",
  text: {
    content: "show progress",
  },
};

function createRuntime(reply: Record<string, unknown>) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "agent:main:dingtalk:direct:U-1",
          accountId: "default",
          agentId: "main",
        }),
      },
      reply,
    },
  };
}

describe("dingtalk reply dispatch", () => {
  afterEach(() => {
    clearDingtalkRuntime();
    sendMessageMock.mockClear();
  });

  it("prefers the direct dispatcher for real-time replies", async () => {
    const dispatchReplyWithDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "先说明一下当前步骤。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "exec: listing files" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "检查完了。" }, { kind: "final" });
      return { queuedFinal: false, counts: { final: 1 } };
    });

    setDingtalkRuntime(
      createRuntime({
        dispatchReplyWithDispatcher,
      }) as DingtalkRuntime
    );

    await handleDingtalkMessage({
      cfg: baseCfg,
      raw: baseRaw,
      log: () => undefined,
      error: () => undefined,
    });

    expect(dispatchReplyWithDispatcher).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: {
          disableBlockStreaming: false,
        },
      })
    );
    expect(sendMessageMock.mock.calls.map(([params]) => params.text)).toEqual([
      "先说明一下当前步骤。",
      "exec: listing files",
      "检查完了。",
    ]);
  });

  it("uses the buffered dispatcher when the direct dispatcher is unavailable", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "先说明一下当前步骤。" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "检查完了。" }, { kind: "final" });
      return { queuedFinal: false, counts: { final: 1 } };
    });

    setDingtalkRuntime(
      createRuntime({
        dispatchReplyWithBufferedBlockDispatcher,
      }) as DingtalkRuntime
    );

    await handleDingtalkMessage({
      cfg: baseCfg,
      raw: baseRaw,
      log: () => undefined,
      error: () => undefined,
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: {
          disableBlockStreaming: false,
        },
      })
    );
    expect(sendMessageMock.mock.calls.map(([params]) => params.text)).toEqual([
      "先说明一下当前步骤。",
      "检查完了。",
    ]);
  });

  it("does not fall back to the legacy dispatcher when no real-time dispatcher exists", async () => {
    const dispatchReplyFromConfig = vi.fn();

    setDingtalkRuntime(
      createRuntime({
        dispatchReplyFromConfig,
      }) as DingtalkRuntime
    );

    await handleDingtalkMessage({
      cfg: baseCfg,
      raw: baseRaw,
      log: () => undefined,
      error: () => undefined,
    });

    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
