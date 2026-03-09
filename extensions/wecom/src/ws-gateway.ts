import { WSClient, type SendMsgBody, type WsFrame as SdkWsFrame } from "@wecom/aibot-node-sdk";

import type { PluginConfig } from "./config.js";
import { createLogger, type Logger } from "@openclaw-china/shared";
import type { ResolvedWecomAccount } from "./types.js";
import { dispatchWecomMessage } from "./bot.js";
import { tryGetWecomRuntime } from "./runtime.js";
import {
  appendWecomWsActiveStreamChunk,
  appendWecomWsActiveStreamReply,
  bindWecomWsRouteContext,
  clearWecomWsReplyContextsForAccount,
  registerWecomWsEventContext,
  registerWecomWsMessageContext,
  scheduleWecomWsMessageContextFinish,
} from "./ws-reply-context.js";
import { normalizeWecomWsCallback, type WecomWsFrame } from "./ws-protocol.js";

type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export interface StartWecomWsGatewayOptions {
  cfg: PluginConfig;
  account: ResolvedWecomAccount;
  runtime?: WecomRuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (status: Record<string, unknown>) => void;
}

type ActiveConnection = {
  client: WSClient | null;
  promise: Promise<void> | null;
  stop: (() => void) | null;
};

const activeConnections = new Map<string, ActiveConnection>();
const processedMessageIds = new Map<string, number>();
const PROCESSED_MESSAGE_TTL_MS = 10 * 60 * 1000;
const activatedTargets = new Map<
  string,
  {
    chatId: string;
    lastInboundAt: number;
    chatType: "single" | "group";
  }
>();

function getOrCreateConnection(accountId: string): ActiveConnection {
  let conn = activeConnections.get(accountId);
  if (!conn) {
    conn = {
      client: null,
      promise: null,
      stop: null,
    };
    activeConnections.set(accountId, conn);
  }
  return conn;
}

function buildLogger(runtime?: WecomRuntimeEnv): Logger {
  return createLogger("wecom", {
    log: runtime?.log,
    error: runtime?.error,
  });
}

function pruneProcessedMessages(accountId: string): void {
  const cutoff = Date.now() - PROCESSED_MESSAGE_TTL_MS;
  for (const [key, ts] of processedMessageIds.entries()) {
    if (!key.startsWith(`${accountId}::`)) continue;
    if (ts < cutoff) {
      processedMessageIds.delete(key);
    }
  }
}

function markProcessedMessage(accountId: string, msgId?: string): boolean {
  const trimmed = msgId?.trim();
  if (!trimmed) return false;
  pruneProcessedMessages(accountId);
  const key = `${accountId}::${trimmed}`;
  if (processedMessageIds.has(key)) {
    return true;
  }
  processedMessageIds.set(key, Date.now());
  return false;
}

function activatedTargetKey(accountId: string, to: string): string {
  return `${accountId}::${to}`;
}

function rememberActivatedTarget(accountId: string, to: string): void {
  const trimmedTo = to.trim();
  if (!trimmedTo) return;
  let chatType: "single" | "group" = "single";
  let chatId = "";
  if (trimmedTo.startsWith("group:")) {
    chatType = "group";
    chatId = trimmedTo.slice("group:".length).trim();
  } else if (trimmedTo.startsWith("user:")) {
    chatId = trimmedTo.slice("user:".length).trim();
  }
  if (!chatId) return;
  activatedTargets.set(activatedTargetKey(accountId.trim(), trimmedTo), {
    chatId,
    lastInboundAt: Date.now(),
    chatType,
  });
}

function getActivatedTarget(accountId: string, to: string): { chatId: string; lastInboundAt: number; chatType: "single" | "group" } | null {
  return activatedTargets.get(activatedTargetKey(accountId.trim(), to.trim())) ?? null;
}

function clearActivatedTargetsForAccount(accountId: string): void {
  const prefix = `${accountId.trim()}::`;
  for (const key of activatedTargets.keys()) {
    if (key.startsWith(prefix)) {
      activatedTargets.delete(key);
    }
  }
}

