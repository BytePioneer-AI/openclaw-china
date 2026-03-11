import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendWecomAppMessageMock } = vi.hoisted(() => ({
  sendWecomAppMessageMock: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    sendWecomAppMessage: sendWecomAppMessageMock,
    stripMarkdown: (text: string) => text,
  };
});

import { computeWecomAppMsgSignature, encryptWecomAppPlaintext } from "./crypto.js";
import { handleWecomAppWebhookRequest, registerWecomAppWebhookTarget } from "./monitor.js";
import { clearWecomAppRuntime, setWecomAppRuntime, type PluginRuntime } from "./runtime.js";
import type { ResolvedWecomAppAccount } from "./types.js";

const token = "token123";
const encodingAESKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function createRequest(method: string, url: string, body?: string): IncomingMessage {
  const stream = new Readable({
    read() {
      return;
    },
  });
  if (body) {
    stream.push(body);
  }
  stream.push(null);
  (stream as IncomingMessage).method = method;
  (stream as IncomingMessage).url = url;
  return stream as IncomingMessage;
}

function createResponseRecorder() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (data?: string | Buffer) => {
      if (data === undefined) return;
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
  } as unknown as ServerResponse;

  return {
    res,
    headers,
    getBody: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

function buildAccount(): ResolvedWecomAppAccount {
  return {
    accountId: "app",
    enabled: true,
    configured: true,
    token,
    encodingAESKey,
    receiveId: "corp123",
    corpId: "corp-id",
    corpSecret: "secret",
    agentId: 1001,
    canSendActive: true,
    config: {
      webhookPath: "/wecom-app",
      agentId: 1001,
      dmPolicy: "open",
    },
  };
}

function buildRuntime(dispatchReplyWithBufferedBlockDispatcher: NonNullable<
  NonNullable<PluginRuntime["channel"]>["reply"]
>["dispatchReplyWithBufferedBlockDispatcher"]): PluginRuntime {
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "session-1",
          accountId: "app",
        }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  };
}

beforeEach(() => {
  sendWecomAppMessageMock.mockReset();
  sendWecomAppMessageMock.mockResolvedValue({
    ok: true,
    errmsg: "ok",
    msgid: "out-1",
  });
});

afterEach(() => {
  clearWecomAppRuntime();
  vi.restoreAllMocks();
});

describe("wecom-app active stream delivery", () => {
  it("actively sends each chunk as soon as it arrives", async () => {
    const secondChunkGate = createDeferred();

    setWecomAppRuntime(buildRuntime(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "first verbose block" });
      await secondChunkGate.promise;
      await dispatcherOptions.deliver({ text: "second verbose block" });
    }));

    const unregister = registerWecomAppWebhookTarget({
      account: buildAccount(),
      config: { channels: { "wecom-app": {} } },
      runtime: {},
      path: "/wecom-app",
    });

    try {
      const message = {
        msgtype: "text",
        msgid: "m-stream-1",
        from: { userid: "user1" },
        text: { content: "hi" },
        AgentID: 1001,
      };

      const encrypt = encryptWecomAppPlaintext({
        encodingAESKey,
        receiveId: "corp123",
        plaintext: JSON.stringify(message),
      });

      const timestamp = "1700000010";
      const nonce = "nonce-stream-1";
      const signature = computeWecomAppMsgSignature({
        token,
        timestamp,
        nonce,
        encrypt,
      });

      const params = new URLSearchParams({
        timestamp,
        nonce,
        msg_signature: signature,
      });

      const req = createRequest("POST", `/wecom-app?${params.toString()}`, JSON.stringify({ encrypt }));
      const recorder = createResponseRecorder();

      const handled = await handleWecomAppWebhookRequest(req, recorder.res);

      expect(handled).toBe(true);
      expect(recorder.getBody()).toContain("\"encrypt\"");

      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(1);
      });
      expect(sendWecomAppMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ accountId: "app" }),
        { userId: "user1" },
        "first verbose block"
      );

      secondChunkGate.resolve();

      await vi.waitFor(() => {
        expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(2);
      });
      expect(sendWecomAppMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ accountId: "app" }),
        { userId: "user1" },
        "second verbose block"
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sendWecomAppMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });
});
