import { EventEmitter } from "node:events";
import crypto from "node:crypto";

import WebSocket from "ws";

type WsFrame = {
  cmd?: string;
  headers?: {
    req_id?: string;
    [key: string]: unknown;
  };
  body?: unknown;
  errcode?: number;
  errmsg?: string;
};

type PendingResolver = {
  resolve: (frame: WsFrame) => void;
  reject: (err: Error) => void;
};

export class WSClient extends EventEmitter {
  private readonly botId: string;
  private readonly secret: string;
  private readonly wsUrl: string;
  private readonly heartbeatInterval: number;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingResolver>();

  constructor(options: {
    botId?: string;
    secret?: string;
    wsUrl?: string;
    heartbeatInterval?: number;
  }) {
    super();
    this.botId = String(options.botId ?? "");
    this.secret = String(options.secret ?? "");
    this.wsUrl = String(options.wsUrl ?? "");
    this.heartbeatInterval = Number(options.heartbeatInterval ?? 30_000);
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): this {
    this.socket = new WebSocket(this.wsUrl);

    this.socket.on("open", () => {
      this.emit("connected");
      void this.sendFrame({
        cmd: "aibot_subscribe",
        headers: {
          req_id: crypto.randomUUID(),
        },
        body: {
          bot_id: this.botId,
          secret: this.secret,
        },
      }).then(() => {
        this.emit("authenticated");
      }).catch((err) => {
        this.emit("error", err);
      });

      if (this.heartbeatInterval > 0) {
        this.heartbeatTimer = setInterval(() => {
          void this.sendFrame({
            cmd: "ping",
            headers: {
              req_id: crypto.randomUUID(),
            },
          }).catch(() => undefined);
        }, this.heartbeatInterval);
      }
    });

    this.socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      const cmd = String(frame.cmd ?? "").trim();
      if (cmd === "aibot_msg_callback") {
        this.emit("message", frame);
        return;
      }
      if (cmd === "aibot_event_callback") {
        this.emit("event", frame);
        return;
      }

      const reqId = String(frame.headers?.req_id ?? "").trim();
      if (!reqId) return;
      const pending = this.pending.get(reqId);
      if (!pending) return;
      this.pending.delete(reqId);
      pending.resolve(frame);
    });

    this.socket.on("close", () => {
      this.clearHeartbeat();
      this.emit("disconnected", "closed");
    });

    this.socket.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });

    return this;
  }

  disconnect(): void {
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  async reply(frame: { headers?: { req_id?: string } }, body: Record<string, unknown>, cmd = "aibot_respond_msg"): Promise<WsFrame> {
    const reqId = String(frame.headers?.req_id ?? "").trim();
    if (!reqId) {
      throw new Error("mock WSClient.reply requires req_id");
    }
    return this.sendFrame({
      cmd,
      headers: {
        req_id: reqId,
      },
      body,
    });
  }

  async replyWelcome(frame: { headers?: { req_id?: string } }, body: Record<string, unknown>): Promise<WsFrame> {
    return this.reply(frame, body, "aibot_respond_welcome_msg");
  }

  async sendMessage(chatid: string, body: Record<string, unknown>): Promise<WsFrame> {
    return this.sendFrame({
      cmd: "aibot_send_msg",
      headers: {
        req_id: crypto.randomUUID(),
      },
      body: {
        chatid,
        ...body,
      },
    });
  }

  private async sendFrame(frame: WsFrame): Promise<WsFrame> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("mock WSClient socket is not connected");
    }

    const reqId = String(frame.headers?.req_id ?? "").trim();
    return new Promise<WsFrame>((resolve, reject) => {
      if (reqId) {
        this.pending.set(reqId, { resolve, reject });
      }

      socket.send(JSON.stringify(frame), (err) => {
        if (!err) return;
        if (reqId) {
          this.pending.delete(reqId);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

const AiBot = {
  WSClient,
};

export default AiBot;
