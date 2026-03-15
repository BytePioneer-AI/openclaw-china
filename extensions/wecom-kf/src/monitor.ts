/**
 * 微信客服渠道 Webhook 处理
 *
 * 核心流程：
 * 1. 收到企微回调通知（包含 open_kfid + Token）
 * 2. 调用 sync_msg 拉取具体消息
 * 3. 对每条消息分发给 bot.ts 处理
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { createLogger, type Logger } from "@openclaw-china/shared";

import type { ResolvedWecomKfAccount, WecomKfInboundMessage } from "./types.js";
import type { PluginConfig } from "./config.js";
import {
  decryptWecomKfEncrypted,
  verifyWecomKfSignature,
} from "./crypto.js";
import { dispatchWecomKfMessage } from "./bot.js";
import { tryGetWecomKfRuntime } from "./runtime.js";
import { syncMessages, sendKfMessage, sendKfEventMessage, splitActiveTextChunks } from "./api.js";

export type WecomKfRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WecomKfWebhookTarget = {
  account: ResolvedWecomKfAccount;
  config: PluginConfig;
  runtime: WecomKfRuntimeEnv;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WecomKfWebhookTarget[]>();

/** 消息去重缓存（msgid -> timestamp），15 分钟过期 */
const processedMsgIds = new Map<string, number>();
const MSG_DEDUP_TTL_MS = 15 * 60 * 1000;

/** sync_msg 游标缓存（per account） */
const syncCursors = new Map<string, string>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function pruneProcessedMsgIds(): void {
  const cutoff = Date.now() - MSG_DEDUP_TTL_MS;
  for (const [id, ts] of processedMsgIds.entries()) {
    if (ts < cutoff) {
      processedMsgIds.delete(id);
    }
  }
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolveSignatureParam(params: URLSearchParams): string {
  return params.get("msg_signature") ?? params.get("msgsignature") ?? params.get("signature") ?? "";
}

/**
 * 解析 XML 格式数据
 */
function parseXmlBody(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const cdataRegex = /<([\w:-]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = cdataRegex.exec(xml)) !== null) {
    const [, key, value] = match;
    result[key!] = value!;
  }
  const simpleRegex = /<([\w:-]+)>([^<]*)<\/\1>/g;
  while ((match = simpleRegex.exec(xml)) !== null) {
    const [, key, value] = match;
    if (!result[key!]) {
      result[key!] = value!;
    }
  }
  return result;
}

async function readRawBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; raw?: string; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, raw });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function buildLogger(target: WecomKfWebhookTarget): Logger {
  return createLogger("wecom-kf", {
    log: target.runtime.log,
    error: target.runtime.error,
  });
}

/**
 * 注册 Webhook 目标
 */
export function registerWecomKfWebhookTarget(target: WecomKfWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
  };
}

/**
 * 处理从 sync_msg 拉取到的单条消息
 */
async function handleSingleMessage(
  target: WecomKfWebhookTarget,
  msg: WecomKfInboundMessage,
  logger: Logger,
): Promise<void> {
  const msgid = msg.msgid;
  if (msgid) {
    if (processedMsgIds.has(msgid)) {
      return; // 去重
    }
    processedMsgIds.set(msgid, Date.now());
  }

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const messageOpenKfId =
    msg.open_kfid?.trim() ||
    (msg as { event?: { open_kfid?: string } }).event?.open_kfid?.trim() ||
    undefined;

  // 只处理来自微信客户的消息（origin === 3）
  const origin = (msg as { origin?: number }).origin;
  if (origin !== undefined && origin !== 3) {
    logger.debug(`skipping non-customer message: origin=${origin}, msgtype=${msgtype}`);
    return;
  }

  // 事件消息
  if (msgtype === "event") {
    const event = (msg as { event?: { event_type?: string; welcome_code?: string } }).event;
    const eventType = event?.event_type ?? "";
    logger.info(`[wecom-kf] event: ${eventType}`);

    if (eventType === "enter_session" && target.account.config.welcomeText?.trim()) {
      const welcomeCode = event?.welcome_code?.trim();
      if (welcomeCode && target.account.canSend) {
        try {
          await sendKfEventMessage(target.account, welcomeCode, target.account.config.welcomeText);
        } catch (err) {
          logger.error(`failed to send welcome message via send_msg_on_event: ${String(err)}`);
        }
      } else if (!welcomeCode) {
        logger.warn("[wecom-kf] enter_session event missing welcome_code, cannot send welcome message");
      }
    }
    return;
  }

  // 普通消息 → 分发给 Agent
  target.statusSink?.({ lastInboundAt: Date.now() });

  const core = tryGetWecomKfRuntime();
  if (!core) {
    logger.debug("runtime not available, skipping dispatch");
    return;
  }

  const externalUserId = msg.external_userid?.trim();
  if (!externalUserId) {
    logger.warn("message missing external_userid, skipping");
    return;
  }

  const activeTarget = { externalUserId, openKfId: messageOpenKfId };

  const hooks = {
    onChunk: async (text: string) => {
      if (!target.account.canSend || !activeTarget) return;
      try {
        const chunks = splitActiveTextChunks(text);
        for (const chunk of chunks) {
          const result = await sendKfMessage(target.account, activeTarget, chunk);
          if (!result.ok) {
            logger.error(`send_msg failed: errcode=${result.errcode} errmsg=${result.errmsg}`);
          }
          target.statusSink?.({ lastOutboundAt: Date.now() });
        }
      } catch (sendErr) {
        logger.error(`send_msg error: ${String(sendErr)}`);
      }
    },
    onError: (err: unknown) => {
      logger.error(`wecom-kf agent failed: ${String(err)}`);
    },
  };

  try {
    await dispatchWecomKfMessage({
      cfg: target.config,
      account: target.account,
      msg,
      core,
      hooks,
      log: target.runtime.log,
      error: target.runtime.error,
    });
  } catch (err) {
    logger.error(`dispatch error: ${String(err)}`);
  }
}

