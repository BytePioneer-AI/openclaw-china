import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { WechatMpAccountState, WechatMpPersistedState } from "./types.js";

/** 48 hours in milliseconds - WeChat's interaction window */
const INTERACTION_WINDOW_MS = 48 * 60 * 60 * 1000;

const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEFAULT_STATE_FILE = join(homedir(), ".openclaw", "wechat-mp", "data", "state.json");

let stateFilePath = DEFAULT_STATE_FILE;
let cachedState: WechatMpPersistedState | null = null;
let loadingState: Promise<WechatMpPersistedState> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function createEmptyState(): WechatMpPersistedState {
  return {
    version: 1,
    processedMsgIds: {},
    accounts: {},
  };
}

function pruneState(state: WechatMpPersistedState): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [msgId, timestamp] of Object.entries(state.processedMsgIds)) {
    if (timestamp < cutoff) {
      delete state.processedMsgIds[msgId];
    }
  }
}

async function saveState(): Promise<void> {
  if (!cachedState) return;
  pruneState(cachedState);
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, `${JSON.stringify(cachedState, null, 2)}\n`, "utf8");
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveState();
  }, 50);
}

async function loadState(): Promise<WechatMpPersistedState> {
  if (cachedState) return cachedState;
  if (loadingState) return loadingState;

  loadingState = (async () => {
    try {
      const raw = await readFile(stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WechatMpPersistedState>;
      cachedState = {
        version: 1,
        processedMsgIds: parsed.processedMsgIds ?? {},
        accounts: parsed.accounts ?? {},
      };
    } catch {
      cachedState = createEmptyState();
    }
    pruneState(cachedState);
    return cachedState;
  })();

  try {
    return await loadingState;
  } finally {
    loadingState = null;
  }
}

export async function markProcessedMessage(msgId: string): Promise<boolean> {
  const normalized = msgId.trim();
  if (!normalized) return false;
  const state = await loadState();
  pruneState(state);
  if (state.processedMsgIds[normalized]) {
    return false;
  }
  state.processedMsgIds[normalized] = Date.now();
  scheduleSave();
  return true;
}

export async function getAccountState(accountId: string): Promise<WechatMpAccountState> {
  const state = await loadState();
  return { ...(state.accounts[accountId] ?? {}) };
}

export async function updateAccountState(
  accountId: string,
  patch: Partial<WechatMpAccountState>
): Promise<WechatMpAccountState> {
  const state = await loadState();
  const current = state.accounts[accountId] ?? {};
  const next = { ...current, ...patch };
  state.accounts[accountId] = next;
  scheduleSave();
  return next;
}

export async function flushWechatMpStateForTests(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveState();
}

export function setWechatMpStateFilePathForTests(nextPath?: string): void {
  stateFilePath = nextPath?.trim() || DEFAULT_STATE_FILE;
  cachedState = null;
  loadingState = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// ============================================================================
// User Interaction Tracking (48h Window)
// ============================================================================

/**
 * Get the last interaction time for a user within an account.
 * Returns null if the user has never interacted or interaction data doesn't exist.
 *
 * @param accountId The account identifier
 * @param openId The user's openId
 * @returns Last interaction timestamp in milliseconds, or null
 */
export async function getLastInteractionTime(
  accountId: string,
  openId: string
): Promise<number | null> {
  const state = await loadState();
  const accountState = state.accounts[accountId];
  if (!accountState?.userInteractions?.[openId]) {
    return null;
  }
  return accountState.userInteractions[openId].lastInteractionAt;
}

/**
 * Record a user interaction timestamp.
 * Called when processing inbound messages to track the 48h interaction window.
 *
 * @param accountId The account identifier
 * @param openId The user's openId
 * @param timestamp Optional timestamp (defaults to Date.now())
 */
export async function recordUserInteraction(
  accountId: string,
  openId: string,
  timestamp?: number
): Promise<void> {
  const state = await loadState();
  const accountState = state.accounts[accountId] ?? {};
  const userInteractions = accountState.userInteractions ?? {};

  userInteractions[openId] = {
    lastInteractionAt: timestamp ?? Date.now(),
  };

  state.accounts[accountId] = {
    ...accountState,
    userInteractions,
  };

  scheduleSave();
}

/**
 * Check if a user is within the 48h interaction window.
 *
 * @param accountId The account identifier
 * @param openId The user's openId
 * @returns true if user has interacted within the last 48 hours
 */
export async function isWithinInteractionWindow(
  accountId: string,
  openId: string
): Promise<boolean> {
  const lastInteraction = await getLastInteractionTime(accountId, openId);
  if (lastInteraction === null) {
    return false;
  }
  return Date.now() - lastInteraction < INTERACTION_WINDOW_MS;
}

/**
 * Get when the 48h interaction window expires for a user.
 *
 * @param accountId The account identifier
 * @param openId The user's openId
 * @returns Expiration timestamp in milliseconds, or null if outside window
 */
export async function getInteractionWindowExpiry(
  accountId: string,
  openId: string
): Promise<number | null> {
  const lastInteraction = await getLastInteractionTime(accountId, openId);
  if (lastInteraction === null) {
    return null;
  }
  const expiresAt = lastInteraction + INTERACTION_WINDOW_MS;
  if (Date.now() >= expiresAt) {
    return null;
  }
  return expiresAt;
}
