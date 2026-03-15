import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type SyncStateEntry = {
  cursor?: string;
  lastProcessedSendTime?: number;
  recentMsgIds: Record<string, number>;
  updatedAt: number;
};

type SyncStateFile = {
  version: 1;
  scopes: Record<string, SyncStateEntry>;
};

const DEFAULT_SYNC_STATE: SyncStateFile = {
  version: 1,
  scopes: {},
};

const RECENT_MSG_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT_MSG_IDS = 512;

let cachedState: SyncStateFile | null = null;

function resolveSyncStateFilePath(): string {
  return join(homedir(), ".openclaw", "wecom-kf", "data", "sync-state.json");
}

function pruneRecentMsgIds(raw: unknown, now: number): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};

  const next = Object.entries(raw as Record<string, unknown>)
    .map(([msgid, ts]) => {
      const value = typeof ts === "number" && Number.isFinite(ts) ? ts : NaN;
      return [msgid.trim(), value] as const;
    })
    .filter(([msgid, ts]) => Boolean(msgid) && Number.isFinite(ts) && ts >= now - RECENT_MSG_ID_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENT_MSG_IDS);

  return Object.fromEntries(next);
}

function normalizeEntry(raw: unknown, now: number): SyncStateEntry {
  const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const cursor = typeof entry.cursor === "string" && entry.cursor.trim() ? entry.cursor.trim() : undefined;
  const lastProcessedSendTime =
    typeof entry.lastProcessedSendTime === "number" && Number.isFinite(entry.lastProcessedSendTime)
      ? entry.lastProcessedSendTime
      : undefined;
  const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;

  return {
    cursor,
    lastProcessedSendTime,
    recentMsgIds: pruneRecentMsgIds(entry.recentMsgIds, now),
    updatedAt,
  };
}

function normalizeState(raw: unknown): SyncStateFile {
  const now = Date.now();
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const scopesRaw = parsed.scopes && typeof parsed.scopes === "object" ? (parsed.scopes as Record<string, unknown>) : {};
  const scopes = Object.fromEntries(
    Object.entries(scopesRaw)
      .map(([scopeKey, value]) => [scopeKey.trim(), normalizeEntry(value, now)] as const)
      .filter(([scopeKey]) => Boolean(scopeKey))
  );

  return {
    version: 1,
    scopes,
  };
}

function loadState(): SyncStateFile {
  if (cachedState) return cachedState;

  const filePath = resolveSyncStateFilePath();
  if (!existsSync(filePath)) {
    cachedState = { ...DEFAULT_SYNC_STATE };
    return cachedState;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    cachedState = normalizeState(JSON.parse(raw));
  } catch {
    cachedState = { ...DEFAULT_SYNC_STATE };
  }

  return cachedState;
}

function saveState(state: SyncStateFile): void {
  const filePath = resolveSyncStateFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function updateScope(scopeKey: string, mutate: (entry: SyncStateEntry, now: number) => boolean): void {
  const key = scopeKey.trim();
  if (!key) return;

  const state = loadState();
  const now = Date.now();
  const current = normalizeEntry(state.scopes[key], now);
  const changed = mutate(current, now);
  if (!changed) return;

  current.updatedAt = now;
  state.scopes[key] = normalizeEntry(current, now);
  saveState(state);
}

export function getPersistedSyncCursor(scopeKey: string): string | undefined {
  const key = scopeKey.trim();
  if (!key) return undefined;
  return normalizeEntry(loadState().scopes[key], Date.now()).cursor;
}

export function getLastProcessedSendTime(scopeKey: string): number | undefined {
  const key = scopeKey.trim();
  if (!key) return undefined;
  return normalizeEntry(loadState().scopes[key], Date.now()).lastProcessedSendTime;
}

export function hasPersistedProcessedMsgId(scopeKey: string, msgid?: string): boolean {
  const key = scopeKey.trim();
  const normalizedMsgId = msgid?.trim();
  if (!key || !normalizedMsgId) return false;
  return Object.prototype.hasOwnProperty.call(normalizeEntry(loadState().scopes[key], Date.now()).recentMsgIds, normalizedMsgId);
}

export function persistSyncCursor(scopeKey: string, cursor?: string): void {
  const normalizedCursor = cursor?.trim();
  if (!normalizedCursor) return;

  updateScope(scopeKey, (entry) => {
    if (entry.cursor === normalizedCursor) return false;
    entry.cursor = normalizedCursor;
    return true;
  });
}

export function persistProcessedMessage(params: {
  scopeKey: string;
  msgid?: string;
  sendTime?: number;
}): void {
  const normalizedMsgId = params.msgid?.trim();
  const normalizedSendTime =
    typeof params.sendTime === "number" && Number.isFinite(params.sendTime) ? params.sendTime : undefined;

  updateScope(params.scopeKey, (entry, now) => {
    let changed = false;

    if (normalizedMsgId) {
      if (entry.recentMsgIds[normalizedMsgId] !== now) {
        entry.recentMsgIds[normalizedMsgId] = now;
        entry.recentMsgIds = pruneRecentMsgIds(entry.recentMsgIds, now);
        changed = true;
      }
    } else {
      const pruned = pruneRecentMsgIds(entry.recentMsgIds, now);
      if (Object.keys(pruned).length !== Object.keys(entry.recentMsgIds).length) {
        entry.recentMsgIds = pruned;
        changed = true;
      }
    }

    if (normalizedSendTime !== undefined && (entry.lastProcessedSendTime ?? Number.NEGATIVE_INFINITY) < normalizedSendTime) {
      entry.lastProcessedSendTime = normalizedSendTime;
      changed = true;
    }

    return changed;
  });
}

export function clearPersistedSyncStateForTest(): void {
  cachedState = null;
}
