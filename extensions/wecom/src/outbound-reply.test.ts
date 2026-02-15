import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it, beforeEach } from "vitest";

import {
  buildTempMediaUrl,
  clearOutboundReplyState,
  consumeResponseUrl,
  getAccountPublicBaseUrl,
  handleTempMediaRequest,
  registerResponseUrl,
  registerTempLocalMedia,
  rememberAccountPublicBaseUrl,
} from "./outbound-reply.js";

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
    getBody: () => Buffer.concat(chunks),
  };
}

describe("wecom outbound reply store", () => {
  beforeEach(() => {
    clearOutboundReplyState();
  });

  it("returns latest response_url and keeps it reusable", () => {
    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://reply.local/1",
    });
    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://reply.local/2",
    });

    expect(
      consumeResponseUrl({
        accountId: "default",
        to: "user:alice",
      })
    ).toBe("https://reply.local/2");
    expect(
      consumeResponseUrl({
        accountId: "default",
        to: "user:alice",
      })
    ).toBe("https://reply.local/2");
  });

  it("captures public base url from forwarded headers", () => {
    const req = {
      headers: {
        "x-forwarded-host": "bot.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
    } as unknown as IncomingMessage;

    rememberAccountPublicBaseUrl("default", req);
    expect(getAccountPublicBaseUrl("default")).toBe("https://bot.example.com");
  });

  it("serves registered temp local media", async () => {
    const filePath = path.join(tmpdir(), `wecom-temp-${Date.now()}.txt`);
    await fs.writeFile(filePath, "hello-temp", "utf8");

    const media = await registerTempLocalMedia({
      filePath,
      fileName: "hello.txt",
    });
    const publicUrl = buildTempMediaUrl({
      baseUrl: "https://bot.example.com",
      id: media.id,
      token: media.token,
      fileName: media.fileName,
    });

    const req = {
      method: "GET",
      url: new URL(publicUrl).pathname + new URL(publicUrl).search,
      headers: {},
    } as unknown as IncomingMessage;
    const recorder = createResponseRecorder();

    const handled = await handleTempMediaRequest(req, recorder.res);
    expect(handled).toBe(true);
    expect(recorder.res.statusCode).toBe(200);
    expect(recorder.getBody().toString("utf8")).toBe("hello-temp");

    await fs.unlink(filePath);
  });
});
