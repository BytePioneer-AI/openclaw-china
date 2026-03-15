import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { computeWecomKfMsgSignature, encryptWecomKfPlaintext } from "../crypto.js";

function createMockRequest(params: {
  method: "GET" | "POST";
  url: string;
  body?: string;
}): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = params.method;
  req.url = params.url;
  if (params.method === "POST") {
    req.push(params.body ?? "");
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

function createAccount(path: string) {
  return {
    accountId: "default",
    name: "Test",
    enabled: true,
    configured: true,
    token,
    encodingAESKey,
    receiveId: "",
    corpId: "corp-1",
    corpSecret: "secret-1",
    openKfid: "wkA_test",
    canSend: true,
    config: {
      webhookPath: path,
      token,
      encodingAESKey,
      corpId: "corp-1",
      corpSecret: "secret-1",
      openKfid: "wkA_test",
    },
  };
}

function buildEncryptedCallbackXml(params: { callbackToken: string; openKfId: string }) {
  const plaintext = `<xml><Token><![CDATA[${params.callbackToken}]]></Token><OpenKfId><![CDATA[${params.openKfId}]]></OpenKfId></xml>`;
  const encrypt = encryptWecomKfPlaintext({
    encodingAESKey,
    plaintext,
  });
  const timestamp = "1700000000";
  const nonce = "nonce-1";
  const signature = computeWecomKfMsgSignature({
    token,
    timestamp,
    nonce,
    encrypt,
  });
  const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;

  return {
    url: `/wecom-kf?msg_signature=${encodeURIComponent(signature)}&timestamp=${timestamp}&nonce=${nonce}`,
    body,
  };
}

async function importMonitorWithMocks(params: {
  syncMessagesMock: ReturnType<typeof vi.fn>;
  dispatchMock: ReturnType<typeof vi.fn>;
}) {
  vi.doMock("../api.js", async () => {
    const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
    return {
      ...actual,
      syncMessages: params.syncMessagesMock,
    };
  });

  vi.doMock("../bot.js", () => ({
    dispatchWecomKfMessage: params.dispatchMock,
  }));

  const runtimeModule = await import("../runtime.js");
  runtimeModule.setWecomKfRuntime({});

  return await import("../monitor.js");
}

describe("wecom-kf replay regression", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("../api.js");
    vi.unmock("../bot.js");
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("persists sync cursor across restart and resumes from the last cursor", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "wecom-kf-home-"));
    process.env.HOME = tempHome;

    const dispatchMock = vi.fn().mockResolvedValue(undefined);
    const syncMessagesMock = vi
      .fn()
      .mockResolvedValueOnce({
        msg_list: [
          {
            msgid: "msg-1",
            msgtype: "text",
            origin: 3,
            external_userid: "ext-user-1",
            send_time: 100,
            text: { content: "hello" },
          },
        ],
        next_cursor: "cursor-1",
        has_more: 0,
      })
      .mockResolvedValueOnce({
        msg_list: [],
        next_cursor: "cursor-2",
        has_more: 0,
      });

    const firstLoad = await importMonitorWithMocks({ syncMessagesMock, dispatchMock });
    const unregisterFirst = firstLoad.registerWecomKfWebhookTarget({
      account: createAccount("/wecom-kf"),
      config: {},
      runtime: {},
      path: "/wecom-kf",
    });

    const firstCallback = buildEncryptedCallbackXml({
      callbackToken: "callback-token-1",
      openKfId: "wkA_test",
    });

    try {
      const req = createMockRequest({
        method: "POST",
        url: firstCallback.url,
        body: firstCallback.body,
      });
      const res = createMockResponse();

      const handled = await firstLoad.handleWecomKfWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getData()).toBe("success");

      await vi.waitFor(() => {
        expect(syncMessagesMock).toHaveBeenCalledTimes(1);
        expect(dispatchMock).toHaveBeenCalledTimes(1);
      });

      await vi.waitFor(() => {
        const stateFilePath = join(tempHome, ".openclaw", "wecom-kf", "data", "sync-state.json");
        expect(readFileSync(stateFilePath, "utf8")).toContain("\"cursor\": \"cursor-1\"");
      });
    } finally {
      unregisterFirst();
    }

    const stateFilePath = join(tempHome, ".openclaw", "wecom-kf", "data", "sync-state.json");
    const persistedRaw = readFileSync(stateFilePath, "utf8");
    expect(persistedRaw).toContain("\"cursor\": \"cursor-1\"");
    expect(persistedRaw).toContain("\"msg-1\"");

    vi.resetModules();

    const secondLoad = await importMonitorWithMocks({ syncMessagesMock, dispatchMock });
    const unregisterSecond = secondLoad.registerWecomKfWebhookTarget({
      account: createAccount("/wecom-kf"),
      config: {},
      runtime: {},
      path: "/wecom-kf",
    });

    const secondCallback = buildEncryptedCallbackXml({
      callbackToken: "callback-token-2",
      openKfId: "wkA_test",
    });

    try {
      const req = createMockRequest({
        method: "POST",
        url: secondCallback.url,
        body: secondCallback.body,
      });
      const res = createMockResponse();

      const handled = await secondLoad.handleWecomKfWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(res._getStatusCode()).toBe(200);

      await vi.waitFor(() => {
        expect(syncMessagesMock).toHaveBeenCalledTimes(2);
      });

      expect(syncMessagesMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ accountId: "default" }),
        "cursor-1",
        "callback-token-2",
        1000,
        "wkA_test",
      );
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    } finally {
      unregisterSecond();
    }
  });
});
