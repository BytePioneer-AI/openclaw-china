/**
 * QQ Bot WebSocket 网关连接管理
 * 支持多账户并发连接
 */
import WebSocket from "ws";
import { HttpError } from "@xuanyue202/shared";
import { createLogger, type Logger } from "./logger.js";
import { handleQQBotDispatch } from "./bot.js";
import {
  mergeQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  type PluginConfig,
} from "./config.js";
import { clearTokenCache, getAccessToken, getGatewayUrl } from "./client.js";

export interface MonitorQQBotOpts {
  config?: PluginConfig;
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (status: Record<string, unknown>) => void;
}

type GatewayPayload = {
  op?: number;
  t?: string;
  s?: number | null;
  id?: string;
  d?: unknown;
};

const INTENTS = {
  GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

const DEFAULT_INTENTS =
  INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];

function formatGatewayConnectError(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body?.trim();
    if (body) {
      return `${err.message}; body=${body}`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * 活动连接状态（每个账户独立）
 */
interface ActiveConnection {
  socket: WebSocket | null;
  promise: Promise<void> | null;
  stop: (() => void) | null;
  sessionId: string | null;
  lastSeq: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  connecting: boolean;
}

function isConnectionIdle(conn: ActiveConnection | undefined): boolean {
  if (!conn) return true;
  return !conn.socket && !conn.promise && !conn.connecting;
}

// 按账户 ID 管理的连接映射
const activeConnections = new Map<string, ActiveConnection>();

/**
 * 获取或创建账户的连接状态
 */
function getOrCreateConnection(accountId: string): ActiveConnection {
  let conn = activeConnections.get(accountId);
  if (!conn) {
    conn = {
      socket: null,
      promise: null,
      stop: null,
      sessionId: null,
      lastSeq: null,
      heartbeatTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      connecting: false,
    };
    activeConnections.set(accountId, conn);
  }
  return conn;
}

/**
 * 清理账户的定时器
 */
function clearTimers(conn: ActiveConnection): void {
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = null;
  }
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
}

/**
 * 清理账户的 WebSocket
 */
function cleanupSocket(conn: ActiveConnection, expectedSocket?: WebSocket): boolean {
  if (expectedSocket && conn.socket !== expectedSocket) {
    return false;
  }
  clearTimers(conn);
  if (conn.socket) {
    try {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.close();
      }
    } catch {
      // ignore
    }
    conn.socket = null;
  }
  return true;
}

