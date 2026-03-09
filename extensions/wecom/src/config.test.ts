import { describe, expect, it } from "vitest";

import {
  DEFAULT_WECOM_WS_HEARTBEAT_MS,
  DEFAULT_WECOM_WS_RECONNECT_INITIAL_MS,
  DEFAULT_WECOM_WS_RECONNECT_MAX_MS,
  DEFAULT_WECOM_WS_URL,
  resolveWecomAccount,
} from "./config.js";

describe("resolveWecomAccount", () => {
  it("defaults to webhook mode for legacy configs", () => {
    const account = resolveWecomAccount({
      cfg: {
        channels: {
          wecom: {
            token: "token-1",
            encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
          },
        },
      },
    });

    expect(account.mode).toBe("webhook");
    expect(account.configured).toBe(true);
    expect(account.token).toBe("token-1");
    expect(account.botId).toBeUndefined();
  });

  it("resolves ws mode credentials and defaults", () => {
    const account = resolveWecomAccount({
      cfg: {
        channels: {
          wecom: {
            mode: "ws",
            botId: "bot-123",
            secret: "secret-xyz",
          },
        },
      },
    });

    expect(account.mode).toBe("ws");
    expect(account.configured).toBe(true);
    expect(account.botId).toBe("bot-123");
    expect(account.secret).toBe("secret-xyz");
    expect(account.wsUrl).toBe(DEFAULT_WECOM_WS_URL);
    expect(account.heartbeatIntervalMs).toBe(DEFAULT_WECOM_WS_HEARTBEAT_MS);
    expect(account.reconnectInitialDelayMs).toBe(DEFAULT_WECOM_WS_RECONNECT_INITIAL_MS);
    expect(account.reconnectMaxDelayMs).toBe(DEFAULT_WECOM_WS_RECONNECT_MAX_MS);
    expect(account.wsImageReplyMode).toBe("native");
  });

  it("resolves ws image reply mode override", () => {
    const account = resolveWecomAccount({
      cfg: {
        channels: {
          wecom: {
            mode: "ws",
            botId: "bot-123",
            secret: "secret-xyz",
            wsImageReplyMode: "markdown-url",
          },
        },
      },
    });

    expect(account.wsImageReplyMode).toBe("markdown-url");
  });
});
