import { beforeEach, describe, expect, it, vi } from "vitest";

import { wecomPlugin } from "./channel.js";
import { clearOutboundReplyState, registerResponseUrl } from "./outbound-reply.js";

const cfg = {
  channels: {
    wecom: {
      enabled: true,
      token: "token-1",
      encodingAESKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    },
  },
};

describe("wecom outbound via response_url", () => {
  beforeEach(() => {
    clearOutboundReplyState();
    vi.restoreAllMocks();
  });

  it("sends text via response_url", async () => {
    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://reply.local/text",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wecomPlugin.outbound.sendText({
      cfg,
      to: "user:alice",
      text: "hello",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    const payload = JSON.parse(String(init.body));
    expect(payload.msgtype).toBe("text");
    expect(payload.text?.content).toBe("hello");
  });

  it("sends file media via response_url", async () => {
    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://reply.local/file",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wecomPlugin.outbound.sendMedia({
      cfg,
      to: "user:alice",
      mediaUrl: "https://cdn.example.com/report.pdf",
      mimeType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    const payload = JSON.parse(String(init.body));
    expect(payload.msgtype).toBe("file");
    expect(payload.file?.url).toBe("https://cdn.example.com/report.pdf");
  });

  it("allows text then file with the same response_url", async () => {
    registerResponseUrl({
      accountId: "default",
      to: "user:alice",
      responseUrl: "https://reply.local/reuse",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const textResult = await wecomPlugin.outbound.sendText({
      cfg,
      to: "user:alice",
      text: "processing...",
    });
    const fileResult = await wecomPlugin.outbound.sendMedia({
      cfg,
      to: "user:alice",
      mediaUrl: "https://cdn.example.com/report.pdf",
      mimeType: "application/pdf",
    });

    expect(textResult.ok).toBe(true);
    expect(fileResult.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
