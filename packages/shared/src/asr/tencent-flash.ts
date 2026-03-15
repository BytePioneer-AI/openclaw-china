import { createHash, createHmac } from "node:crypto";
import {
  ASRAuthError,
  ASREmptyResultError,
  ASRRequestError,
  ASRResponseParseError,
  ASRServiceError,
  ASRTimeoutError,
} from "./errors.js";

const ASR_FLASH_HOST = "asr.cloud.tencent.com";
const ASR_FLASH_PATH_PREFIX = "/asr/flash/v1";
const ASR_FLASH_URL_PREFIX = `https://${ASR_FLASH_HOST}${ASR_FLASH_PATH_PREFIX}`;
const ASR_API3_HOST = "asr.tencentcloudapi.com";
const ASR_API3_URL = `https://${ASR_API3_HOST}/`;
const ASR_API3_ACTION = "SentenceRecognition";
const ASR_API3_VERSION = "2019-06-14";
const ASR_PROVIDER = "tencent-flash";

export interface TencentFlashASRConfig {
  appId: string;
  secretId: string;
  secretKey: string;
  engineType?: string;
  voiceFormat?: string;
  timeoutMs?: number;
}

interface TencentFlashResponseSentence {
  text?: string;
}

interface TencentFlashResponseItem {
  text?: string;
  sentence_list?: TencentFlashResponseSentence[];
}

interface TencentFlashResponse {
  code?: number;
  message?: string;
  flash_result?: TencentFlashResponseItem[];
}

interface TencentSentenceRecognitionError {
  Code?: string;
  Message?: string;
}

interface TencentSentenceRecognitionWord {
  Word?: string;
}

interface TencentSentenceRecognitionPayload {
  Response?: {
    Result?: string;
    AudioDuration?: number;
    WordList?: TencentSentenceRecognitionWord[];
    RequestId?: string;
    Error?: TencentSentenceRecognitionError;
  };
}

