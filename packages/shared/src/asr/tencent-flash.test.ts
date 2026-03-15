import { afterEach, describe, expect, it, vi } from "vitest";

import { ASRRequestError, ASRResponseParseError } from "./errors.js";
import { transcribeTencentFlash } from "./tencent-flash.js";

describe("transcribeTencentFlash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports non-JSON HTTP errors as request errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><h1>404 Not Found</h1></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      }))
    );

    await expect(
      transcribeTencentFlash({
        audio: Buffer.from("test"),
        config: {
          appId: "1234567890",
          secretId: "sid",
          secretKey: "skey",
          voiceFormat: "amr",
        },
      })
    ).rejects.toMatchObject<Partial<ASRRequestError>>({
      name: "ASRRequestError",
      status: 404,
      bodySnippet: "<html><h1>404 Not Found</h1></html>",
    });
  });

  it("keeps successful non-JSON responses as parse errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }))
    );

    await expect(
      transcribeTencentFlash({
        audio: Buffer.from("test"),
        config: {
          appId: "1234567890",
          secretId: "sid",
          secretKey: "skey",
          voiceFormat: "amr",
        },
      })
    ).rejects.toMatchObject<Partial<ASRResponseParseError>>({
      name: "ASRResponseParseError",
      status: 200,
      bodySnippet: "not-json",
    });
  });

  it("falls back to SentenceRecognition when flash returns 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><h1>404 Not Found</h1></html>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          Response: {
            Result: "你好",
            RequestId: "req-1",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeTencentFlash({
        audio: Buffer.from("test"),
        config: {
          appId: "1234567890",
          secretId: "sid",
          secretKey: "skey",
          voiceFormat: "amr",
        },
      })
    ).resolves.toBe("你好");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
