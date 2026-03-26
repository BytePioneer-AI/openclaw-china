import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageDingtalk = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1", conversationId: "conv-1" })),
);
const sendMediaDingtalk = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "media-1", conversationId: "conv-1" })),
);

vi.mock("./send.js", () => ({
  sendMessageDingtalk,
}));

vi.mock("./media.js", () => ({
  sendMediaDingtalk,
}));

import { dingtalkMessageActions } from "./actions.js";
import type { PluginConfig } from "./config.js";

function configuredCfg(): PluginConfig {
  return {
    channels: {
      dingtalk: {
        clientId: "app-key",
        clientSecret: "app-secret",
      },
    },
  };
}

describe("dingtalk message actions", () => {
  beforeEach(() => {
    sendMessageDingtalk.mockClear();
    sendMediaDingtalk.mockClear();
  });

  it("hides shared message actions when no configured account is available", () => {
    expect(dingtalkMessageActions.describeMessageTool({ cfg: {} })).toBeNull();
  });

  it("dispatches the send action through the existing text sender", async () => {
    await dingtalkMessageActions.handleAction({
      action: "send",
      params: {
        to: "group:chat-123",
        message: "hello from tool",
      },
      cfg: configuredCfg(),
    });

    expect(sendMessageDingtalk).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat-123",
        text: "hello from tool",
        chatType: "group",
      }),
    );
    expect(sendMediaDingtalk).not.toHaveBeenCalled();
  });

  it("reuses the existing media sender when media parameters are present", async () => {
    await dingtalkMessageActions.handleAction({
      action: "send",
      params: {
        to: "user:staff-1",
        message: "see attachment",
        mediaUrl: "https://example.com/file.png",
      },
      cfg: configuredCfg(),
    });

    expect(sendMessageDingtalk).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "staff-1",
        text: "see attachment",
        chatType: "direct",
      }),
    );
    expect(sendMediaDingtalk).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "staff-1",
        mediaUrl: "https://example.com/file.png",
        chatType: "direct",
      }),
    );
  });
});
