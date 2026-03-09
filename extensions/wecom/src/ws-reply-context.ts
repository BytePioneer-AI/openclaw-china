import type { WecomWsFrame } from "./ws-protocol.js";
import { buildWecomWsRespondMessageCommand, buildWecomWsUpdateTemplateCardCommand, createWecomWsStreamId } from "./ws-protocol.js";
import { WECOM_REPLY_MSG_ITEM_LIMIT, type WecomReplyMsgItem } from "./ws-media.js";

type WsSendFrame = (frame: WecomWsFrame) => Promise<void>;
type WsEventKind = "template_card_event" | "enter_chat" | "feedback_event";

type WsMessageContext = {
  accountId: string;
  reqId: string;
  to: string;
  streamId: string;
  createdSeq: number;
  content: string;
  msgItems: WecomReplyMsgItem[];
  pendingAutoImagePaths: string[];
  createdAt: number;
  updatedAt: number;
  sessionKey?: string;
  runId?: string;
  started: boolean;
  finished: boolean;
  queue: Promise<void>;
  send: WsSendFrame;
};

type WsEventContext = {
  accountId: string;
  reqId: string;
  to: string;
  kind: WsEventKind;
  createdAt: number;
  updatedAt: number;
  queue: Promise<void>;
  send: WsSendFrame;
};

const MESSAGE_CONTEXT_TTL_MS = 6 * 60 * 1000;
const EVENT_CONTEXT_TTL_MS = 10 * 1000;
const STREAM_FINISH_GRACE_MS = 2_500;

const messageContexts = new Map<string, WsMessageContext>();
const eventContexts = new Map<string, WsEventContext>();
const messageBySessionKey = new Map<string, string>();
const messageByRunId = new Map<string, string>();
const messageByTarget = new Map<string, Set<string>>();
const eventByTarget = new Map<string, Set<string>>();
const finishTimers = new Map<string, NodeJS.Timeout>();
let nextMessageContextSeq = 0;

export type WecomWsAppendResult = {
  accepted: boolean;
  appendedMsgItems: number;
};

function appendStreamSnapshotContent(current: string, chunk: string): string {
  if (!current.trim()) return chunk;
  if (!chunk.trim()) return current;

  const currentEndsWithBreak = /\n\s*$/.test(current);
  const chunkStartsWithBreak = /^\s*\n/.test(chunk);
  const separator = currentEndsWithBreak || chunkStartsWithBreak ? "" : "\n\n";
  return `${current}${separator}${chunk}`;
}

function now(): number {
  return Date.now();
}

function messageKey(accountId: string, reqId: string): string {
  return `${accountId}::${reqId}`;
}

function targetKey(accountId: string, to: string): string {
  return `${accountId}::${to}`;
}

function routeKey(accountId: string, value: string): string {
  return `${accountId}::${value}`;
}

function addTargetIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const current = index.get(key) ?? new Set<string>();
  current.add(value);
  index.set(key, current);
}

function removeTargetIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const current = index.get(key);
  if (!current) return;
  current.delete(value);
  if (current.size === 0) {
    index.delete(key);
  }
}

function clearFinishTimer(key: string): void {
  const timer = finishTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  finishTimers.delete(key);
}

function trimActiveIds<T extends { updatedAt: number }>(
  ids: Iterable<string>,
  lookup: Map<string, T>,
  ttlMs: number
): string[] {
  const cutoff = now() - ttlMs;
  const active: string[] = [];
  for (const id of ids) {
    const item = lookup.get(id);
    if (!item) continue;
    if (item.updatedAt < cutoff) continue;
    active.push(id);
  }
  return active;
}

function pickNewestContext<T extends { updatedAt: number }>(ids: string[], lookup: Map<string, T>): T | null {
  let newest: T | null = null;
  for (const id of ids) {
    const current = lookup.get(id);
    if (!current) continue;
    if (!newest || current.updatedAt > newest.updatedAt) {
      newest = current;
    }
  }
  return newest;
}

