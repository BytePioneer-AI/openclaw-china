import type { WecomFooterConfig } from "./types.js";

export type ResolvedWecomFooterConfig = {
  status: boolean;
  elapsed: boolean;
};

export const DEFAULT_WECOM_FOOTER_CONFIG: ResolvedWecomFooterConfig = {
  status: false,
  elapsed: false,
};

export function resolveWecomFooterConfig(config?: WecomFooterConfig): ResolvedWecomFooterConfig {
  if (!config) return { ...DEFAULT_WECOM_FOOTER_CONFIG };
  return {
    status: config.status ?? DEFAULT_WECOM_FOOTER_CONFIG.status,
    elapsed: config.elapsed ?? DEFAULT_WECOM_FOOTER_CONFIG.elapsed,
  };
}

export function formatWecomElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function buildWecomFooterText(params: {
  footer?: WecomFooterConfig;
  createdAt: number;
  finishedAt?: number;
  isError?: boolean;
  isAborted?: boolean;
}): string {
  const footer = resolveWecomFooterConfig(params.footer);
  const parts: string[] = [];
  if (footer.status) {
    if (params.isAborted) parts.push("已停止");
    else if (params.isError) parts.push("出错");
    else parts.push("已完成");
  }
  if (footer.elapsed) {
    const finishedAt = params.finishedAt ?? Date.now();
    const elapsedMs = Math.max(0, finishedAt - params.createdAt);
    parts.push(`耗时 ${formatWecomElapsed(elapsedMs)}`);
  }
  return parts.join(" · ");
}

export function appendWecomFooterText(content: string | undefined, footerText: string): string | undefined {
  const trimmedFooter = footerText.trim();
  if (!trimmedFooter) return content;
  const trimmedContent = String(content ?? "").trim();
  if (!trimmedContent) return undefined;
  return `${trimmedContent}\n\n——\n${trimmedFooter}`;
}
