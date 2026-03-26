function stripProviderPrefix(raw: string): string {
  return raw.trim().replace(/^(dingtalk|ding):/i, "").trim();
}

function normalizePrefixedTarget(raw: string, prefix: "user" | "group" | "channel" | "chat") {
  const marker = `${prefix}:`;
  if (!raw.toLowerCase().startsWith(marker)) {
    return undefined;
  }

  const targetId = raw.slice(marker.length).trim();
  if (!targetId) {
    return undefined;
  }

  return prefix === "user" ? `user:${targetId}` : `group:${targetId}`;
}

export function normalizeDingtalkMessagingTarget(raw: string): string | undefined {
  const withoutProvider = stripProviderPrefix(raw);
  if (!withoutProvider) {
    return undefined;
  }

  const prefixed =
    normalizePrefixedTarget(withoutProvider, "user") ??
    normalizePrefixedTarget(withoutProvider, "group") ??
    normalizePrefixedTarget(withoutProvider, "channel") ??
    normalizePrefixedTarget(withoutProvider, "chat");
  if (prefixed) {
    return prefixed;
  }

  if (withoutProvider.startsWith("@")) {
    const userId = withoutProvider.slice(1).trim();
    return userId ? `user:${userId}` : undefined;
  }

  if (withoutProvider.startsWith("#")) {
    const groupId = withoutProvider.slice(1).trim();
    return groupId ? `group:${groupId}` : undefined;
  }

  return `user:${withoutProvider}`;
}

export function parseDingtalkSendTarget(raw: string):
  | { normalized: string; targetId: string; chatType: "direct" | "group" }
  | null {
  const normalized = normalizeDingtalkMessagingTarget(raw);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("group:")) {
    return {
      normalized,
      targetId: normalized.slice("group:".length),
      chatType: "group",
    };
  }

  return {
    normalized,
    targetId: normalized.slice("user:".length),
    chatType: "direct",
  };
}

export function looksLikeDingtalkTarget(raw: string, normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(dingtalk|ding):(user|group|channel|chat):/i.test(trimmed)) {
    return true;
  }

  if (/^(user|group|channel|chat):/i.test(trimmed) || /^[@#]/.test(trimmed)) {
    return true;
  }

  const resolved = normalized ?? normalizeDingtalkMessagingTarget(trimmed);
  if (!resolved) {
    return false;
  }

  const candidate = resolved.replace(/^(user|group):/i, "").trim();
  return candidate.length > 0 && !/\s/.test(candidate);
}

export function inferDingtalkTargetChatType(raw: string): "direct" | "group" | undefined {
  return parseDingtalkSendTarget(raw)?.chatType;
}

export function formatDingtalkTargetDisplay(params: {
  target: string;
  display?: string;
}): string {
  const parsed = parseDingtalkSendTarget(params.target);
  if (!parsed) {
    return params.display?.trim() || params.target;
  }

  const display = params.display?.trim();
  if (display) {
    if (display.startsWith("@") || display.startsWith("#")) {
      return display;
    }
    return parsed.chatType === "group" ? `#${display}` : `@${display}`;
  }

  return parsed.normalized;
}