function pickPreferredMessageContext(ids: string[], lookup: Map<string, WsMessageContext>): WsMessageContext | null {
  let preferred: WsMessageContext | null = null;
  for (const id of ids) {
    const current = lookup.get(id);
    if (!current || current.finished) continue;
    if (!preferred) {
      preferred = current;
      continue;
    }
    if (preferred.started && !current.started) {
      preferred = current;
      continue;
    }
    if (preferred.started === current.started && current.createdSeq > preferred.createdSeq) {
      preferred = current;
    }
  }
  return preferred;
}

function enqueue<T extends { queue: Promise<void> }>(context: T, task: () => Promise<void>): Promise<void> {
  context.queue = context.queue.then(task, task);
  return context.queue;
}

function pruneMessageContexts(): void {
  const cutoff = now() - MESSAGE_CONTEXT_TTL_MS;
  for (const [key, context] of messageContexts.entries()) {
    if (context.updatedAt >= cutoff) continue;
    clearFinishTimer(key);
    messageContexts.delete(key);
    const sessionKey = context.sessionKey?.trim();
    if (sessionKey) {
      const route = routeKey(context.accountId, sessionKey);
      if (messageBySessionKey.get(route) === key) {
        messageBySessionKey.delete(route);
      }
    }
    const runId = context.runId?.trim();
    if (runId) {
      const route = routeKey(context.accountId, runId);
      if (messageByRunId.get(route) === key) {
        messageByRunId.delete(route);
      }
    }
    removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
  }
}

function pruneEventContexts(): void {
  const cutoff = now() - EVENT_CONTEXT_TTL_MS;
  for (const [key, context] of eventContexts.entries()) {
    if (context.updatedAt >= cutoff) continue;
    eventContexts.delete(key);
    removeTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
  }
}

function pruneContexts(): void {
  pruneMessageContexts();
  pruneEventContexts();
}

function findMessageContext(params: {
  accountId: string;
  to: string;
  sessionKey?: string;
  runId?: string;
}): WsMessageContext | null {
  pruneMessageContexts();
  const accountId = params.accountId.trim();
  const runId = params.runId?.trim();
  const sessionKey = params.sessionKey?.trim();
  const to = params.to.trim();

  if (runId) {
    const key = messageByRunId.get(routeKey(accountId, runId));
    if (key) {
      const context = messageContexts.get(key);
      if (context && !context.finished) return context;
    }
  }

  if (sessionKey) {
    const key = messageBySessionKey.get(routeKey(accountId, sessionKey));
    if (key) {
      const context = messageContexts.get(key);
      if (context && !context.finished) return context;
    }
  }

  const ids = trimActiveIds(messageByTarget.get(targetKey(accountId, to)) ?? [], messageContexts, MESSAGE_CONTEXT_TTL_MS);
  return pickPreferredMessageContext(ids, messageContexts);
}

function findEventContext(params: {
  accountId: string;
  to: string;
  kind: WsEventKind;
}): WsEventContext | null {
  pruneEventContexts();
  const ids = trimActiveIds(eventByTarget.get(targetKey(params.accountId.trim(), params.to.trim())) ?? [], eventContexts, EVENT_CONTEXT_TTL_MS);
  const matches = ids
    .map((id) => eventContexts.get(id))
    .filter((context): context is WsEventContext => Boolean(context && context.kind === params.kind));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] ?? null;
}

export function registerWecomWsMessageContext(params: {
  accountId: string;
  reqId: string;
  to: string;
  send: WsSendFrame;
  streamId?: string;
}): string {
  pruneContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context: WsMessageContext = {
    accountId: params.accountId.trim(),
    reqId: params.reqId.trim(),
    to: params.to.trim(),
    streamId: params.streamId?.trim() || createWecomWsStreamId(),
    createdSeq: ++nextMessageContextSeq,
    content: "",
    msgItems: [],
    pendingAutoImagePaths: [],
    createdAt: now(),
    updatedAt: now(),
    started: false,
    finished: false,
    queue: Promise.resolve(),
    send: params.send,
  };
  messageContexts.set(key, context);
  addTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
  return context.streamId;
}

