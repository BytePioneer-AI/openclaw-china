import { describe, expect, it } from "vitest";

import { dispatchWecomAppMessage, extractWecomAppContent } from "./bot.js";
import type { PluginRuntime } from "./runtime.js";
import type { ResolvedWecomAppAccount } from "./types.js";
import type { WecomAppInboundMessage } from "./types.js";

function createAccount(): ResolvedWecomAppAccount {
  return {
    accountId: "app",
    enabled: true,
    configured: true,
    receiveId: "corp123",
    canSendActive: false,
    config: {
      dmPolicy: "open",
    },
  };
}

function createRuntime(params: {
  dispatchReplyWithBufferedBlockDispatcher: NonNullable<
    NonNullable<PluginRuntime["channel"]>["reply"]
  >["dispatchReplyWithBufferedBlockDispatcher"];
}): PluginRuntime {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "session-1",
          accountId: "app",
        }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: params.dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  };
}

describe("extractWecomAppContent location", () => {
  it("formats classic XML-style location fields", () => {
    const msg = {
      msgtype: "location",
      Location_X: "31.2304",
      Location_Y: "121.4737",
      Scale: "15",
      Label: "上海市黄浦区",
    } as WecomAppInboundMessage;

    expect(extractWecomAppContent(msg)).toBe("[location] 31.2304,121.4737 上海市黄浦区 scale=15");
  });

  it("formats Event=LOCATION style fields", () => {
    const msg = {
      msgtype: "location",
      Latitude: "39.9042",
      Longitude: "116.4074",
      Precision: "30",
    } as WecomAppInboundMessage;

    expect(extractWecomAppContent(msg)).toBe("[location] 39.9042,116.4074 scale=30");
  });

  it("falls back to tag-only output when fields are missing", () => {
    const msg = {
      msgtype: "location",
    } as WecomAppInboundMessage;

    expect(extractWecomAppContent(msg)).toBe("[location]");
  });

  it("awaits async onChunk hooks before finishing dispatch", async () => {
    let finishOnChunk: (() => void) | undefined;
    const onChunkDone = new Promise<void>((resolve) => {
      finishOnChunk = resolve;
    });

    const dispatchPromise = dispatchWecomAppMessage({
      cfg: {},
      account: createAccount(),
      msg: {
        msgtype: "text",
        msgid: "msg-1",
        from: { userid: "user-1" },
        text: { content: "hello" },
      } as WecomAppInboundMessage,
      core: createRuntime({
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver({ text: "chunk-1" });
        },
      }),
      hooks: {
        onChunk: async () => {
          await onChunkDone;
        },
      },
    });

    const pendingState = await Promise.race([
      dispatchPromise.then(() => "resolved"),
      Promise.resolve("pending"),
    ]);
    expect(pendingState).toBe("pending");

    finishOnChunk?.();
    await dispatchPromise;
  });
});
