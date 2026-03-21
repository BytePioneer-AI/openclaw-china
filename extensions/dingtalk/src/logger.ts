/**
 * 钉钉插件日志工具
 *
 * 在 shared logger 基础上，为钉钉日志增加淡绿色显示。
 */

import {
  createLogger as createBaseLogger,
  type Logger,
  type LogLevel,
  type LoggerOptions,
} from "@xuanyue202/shared";

const PALE_GREEN = "\x1b[38;5;120m";
const RESET = "\x1b[0m";

function colorize(msg: string): string {
  return `${PALE_GREEN}${msg}${RESET}`;
}

export type { Logger, LogLevel, LoggerOptions };

export function createLogger(prefix: string, opts?: LoggerOptions): Logger {
  const log = opts?.log ?? console.log;
  const error = opts?.error ?? console.error;

  return createBaseLogger(prefix, {
    log: (msg: string) => log(colorize(msg)),
    error: (msg: string) => error(colorize(msg)),
  });
}

/**
 * 默认钉钉日志器
 */
export const dingtalkLogger = createLogger("dingtalk");
