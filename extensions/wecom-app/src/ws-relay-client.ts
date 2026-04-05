/**
 * 企业微信自建应用 WebSocket Relay 客户端
 *
 * 实现 lsbot relay 协议，连接 bot.lingti.com 等中继服务。
 * 重点支持 wecom_raw 模式：relay 转发加密原文，客户端本地解密。
 *
 * 协议参考: https://github.com/ruilisi/lsbot
 */

import crypto from "node:crypto";
import https from "node:https";
import { WebSocket } from "ws";
import { createLogger, type Logger } from "@xuanyue202/shared";

import type { ResolvedWecomAppAccount, WecomAppInboundMessage } from "./types.js";
import type { PluginConfig } from "./config.js";
import type { WecomAppRuntimeEnv } from "./monitor.js";
import { verifyWecomAppSignature, decryptWecomAppEncrypted } from "./crypto.js";
import { parseWecomAppPlainMessage, parseXmlBody, splitMessageByBytes } from "./monitor.js";
import { dispatchWecomAppMessage } from "./bot.js";
import { tryGetWecomAppRuntime } from "./runtime.js";
import { sendWecomAppMessage, stripMarkdown } from "./api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WS_RELAY_URL = "wss://bot.lingti.com/ws";
const DEFAULT_WS_RELAY_WEBHOOK_URL = "https://bot.lingti.com/webhook";
const CLIENT_VERSION = "2.0.4";

const INITIAL_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS = 40_000;
const PING_INTERVAL_MS = 3_000;
const AUTH_TIMEOUT_MS = 10_000;
const PROCESSED_MSG_TTL_MS = 10 * 60 * 1000;
const PROCESSED_MSG_MAX = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Protocol types
// ─────────────────────────────────────────────────────────────────────────────

type RelayAuthMessage = {
  type: "auth";
  user_id: string;
  platform: "wecom";
  client_version: string;
  ai_provider?: string;
  ai_model?: string;
  wecom_corp_id: string;
  wecom_agent_id: string;
  wecom_secret: string;
  wecom_token: string;
  wecom_aes_key: string;
};

type RelayAuthResult = {
  type: "auth_result";
  success: boolean;
  session_id?: string;
  error?: string;
  server_version?: string;
  capabilities?: { media_proxy?: boolean };
};

type RelayWecomRaw = {
  type: "wecom_raw";
  msg_signature: string;
  timestamp: string;
  nonce: string;
  body: string;
};

type RelayMessage = {
  type: "message";
  id: string;
  platform: string;
  channel_id: string;
  user_id: string;
  username: string;
  text: string;
  thread_id?: string;
  metadata?: Record<string, unknown>;
};

type RelayPing = { type: "ping" };
type RelayError = { type: "error"; code: string; message: string };
type RelaySendResult = { type: "send_result"; id: string; ok: boolean; errcode?: number; errmsg?: string };

type RelayInbound = RelayAuthResult | RelayWecomRaw | RelayMessage | RelayPing | RelayError | RelaySendResult;

