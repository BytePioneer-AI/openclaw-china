import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

vi.mock("@wecom/aibot-node-sdk", async () => await import("./test-sdk-mock.js"));

import { resolveWecomAccount, type PluginConfig } from "./config.js";
import { clearWecomRuntime, setWecomRuntime } from "./runtime.js";
import {
  sendWecomWsProactiveMarkdown,
  startWecomWsGateway,
  stopWecomWsGatewayForAccount,
} from "./ws-gateway.js";
import type { WecomWsFrame } from "./ws-protocol.js";

async function waitFor(condition: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("wecom ws gateway", () => {
  afterEach(() => {
    stopWecomWsGatewayForAccount("default");
    clearWecomRuntime();
  });

  it("subscribes, heartbeats, and proactively sends after activation", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");

    const received: WecomWsFrame[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as WecomWsFrame;
        received.push(frame);
        if (frame.cmd === "aibot_subscribe" || frame.cmd === "aibot_send_msg" || frame.cmd === "ping") {
          socket.send(
            JSON.stringify({
              cmd: frame.cmd,
              headers: {
                req_id: frame.headers?.req_id,
              },
              errcode: 0,
            })
          );
        }
      });
    });

    const { port } = server.address() as AddressInfo;
    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          botId: "bot-1",
          secret: "secret-1",
          wsUrl: `ws://127.0.0.1:${port}`,
          heartbeatIntervalMs: 20,
          reconnectInitialDelayMs: 10,
          reconnectMaxDelayMs: 40,
        },
      },
    };
    const account = resolveWecomAccount({ cfg, accountId: "default" });
    const statuses: Array<Record<string, unknown>> = [];
    const controller = new AbortController();

    const gatewayPromise = startWecomWsGateway({
      cfg,
      account,
      abortSignal: controller.signal,
      runtime: {
        log: () => {},
        error: () => {},
      },
      setStatus: (status) => {
        statuses.push(status);
      },
    });

    await waitFor(
      () =>
        received.some((frame) => frame.cmd === "aibot_subscribe") &&
        statuses.some((status) => status.connectionState === "ready")
    );
    await waitFor(() => received.some((frame) => frame.cmd === "ping"));

    const client = [...server.clients][0];
    client?.send(
      JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: {
          req_id: "req-callback-1",
        },
        body: {
          msgid: "msg-1",
          chattype: "single",
          from: { userid: "user-1" },
          msgtype: "text",
          text: { content: "hello" },
        },
      })
    );

    await waitFor(() => statuses.some((status) => typeof status.lastInboundAt === "number"));

    await sendWecomWsProactiveMarkdown({
      accountId: account.accountId,
      to: "user:user-1",
      content: "follow-up",
    });

    await waitFor(() => received.some((frame) => frame.cmd === "aibot_send_msg"));
    expect(received.find((frame) => frame.cmd === "aibot_send_msg")?.body).toEqual({
      chatid: "user-1",
      msgtype: "markdown",
      markdown: {
        content: "follow-up",
      },
    });

    controller.abort();
    await expect(gatewayPromise).resolves.toBeUndefined();
    expect(statuses.some((status) => status.running === false)).toBe(true);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it("rejects proactive send before the conversation is activated", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");

    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as WecomWsFrame;
        if (frame.cmd === "aibot_subscribe") {
          socket.send(
            JSON.stringify({
              cmd: frame.cmd,
              headers: {
                req_id: frame.headers?.req_id,
              },
              errcode: 0,
            })
          );
        }
      });
    });

    const { port } = server.address() as AddressInfo;
    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          botId: "bot-1",
          secret: "secret-1",
          wsUrl: `ws://127.0.0.1:${port}`,
          heartbeatIntervalMs: 20,
        },
      },
    };
    const account = resolveWecomAccount({ cfg, accountId: "default" });
    const controller = new AbortController();
    const gatewayPromise = startWecomWsGateway({
      cfg,
      account,
      abortSignal: controller.signal,
      runtime: {
        log: () => {},
        error: () => {},
      },
    });

    await waitFor(() => server.clients.size === 1);
    await expect(
      sendWecomWsProactiveMarkdown({
        accountId: account.accountId,
        to: "user:never-seen",
        content: "follow-up",
      })
    ).rejects.toThrow("No activated WeCom ws conversation found");

    controller.abort();
    await expect(gatewayPromise).resolves.toBeUndefined();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it("sends a placeholder frame after acceptance and then overwrites it with the real reply", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");

    const received: WecomWsFrame[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as WecomWsFrame;
        received.push(frame);
        if (frame.cmd === "aibot_msg_callback" || frame.cmd === "aibot_event_callback") {
          return;
        }
        socket.send(
          JSON.stringify({
            cmd: frame.cmd,
            headers: {
              req_id: frame.headers?.req_id,
            },
            errcode: 0,
          })
        );
      });
    });

    const { port } = server.address() as AddressInfo;
    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          dmPolicy: "open",
          botId: "bot-1",
          secret: "secret-1",
          wsUrl: `ws://127.0.0.1:${port}`,
          heartbeatIntervalMs: 20,
          reconnectInitialDelayMs: 10,
          reconnectMaxDelayMs: 40,
        },
      },
    };
    const account = resolveWecomAccount({ cfg, accountId: "default" });
    setWecomRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "session-1",
            accountId: account.accountId,
          }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            await dispatcherOptions.deliver({
              text: "final answer",
            });
          },
        },
      },
    });

    const controller = new AbortController();
    const gatewayPromise = startWecomWsGateway({
      cfg,
      account,
      abortSignal: controller.signal,
      runtime: {
        log: () => {},
        error: () => {},
      },
    });

    await waitFor(() => received.some((frame) => frame.cmd === "aibot_subscribe"));

    const client = [...server.clients][0];
    client?.send(
      JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: {
          req_id: "req-placeholder-1",
        },
        body: {
          msgid: "msg-placeholder-1",
          chattype: "single",
          from: { userid: "user-1" },
          msgtype: "text",
          text: { content: "hello" },
        },
      })
    );

    await waitFor(() =>
      received.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.body).length >= 2
    );

    const replies = received.filter((frame) => frame.cmd === "aibot_respond_msg");
    expect(replies[0]).toMatchObject({
      headers: { req_id: "req-placeholder-1" },
      body: {
        msgtype: "stream",
        stream: {
          finish: false,
          content: "⏳",
        },
      },
    });
    expect(replies[1]).toMatchObject({
      headers: { req_id: "req-placeholder-1" },
      body: {
        msgtype: "stream",
        stream: {
          finish: false,
          content: "final answer",
        },
      },
    });
    expect(
      (replies[0].body as { stream?: { id?: string } }).stream?.id
    ).toBe(
      (replies[1].body as { stream?: { id?: string } }).stream?.id
    );

    controller.abort();
    await expect(gatewayPromise).resolves.toBeUndefined();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it("does not send a placeholder frame when the message is rejected before dispatch", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");

    const received: WecomWsFrame[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as WecomWsFrame;
        received.push(frame);
        if (frame.cmd === "aibot_msg_callback" || frame.cmd === "aibot_event_callback") {
          return;
        }
        socket.send(
          JSON.stringify({
            cmd: frame.cmd,
            headers: {
              req_id: frame.headers?.req_id,
            },
            errcode: 0,
          })
        );
      });
    });

    const { port } = server.address() as AddressInfo;
    const cfg: PluginConfig = {
      channels: {
        wecom: {
          mode: "ws",
          dmPolicy: "disabled",
          botId: "bot-1",
          secret: "secret-1",
          wsUrl: `ws://127.0.0.1:${port}`,
          heartbeatIntervalMs: 20,
          reconnectInitialDelayMs: 10,
          reconnectMaxDelayMs: 40,
        },
      },
    };
    const account = resolveWecomAccount({ cfg, accountId: "default" });
    setWecomRuntime({
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            sessionKey: "session-1",
            accountId: account.accountId,
          }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({
              text: "should not happen",
            });
          },
        },
      },
    });

    const controller = new AbortController();
    const gatewayPromise = startWecomWsGateway({
      cfg,
      account,
      abortSignal: controller.signal,
      runtime: {
        log: () => {},
        error: () => {},
      },
    });

    await waitFor(() => received.some((frame) => frame.cmd === "aibot_subscribe"));

    const client = [...server.clients][0];
    client?.send(
      JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: {
          req_id: "req-disabled-1",
        },
        body: {
          msgid: "msg-disabled-1",
          chattype: "single",
          from: { userid: "user-1" },
          msgtype: "text",
          text: { content: "hello" },
        },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.filter((frame) => frame.cmd === "aibot_respond_msg")).toHaveLength(0);

    controller.abort();
    await expect(gatewayPromise).resolves.toBeUndefined();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
});
