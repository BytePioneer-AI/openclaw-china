/**
 * 媒体处理模块
 *
 * 提供统一的媒体解析、路径处理和文件读取功能
 *
 * @module @xuanyue202/shared/media
 */

// 媒体解析
export {
  // 类型
  type MediaType,
  type ExtractedMedia,
  type MediaParseResult,
  type MediaParseOptions,
  // 常量
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  NON_IMAGE_EXTENSIONS,
  // 路径处理函数
  isHttpUrl,
  isFileUrl,
  isLocalReference,
  normalizeLocalPath,
  stripTitleFromUrl,
  getExtension,
  isImagePath,
  isNonImageFilePath,
  detectMediaType,
  // 媒体提取函数
  extractMediaFromText,
  extractImagesFromText,
  extractFilesFromText,
} from "./media-parser.js";

// 媒体 IO
export {
  // 类型
  type MediaReadResult,
  type MediaReadOptions,
  type DownloadToTempFileResult,
  type DownloadToTempFileOptions,
  type FinalizeInboundMediaOptions,
  type PruneInboundMediaDirOptions,
  type PathSecurityOptions,
  // 错误类
  FileSizeLimitError,
  MediaTimeoutError,
  PathSecurityError,
  // 路径安全
  validatePathSecurity,
  getDefaultAllowedPrefixes,
  // MIME 类型
  getMimeType,
  // 媒体读取函数
  fetchMediaFromUrl,
  readMediaFromLocal,
  readMedia,
  readMediaBatch,
  downloadToTempFile,
  finalizeInboundMediaFile,
  pruneInboundMediaDir,
  cleanupFileSafe,
} from "./media-io.js";