export function registerWecomWsEventContext(params: {
  accountId: string;
  reqId: string;
  to: string;
  kind: WsEventKind;
  send: WsSendFrame;
}): void {
  pruneContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context: WsEventContext = {
    accountId: params.accountId.trim(),
    reqId: params.reqId.trim(),
    to: params.to.trim(),
    kind: params.kind,
    createdAt: now(),
    updatedAt: now(),
    queue: Promise.resolve(),
    send: params.send,
  };
  eventContexts.set(key, context);
  addTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
}

export function bindWecomWsRouteContext(params: {
  accountId: string;
  reqId: string;
  sessionKey?: string;
  runId?: string;
}): void {
  pruneMessageContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  const context = messageContexts.get(key);
  if (!context) return;
  const sessionKey = params.sessionKey?.trim();
  const runId = params.runId?.trim();
  if (sessionKey) {
    context.sessionKey = sessionKey;
    messageBySessionKey.set(routeKey(context.accountId, sessionKey), key);
  }
  if (runId) {
    context.runId = runId;
    messageByRunId.set(routeKey(context.accountId, runId), key);
  }
  context.updatedAt = now();
}

export async function appendWecomWsActiveStreamChunk(params: {
  accountId: string;
  to: string;
  chunk: string;
  sessionKey?: string;
  runId?: string;
}): Promise<boolean> {
  const result = await appendWecomWsActiveStreamReply({
    accountId: params.accountId,
    to: params.to,
    chunk: params.chunk,
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
  return result.accepted;
}

export function registerWecomWsPendingAutoImagePaths(params: {
  accountId: string;
  to: string;
  imagePaths: string[];
  sessionKey?: string;
  runId?: string;
}): number {
  const context = findMessageContext(params);
  if (!context) return 0;
  const seen = new Set(context.pendingAutoImagePaths.map((entry) => entry.trim()).filter(Boolean));
  let added = 0;
  for (const raw of params.imagePaths) {
    const imagePath = String(raw ?? "").trim();
    if (!imagePath || seen.has(imagePath)) continue;
    context.pendingAutoImagePaths.push(imagePath);
    seen.add(imagePath);
    added += 1;
  }
  if (added > 0) {
    context.updatedAt = now();
  }
  return added;
}

export function consumeWecomWsPendingAutoImagePaths(params: {
  accountId: string;
  to: string;
  sessionKey?: string;
  runId?: string;
}): string[] {
  const context = findMessageContext(params);
  if (!context || context.pendingAutoImagePaths.length === 0) return [];
  const imagePaths = context.pendingAutoImagePaths.slice();
  context.pendingAutoImagePaths = [];
  context.updatedAt = now();
  return imagePaths;
}

export async function appendWecomWsActiveStreamReply(params: {
  accountId: string;
  to: string;
  chunk?: string;
  msgItems?: WecomReplyMsgItem[];
  sessionKey?: string;
  runId?: string;
}): Promise<WecomWsAppendResult> {
  const context = findMessageContext(params);
  if (!context) {
    return {
      accepted: false,
      appendedMsgItems: 0,
    };
  }
  const chunk = String(params.chunk ?? "");
  const rawMsgItems = Array.isArray(params.msgItems) ? params.msgItems : [];
  const remainingMsgItemSlots = Math.max(0, WECOM_REPLY_MSG_ITEM_LIMIT - context.msgItems.length);
  const acceptedMsgItems = remainingMsgItemSlots > 0 ? rawMsgItems.slice(0, remainingMsgItemSlots) : [];
  if (!chunk.trim() && acceptedMsgItems.length === 0) {
    return {
      accepted: true,
      appendedMsgItems: 0,
    };
  }
  const key = messageKey(context.accountId, context.reqId);
  clearFinishTimer(key);
  await enqueue(context, async () => {
    if (acceptedMsgItems.length > 0) {
      context.msgItems.push(...acceptedMsgItems);
    }
    if (chunk.trim()) {
      context.content = appendStreamSnapshotContent(context.content, chunk);
      await context.send(
        buildWecomWsRespondMessageCommand({
          reqId: context.reqId,
          streamId: context.streamId,
          content: context.content,
          finish: false,
        })
      );
      context.started = true;
    }
    context.updatedAt = now();
  });
  return {
    accepted: true,
    appendedMsgItems: acceptedMsgItems.length,
  };
}

export function scheduleWecomWsMessageContextFinish(params: {
  accountId: string;
  reqId: string;
  error?: unknown;
}): void {
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  clearFinishTimer(key);
  const timer = setTimeout(() => {
    void finishWecomWsMessageContext(params);
  }, STREAM_FINISH_GRACE_MS);
  finishTimers.set(key, timer);
}

export async function finishWecomWsMessageContext(params: {
  accountId: string;
  reqId: string;
  error?: unknown;
}): Promise<void> {
  pruneMessageContexts();
  const key = messageKey(params.accountId.trim(), params.reqId.trim());
  clearFinishTimer(key);
  const context = messageContexts.get(key);
  if (!context || context.finished) return;
  await enqueue(context, async () => {
    const errorMessage = params.error ? `Error: ${params.error instanceof Error ? params.error.message : String(params.error)}` : "";
    const finalContent = errorMessage
      ? context.content
        ? `${context.content}\n\n${errorMessage}`
        : errorMessage
      : context.content;
    const sendFinish = context.started || Boolean(finalContent) || context.msgItems.length > 0;
    if (sendFinish) {
      await context.send(
        buildWecomWsRespondMessageCommand({
          reqId: context.reqId,
          streamId: context.streamId,
          content: finalContent || undefined,
          finish: true,
          msgItems: context.msgItems,
        })
      );
    }
    context.finished = true;
    context.updatedAt = now();
  });
  messageContexts.delete(key);
  const sessionKey = context.sessionKey?.trim();
  if (sessionKey) {
    const route = routeKey(context.accountId, sessionKey);
    if (messageBySessionKey.get(route) === key) {
      messageBySessionKey.delete(route);
    }
  }
  const runId = context.runId?.trim();
  if (runId) {
    const route = routeKey(context.accountId, runId);
    if (messageByRunId.get(route) === key) {
      messageByRunId.delete(route);
    }
  }
  removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
}

export async function sendWecomWsActiveTemplateCard(params: {
  accountId: string;
  to: string;
  templateCard: Record<string, unknown>;
}): Promise<boolean> {
  const context = findEventContext({
    accountId: params.accountId,
    to: params.to,
    kind: "template_card_event",
  });
  if (!context) return false;
  await enqueue(context, async () => {
    await context.send(
      buildWecomWsUpdateTemplateCardCommand({
        reqId: context.reqId,
        templateCard: params.templateCard,
      })
    );
    context.updatedAt = now();
  });
  return true;
}

export function clearWecomWsReplyContextsForAccount(accountId: string): void {
  const trimmed = accountId.trim();
  for (const [key, context] of messageContexts.entries()) {
    if (context.accountId !== trimmed) continue;
    clearFinishTimer(key);
    messageContexts.delete(key);
    removeTargetIndex(messageByTarget, targetKey(context.accountId, context.to), key);
    if (context.sessionKey) {
      messageBySessionKey.delete(routeKey(context.accountId, context.sessionKey));
    }
    if (context.runId) {
      messageByRunId.delete(routeKey(context.accountId, context.runId));
    }
  }
  for (const [key, context] of eventContexts.entries()) {
    if (context.accountId !== trimmed) continue;
    eventContexts.delete(key);
    removeTargetIndex(eventByTarget, targetKey(context.accountId, context.to), key);
  }
}
