import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

type ResponseEndpoint = {
  url: string;
  createdAt: number;
  expiresAt: number;
};

type TempMediaEntry = {
  id: string;
  token: string;
  filePath: string;
  fileName: string;
  createdAt: number;
  expiresAt: number;
};

const RESPONSE_URL_TTL_MS = 55 * 60 * 1000;
const TEMP_MEDIA_TTL_MS = 15 * 60 * 1000;
const TEMP_MEDIA_PREFIX = "/wecom-media";

const responseEndpoints = new Map<string, ResponseEndpoint[]>();
const accountPublicBaseUrl = new Map<string, string>();
const tempMedia = new Map<string, TempMediaEntry>();

function endpointKey(accountId: string, to: string): string {
  return `${accountId}::${to}`;
}

function now(): number {
  return Date.now();
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

function pickFirstHeaderPart(value: string): string {
  return value
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) ?? "";
}

function normalizeProto(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "https" || lower === "http") return lower;
  return "https";
}

function guessContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function pruneExpiredResponseUrls(): void {
  const ts = now();
  for (const [key, list] of responseEndpoints.entries()) {
    const active = list.filter((entry) => entry.expiresAt > ts);
    if (active.length > 0) {
      responseEndpoints.set(key, active);
    } else {
      responseEndpoints.delete(key);
    }
  }
}

function pruneExpiredTempMedia(): void {
  const ts = now();
  for (const [id, item] of tempMedia.entries()) {
    if (item.expiresAt <= ts) {
      tempMedia.delete(id);
    }
  }
}

export function rememberAccountPublicBaseUrl(accountId: string, req: IncomingMessage): void {
  const headers = (req as { headers?: IncomingMessage["headers"] }).headers ?? {};
  const forwardedHost = pickFirstHeaderPart(normalizeHeaderValue(headers["x-forwarded-host"]));
  const host = forwardedHost || normalizeHeaderValue(headers.host).trim();
  if (!host) return;
  const forwardedProto = pickFirstHeaderPart(normalizeHeaderValue(headers["x-forwarded-proto"]));
  const encrypted = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
  const proto = normalizeProto(forwardedProto || (encrypted ? "https" : "http"));
  accountPublicBaseUrl.set(accountId, `${proto}://${host}`);
}

export function getAccountPublicBaseUrl(accountId: string): string | undefined {
  return accountPublicBaseUrl.get(accountId);
}

export function registerResponseUrl(params: {
  accountId: string;
  to: string;
  responseUrl: string;
}): void {
  const accountId = params.accountId.trim();
  const to = params.to.trim();
  const responseUrl = params.responseUrl.trim();
  if (!accountId || !to || !responseUrl) return;
  pruneExpiredResponseUrls();
  const key = endpointKey(accountId, to);
  const list = responseEndpoints.get(key) ?? [];
  if (list.some((entry) => entry.url === responseUrl)) return;
  list.push({
    url: responseUrl,
    createdAt: now(),
    expiresAt: now() + RESPONSE_URL_TTL_MS,
  });
  responseEndpoints.set(key, list);
}

export function consumeResponseUrl(params: {
  accountId: string;
  to: string;
}): string | null {
  const accountId = params.accountId.trim();
  const to = params.to.trim();
  if (!accountId || !to) return null;
  pruneExpiredResponseUrls();
  const key = endpointKey(accountId, to);
  const list = responseEndpoints.get(key) ?? [];
  const next = list[list.length - 1];
  return next?.url ?? null;
}

export async function registerTempLocalMedia(params: {
  filePath: string;
  fileName?: string;
}): Promise<{ id: string; token: string; fileName: string }> {
  pruneExpiredTempMedia();
  const absPath = path.resolve(params.filePath);
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error(`Local media path is not a file: ${absPath}`);
  }
  const id = randomBytes(12).toString("hex");
  const token = randomBytes(16).toString("hex");
  const fileName = (params.fileName?.trim() || path.basename(absPath) || "file.bin").replace(/[^\w.\-]/g, "_");
  tempMedia.set(id, {
    id,
    token,
    filePath: absPath,
    fileName,
    createdAt: now(),
    expiresAt: now() + TEMP_MEDIA_TTL_MS,
  });
  return { id, token, fileName };
}

export function buildTempMediaUrl(params: {
  baseUrl: string;
  id: string;
  token: string;
  fileName: string;
}): string {
  const base = params.baseUrl.replace(/\/+$/, "");
  const safeName = encodeURIComponent(params.fileName);
  return `${base}${TEMP_MEDIA_PREFIX}/${params.id}/${safeName}?token=${encodeURIComponent(params.token)}`;
}

export async function handleTempMediaRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  pruneExpiredTempMedia();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(`${TEMP_MEDIA_PREFIX}/`)) return false;

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return true;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /wecom-media/:id/:filename
  if (parts.length < 2) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }
  const id = parts[1] ?? "";
  const token = String(url.searchParams.get("token") ?? "").trim();
  const entry = tempMedia.get(id);
  if (!entry || !token || token !== entry.token) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  try {
    const data = await fs.readFile(entry.filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", guessContentType(entry.fileName));
    res.setHeader("Content-Disposition", `inline; filename="${entry.fileName}"`);
    res.end(data);
    return true;
  } catch {
    tempMedia.delete(id);
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }
}

// 仅用于测试
export function clearOutboundReplyState(): void {
  responseEndpoints.clear();
  accountPublicBaseUrl.clear();
  tempMedia.clear();
}
