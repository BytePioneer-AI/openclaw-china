import { describe, expect, it, vi } from "vitest";

import { dispatchWecomKfMessage } from "../bot.js";

describe("wecom-kf stale inbound guard", () => {
  it("skips replayed inbound messages older than the persisted session watermark", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const resolveAgentRoute = vi.fn().mockReturnValue({
      sessionKey: "session:user-1",
      accountId: "default",
      agentId: "agent-1",
    });
    const readSessionUpdatedAt = vi.fn().mockReturnValue(1_700_000_000_000);

    await dispatchWecomKfMessage({
      cfg: { session: { store: { kind: "file" } } },
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        canSend: true,
        receiveId: "corp-1",
        corpId: "corp-1",
        corpSecret: "secret-1",
        openKfid: "wkA_test",
        config: {},
      },
      msg: {
        msgid: "msg-old-1",
        msgtype: "text",
        origin: 3,
        external_userid: "user-1",
        send_time: 1_600_000_000,
        text: { content: "old text" },
      },
      core: {
        channel: {
          routing: {
            resolveAgentRoute,
          },
          session: {
            resolveStorePath: () => "memory://wecom-kf",
            readSessionUpdatedAt,
            recordInboundSession,
          },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher,
          },
        },
      },
      hooks: {
        onChunk: vi.fn(),
      },
    });

    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
    expect(readSessionUpdatedAt).toHaveBeenCalledWith({
      storePath: "memory://wecom-kf",
      sessionKey: "session:user-1",
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("does not skip a new message in the same recent window", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue(undefined);
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const resolveAgentRoute = vi.fn().mockReturnValue({
      sessionKey: "session:user-1",
      accountId: "default",
      agentId: "agent-1",
    });
    const readSessionUpdatedAt = vi.fn().mockReturnValue(1_700_000_000_000);

    await dispatchWecomKfMessage({
      cfg: { session: { store: { kind: "file" } } },
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        canSend: true,
        receiveId: "corp-1",
        corpId: "corp-1",
        corpSecret: "secret-1",
        openKfid: "wkA_test",
        config: {},
      },
      msg: {
        msgid: "msg-new-1",
        msgtype: "text",
        origin: 3,
        external_userid: "user-1",
        send_time: 1_700_000_000,
        text: { content: "fresh text" },
      },
      core: {
        channel: {
          routing: {
            resolveAgentRoute,
          },
          session: {
            resolveStorePath: () => "memory://wecom-kf",
            readSessionUpdatedAt,
            recordInboundSession,
          },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher,
          },
        },
      },
      hooks: {
        onChunk: vi.fn(),
      },
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
});
