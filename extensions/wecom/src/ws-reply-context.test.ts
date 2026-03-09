import { afterEach, describe, expect, it } from "vitest";

import {
  appendWecomWsActiveStreamChunk,
  appendWecomWsActiveStreamReply,
  bindWecomWsRouteContext,
  clearWecomWsReplyContextsForAccount,
  consumeWecomWsPendingAutoImagePaths,
  finishWecomWsMessageContext,
  registerWecomWsEventContext,
  registerWecomWsMessageContext,
  registerWecomWsPendingAutoImagePaths,
  sendWecomWsActiveTemplateCard,
} from "./ws-reply-context.js";

describe("wecom ws reply context", () => {
  afterEach(() => {
    clearWecomWsReplyContextsForAccount("acc-1");
  });

  it("separates multiple OpenClaw reply payloads with blank lines and repeats the final content on finish", async () => {
    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-1",
      to: "user:alice",
      send: async (frame) => {
        sent.push(frame);
      },
      streamId: "stream-1",
    });

    bindWecomWsRouteContext({
      accountId: "acc-1",
      reqId: "req-1",
      sessionKey: "session-1",
      runId: "run-1",
    });

    await expect(
      appendWecomWsActiveStreamChunk({
        accountId: "acc-1",
        to: "user:alice",
        chunk: "hello",
        runId: "run-1",
      })
    ).resolves.toBe(true);

    await expect(
      appendWecomWsActiveStreamChunk({
        accountId: "acc-1",
        to: "user:alice",
        chunk: "world",
        runId: "run-1",
      })
    ).resolves.toBe(true);

    await finishWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-1",
    });

    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-1" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-1",
          finish: false,
          content: "hello",
        },
      },
    });
    expect(sent[1]).toMatchObject({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-1" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-1",
          finish: false,
          content: "hello\n\nworld",
        },
      },
    });
    expect(sent[2]).toMatchObject({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-1" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-1",
          finish: true,
          content: "hello\n\nworld",
        },
      },
    });
  });

  it("does not add an extra separator when the next payload already starts on a new line", async () => {
    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-3",
      to: "user:alice",
      send: async (frame) => {
        sent.push(frame);
      },
      streamId: "stream-3",
    });

    await appendWecomWsActiveStreamChunk({
      accountId: "acc-1",
      to: "user:alice",
      chunk: "hello",
    });

    await appendWecomWsActiveStreamChunk({
      accountId: "acc-1",
      to: "user:alice",
      chunk: "\nworld",
    });

    await finishWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-3",
    });

    expect(sent[1]).toMatchObject({
      body: {
        stream: {
          content: "hello\nworld",
        },
      },
    });
    expect(sent[2]).toMatchObject({
      body: {
        stream: {
          content: "hello\nworld",
          finish: true,
        },
      },
    });
  });

  it("appends error details to the final stream snapshot", async () => {
    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-2",
      to: "user:alice",
      send: async (frame) => {
        sent.push(frame);
      },
      streamId: "stream-2",
    });

    await expect(
      appendWecomWsActiveStreamChunk({
        accountId: "acc-1",
        to: "user:alice",
        chunk: "partial answer",
      })
    ).resolves.toBe(true);

    await finishWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-2",
      error: new Error("upstream failed"),
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-2" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-2",
          finish: true,
          content: "partial answer\n\nError: upstream failed",
        },
      },
    });
  });

  it("stores image msg items and emits them only on the final frame", async () => {
    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-image",
      to: "user:alice",
      send: async (frame) => {
        sent.push(frame);
      },
      streamId: "stream-image",
    });

    await expect(
      appendWecomWsActiveStreamReply({
        accountId: "acc-1",
        to: "user:alice",
        chunk: "caption",
        msgItems: [
          {
            msgtype: "image",
            image: {
              base64: "abc",
              md5: "def",
            },
          },
        ],
      })
    ).resolves.toEqual({
      accepted: true,
      appendedMsgItems: 1,
    });

    await finishWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-image",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      body: {
        stream: {
          id: "stream-image",
          finish: false,
          content: "caption",
        },
      },
    });
    expect(sent[1]).toMatchObject({
      body: {
        stream: {
          id: "stream-image",
          finish: true,
          content: "caption",
          msg_item: [
            {
              msgtype: "image",
              image: {
                base64: "abc",
                md5: "def",
              },
            },
          ],
        },
      },
    });
  });

  it("stores pending auto image paths and consumes them once", () => {
    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-auto-image",
      to: "user:alice",
      send: async () => undefined,
      streamId: "stream-auto-image",
    });

    const added = registerWecomWsPendingAutoImagePaths({
      accountId: "acc-1",
      to: "user:alice",
      imagePaths: ["/tmp/a.png", "/tmp/a.png", "/tmp/b.png"],
    });

    expect(added).toBe(2);
    expect(
      consumeWecomWsPendingAutoImagePaths({
        accountId: "acc-1",
        to: "user:alice",
      })
    ).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(
      consumeWecomWsPendingAutoImagePaths({
        accountId: "acc-1",
        to: "user:alice",
      })
    ).toEqual([]);
  });

  it("prefers the newest callback context for target fallback instead of the most recently updated old stream", async () => {
    const sent: Array<{ reqId: string; content?: string; finish?: boolean }> = [];

    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-old",
      to: "user:alice",
      send: async (frame) => {
        sent.push({
          reqId: String(frame.headers?.req_id ?? ""),
          content: (frame.body as { stream?: { content?: string; finish?: boolean } })?.stream?.content,
          finish: (frame.body as { stream?: { content?: string; finish?: boolean } })?.stream?.finish,
        });
      },
      streamId: "stream-old",
    });

    await appendWecomWsActiveStreamChunk({
      accountId: "acc-1",
      to: "user:alice",
      chunk: "old reply",
    });

    registerWecomWsMessageContext({
      accountId: "acc-1",
      reqId: "req-new",
      to: "user:alice",
      send: async (frame) => {
        sent.push({
          reqId: String(frame.headers?.req_id ?? ""),
          content: (frame.body as { stream?: { content?: string; finish?: boolean } })?.stream?.content,
          finish: (frame.body as { stream?: { content?: string; finish?: boolean } })?.stream?.finish,
        });
      },
      streamId: "stream-new",
    });

    await expect(
      appendWecomWsActiveStreamChunk({
        accountId: "acc-1",
        to: "user:alice",
        chunk: "new reply",
      })
    ).resolves.toBe(true);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      reqId: "req-old",
      content: "old reply",
      finish: false,
    });
    expect(sent[1]).toMatchObject({
      reqId: "req-new",
      content: "new reply",
      finish: false,
    });
  });

  it("sends template card updates through the active event context", async () => {
    const sent: unknown[] = [];
    registerWecomWsEventContext({
      accountId: "acc-1",
      reqId: "event-1",
      to: "user:alice",
      kind: "template_card_event",
      send: async (frame) => {
        sent.push(frame);
      },
    });

    await expect(
      sendWecomWsActiveTemplateCard({
        accountId: "acc-1",
        to: "user:alice",
        templateCard: { card_type: "button_interaction" },
      })
    ).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      cmd: "aibot_respond_update_msg",
      headers: { req_id: "event-1" },
      body: {
        response_type: "update_template_card",
        template_card: {
          card_type: "button_interaction",
        },
      },
    });
  });
});