type RelayResponsePayload = {
  type: "response";
  message_id: string;
  platform: "wecom";
  channel_id: string;
  text?: string;
  files?: Array<{ name: string; media_type: string; data: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Outbound relay sender (module-level singleton)
// ─────────────────────────────────────────────────────────────────────────────

type RelaySendFn = (params: {
  channelId: string;
  text: string;
}) => Promise<{ ok: boolean; errcode?: number; errmsg?: string }>;

let activeRelaySender: RelaySendFn | null = null;

/** Relay media proxy base info (set when connected) */
let activeRelayMediaProxy: {
  /** HTTP(S) base URL of the relay server, e.g. "https://bot.lingti.com" */
  baseUrl: string;
  sessionId: string;
  insecure: boolean;
} | null = null;

/**
 * Check if a ws-relay outbound sender is active.
 * Used by api.ts to decide whether to route through relay.
 */
export function isWsRelayOutboundActive(): boolean {
  return activeRelaySender !== null;
}

/**
 * Get the relay media proxy info (baseUrl + sessionId) when ws-relay is active.
 * Returns null if no relay is active.
 */
export function getWsRelayMediaProxy(): {
  baseUrl: string;
  sessionId: string;
  insecure: boolean;
} | null {
  return activeRelayMediaProxy;
}

/**
 * Send a message through the active ws-relay connection.
 * Returns null if no relay is active (caller should fall back to direct API).
 */
export async function sendViaWsRelay(params: {
  channelId: string;
  text: string;
}): Promise<{ ok: boolean; errcode?: number; errmsg?: string } | null> {
  if (!activeRelaySender) return null;
  return activeRelaySender(params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Processed message deduplication
// ─────────────────────────────────────────────────────────────────────────────

const processedMessages = new Map<string, number>();

function isProcessed(msgId: string): boolean {
  return processedMessages.has(msgId);
}

function markProcessed(msgId: string): void {
  processedMessages.set(msgId, Date.now());
  pruneProcessed();
}

function pruneProcessed(): void {
  if (processedMessages.size <= PROCESSED_MSG_MAX) return;
  const cutoff = Date.now() - PROCESSED_MSG_TTL_MS;
  for (const [id, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook response sender
// ─────────────────────────────────────────────────────────────────────────────

async function sendRelayWebhookResponse(params: {
  webhookUrl: string;
  sessionId: string;
  userId: string;
  payload: RelayResponsePayload;
  logger: Logger;
  insecure?: boolean;
}): Promise<void> {
  const { webhookUrl, sessionId, userId, payload, logger } = params;
  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Session-ID": sessionId,
    "X-User-ID": userId,
  };

  try {
    if (params.insecure && webhookUrl.startsWith("https:")) {
      // Node.js native fetch doesn't support rejectUnauthorized.
      // Use https.request for self-signed cert scenarios.
      await new Promise<void>((resolve, reject) => {
        const url = new URL(webhookUrl);
        const req = https.request({
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          headers,
          rejectUnauthorized: false,
        }, (res) => {
          let data = "";
          res.on("data", (c: Buffer) => { data += c.toString(); });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              logger.error(`relay webhook response failed: ${res.statusCode} ${data}`);
            }
            resolve();
          });
        });
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
      });
    } else {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: bodyStr,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        logger.error(`relay webhook response failed: ${resp.status} ${text}`);
      }
    }
  } catch (err) {
    logger.error(`relay webhook response error: ${String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main client
// ─────────────────────────────────────────────────────────────────────────────

export async function startWecomAppWsRelayClient(opts: {
  cfg: PluginConfig;
  account: ResolvedWecomAppAccount;
  runtime: WecomAppRuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (status: Record<string, unknown>) => void;
}): Promise<void> {
  const { cfg, account, runtime, abortSignal, setStatus } = opts;
  const logger: Logger = createLogger("wecom-app-relay", { log: runtime.log, error: runtime.error });

  const wsUrl = account.wsRelayUrl || DEFAULT_WS_RELAY_URL;
  const webhookUrl = account.wsRelayWebhookUrl || DEFAULT_WS_RELAY_WEBHOOK_URL;
  const userId = account.wsRelayUserId || `openclaw-${account.accountId}-${crypto.randomBytes(4).toString("hex")}`;
  const reconnectBaseMs = account.config.wsRelayReconnectMs ?? INITIAL_RECONNECT_MS;
  const insecure = account.wsRelayInsecure ?? false;

  if (insecure) {
    logger.info("TLS certificate verification disabled (wsRelayInsecure=true)");
  }

  if (!account.corpId || !account.corpSecret || !account.token || !account.encodingAESKey || account.agentId == null) {
    logger.error("ws-relay mode requires corpId, corpSecret, token, encodingAESKey, agentId");
    setStatus?.({ running: false, configured: false, error: "missing required credentials" });
    return;
  }

  let sessionId = "";
  let reconnectDelay = reconnectBaseMs;
  let stopping = false;

  if (abortSignal?.aborted) return;

  const connect = (): Promise<void> => {
    return new Promise<void>((resolveConnect) => {
      if (stopping || abortSignal?.aborted) {
        resolveConnect();
        return;
      }

      logger.info(`connecting to relay: ${wsUrl}`);
      setStatus?.({ connectionState: "connecting", wsRelayUrl: wsUrl });

      let ws: WebSocket;
      try {
        ws = insecure
          ? new WebSocket(wsUrl, { rejectUnauthorized: false })
          : new WebSocket(wsUrl);
      } catch (err) {
        logger.error(`ws connect error: ${String(err)}`);
        resolveConnect();
        return;
      }

      let authenticated = false;
      let authTimer: ReturnType<typeof setTimeout> | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      // Pending outbound request callbacks (keyed by request id)
      const pendingSendRequests = new Map<string, {
        resolve: (result: { ok: boolean; errcode?: number; errmsg?: string }) => void;
        timer: ReturnType<typeof setTimeout>;
      }>();

      const SEND_TIMEOUT_MS = 30_000;

      const cleanup = () => {
        if (authTimer) clearTimeout(authTimer);
        if (pingTimer) clearInterval(pingTimer);
        authTimer = undefined;
        pingTimer = undefined;
      };

      const closeConnection = () => {
        cleanup();
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "client shutdown");
          }
        } catch {
          // ignore
        }
      };

      const onAbort = () => {
        stopping = true;
        closeConnection();
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        logger.info("ws connected, sending auth");
        setStatus?.({ connectionState: "authenticating" });

        const authMsg: RelayAuthMessage = {
          type: "auth",
          user_id: userId,
          platform: "wecom",
          client_version: CLIENT_VERSION,
          wecom_corp_id: account.corpId!,
          wecom_agent_id: String(account.agentId),
          wecom_secret: account.corpSecret!,
          wecom_token: account.token!,
          wecom_aes_key: account.encodingAESKey!,
        };

        ws.send(JSON.stringify(authMsg));

        authTimer = setTimeout(() => {
          if (!authenticated) {
            logger.error("auth timeout");
            closeConnection();
          }
        }, AUTH_TIMEOUT_MS);
      });

      ws.on("message", (data: Buffer | string) => {
        let parsed: RelayInbound;
        try {
          const text = typeof data === "string" ? data : data.toString("utf8");
          parsed = JSON.parse(text) as RelayInbound;
        } catch {
          logger.error("invalid relay message");
          return;
        }

        switch (parsed.type) {
          case "auth_result":
            handleAuthResult(parsed);
            break;
          case "wecom_raw":
            handleWecomRaw(parsed);
            break;
          case "message":
            handleMessage(parsed);
            break;
          case "send_result":
            handleSendResult(parsed);
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "error":
            logger.error(`relay error: [${parsed.code}] ${parsed.message}`);
            break;
          default:
            break;
        }
      });

      ws.on("close", (code, reason) => {
        cleanup();
        // Clear outbound relay sender and media proxy info
        activeRelaySender = null;
        activeRelayMediaProxy = null;
        // Reject all pending send requests
        for (const [id, pending] of pendingSendRequests) {
          clearTimeout(pending.timer);
          pending.resolve({ ok: false, errcode: -1, errmsg: "ws-relay disconnected" });
        }
        pendingSendRequests.clear();

        abortSignal?.removeEventListener("abort", onAbort);
        const reasonStr = reason?.toString("utf8") ?? "";
        logger.info(`ws closed: code=${code} reason=${reasonStr}`);
        setStatus?.({ connectionState: "disconnected", lastDisconnectAt: Date.now() });
        authenticated = false;
        resolveConnect();
      });

      ws.on("error", (err) => {
        logger.error(`ws error: ${String(err)}`);
      });

      // ── Auth result handler ──
      function handleAuthResult(msg: RelayAuthResult): void {
        if (authTimer) clearTimeout(authTimer);
        authTimer = undefined;

        if (!msg.success) {
          logger.error(`auth failed: ${msg.error ?? "unknown"}`);
          setStatus?.({ connectionState: "auth_failed", error: msg.error });
          closeConnection();
          return;
        }

        authenticated = true;
        sessionId = msg.session_id ?? "";
        reconnectDelay = reconnectBaseMs;
        const serverVer = msg.server_version ? ` server=${msg.server_version}` : "";
        logger.info(`auth success, sessionId=${sessionId}${serverVer}`);
        setStatus?.({
          connectionState: "connected",
          running: true,
          configured: true,
          sessionId,
          lastConnectAt: Date.now(),
        });

        // Register relay media proxy info only if the relay server declares media_proxy capability
        if (msg.capabilities?.media_proxy) {
          const urlObj = new URL(webhookUrl);
          activeRelayMediaProxy = {
            baseUrl: `${urlObj.protocol}//${urlObj.host}`,
            sessionId,
            insecure,
          };
          logger.info("relay supports media_proxy, registered proxy info");
        } else {
          activeRelayMediaProxy = null;
          logger.info("relay does not advertise media_proxy capability, media downloads will go direct");
        }

        // Register outbound relay sender so api.ts can route through relay
        activeRelaySender = async (params) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return { ok: false, errcode: -1, errmsg: "ws-relay not connected" };
          }
          const requestId = `send_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              pendingSendRequests.delete(requestId);
              resolve({ ok: false, errcode: -1, errmsg: "send_message timeout" });
            }, SEND_TIMEOUT_MS);
            pendingSendRequests.set(requestId, { resolve, timer });
            ws.send(JSON.stringify({
              type: "send_message",
              id: requestId,
              platform: "wecom",
              channel_id: params.channelId,
              text: params.text,
            }));
          });
        };

        // Start ping interval
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        }, PING_INTERVAL_MS);
      }

      // ── send_result handler ──
      function handleSendResult(msg: RelaySendResult): void {
        const pending = pendingSendRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingSendRequests.delete(msg.id);
          pending.resolve({ ok: msg.ok, errcode: msg.errcode, errmsg: msg.errmsg });
        }
      }

      // ── wecom_raw message handler (本地解密) ──
      function handleWecomRaw(raw: RelayWecomRaw): void {
        if (!authenticated) return;

        // Extract encrypted content from XML body
        const xmlData = parseXmlBody(raw.body);
        const encrypt = xmlData.Encrypt ?? "";
        if (!encrypt) {
          logger.error("wecom_raw: no Encrypt field in XML body");
          return;
        }

        // Verify signature
        const valid = verifyWecomAppSignature({
          token: account.token!,
          timestamp: raw.timestamp,
          nonce: raw.nonce,
          encrypt,
          signature: raw.msg_signature,
        });
        if (!valid) {
          logger.error("wecom_raw: signature verification failed");
          return;
        }

        // Decrypt
        let plaintext: string;
        try {
          plaintext = decryptWecomAppEncrypted({
            encodingAESKey: account.encodingAESKey!,
            receiveId: account.receiveId,
            encrypt,
          });
        } catch (err) {
          logger.error(`wecom_raw: decryption failed: ${String(err)}`);
          return;
        }

        // Parse message
        const msg = parseWecomAppPlainMessage(plaintext);
        processInboundMessage(msg);
      }

      // ── Parsed message handler (relay 已解密) ──
      function handleMessage(relayMsg: RelayMessage): void {
        if (!authenticated) return;

        // Construct a WecomAppInboundMessage from relay's parsed format
        const msg: WecomAppInboundMessage = {
          msgtype: relayMsg.metadata?.msg_type as string ?? "text",
          MsgType: relayMsg.metadata?.msg_type as string ?? "text",
          msgid: relayMsg.id,
          MsgId: relayMsg.id,
          from: { userid: relayMsg.user_id },
          FromUserName: relayMsg.user_id,
          Content: relayMsg.text,
          content: relayMsg.text,
          // image fields from metadata
          PicUrl: relayMsg.metadata?.pic_url as string | undefined,
          MediaId: relayMsg.metadata?.media_id as string | undefined,
          image: relayMsg.metadata?.pic_url ? { url: relayMsg.metadata.pic_url as string } : undefined,
          // voice fields
          Format: relayMsg.metadata?.format as string | undefined,
          Recognition: relayMsg.metadata?.recognition as string | undefined,
        } as WecomAppInboundMessage;

        processInboundMessage(msg);
      }

      // ── Common inbound message processing ──
      function processInboundMessage(msg: WecomAppInboundMessage): void {
        const msgtype = String(msg.msgtype ?? msg.MsgType ?? "").toLowerCase();
        const msgid = msg.msgid ?? msg.MsgId ? String(msg.msgid ?? msg.MsgId) : undefined;

        // Skip stream refresh (relay handles it)
        if (msgtype === "stream") return;

        // Deduplication
        if (msgid && isProcessed(msgid)) {
          logger.info(`duplicate message skipped: ${msgid}`);
          return;
        }
        if (msgid) markProcessed(msgid);

        // Event messages (welcome etc.)
        if (msgtype === "event") {
          handleEventMessage(msg);
          return;
        }

        setStatus?.({ lastInboundAt: Date.now() });

        const senderId = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim() ?? "unknown";

        const core = tryGetWecomAppRuntime();
        if (!core) {
          logger.error("runtime not initialized, cannot dispatch");
          return;
        }

        // Accumulate response text and send via relay webhook when done
        let responseText = "";

        const hooks = {
          onChunk: (text: string) => {
            responseText += text;
          },
          onError: (err: unknown) => {
            logger.error(`dispatch error: ${String(err)}`);
          },
        };

        dispatchWecomAppMessage({
          cfg,
          account,
          msg,
          core,
          hooks,
          log: runtime.log,
          error: runtime.error,
        })
          .then(async () => {
            if (!responseText.trim()) return;
            setStatus?.({ lastOutboundAt: Date.now() });

            // Split long responses: enterprise wechat limits each message to 2048 bytes.
            // The relay webhook forwards each payload as a separate wecom message, so we
            // must chunk here rather than sending the full text in one payload.
            const chunks = splitMessageByBytes(stripMarkdown(responseText), 2048);
            for (const chunk of chunks) {
              if (!chunk.trim()) continue;
              await sendRelayWebhookResponse({
                webhookUrl,
                sessionId,
                userId,
                payload: {
                  type: "response",
                  message_id: msgid ?? "",
                  platform: "wecom",
                  channel_id: senderId,
                  text: chunk,
                },
                logger,
                insecure,
              });
            }
          })
          .catch((err) => {
            logger.error(`dispatch failed: ${String(err)}`);
          });
      }

      // ── Event message handler ──
      function handleEventMessage(msg: WecomAppInboundMessage): void {
        const eventtype = String(
          (msg as { event?: { eventtype?: string }; Event?: string }).event?.eventtype ??
          (msg as { Event?: string }).Event ?? ""
        ).toLowerCase();

        if (eventtype === "enter_chat" || eventtype === "subscribe") {
          const welcome = account.config.welcomeText?.trim();
          const senderId = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim();
          if (welcome && account.canSendActive && senderId) {
            sendWecomAppMessage(account, { userId: senderId }, welcome).catch((err) => {
              logger.error(`failed to send welcome: ${String(err)}`);
            });
          }
        }
      }
    });
  };

  // ── Reconnection loop ──
  while (!stopping && !abortSignal?.aborted) {
    await connect();

    if (stopping || abortSignal?.aborted) break;

    logger.info(`reconnecting in ${reconnectDelay}ms`);
    setStatus?.({ connectionState: "reconnecting", reconnectDelay });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, reconnectDelay);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });

    // Exponential backoff
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  activeRelaySender = null;
  activeRelayMediaProxy = null;
  setStatus?.({ running: false, connectionState: "stopped", lastStopAt: Date.now() });
  logger.info("ws-relay client stopped");
}
