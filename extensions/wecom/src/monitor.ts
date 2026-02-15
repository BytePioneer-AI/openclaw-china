import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

import { createLogger, type Logger } from "@openclaw-china/shared";

import type { ResolvedWecomAccount, WecomInboundMessage } from "./types.js";
import type { PluginConfig } from "./config.js";
import { decryptWecomEncrypted, encryptWecomPlaintext, verifyWecomSignature, computeWecomMsgSignature } from "./crypto.js";
import { dispatchWecomMessage } from "./bot.js";
import { tryGetWecomRuntime } from "./runtime.js";
import { handleTempMediaRequest, rememberAccountPublicBaseUrl } from "./outbound-reply.js";

export type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WecomWebhookTarget = {
  account: ResolvedWecomAccount;
  config: PluginConfig;
  runtime: WecomRuntimeEnv;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type StreamState = {
  streamId: string;
  msgid?: string;
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
};

type StreamBinding = {
  accountId: string;
  to: string;
};

type StreamRouteBinding = {
  sessionKey?: string;
  runId?: string;
};

const webhookTargets = new Map<string, WecomWebhookTarget[]>();
const streams = new Map<string, StreamState>();
const msgidToStreamId = new Map<string, string>();
const streamBindings = new Map<string, StreamBinding>();
const activeStreamByTarget = new Map<string, string>();
const activeStreamIdsByTo = new Map<string, Set<string>>();
const streamRouteBindings = new Map<string, StreamRouteBinding>();
const streamBySessionKey = new Map<string, string>();
const streamByRunId = new Map<string, string>();

const STREAM_TTL_MS = 10 * 60 * 1000;
const STREAM_MAX_BYTES = 20_480;
const INITIAL_STREAM_WAIT_MS = 800;

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function normalizeToToken(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("user:")) {
    return `user:${value.slice("user:".length).trim().toLowerCase()}`;
  }
  if (value.startsWith("group:")) {
    return `group:${value.slice("group:".length).trim()}`;
  }
  return value;
}

function normalizeAccountTargetKey(accountId: string, to: string): string {
  return `${accountId.trim()}::${normalizeToToken(to)}`;
}

function isStreamActive(streamId: string): boolean {
  const state = streams.get(streamId);
  return Boolean(state && !state.finished);
}

function appendToStream(streamId: string, chunk: string): boolean {
  const state = streams.get(streamId);
  if (!state || state.finished) return false;
  appendStreamContent(state, chunk);
  return true;
}

function pruneStreams(): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
      unbindActiveStream(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
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
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function buildEncryptedJsonReply(params: {
  account: ResolvedWecomAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return params.get("msg_signature") ?? params.get("msgsignature") ?? params.get("signature") ?? "";
}

function buildStreamPlaceholderReply(streamId: string): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: "稍等~",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };
}

function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

function appendStreamContent(state: StreamState, nextText: string): void {
  const content = state.content ? `${state.content}\n\n${nextText}`.trim() : nextText.trim();
  state.content = truncateUtf8Bytes(content, STREAM_MAX_BYTES);
  state.updatedAt = Date.now();
}

function bindActiveStream(params: { streamId: string; accountId: string; to: string }): void {
  const accountId = params.accountId.trim();
  const to = normalizeToToken(params.to);
  if (!accountId || !to) return;
  streamBindings.set(params.streamId, { accountId, to });
  activeStreamByTarget.set(normalizeAccountTargetKey(accountId, to), params.streamId);
  const ids = activeStreamIdsByTo.get(to) ?? new Set<string>();
  ids.add(params.streamId);
  activeStreamIdsByTo.set(to, ids);
}

function bindStreamRouteContext(params: { streamId: string; sessionKey?: string; runId?: string }): void {
  const streamId = params.streamId.trim();
  if (!streamId) return;
  const sessionKey = params.sessionKey?.trim();
  const runId = params.runId?.trim();
  const current = streamRouteBindings.get(streamId) ?? {};
  const next: StreamRouteBinding = {
    sessionKey: sessionKey || current.sessionKey,
    runId: runId || current.runId,
  };
  streamRouteBindings.set(streamId, next);
  if (next.sessionKey) {
    streamBySessionKey.set(next.sessionKey, streamId);
  }
  if (next.runId) {
    streamByRunId.set(next.runId, streamId);
  }
}