/**
 * 处理微信客服 Webhook 请求
 *
 * GET  → URL 验证（echostr）
 * POST → 收到消息通知后，拉取 sync_msg 并处理
 */
export async function handleWecomKfWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  pruneProcessedMsgIds();

  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  const primary = targets[0]!;
  const logger = buildLogger(primary);

  // GET 请求 - URL 验证
  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      res.statusCode = 400;
      res.end("missing query params");
      return true;
    }

    const matched = targets.filter((candidate) => {
      if (!candidate.account.token) return false;
      return verifyWecomKfSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (matched.length === 0) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    const target = matched[0]!;
    if (!target.account.encodingAESKey) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    try {
      const plaintext = decryptWecomKfEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.receiveId,
        encrypt: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plaintext);
    } catch (err) {
      logger.error(`echostr decrypt failed: ${String(err)}`);
      res.statusCode = 400;
      res.end("decrypt failed");
    }
    return true;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  // POST 请求 - 消息通知
  if (!timestamp || !nonce || !signature) {
    res.statusCode = 400;
    res.end("missing query params");
    return true;
  }

  const body = await readRawBody(req, 1024 * 1024);
  if (!body.ok || !body.raw) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const xmlData = parseXmlBody(body.raw);
  const encrypt = xmlData.Encrypt ?? "";

  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing Encrypt field");
    return true;
  }

  const matched = targets.filter((candidate) => {
    if (!candidate.account.token) return false;
    return verifyWecomKfSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });

  if (matched.length === 0) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  const target = matched[0]!;
  if (!target.account.encodingAESKey) {
    res.statusCode = 500;
    res.end("wecom-kf not configured");
    return true;
  }

  let callbackXml: Record<string, string>;
  try {
    const plaintext = decryptWecomKfEncrypted({
      encodingAESKey: target.account.encodingAESKey,
      receiveId: target.account.receiveId,
      encrypt,
    });
    callbackXml = parseXmlBody(plaintext);
  } catch (err) {
    logger.error(`decrypt failed: ${String(err)}`);
    res.statusCode = 400;
    res.end("decrypt failed");
    return true;
  }

  // 先响应 200（企微要求 3 秒内响应）
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("success");

  const callbackToken = callbackXml.Token ?? "";
  const callbackOpenKfId = callbackXml.OpenKfId ?? "";

  logger.info(`[wecom-kf] callback received: open_kfid=${callbackOpenKfId}`);
  if (callbackOpenKfId && target.account.openKfid && target.account.openKfid !== callbackOpenKfId) {
    logger.warn(
      `[wecom-kf] configured openKfid=${target.account.openKfid} differs from callback open_kfid=${callbackOpenKfId}; using callback value for inbound sync`
    );
  }

  // 异步拉取消息并处理（不阻塞 HTTP 响应）
  pullAndProcessMessages(target, callbackToken, callbackOpenKfId, logger).catch((err) => {
    logger.error(`pull and process messages failed: ${String(err)}`);
  });

  return true;
}

/**
 * 拉取消息并处理
 */
async function pullAndProcessMessages(
  target: WecomKfWebhookTarget,
  callbackToken: string,
  callbackOpenKfId: string,
  logger: Logger,
): Promise<void> {
  if (!target.account.canSend) {
    logger.warn("account not configured for sync_msg, skipping pull");
    return;
  }

  const activeOpenKfId = callbackOpenKfId?.trim() || target.account.openKfid?.trim() || "";
  const cursorKey = `${target.account.accountId}:${activeOpenKfId}`;
  let cursor = syncCursors.get(cursorKey) ?? "";
  let hasMore = true;

  while (hasMore) {
    try {
      const response = await syncMessages(target.account, cursor, callbackToken, 1000, activeOpenKfId);

      if (response.errcode !== undefined && response.errcode !== 0) {
        logger.error(`sync_msg failed: errcode=${response.errcode} errmsg=${response.errmsg}`);
        break;
      }

      const messages = response.msg_list ?? [];
      logger.info(`[wecom-kf] sync_msg returned ${messages.length} messages`);

      for (const msg of messages) {
        try {
          await handleSingleMessage(target, msg, logger);
        } catch (err) {
          logger.error(`handle message failed: msgid=${msg.msgid} error=${String(err)}`);
        }
      }

      if (response.next_cursor) {
        cursor = response.next_cursor;
        syncCursors.set(cursorKey, cursor);
      }

      hasMore = response.has_more === 1;
    } catch (err) {
      logger.error(`sync_msg request failed: ${String(err)}`);
      break;
    }
  }
}
