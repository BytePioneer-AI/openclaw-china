import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@wecom/aibot-node-sdk", async () => await import("./test-sdk-mock.js"));

import { wecomPlugin } from "./channel.js";
import { type PluginConfig } from "./config.js";
import { computeWecomMsgSignature, decryptWecomEncrypted, encryptWecomPlaintext } from "./crypto.js";
import {
  appendWecomActiveStreamChunk,
  handleWecomWebhookRequest,
  registerWecomWebhookTarget,
} from "./monitor.js";
import { clearOutboundReplyState, registerResponseUrl } from "./outbound-reply.js";
import type { ResolvedWecomAccount } from "./types.js";

function createMockRequest(params: {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = params.method;
  req.url = params.url;
  if (params.method === "POST") {
    req.push(JSON.stringify(params.body ?? {}));
  }
  req.push(null);
  return req;
}

function createMockResponse(): ServerResponse & {
  _getData: () => string;
  _getStatusCode: () => number;
} {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const mutableRes = res as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => ServerResponse;
  };
  let data = "";
  mutableRes.write = (chunk?: unknown) => {
    data += String(chunk);
    return true;
  };
  mutableRes.end = (chunk?: unknown) => {
    if (chunk) data += String(chunk);
    return res;
  };
  return Object.assign(res, {
    _getData: () => data,
    _getStatusCode: () => res.statusCode,
  });
}

const token = "test-token";
const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function createWebhookAccount(path: string): ResolvedWecomAccount {
  return {
    accountId: "default",
    name: "Test",
    enabled: true,
    configured: true,
    mode: "webhook",
    token,
    encodingAESKey,
    receiveId: "",
    wsUrl: "wss://openws.work.weixin.qq.com",
    heartbeatIntervalMs: 30_000,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    wsImageReplyMode: "native",
    config: {
      mode: "webhook",
      webhookPath: path,
      token,
      encodingAESKey,
    },
  };
}

