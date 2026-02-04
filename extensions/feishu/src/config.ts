// 飞书配置 schema
import { z } from "zod";

/**
 * 飞书渠道配置 Schema
 *
 * 配置字段说明:
 * - enabled: 是否启用该渠道
 * - appId: 飞书应用 App ID
 * - appSecret: 飞书应用 App Secret
 * - connectionMode: 连接模式（仅支持 websocket）
 * - dmPolicy: 单聊策略 (open=开放, pairing=配对, allowlist=白名单)
 * - groupPolicy: 群聊策略 (open=开放, allowlist=白名单, disabled=禁用)
 * - requireMention: 群聊是否需要 @机器人
 * - allowFrom: 单聊白名单用户 ID 列表
 * - groupAllowFrom: 群聊白名单会话 ID 列表
 * - historyLimit: 历史消息数量限制
 * - textChunkLimit: 文本分块大小限制
 * - replyFinalOnly: 是否只发送最终回复（非流式）
 */
export const FeishuConfigSchema = z.object({
  /** 是否启用飞书渠道 */
  enabled: z.boolean().optional().default(true),

  /** 飞书应用 App ID */
  appId: z.string().optional(),

  /** 飞书应用 App Secret */
  appSecret: z.string().optional(),

  /** 连接模式（暂只支持 websocket） */
  connectionMode: z.enum(["websocket"]).optional().default("websocket"),

  /** 单聊策略: open=开放, pairing=配对, allowlist=白名单 */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),

  /** 群聊策略: open=开放, allowlist=白名单, disabled=禁用 */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),

  /** 群聊是否需要 @机器人才响应 */
  requireMention: z.boolean().optional().default(true),

  /** 单聊白名单: 允许的用户 ID 列表 */
  allowFrom: z.array(z.string()).optional(),

  /** 群聊白名单: 允许的会话 ID 列表 */
  groupAllowFrom: z.array(z.string()).optional(),

  /** 是否将 Markdown 文本以卡片形式发送 */
  sendMarkdownAsCard: z.boolean().optional().default(true),

  /** 历史消息数量限制 */
  historyLimit: z.number().int().min(0).optional().default(20),

  /** 文本分块大小限制 (飞书文本消息最大 4000 字符) */
  textChunkLimit: z.number().int().positive().optional().default(4000),

  /** 仅发送最终回复（非流式） */
  replyFinalOnly: z.boolean().optional().default(false),
});

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

/**
 * 检查飞书配置是否已配置凭证
 * @param config 飞书配置对象
 * @returns 是否已配置 appId 和 appSecret
 */
export function isConfigured(config: FeishuConfig | undefined): boolean {
  return Boolean(config?.appId && config?.appSecret);
}

/**
 * 解析飞书凭证
 * @param config 飞书配置对象
 * @returns 凭证对象或 undefined
 */
export function resolveFeishuCredentials(
  config: FeishuConfig | undefined
): { appId: string; appSecret: string } | undefined {
  if (!config?.appId || !config?.appSecret) {
    return undefined;
  }
  return {
    appId: config.appId,
    appSecret: config.appSecret,
  };
}