function unbindActiveStream(streamId: string): void {
  const binding = streamBindings.get(streamId);
  if (binding) {
    const key = normalizeAccountTargetKey(binding.accountId, binding.to);
    if (activeStreamByTarget.get(key) === streamId) {
      activeStreamByTarget.delete(key);
    }
    const ids = activeStreamIdsByTo.get(binding.to);
    if (ids) {
      ids.delete(streamId);
      if (ids.size > 0) {
        activeStreamIdsByTo.set(binding.to, ids);
      } else {
        activeStreamIdsByTo.delete(binding.to);
      }
    }
  }
  streamBindings.delete(streamId);
  const routeBinding = streamRouteBindings.get(streamId);
  if (routeBinding?.sessionKey && streamBySessionKey.get(routeBinding.sessionKey) === streamId) {
    streamBySessionKey.delete(routeBinding.sessionKey);
  }
  if (routeBinding?.runId && streamByRunId.get(routeBinding.runId) === streamId) {
    streamByRunId.delete(routeBinding.runId);
  }
  streamRouteBindings.delete(streamId);
}

export function appendWecomActiveStreamChunk(params: {
  accountId: string;
  to: string;
  chunk: string;
  sessionKey?: string;
  runId?: string;
}): boolean {
  const accountId = params.accountId.trim();
  const to = normalizeToToken(params.to);
  const chunk = params.chunk.trim();
  if (!accountId || !to || !chunk) return false;

  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    const streamId = streamBySessionKey.get(sessionKey);
    if (streamId && appendToStream(streamId, chunk)) return true;
  }

  const runId = params.runId?.trim();
  if (runId) {
    const streamId = streamByRunId.get(runId);
    if (streamId && appendToStream(streamId, chunk)) return true;
  }

  const streamId = activeStreamByTarget.get(normalizeAccountTargetKey(accountId, to));
  if (streamId && appendToStream(streamId, chunk)) return true;

  const candidates = Array.from(activeStreamIdsByTo.get(to) ?? []).filter((id) => isStreamActive(id));
  if (candidates.length === 1) {
    console.warn(`[wecom] append stream chunk fallback by to-only key: to=${to}`);
    return appendToStream(candidates[0]!, chunk);
  }

  return false;
}

function buildLogger(target: WecomWebhookTarget): Logger {
  return createLogger("wecom", {
    log: target.runtime.log,
    error: target.runtime.error,
  });
}

export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
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