describe("wecom webhook transport regressions", () => {
  afterEach(() => {
    clearOutboundReplyState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("handles GET webhook verification", async () => {
    const account = createWebhookAccount("/hook-verify");
    const unregister = registerWecomWebhookTarget({
      account,
      config: {} as PluginConfig,
      runtime: {},
      path: "/hook-verify",
    });

    try {
      const timestamp = "13500001234";
      const nonce = "123412323";
      const echostr = encryptWecomPlaintext({
        encodingAESKey,
        plaintext: "ping",
      });
      const msgSignature = computeWecomMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt: echostr,
      });

      const req = createMockRequest({
        method: "GET",
        url: `/hook-verify?msg_signature=${encodeURIComponent(msgSignature)}&timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}&echostr=${encodeURIComponent(echostr)}`,
      });
      const res = createMockResponse();

      const handled = await handleWecomWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getData()).toBe("ping");
    } finally {
      unregister();
    }
  });

  it("returns a placeholder stream and later exposes appended chunks", async () => {
    const account = createWebhookAccount("/hook-stream");
    const unregister = registerWecomWebhookTarget({
      account,
      config: {} as PluginConfig,
      runtime: {},
      path: "/hook-stream",
    });

    try {
      const timestamp = "1700000000";
      const nonce = "nonce-1";
      const plain = JSON.stringify({
        msgid: "msg-stream-1",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "user-stream-1" },
        msgtype: "text",
        text: { content: "hello" },
      });
      const encrypt = encryptWecomPlaintext({
        encodingAESKey,
        plaintext: plain,
      });
      const msgSignature = computeWecomMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const req = createMockRequest({
        method: "POST",
        url: `/hook-stream?msg_signature=${encodeURIComponent(msgSignature)}&timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}`,
        body: { encrypt },
      });
      const res = createMockResponse();

      const handled = await handleWecomWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(res._getStatusCode()).toBe(200);

      const initialReply = JSON.parse(
        decryptWecomEncrypted({
          encodingAESKey,
          encrypt: String((JSON.parse(res._getData()) as { encrypt: string }).encrypt),
        })
      ) as {
        msgtype: string;
        stream?: { id?: string; content?: string; finish?: boolean };
      };
      expect(initialReply.msgtype).toBe("stream");
      expect(initialReply.stream?.id).toBeTruthy();
      expect(initialReply.stream?.finish).toBe(false);

      expect(
        appendWecomActiveStreamChunk({
          accountId: account.accountId,
          to: "user:user-stream-1",
          chunk: "hello from reply pipeline",
        })
      ).toBe(true);

      const streamQueryPlain = JSON.stringify({
        msgtype: "stream",
        stream: {
          id: initialReply.stream?.id,
        },
      });
      const streamQueryEncrypt = encryptWecomPlaintext({
        encodingAESKey,
        plaintext: streamQueryPlain,
      });
      const streamQuerySignature = computeWecomMsgSignature({
        token,
        timestamp: "1700000001",
        nonce: "nonce-2",
        encrypt: streamQueryEncrypt,
      });
      const streamReq = createMockRequest({
        method: "POST",
        url: `/hook-stream?msg_signature=${encodeURIComponent(streamQuerySignature)}&timestamp=1700000001&nonce=nonce-2`,
        body: { encrypt: streamQueryEncrypt },
      });
      const streamRes = createMockResponse();

      const streamHandled = await handleWecomWebhookRequest(streamReq, streamRes);
      expect(streamHandled).toBe(true);
      expect(streamRes._getStatusCode()).toBe(200);

      const streamedReply = JSON.parse(
        decryptWecomEncrypted({
          encodingAESKey,
          encrypt: String((JSON.parse(streamRes._getData()) as { encrypt: string }).encrypt),
        })
      ) as {
        msgtype: string;
        stream?: { content?: string; finish?: boolean };
      };
      expect(streamedReply.msgtype).toBe("stream");
      expect(streamedReply.stream?.content).toContain("hello from reply pipeline");
      expect(streamedReply.stream?.finish).toBe(false);
    } finally {
      unregister();
    }
  });

  it("appends completion footer metadata to finished webhook streams when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T10:00:00.000Z"));

    const account = {
      ...createWebhookAccount("/hook-footer"),
      config: {
        mode: "webhook",
        webhookPath: "/hook-footer",
        token,
        encodingAESKey,
        footer: {
          status: true,
          elapsed: true,
        },
      },
    };
    const unregister = registerWecomWebhookTarget({
      account,
      config: {} as PluginConfig,
      runtime: {},
      path: "/hook-footer",
    });

    try {
      const timestamp = "1700000100";
      const nonce = "nonce-footer-1";
      const plain = JSON.stringify({
        msgid: "msg-stream-footer-1",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "user-stream-footer-1" },
        msgtype: "text",
        text: { content: "hello" },
      });
      const encrypt = encryptWecomPlaintext({
        encodingAESKey,
        plaintext: plain,
      });
      const msgSignature = computeWecomMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const req = createMockRequest({
        method: "POST",
        url: `/hook-footer?msg_signature=${encodeURIComponent(msgSignature)}&timestamp=${encodeURIComponent(timestamp)}&nonce=${encodeURIComponent(nonce)}`,
        body: { encrypt },
      });
      const res = createMockResponse();

      const handledPromise = handleWecomWebhookRequest(req, res);
      await vi.advanceTimersByTimeAsync(850);
      const handled = await handledPromise;
      expect(handled).toBe(true);

      const initialReply = JSON.parse(
        decryptWecomEncrypted({
          encodingAESKey,
          encrypt: String((JSON.parse(res._getData()) as { encrypt: string }).encrypt),
        })
      ) as {
        msgtype: string;
        stream?: { id?: string; content?: string; finish?: boolean };
      };
      expect(initialReply.stream?.id).toBeTruthy();
      expect(initialReply.stream?.finish).toBe(false);

      expect(
        appendWecomActiveStreamChunk({
          accountId: account.accountId,
          to: "user:user-stream-footer-1",
          chunk: "hello from reply pipeline",
        })
      ).toBe(true);

      vi.setSystemTime(new Date("2026-03-17T10:00:03.200Z"));
      await vi.advanceTimersByTimeAsync(2_600);

      const streamQueryPlain = JSON.stringify({
        msgtype: "stream",
        stream: {
          id: initialReply.stream?.id,
        },
      });
      const streamQueryEncrypt = encryptWecomPlaintext({
        encodingAESKey,
        plaintext: streamQueryPlain,
      });
      const streamQuerySignature = computeWecomMsgSignature({
        token,
        timestamp: "1700000101",
        nonce: "nonce-footer-2",
        encrypt: streamQueryEncrypt,
      });
      const streamReq = createMockRequest({
        method: "POST",
        url: `/hook-footer?msg_signature=${encodeURIComponent(streamQuerySignature)}&timestamp=1700000101&nonce=nonce-footer-2`,
        body: { encrypt: streamQueryEncrypt },
      });
      const streamRes = createMockResponse();

      const streamHandled = await handleWecomWebhookRequest(streamReq, streamRes);
      expect(streamHandled).toBe(true);
      expect(streamRes._getStatusCode()).toBe(200);

      const streamedReply = JSON.parse(
        decryptWecomEncrypted({
          encodingAESKey,
          encrypt: String((JSON.parse(streamRes._getData()) as { encrypt: string }).encrypt),
        })
      ) as {
        msgtype: string;
        stream?: { content?: string; finish?: boolean };
      };
      expect(streamedReply.msgtype).toBe("stream");
      expect(streamedReply.stream?.finish).toBe(true);
      expect(streamedReply.stream?.content).toBe("hello from reply pipeline\n\n——\n已完成 · 耗时 5.7s");
    } finally {
      unregister();
    }
  });

  it("sends template cards through stored response_url endpoints", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://example.test/wecom-response",
    });

    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "webhook",
          token,
          encodingAESKey,
        },
      },
    };

    const result = await wecomPlugin.outbound.sendTemplateCard({
      cfg,
      to: "user:alice",
      templateCard: {
        card_type: "text_notice",
        main_title: {
          title: "hello",
          desc: "world",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/wecom-response",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "template_card",
          template_card: {
            card_type: "text_notice",
            main_title: {
              title: "hello",
              desc: "world",
            },
          },
        }),
      })
    );
  });
});