function normalizeBodySnippet(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim().slice(0, 300);
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildSignedQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeQueryValue(value)}`)
    .join("&");
}

function extractTranscript(payload: TencentFlashResponse): string {
  const items = Array.isArray(payload.flash_result) ? payload.flash_result : [];
  const lines: string[] = [];

  for (const item of items) {
    if (typeof item?.text === "string" && item.text.trim()) {
      lines.push(item.text.trim());
      continue;
    }
    const sentenceList = Array.isArray(item?.sentence_list) ? item.sentence_list : [];
    for (const sentence of sentenceList) {
      if (typeof sentence?.text === "string" && sentence.text.trim()) {
        lines.push(sentence.text.trim());
      }
    }
  }

  return lines.join("\n").trim();
}

function hashSha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmacSha256(key: Buffer | string, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

async function transcribeTencentSentenceRecognition(params: {
  audio: Buffer;
  config: TencentFlashASRConfig;
}): Promise<string> {
  const { audio, config } = params;
  const now = Math.floor(Date.now() / 1000);
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    Data: audio.toString("base64"),
    DataLen: audio.length,
    EngSerViceType: config.engineType ?? "16k_zh",
    SourceType: 1,
    SubServiceType: 2,
    VoiceFormat: config.voiceFormat ?? "silk",
    WordInfo: 0,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
    ConvertNumMode: 1,
    ProjectId: 0,
  });

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${ASR_API3_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashSha256Hex(payload),
  ].join("\n");

  const credentialScope = `${date}/asr/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(now),
    credentialScope,
    hashSha256Hex(canonicalRequest),
  ].join("\n");

  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, "asr");
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(ASR_API3_URL, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: ASR_API3_HOST,
      "X-TC-Action": ASR_API3_ACTION,
      "X-TC-Timestamp": String(now),
      "X-TC-Version": ASR_API3_VERSION,
    },
    body: payload,
  });

  const bodyText = await response.text();
  const bodySnippet = normalizeBodySnippet(bodyText);
  let parsed: TencentSentenceRecognitionPayload;
  try {
    parsed = JSON.parse(bodyText.replace(/^\uFEFF/, "")) as TencentSentenceRecognitionPayload;
  } catch {
    if (!response.ok) {
      throw new ASRRequestError(
        ASR_PROVIDER,
        `Tencent SentenceRecognition request failed: HTTP ${response.status}`,
        response.status,
        bodySnippet
      );
    }
    throw new ASRResponseParseError(ASR_PROVIDER, bodySnippet, response.status);
  }

  const error = parsed.Response?.Error;
  if (!response.ok) {
    const message = error?.Message ?? `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new ASRAuthError(ASR_PROVIDER, `Tencent SentenceRecognition authentication failed: ${message}`, response.status);
    }
    throw new ASRRequestError(
      ASR_PROVIDER,
      `Tencent SentenceRecognition request failed: ${message}`,
      response.status,
      bodySnippet
    );
  }

  if (error?.Code) {
    throw new ASRServiceError(
      ASR_PROVIDER,
      `Tencent SentenceRecognition failed: ${error.Message ?? error.Code} (${error.Code})`
    );
  }

  const transcript = String(parsed.Response?.Result ?? "").trim();
  if (transcript) return transcript;

  const wordTranscript = (parsed.Response?.WordList ?? [])
    .map((item) => String(item?.Word ?? "").trim())
    .filter(Boolean)
    .join("");
  if (wordTranscript) return wordTranscript;

  throw new ASREmptyResultError(ASR_PROVIDER);
}

export async function transcribeTencentFlash(params: {
  audio: Buffer;
  config: TencentFlashASRConfig;
}): Promise<string> {
  const { audio, config } = params;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const engineType = config.engineType ?? "16k_zh";
  const voiceFormat = config.voiceFormat ?? "silk";
  const query = buildSignedQuery({
    engine_type: engineType,
    secretid: config.secretId,
    timestamp,
    voice_format: voiceFormat,
  });

  const signText = `POST${ASR_FLASH_HOST}${ASR_FLASH_PATH_PREFIX}/${config.appId}?${query}`;
  const authorization = createHmac("sha1", config.secretKey).update(signText).digest("base64");
  const url = `${ASR_FLASH_URL_PREFIX}/${config.appId}?${query}`;
  const timeoutMs = config.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
      },
      body: audio,
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const bodySnippet = normalizeBodySnippet(bodyText);
    const normalizedBodyText = bodyText.replace(/^\uFEFF/, "");
    let payload: TencentFlashResponse;
    try {
      payload = JSON.parse(normalizedBodyText) as TencentFlashResponse;
    } catch {
      if (!response.ok) {
        const message = `Tencent Flash ASR request failed: HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          throw new ASRAuthError(ASR_PROVIDER, message, response.status);
        }
        throw new ASRRequestError(ASR_PROVIDER, message, response.status, bodySnippet);
      }
      throw new ASRResponseParseError(ASR_PROVIDER, bodySnippet, response.status);
    }

    if (!response.ok) {
      const message = payload.message ?? `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw new ASRAuthError(
          ASR_PROVIDER,
          `Tencent Flash ASR authentication failed: ${message}`,
          response.status
        );
      }
      throw new ASRRequestError(
        ASR_PROVIDER,
        `Tencent Flash ASR request failed: ${message}`,
        response.status,
        bodySnippet
      );
    }

    if (payload.code !== 0) {
      throw new ASRServiceError(
        ASR_PROVIDER,
        `Tencent Flash ASR failed: ${payload.message ?? "unknown error"} (code=${payload.code})`
        ,
        payload.code
      );
    }

    const transcript = extractTranscript(payload);
    if (!transcript) {
      throw new ASREmptyResultError(ASR_PROVIDER);
    }
    return transcript;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ASRTimeoutError(ASR_PROVIDER, timeoutMs);
    }
    if (
      error instanceof ASRResponseParseError ||
      error instanceof ASRAuthError ||
      error instanceof ASRRequestError ||
      error instanceof ASRServiceError ||
      error instanceof ASREmptyResultError ||
      error instanceof ASRTimeoutError
    ) {
      if (error instanceof ASRRequestError && error.status === 404) {
        return await transcribeTencentSentenceRecognition(params);
      }
      throw error;
    }
    throw new ASRRequestError(
      ASR_PROVIDER,
      `Tencent Flash ASR request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
