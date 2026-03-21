/**
 * 飞书插件日志工具
 *
 * 从 @xuanyue202/shared 重新导出，保持一致
 */

export { createLogger, type Logger, type LogLevel, type LoggerOptions } from "@xuanyue202/shared";

import { createLogger } from "@xuanyue202/shared";

/** 默认飞书日志器 */
export const feishuLogger = createLogger("feishu");
