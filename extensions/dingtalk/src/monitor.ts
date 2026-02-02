/**
 * 钉钉 Stream 连接管理
 * 
 * 使用 dingtalk-stream SDK 建立持久连接接收消息
 * 
 */

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDingtalkClientFromConfig } from "./client.js";
import { handleDingtalkMessage } from "./bot.js";
import type { DingtalkConfig } from "./config.js";
import type { DingtalkRawMessage } from "./types.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * Monitor 配置选项
 */
export interface MonitorDingtalkOpts {
  /** 钉钉渠道配置 */
  config?: {
    channels?: {
      dingtalk?: DingtalkConfig;
    };
  };
  /** 运行时环境 */
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 中断信号，用于优雅关闭 */
  abortSignal?: AbortSignal;
  /** 账户 ID */
  accountId?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function ensureGatewayHttpEnabled(params: {
  dingtalkCfg?: DingtalkConfig;
  logger: Logger;
}): Promise<void> {
  const { dingtalkCfg, logger } = params;
  if (!dingtalkCfg?.enableAICard) return;

  const home = os.homedir();
  const candidates = [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "config.json"),
  ];

  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const cleaned = raw.replace(/^\uFEFF/, "").trim();
      if (!cleaned) continue;

      const cfg = JSON.parse(cleaned) as Record<string, unknown>;
      const gateway = toRecord(cfg.gateway);
      const http = toRecord(gateway.http);
      const endpoints = toRecord(http.endpoints);
      const chatCompletions = toRecord(endpoints.chatCompletions);

      if (chatCompletions.enabled === true) {
      logger.debug(`[gateway] chatCompletions already enabled in ${filePath}`);
      return;
      }

      chatCompletions.enabled = true;
      endpoints.chatCompletions = chatCompletions;
      http.endpoints = endpoints;
      gateway.http = http;
      cfg.gateway = gateway;

      const output = JSON.stringify(cfg, null, 2);
      await fs.writeFile(filePath, `${output}\n`, "utf8");
      logger.info(`[gateway] enabled http.endpoints.chatCompletions in ${filePath}`);
      logger.info("[gateway] restart OpenClaw gateway to apply HTTP endpoint change");
      return;
    } catch (err) {
      logger.warn(`[gateway] failed to update ${filePath}: ${String(err)}`);
    }
  }

  logger.warn("[gateway] openclaw config not found; cannot auto-enable http endpoint");
}

/** 当前活跃的 Stream 客户端 */
let currentClient: DWClient | null = null;

/** 当前活跃连接的账户 ID */
let currentAccountId: string | null = null;

/** 当前 Monitor Promise */
let currentPromise: Promise<void> | null = null;

/** 停止当前 Monitor */
let currentStop: (() => void) | null = null;

/**
 * 启动钉钉 Stream 连接监控
 * 
 * 使用 DWClient 建立 Stream 连接，注册 TOPIC_ROBOT 回调处理消息。
 * 支持 abortSignal 进行优雅关闭。
 * 
 * @param opts 监控配置选项
 * @returns Promise<void> 连接关闭时 resolve
 * @throws Error 如果凭证未配置
 */
