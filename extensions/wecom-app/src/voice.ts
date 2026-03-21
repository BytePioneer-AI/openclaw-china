import { AUDIO_EXTENSIONS, resolveExtension } from "@xuanyue202/shared";

const EXTRA_AUDIO_EXTENSIONS = [
  "speex",
  "spx",
  "opus",
  "oga",
  "aac",
  "aiff",
  "aif",
  "caf",
  "m4b",
  "silk",
] as const;

export const WECOM_NATIVE_VOICE_EXTENSIONS = new Set(["amr", "speex"]);
export const WECOM_AUDIO_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...EXTRA_AUDIO_EXTENSIONS]);

export function normalizeMimeType(mimeType?: string): string | undefined {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function extractSourceExtension(source: string): string | undefined {
  const trimmed = String(source ?? "").trim();
  if (!trimmed) return undefined;

  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const match = withoutQuery.match(/\.([^.\\/]+)$/);
  return match?.[1]?.toLowerCase();
}

export function isWecomNativeVoiceExtension(extension?: string): boolean {
  const normalized = extension?.replace(/^\./, "").trim().toLowerCase();
  return Boolean(normalized && WECOM_NATIVE_VOICE_EXTENSIONS.has(normalized));
}

export function isWecomAudioExtension(extension?: string): boolean {
  const normalized = extension?.replace(/^\./, "").trim().toLowerCase();
  return Boolean(normalized && WECOM_AUDIO_EXTENSIONS.has(normalized));
}

export function isWecomAudioMimeType(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized === "voice" || Boolean(normalized && normalized.startsWith("audio/"));
}

export function isWecomNativeVoiceMimeType(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized === "audio/amr" || normalized === "audio/speex" || normalized === "audio/x-speex";
}

export function isWecomAudioSource(source: string, mimeType?: string): boolean {
  if (isWecomAudioMimeType(mimeType)) return true;
  return isWecomAudioExtension(extractSourceExtension(source));
}

export function shouldTranscodeWecomVoice(source: string, mimeType?: string): boolean {
  if (isWecomNativeVoiceMimeType(mimeType)) return false;

  const extension = extractSourceExtension(source);
  if (isWecomNativeVoiceExtension(extension)) return false;

  return isWecomAudioSource(source, mimeType);
}

export function resolveWecomVoiceSourceExtension(source: string, mimeType?: string): string {
  const extension = extractSourceExtension(source);
  if (extension) {
    return `.${extension}`;
  }

  if (mimeType) {
    return resolveExtension(mimeType);
  }

  return ".bin";
}
