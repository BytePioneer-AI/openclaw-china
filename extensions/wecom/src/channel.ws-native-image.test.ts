import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@wecom/aibot-node-sdk", async () => await import("./test-sdk-mock.js"));

import { wecomPlugin } from "./channel.js";
import type { PluginConfig } from "./config.js";
import { clearOutboundReplyState, setAccountPublicBaseUrl } from "./outbound-reply.js";
import {
  clearWecomWsReplyContextsForAccount,
  finishWecomWsMessageContext,
  registerWecomWsMessageContext,
  registerWecomWsPendingAutoImagePaths,
} from "./ws-reply-context.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pG8L1cAAAAASUVORK5CYII=";

describe("wecom channel ws native image reply", () => {
  afterEach(() => {
    clearWecomWsReplyContextsForAccount("default");
    clearOutboundReplyState();
  });

  it("sends local png through ws msg_item without requiring a public url", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-native-image-"));
    const imagePath = path.join(tempDir, "reply.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "default",
      reqId: "req-native-image",
      to: "user:alice",
      streamId: "stream-native-image",
      send: async (frame) => {
        sent.push(frame);
      },
    });

    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          botId: "bot-1",
          secret: "secret-1",
        },
      },
    };

    const result = await wecomPlugin.outbound.sendMedia({
      cfg,
      to: "user:alice",
      mediaUrl: imagePath,
      text: "caption",
    });

    expect(result.ok).toBe(true);
    await finishWecomWsMessageContext({
      accountId: "default",
      reqId: "req-native-image",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      body: {
        stream: {
          id: "stream-native-image",
          finish: false,
          content: "caption",
        },
      },
    });
    expect(sent[1]).toMatchObject({
      body: {
        stream: {
          id: "stream-native-image",
          finish: true,
          content: "caption",
          msg_item: [
            {
              msgtype: "image",
              image: {
                base64: expect.any(String),
                md5: expect.any(String),
              },
            },
          ],
        },
      },
    });
  });

  it("can force local ws image replies through markdown urls", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-markdown-image-"));
    const imagePath = path.join(tempDir, "reply.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "default",
      reqId: "req-markdown-image",
      to: "user:alice",
      streamId: "stream-markdown-image",
      send: async (frame) => {
        sent.push(frame);
      },
    });
    setAccountPublicBaseUrl("default", "https://example.test");

    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          botId: "bot-1",
          secret: "secret-1",
          wsImageReplyMode: "markdown-url",
        },
      },
    };

    const result = await wecomPlugin.outbound.sendMedia({
      cfg,
      to: "user:alice",
      mediaUrl: imagePath,
      text: "caption",
    });

    expect(result.ok).toBe(true);
    await finishWecomWsMessageContext({
      accountId: "default",
      reqId: "req-markdown-image",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      body: {
        stream: {
          id: "stream-markdown-image",
          finish: false,
        },
      },
    });
    expect(JSON.stringify(sent[0])).toContain("caption");
    expect(JSON.stringify(sent[0])).toContain("![](https://example.test/wecom-media/");
    expect(sent[1]).toMatchObject({
      body: {
        stream: {
          id: "stream-markdown-image",
          finish: true,
        },
      },
    });
    expect(JSON.stringify(sent[1])).not.toContain("\"msg_item\"");
  });

  it("auto-attaches pending inbound images when the agent only sends text", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-auto-image-"));
    const imagePath = path.join(tempDir, "reply.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

    const sent: unknown[] = [];
    registerWecomWsMessageContext({
      accountId: "default",
      reqId: "req-auto-image",
      to: "user:alice",
      streamId: "stream-auto-image",
      send: async (frame) => {
        sent.push(frame);
      },
    });
    registerWecomWsPendingAutoImagePaths({
      accountId: "default",
      to: "user:alice",
      imagePaths: [imagePath],
    });

    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          botId: "bot-1",
          secret: "secret-1",
        },
      },
    };

    const result = await wecomPlugin.outbound.sendText({
      cfg,
      to: "user:alice",
      text: "caption",
    });

    expect(result.ok).toBe(true);
    await finishWecomWsMessageContext({
      accountId: "default",
      reqId: "req-auto-image",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      body: {
        stream: {
          id: "stream-auto-image",
          finish: false,
          content: "caption",
        },
      },
    });
    expect(sent[1]).toMatchObject({
      body: {
        stream: {
          id: "stream-auto-image",
          finish: true,
          content: "caption",
          msg_item: [
            {
              msgtype: "image",
              image: {
                base64: expect.any(String),
                md5: expect.any(String),
              },
            },
          ],
        },
      },
    });
  });
});