export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;
  
  const logger: Logger = createLogger("dingtalk", {
    log: runtime?.log,
    error: runtime?.error,
  });
  
  // Single-account: only one active connection allowed.
  if (currentClient) {
    if (currentAccountId && currentAccountId !== accountId) {
      throw new Error(`DingTalk already running for account ${currentAccountId}`);
    }
    logger.debug(`existing connection for account ${accountId} is active, reusing monitor`);
    if (currentPromise) {
      return currentPromise;
    }
    throw new Error("DingTalk monitor state invalid: active client without promise");
  }

  // Get DingTalk config.
  const dingtalkCfg = config?.channels?.dingtalk;
  if (!dingtalkCfg) {
    throw new Error("DingTalk configuration not found");
  }

  await ensureGatewayHttpEnabled({ dingtalkCfg, logger });

  currentAccountId = accountId;

  // 使用内部重连循环
  currentPromise = (async () => {
    let retryCount = 0;
    const maxRetryDelay = 30000;

    while (true) {
      if (abortSignal?.aborted) break;

      try {
        await new Promise<void>((resolve, reject) => {
          let stopped = false;
          let healthCheckTimer: NodeJS.Timeout | null = null;
          let lastActivityAt = Date.now();

          // Create Stream client.
          const client = createDingtalkClientFromConfig(dingtalkCfg);
          currentClient = client;

          const cleanup = () => {
            if (healthCheckTimer) {
              clearInterval(healthCheckTimer);
              healthCheckTimer = null;
            }
            if (currentClient === client) {
              currentClient = null;
              currentStop = null;
            }
            try {
              client.disconnect();
            } catch (err) {
              logger.error(`failed to disconnect client: ${String(err)}`);
            }
          };

          const finalizeResolve = () => {
            if (stopped) return;
            stopped = true;
            abortSignal?.removeEventListener("abort", handleAbort);
            cleanup();
            resolve();
          };

          const finalizeReject = (err: unknown) => {
            if (stopped) return;
            stopped = true;
            abortSignal?.removeEventListener("abort", handleAbort);
            cleanup();
            reject(err);
          };

          const handleAbort = () => {
            logger.info("abort signal received, stopping Stream client");
            finalizeResolve();
          };

          currentStop = () => {
            logger.info("stop requested, stopping Stream client");
            finalizeResolve();
          };

          abortSignal?.addEventListener("abort", handleAbort, { once: true });

          healthCheckTimer = setInterval(() => {
            const idleTime = Date.now() - lastActivityAt;
            if (idleTime > 90000) {
              logger.error(`Stream connection idle for ${Math.round(idleTime / 1000)}s, forcing reconnect...`);
              finalizeReject(new Error("Stream connection hung (idle timeout)"));
            }
          }, 30000);

          try {
            client.registerCallbackListener(TOPIC_ROBOT, (res) => {
              lastActivityAt = Date.now();
              const streamMessageId = res?.headers?.messageId;
              if (streamMessageId) {
                try {
                  client.socketCallBackResponse(streamMessageId, { success: true });
                } catch (ackErr) {
                  logger.error(`failed to ACK message ${streamMessageId}: ${String(ackErr)}`);
                }
              }
              try {
                const rawMessage = JSON.parse(res.data) as DingtalkRawMessage;
                if (streamMessageId) {
                  rawMessage.streamMessageId = streamMessageId;
                }
                let contentText = "";
                if (rawMessage.msgtype === "text" && rawMessage.text?.content) {
                  contentText = rawMessage.text.content;
                } else if (rawMessage.content) {
                  const contentObj = typeof rawMessage.content === "string"
                    ? (() => { try { return JSON.parse(rawMessage.content); } catch { return null; } })()
                    : rawMessage.content;
                  if (contentObj && typeof contentObj === "object" && "recognition" in contentObj && typeof contentObj.recognition === "string") {
                    contentText = contentObj.recognition;
                  }
                }
                const contentTrimmed = contentText.trim();
                const senderName = rawMessage.senderNick ?? rawMessage.senderId;
                const textPreview = contentTrimmed.slice(0, 50);
                logger.info(`Inbound: from=${senderName} text="${textPreview}${contentTrimmed.length > 50 ? "..." : ""}"`);
                void handleDingtalkMessage({
                  cfg: config,
                  raw: rawMessage,
                  accountId,
                  log: (msg: string) => logger.info(msg.replace(/^\[dingtalk\]\s*/, "")),
                  error: (msg: string) => logger.error(msg.replace(/^\[dingtalk\]\s*/, "")),
                  enableAICard: dingtalkCfg?.enableAICard ?? true,
                }).catch((err) => {
                  logger.error(`error handling message: ${String(err)}`);
                });
              } catch (err) {
                logger.error(`error parsing message: ${String(err)}`);
              }
            });

            client.connect();
            logger.info("Stream client connected");
            retryCount = 0; // 重置重试计数
          } catch (err) {
            logger.error(`failed to start Stream connection: ${String(err)}`);
            finalizeReject(err);
          }
        });

        // 如果是正常 resolve (finalizeResolve)，说明是主动停止，跳出循环
        break;
      } catch (err) {
        if (abortSignal?.aborted) break;
        
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), maxRetryDelay);
        logger.warn(`Stream connection lost: ${String(err)}. Retrying in ${delay / 1000}s... (retry #${retryCount})`);
        
        // 清除缓存，确保下次重连使用新实例
        const { clearClientCache } = await import("./client.js");
        clearClientCache();

        await new Promise(r => setTimeout(r, delay));
      }
    }
    
    currentClient = null;
    currentAccountId = null;
    currentStop = null;
    currentPromise = null;
  })();

  return currentPromise;
}

/**
 * 停止钉钉 Monitor
 */
export function stopDingtalkMonitor(): void {
  if (currentStop) {
    currentStop();
    return;
  }
  if (currentClient) {
    try {
      currentClient.disconnect();
    } catch (err) {
      console.error(`[dingtalk] failed to disconnect client: ${String(err)}`);
    } finally {
      currentClient = null;
      currentAccountId = null;
      currentPromise = null;
      currentStop = null;
    }
  }
}

/**
 * 获取当前 Stream 客户端状态
 */
export function isMonitorActive(): boolean {
  return currentClient !== null;
}

/**
 * 获取当前活跃连接的账户 ID
 */
export function getCurrentAccountId(): string | null {
  return currentAccountId;
}