export async function handleWecomWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  pruneStreams();

  if (await handleTempMediaRequest(req, res)) {
    return true;
  }

  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  const primary = targets[0]!;
  const logger = buildLogger(primary);
  logger.debug(`incoming ${req.method} request on ${path} (timestamp=${timestamp}, nonce=${nonce})`);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      res.statusCode = 400;
      res.end("missing query params");
      return true;
    }

    const target = targets.find((candidate) => {
      if (!candidate.account.configured || !candidate.account.token) return false;
      return verifyWecomSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (!target || !target.account.encodingAESKey) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    try {
      const plain = decryptWecomEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.receiveId,
        encrypt: echostr,
      });
      rememberAccountPublicBaseUrl(target.account.accountId, req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 400;
      res.end(msg || "decrypt failed");
      return true;
    }
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  if (!timestamp || !nonce || !signature) {
    res.statusCode = 400;
    res.end("missing query params");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const record = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : null;
  const encrypt = record ? String(record.encrypt ?? record.Encrypt ?? "") : "";
  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

  const target = targets.find((candidate) => {
    if (!candidate.account.token) return false;
    return verifyWecomSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });

  if (!target) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }
  rememberAccountPublicBaseUrl(target.account.accountId, req);

  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    res.statusCode = 500;
    res.end("wecom not configured");
    return true;
  }

  let plain: string;
  try {
    plain = decryptWecomEncrypted({
      encodingAESKey: target.account.encodingAESKey,
      receiveId: target.account.receiveId,
      encrypt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  target.statusSink?.({ lastInboundAt: Date.now() });

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const msgid = msg.msgid ? String(msg.msgid) : undefined;

  if (msgtype === "stream") {
    const streamId = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    const state = streamId ? streams.get(streamId) : undefined;
    const reply = state
      ? buildStreamReplyFromState(state)
      : buildStreamReplyFromState({
          streamId: streamId || "unknown",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          started: true,
          finished: true,
          content: "",
        });
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      })
    );
    return true;
  }

  if (msgid && msgidToStreamId.has(msgid)) {
    const streamId = msgidToStreamId.get(msgid) ?? "";
    const reply = buildStreamPlaceholderReply(streamId);
    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      })
    );
    return true;
  }

  if (msgtype === "event") {
    const eventtype = String((msg as { event?: { eventtype?: string } }).event?.eventtype ?? "").toLowerCase();
    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      const reply = welcome ? { msgtype: "text", text: { content: welcome } } : {};
      jsonOk(
        res,
        buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: reply,
          nonce,
          timestamp,
        })
      );
      return true;
    }

    const core = tryGetWecomRuntime();
    if (core) {
      dispatchWecomMessage({
        cfg: target.config,
        account: target.account,
        msg,
        core,
        hooks: {
          onChunk: () => {
            // Event callbacks are acknowledged with empty payload; business side
            // can still use response_url for active replies if needed.
          },
          onError: (err: unknown) => {
            logger.error(`wecom event dispatch failed: ${String(err)}`);
          },
        },
        log: target.runtime.log,
        error: target.runtime.error,
      }).catch((err) => {
        logger.error(`wecom event dispatch failed: ${String(err)}`);
      });
    }

    jsonOk(
      res,
      buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: {},
        nonce,
        timestamp,
      })
    );
    return true;
  }

  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);
  const senderId = String(msg.from?.userid ?? "").trim() || "unknown";
  const chatType = String(msg.chattype ?? "").toLowerCase() === "group" ? "group" : "single";
  const to = chatType === "group" ? `group:${String(msg.chatid ?? "").trim() || "unknown"}` : `user:${senderId}`;
  streams.set(streamId, {
    streamId,
    msgid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: false,
    finished: false,
    content: "",
  });
  bindActiveStream({
    streamId,
    accountId: target.account.accountId,
    to,
  });

  const core = tryGetWecomRuntime();

  if (core) {
    const state = streams.get(streamId);
    if (state) state.started = true;
    let chunkFlush = Promise.resolve();

    const markStreamFinished = async (err?: unknown): Promise<void> => {
      await chunkFlush.catch(() => undefined);
      const current = streams.get(streamId);
      if (!current) return;
      if (err) {
        current.error = err instanceof Error ? err.message : String(err);
        current.content = current.content || `Error: ${current.error}`;
      }
      current.finished = true;
      current.updatedAt = Date.now();
      unbindActiveStream(streamId);
    };

    const hooks = {
      onRouteContext: (context: { sessionKey?: string; runId?: string }) => {
        bindStreamRouteContext({
          streamId,
          sessionKey: context.sessionKey,
          runId: context.runId,
        });
      },
      onChunk: (text: string) => {
        chunkFlush = chunkFlush.then(async () => {
          const current = streams.get(streamId);
          if (!current) return;
          appendStreamContent(current, text);
          target.statusSink?.({ lastOutboundAt: Date.now() });
        });
        return chunkFlush;
      },
      onError: (err: unknown) => {
        chunkFlush = chunkFlush.then(async () => {
          const current = streams.get(streamId);
          if (current) {
            current.error = err instanceof Error ? err.message : String(err);
            current.content = current.content || `Error: ${current.error}`;
            current.updatedAt = Date.now();
          }
        });
        logger.error(`wecom agent failed: ${String(err)}`);
      },
    };

    dispatchWecomMessage({
      cfg: target.config,
      account: target.account,
      msg,
      core,
      hooks,
      log: target.runtime.log,
      error: target.runtime.error,
    })
      .then(() => {
        void markStreamFinished();
      })
      .catch((err) => {
        void markStreamFinished(err);
        logger.error(`wecom agent failed: ${String(err)}`);
      });
  } else {
    const state = streams.get(streamId);
    if (state) {
      state.finished = true;
      state.updatedAt = Date.now();
    }
    unbindActiveStream(streamId);
  }

  await waitForStreamContent(streamId, INITIAL_STREAM_WAIT_MS);
  const state = streams.get(streamId);
  const initialReply = state && (state.content.trim() || state.error)
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);

  jsonOk(
    res,
    buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: initialReply,
      nonce,
      timestamp,
    })
  );

  return true;
}
