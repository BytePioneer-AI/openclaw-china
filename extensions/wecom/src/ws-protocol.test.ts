import { describe, expect, it } from "vitest";

import {
  buildWecomWsSendMessageCommand,
  buildWecomWsRespondMessageCommand,
  buildWecomWsRespondWelcomeCommand,
  normalizeWecomWsCallback,
  resolveWecomWsTarget,
} from "./ws-protocol.js";

describe("wecom ws protocol", () => {
  it("normalizes message callbacks", () => {
    const callback = normalizeWecomWsCallback({
      cmd: "aibot_msg_callback",
      headers: {
        req_id: "req-1",
      },
      body: {
        msgid: "msg-1",
        chattype: "group",
        chatid: "chat-1",
        from: { userid: "user-1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    });

    expect(callback).not.toBeNull();
    expect(callback?.kind).toBe("message");
    expect(callback?.reqId).toBe("req-1");
    expect(callback?.target).toBe("group:chat-1");
  });

  it("resolves direct targets from inbound payloads", () => {
    expect(
      resolveWecomWsTarget({
        chattype: "single",
        from: { userid: "alice" },
      })
    ).toBe("user:alice");
  });

  it("builds stream and welcome reply commands", () => {
    expect(
      buildWecomWsRespondMessageCommand({
        reqId: "req-1",
        streamId: "stream-1",
        content: "chunk",
        finish: false,
      })
    ).toEqual({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-1" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-1",
          finish: false,
          content: "chunk",
        },
      },
    });

    expect(
      buildWecomWsRespondMessageCommand({
        reqId: "req-1",
        streamId: "stream-1",
        content: "chunk",
        finish: true,
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
    ).toEqual({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-1" },
      body: {
        msgtype: "stream",
        stream: {
          id: "stream-1",
          finish: true,
          content: "chunk",
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

    expect(
      buildWecomWsRespondWelcomeCommand({
        reqId: "req-2",
        content: "welcome",
      })
    ).toEqual({
      cmd: "aibot_respond_welcome_msg",
      headers: { req_id: "req-2" },
      body: {
        msgtype: "text",
        text: { content: "welcome" },
      },
    });
  });

  it("builds proactive send commands", () => {
    const command = buildWecomWsSendMessageCommand({
      chatId: "user-1",
      body: {
        msgtype: "markdown",
        markdown: {
          content: "hello",
        },
      },
    });

    expect(command.cmd).toBe("aibot_send_msg");
    expect(command.headers?.req_id).toBeTruthy();
    expect(command.body).toEqual({
      chatid: "user-1",
      msgtype: "markdown",
      markdown: {
        content: "hello",
      },
    });
  });
});