export async function monitorQQBotProvider(opts: MonitorQQBotOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = DEFAULT_ACCOUNT_ID, setStatus } = opts;
  const logger = createLogger("qqbot", {
    log: runtime?.log,
    error: runtime?.error,
  });

  const existingConn = activeConnections.get(accountId);
  if (!existingConn) {
    // continue
  } else if (isConnectionIdle(existingConn)) {
    activeConnections.delete(accountId);
  }

  const conn = activeConnections.get(accountId);

  // 如果该账户已有活动连接或正在建立连接，返回现有 promise
  const existingPromise = conn?.promise;
  if (existingPromise) {
    return existingPromise;
  }
  if (conn?.socket) {
    throw new Error(`QQBot monitor state invalid for account ${accountId}: active socket without promise`);
  }

  const qqCfg = config ? mergeQQBotAccountConfig(config, accountId) : undefined;
  if (!qqCfg) {
    throw new Error("QQBot configuration not found");
  }

  if (!qqCfg.appId || !qqCfg.clientSecret) {
    throw new Error(`QQBot not configured for account ${accountId} (missing appId or clientSecret)`);
  }

  const nextConn = conn ?? getOrCreateConnection(accountId);

  nextConn.promise = new Promise<void>((resolve, reject) => {
    let stopped = false;

    const finish = (err?: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", onAbort);
      cleanupSocket(nextConn);
      nextConn.connecting = false;
      nextConn.sessionId = null;
      nextConn.lastSeq = null;
      nextConn.promise = null;
      nextConn.stop = null;
      nextConn.reconnectAttempt = 0;
      activeConnections.delete(accountId);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onAbort = () => {
      logger.info("abort signal received, stopping gateway");
      finish();
    };

    nextConn.stop = () => {
      logger.info("stop requested");
      finish();
    };

    const scheduleReconnect = (reason: string) => {
      if (stopped) return;
      if (nextConn.reconnectTimer) return;
      const delay =
        RECONNECT_DELAYS_MS[Math.min(nextConn.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      nextConn.reconnectAttempt += 1;
      logger.warn(`[reconnect] ${reason}; retry in ${delay}ms`);
      nextConn.reconnectTimer = setTimeout(() => {
        nextConn.reconnectTimer = null;
        void connect();
      }, delay);
    };

    const startHeartbeat = (intervalMs: number) => {
      if (nextConn.heartbeatTimer) {
        clearInterval(nextConn.heartbeatTimer);
      }
      nextConn.heartbeatTimer = setInterval(() => {
        if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
        const payload = JSON.stringify({ op: 1, d: nextConn.lastSeq });
        nextConn.socket.send(payload);
      }, intervalMs);
    };

    const sendIdentify = (token: string) => {
      if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: DEFAULT_INTENTS,
          shard: [0, 1],
        },
      };
      nextConn.socket.send(JSON.stringify(payload));
    };

    const sendResume = (token: string, session: string, seq: number) => {
      if (!nextConn.socket || nextConn.socket.readyState !== WebSocket.OPEN) return;
      const payload = {
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: session,
          seq,
        },
      };
      nextConn.socket.send(JSON.stringify(payload));
    };

    const handleGatewayPayload = async (payload: GatewayPayload, activeSocket: WebSocket) => {
      if (stopped || nextConn.socket !== activeSocket) {
        return;
      }
      if (typeof payload.s === "number") {
        nextConn.lastSeq = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const hello = payload.d as { heartbeat_interval?: number } | undefined;
          const interval = hello?.heartbeat_interval ?? 30000;
          startHeartbeat(interval);

          const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
          if (stopped || nextConn.socket !== activeSocket) {
            return;
          }
          if (nextConn.sessionId && typeof nextConn.lastSeq === "number") {
            sendResume(token, nextConn.sessionId, nextConn.lastSeq);
          } else {
            sendIdentify(token);
          }
          return;
        }
        case 11:
          // Heartbeat ACK - 更新 lastEventAt 让 OpenClaw 健康检查感知连接存活
          setStatus?.({ lastEventAt: Date.now() });
          return;
        case 7:
          if (!cleanupSocket(nextConn, activeSocket)) {
            return;
          }
          scheduleReconnect("server requested reconnect");
          return;
        case 9:
          nextConn.sessionId = null;
          nextConn.lastSeq = null;
          clearTokenCache(qqCfg.appId as string);
          if (!cleanupSocket(nextConn, activeSocket)) {
            return;
          }
          scheduleReconnect("invalid session");
          return;
        case 0: {
          const eventType = payload.t ?? "";
          if (eventType === "READY") {
            const ready = payload.d as { session_id?: string } | undefined;
            if (ready?.session_id) {
              nextConn.sessionId = ready.session_id;
            }
            nextConn.reconnectAttempt = 0;
            logger.info("gateway ready");
            return;
          }
          if (eventType === "RESUMED") {
            nextConn.reconnectAttempt = 0;
            logger.info("gateway resumed");
            return;
          }
          if (eventType) {
            await handleQQBotDispatch({
              eventType,
              eventData: payload.d,
              eventId: payload.id,
              cfg: opts.config,
              accountId,
              logger,
            });
          }
          return;
        }
        default:
          return;
      }
    };

    const connect = async () => {
      if (stopped || nextConn.connecting) return;
      nextConn.connecting = true;

      try {
        cleanupSocket(nextConn);
        const token = await getAccessToken(qqCfg.appId as string, qqCfg.clientSecret as string);
        if (stopped) return;
        const gatewayUrl = await getGatewayUrl(token);
        if (stopped) return;
        logger.info(`connecting gateway: ${gatewayUrl}`);

        const ws = new WebSocket(gatewayUrl);
        nextConn.socket = ws;
        if (stopped) {
          cleanupSocket(nextConn, ws);
          return;
        }

        ws.on("open", () => {
          logger.info("gateway socket opened");
        });

        ws.on("message", (data) => {
          const raw = typeof data === "string" ? data : data.toString();
          let payload: GatewayPayload;
          try {
            payload = JSON.parse(raw) as GatewayPayload;
          } catch (err) {
            logger.warn(`failed to parse gateway payload: ${String(err)}`);
            return;
          }
          void handleGatewayPayload(payload, ws).catch((err) => {
            logger.error(`gateway dispatch error: ${String(err)}`);
          });
        });

        ws.on("close", (code, reason) => {
          if (!cleanupSocket(nextConn, ws)) {
            return;
          }
          logger.warn(`gateway socket closed (${code}) ${String(reason)}`);
          scheduleReconnect("socket closed");
        });

        ws.on("error", (err) => {
          if (stopped || nextConn.socket !== ws) {
            return;
          }
          logger.error(`gateway socket error: ${String(err)}`);
        });
      } catch (err) {
        logger.error(`gateway connect failed: ${formatGatewayConnectError(err)}`);
        cleanupSocket(nextConn);
        scheduleReconnect("connect failed");
      } finally {
        nextConn.connecting = false;
      }
    };

    if (abortSignal?.aborted) {
      finish();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    void connect();
  });

  return nextConn.promise;
}

/**
 * 停止指定账户的连接
 */
export function stopQQBotMonitorForAccount(accountId: string = DEFAULT_ACCOUNT_ID): void {
  const conn = activeConnections.get(accountId);
  if (!conn) return;

  if (conn.stop) {
    conn.stop();
    return;
  }

  cleanupSocket(conn);
  activeConnections.delete(accountId);
}

/**
 * 停止所有账户的连接
 */
export function stopAllQQBotMonitors(): void {
  for (const accountId of activeConnections.keys()) {
    stopQQBotMonitorForAccount(accountId);
  }
}

/**
 * @deprecated 使用 stopQQBotMonitorForAccount 或 stopAllQQBotMonitors
 * 为了向后兼容，停止默认账户
 */
export function stopQQBotMonitor(): void {
  stopQQBotMonitorForAccount(DEFAULT_ACCOUNT_ID);
}

/**
 * 检查指定账户是否有活动连接
 */
export function isQQBotMonitorActiveForAccount(accountId: string = DEFAULT_ACCOUNT_ID): boolean {
  const conn = activeConnections.get(accountId);
  return Boolean(conn?.socket);
}

/**
 * @deprecated 使用 isQQBotMonitorActiveForAccount
 */
export function isQQBotMonitorActive(): boolean {
  return isQQBotMonitorActiveForAccount(DEFAULT_ACCOUNT_ID);
}

/**
 * 获取所有活动账户 ID
 */
export function getActiveAccountIds(): string[] {
  return Array.from(activeConnections.keys());
}