function formatLogMessage(message: string, args: unknown[]): string {
  if (args.length === 0) return message;
  const suffix = args
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
  return `${message} ${suffix}`.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function summarizeWecomReplyFrame(frame: WecomWsFrame): string {
  const body = asRecord(frame.body);
  const summary: Record<string, unknown> = {
    cmd: frame.cmd ?? "",
    reqId: frame.headers?.req_id ?? "",
    msgtype: typeof body.msgtype === "string" ? body.msgtype : undefined,
  };
  const stream = asRecord(body.stream);
  if (Object.keys(stream).length > 0) {
    const msgItems = Array.isArray(stream.msg_item) ? stream.msg_item : [];
    summary.stream = {
      id: typeof stream.id === "string" ? stream.id : undefined,
      finish: Boolean(stream.finish),
      contentLength:
        typeof stream.content === "string" ? Buffer.byteLength(stream.content, "utf8") : 0,
      msgItemCount: msgItems.length,
      msgItems: msgItems.map((item) => {
        const msgItem = asRecord(item);
        const image = asRecord(msgItem.image);
        return {
          msgtype: typeof msgItem.msgtype === "string" ? msgItem.msgtype : undefined,
          base64Length:
            typeof image.base64 === "string" ? image.base64.length : undefined,
          md5: typeof image.md5 === "string" ? image.md5 : undefined,
        };
      }),
    };
  }
  return JSON.stringify(summary);
}

function createSdkLogger(logger: Logger) {
  return {
    debug(message: string, ...args: unknown[]) {
      logger.debug(formatLogMessage(message, args));
    },
    info(message: string, ...args: unknown[]) {
      logger.info(formatLogMessage(message, args));
    },
    warn(message: string, ...args: unknown[]) {
      logger.warn(formatLogMessage(message, args));
    },
    error(message: string, ...args: unknown[]) {
      logger.error(formatLogMessage(message, args));
    },
  };
}

function requireActiveClient(accountId: string): WSClient {
  const conn = activeConnections.get(accountId);
  if (!conn?.client) {
    throw new Error(`WeCom ws gateway is not active for account ${accountId}`);
  }
  return conn.client;
}

function toWecomWsFrame(frame: SdkWsFrame | WecomWsFrame): WecomWsFrame {
  return frame as unknown as WecomWsFrame;
}

function buildHeaders(reqId: string): { headers: { req_id: string } } {
  return {
    headers: {
      req_id: reqId,
    },
  };
}

async function sendSdkReplyFrame(params: {
  client: WSClient;
  frame: WecomWsFrame;
  logger: Logger;
}): Promise<void> {
  const reqId = String(params.frame.headers?.req_id ?? "").trim();
  if (!reqId) {
    throw new Error("WeCom ws reply frame missing req_id");
  }
  params.logger.debug(`[wecom] ws reply frame: ${summarizeWecomReplyFrame(params.frame)}`);
  const response = await params.client.reply(
    buildHeaders(reqId),
    (params.frame.body ?? {}) as Record<string, unknown>,
    params.frame.cmd
  );
  if (typeof response.errcode === "number" && response.errcode !== 0) {
    throw new Error(`WeCom ws reply failed: ${response.errcode} ${response.errmsg ?? ""}`.trim());
  }
}

async function sendWecomWsProactiveCommand(params: {
  accountId: string;
  to: string;
  body: SendMsgBody;
}): Promise<void> {
  const activated = getActivatedTarget(params.accountId, params.to);
  if (!activated) {
    throw new Error(
      `No activated WeCom ws conversation found for ${params.to}. The user or group must have sent at least one message in this runtime before proactive send is allowed.`
    );
  }
  const client = requireActiveClient(params.accountId);
  const response = await client.sendMessage(activated.chatId, params.body);
  if (typeof response.errcode === "number" && response.errcode !== 0) {
    throw new Error(`WeCom proactive send failed: ${response.errcode} ${response.errmsg ?? ""}`.trim());
  }
}

export async function sendWecomWsProactiveMarkdown(params: {
  accountId: string;
  to: string;
  content: string;
}): Promise<void> {
  await sendWecomWsProactiveCommand({
    accountId: params.accountId,
    to: params.to,
    body: {
      msgtype: "markdown",
      markdown: {
        content: params.content,
      },
    },
  });
}

export async function sendWecomWsProactiveTemplateCard(params: {
  accountId: string;
  to: string;
  templateCard: Record<string, unknown>;
}): Promise<void> {
  await sendWecomWsProactiveCommand({
    accountId: params.accountId,
    to: params.to,
    body: {
      msgtype: "template_card",
      template_card: params.templateCard as SendMsgBody extends { template_card: infer T } ? T : never,
    },
  });
}

export async function startWecomWsGateway(opts: StartWecomWsGatewayOptions): Promise<void> {
  const { account, cfg, runtime, abortSignal, setStatus } = opts;
  const logger = buildLogger(runtime);
  const conn = getOrCreateConnection(account.accountId);

  if (conn.client) {
    if (conn.promise) {
      return conn.promise;
    }
    throw new Error(`WeCom ws gateway state invalid for account ${account.accountId}`);
  }

  conn.promise = new Promise<void>((resolve, reject) => {
    let finished = false;

    const client = new WSClient({
      botId: account.botId ?? "",
      secret: account.secret ?? "",
      wsUrl: account.wsUrl,
      heartbeatInterval: account.heartbeatIntervalMs,
      reconnectInterval: account.reconnectInitialDelayMs,
      maxReconnectAttempts: -1,
      logger: createSdkLogger(logger),
    });
    conn.client = client;

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      abortSignal?.removeEventListener("abort", onAbort);
      client.removeAllListeners();
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      clearWecomWsReplyContextsForAccount(account.accountId);
      clearActivatedTargetsForAccount(account.accountId);
      conn.client = null;
      conn.promise = null;
      conn.stop = null;
      activeConnections.delete(account.accountId);
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        running: false,
        lastStopAt: Date.now(),
      });
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => {
      logger.info("abort signal received, stopping wecom ws gateway");
      finish();
    };

    const handleMessageCallback = (frame: SdkWsFrame) => {
      const callback = normalizeWecomWsCallback(toWecomWsFrame(frame));
      if (!callback || callback.kind !== "message") return;
      if (markProcessedMessage(account.accountId, callback.msgId)) {
        logger.debug(`wecom ws duplicate callback skipped: ${callback.msgId}`);
        return;
      }
      rememberActivatedTarget(account.accountId, callback.target);

      const core = tryGetWecomRuntime();
      if (!core) {
        logger.warn("wecom runtime missing, skipping ws message callback");
        return;
      }

      registerWecomWsMessageContext({
        accountId: account.accountId,
        reqId: callback.reqId,
        to: callback.target,
        send: async (replyFrame) => {
          await sendSdkReplyFrame({
            client,
            frame: replyFrame,
            logger,
          });
          setStatus?.({
            accountId: account.accountId,
            mode: "ws",
            lastOutboundAt: Date.now(),
          });
        },
      });

      dispatchWecomMessage({
        cfg,
        account,
        msg: callback.msg,
        core,
        hooks: {
          onRouteContext: (context) => {
            bindWecomWsRouteContext({
              accountId: account.accountId,
              reqId: callback.reqId,
              sessionKey: context.sessionKey,
              runId: context.runId,
            });
          },
          onChunk: async (text) => {
            await appendWecomWsActiveStreamChunk({
              accountId: account.accountId,
              to: callback.target,
              chunk: text,
            });
            setStatus?.({
              accountId: account.accountId,
              mode: "ws",
              lastOutboundAt: Date.now(),
            });
          },
          onRichChunk: async (chunk) => {
            const appended = await appendWecomWsActiveStreamReply({
              accountId: account.accountId,
              to: callback.target,
              chunk: chunk.text,
              msgItems: chunk.msgItems,
            });
            if (!appended.accepted) return;
            if (chunk.msgItems.length > appended.appendedMsgItems) {
              logger.warn(
                `wecom ws native image items dropped: accepted=${appended.appendedMsgItems}, requested=${chunk.msgItems.length}`
              );
            }
            setStatus?.({
              accountId: account.accountId,
              mode: "ws",
              lastOutboundAt: Date.now(),
            });
          },
          onError: (err) => {
            logger.error(`wecom ws agent failed: ${String(err)}`);
          },
        },
        log: runtime?.log,
        error: runtime?.error,
      })
        .then(() => {
          scheduleWecomWsMessageContextFinish({
            accountId: account.accountId,
            reqId: callback.reqId,
          });
        })
        .catch((err) => {
          logger.error(`wecom ws agent failed: ${String(err)}`);
          scheduleWecomWsMessageContextFinish({
            accountId: account.accountId,
            reqId: callback.reqId,
            error: err,
          });
        });
    };

    const handleEventCallback = (frame: SdkWsFrame) => {
      const callback = normalizeWecomWsCallback(toWecomWsFrame(frame));
      if (!callback || callback.kind !== "event") return;
      const eventType = callback.eventType?.toLowerCase() ?? "";

      if (eventType === "disconnected_event") {
        logger.warn("received disconnected_event from wecom ws server");
        clearWecomWsReplyContextsForAccount(account.accountId);
        setStatus?.({
          accountId: account.accountId,
          mode: "ws",
          lastDisconnectAt: Date.now(),
          lastDisconnectReason: "disconnected_event",
        });
        return;
      }

      rememberActivatedTarget(account.accountId, callback.target);

      if (eventType === "enter_chat") {
        const welcome = account.config.welcomeText?.trim();
        if (welcome) {
          void client.replyWelcome(buildHeaders(callback.reqId), {
            msgtype: "text",
            text: {
              content: welcome,
            },
          }).then((response) => {
            if (typeof response.errcode === "number" && response.errcode !== 0) {
              throw new Error(`wecom ws welcome reply failed: ${response.errcode} ${response.errmsg ?? ""}`.trim());
            }
            setStatus?.({
              accountId: account.accountId,
              mode: "ws",
              lastOutboundAt: Date.now(),
            });
          }).catch((err) => {
            logger.error(`wecom ws welcome reply failed: ${String(err)}`);
          });
          return;
        }
      }

      if (eventType === "template_card_event" || eventType === "feedback_event" || eventType === "enter_chat") {
        registerWecomWsEventContext({
          accountId: account.accountId,
          reqId: callback.reqId,
          to: callback.target,
          kind:
            eventType === "template_card_event"
              ? "template_card_event"
              : eventType === "feedback_event"
                ? "feedback_event"
                : "enter_chat",
          send: async (replyFrame) => {
            await sendSdkReplyFrame({
              client,
              frame: replyFrame,
              logger,
            });
            setStatus?.({
              accountId: account.accountId,
              mode: "ws",
              lastOutboundAt: Date.now(),
            });
          },
        });
      }

      const core = tryGetWecomRuntime();
      if (!core) return;
      dispatchWecomMessage({
        cfg,
        account,
        msg: callback.msg,
        core,
        hooks: {
          onChunk: async () => {
            // Event callbacks do not use text chunk replies in this transport adapter.
          },
          onError: (err) => {
            logger.error(`wecom ws event dispatch failed: ${String(err)}`);
          },
        },
        log: runtime?.log,
        error: runtime?.error,
      }).catch((err) => {
        logger.error(`wecom ws event dispatch failed: ${String(err)}`);
      });
    };

    client.on("connected", () => {
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        connectionState: "connecting",
        lastConnectAt: Date.now(),
      });
    });

    client.on("authenticated", () => {
      logger.info(`[wecom] ws authenticated for account ${account.accountId}`);
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        running: true,
        configured: true,
        connectionState: "ready",
        lastSubscribeAt: Date.now(),
      });
    });

    client.on("message", (frame) => {
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        lastInboundAt: Date.now(),
      });
      handleMessageCallback(frame);
    });

    client.on("event", (frame) => {
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        lastInboundAt: Date.now(),
      });
      handleEventCallback(frame);
    });

    client.on("reconnecting", (attempt) => {
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        running: true,
        connectionState: "reconnecting",
        reconnectAttempt: attempt,
      });
    });

    client.on("disconnected", (reason) => {
      clearWecomWsReplyContextsForAccount(account.accountId);
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        running: true,
        connectionState: "disconnected",
        lastDisconnectAt: Date.now(),
        lastDisconnectReason: reason,
      });
    });

    client.on("error", (error) => {
      logger.error(`wecom ws sdk error: ${error.message}`);
      setStatus?.({
        accountId: account.accountId,
        mode: "ws",
        lastErrorAt: Date.now(),
        lastError: error.message,
      });
    });

    conn.stop = () => {
      finish();
    };

    if (abortSignal?.aborted) {
      finish();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      client.connect();
    } catch (err) {
      finish(err);
    }
  });

  return conn.promise;
}

export function stopWecomWsGatewayForAccount(accountId: string): void {
  const conn = activeConnections.get(accountId);
  if (!conn) return;
  if (conn.stop) {
    conn.stop();
    return;
  }
  try {
    conn.client?.disconnect();
  } catch {
    // ignore
  }
  conn.client = null;
  clearWecomWsReplyContextsForAccount(accountId);
  clearActivatedTargetsForAccount(accountId);
  activeConnections.delete(accountId);
}
