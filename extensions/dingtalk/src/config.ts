// 钉钉配置 schema
import { z } from "zod";

/**
 * 钉钉渠道配置 Schema
 * 
 * 配置字段说明:
 * - enabled: 是否启用该渠道
 * - clientId: 钉钉应用的 AppKey
 * - clientSecret: 钉钉应用的 AppSecret
 * - dmPolicy: 单聊策略 (open=开放, pairing=配对, allowlist=白名单)
 * - groupPolicy: 群聊策略 (open=开放, allowlist=白名单, disabled=禁用)
 * - requireMention: 群聊是否需要 @机器人
 * - allowFrom: 单聊白名单用户 ID 列表
 * - groupAllowFrom: 群聊白名单会话 ID 列表
 * - historyLimit: 历史消息数量限制
 * - textChunkLimit: 文本分块大小限制
 * - enableAICard: 是否启用 AI Card 流式响应
 * - maxFileSizeMB: 媒体文件大小限制 (MB)
 * - replyFinalOnly: 是否只发送最终回复（非流式）
 */
export const DingtalkConfigSchema = z.object({
  /** 是否启用钉钉渠道 */
  enabled: z.boolean().optional().default(true),
  
  /** 钉钉应用 AppKey (clientId) */
  clientId: z.string().optional(),
  
  /** 钉钉应用 AppSecret (clientSecret) */
  clientSecret: z.string().optional(),
  
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
  
  /** 历史消息数量限制 */
  historyLimit: z.number().int().min(0).optional().default(10),
  
  /** 文本分块大小限制 (钉钉单条消息最大 4000 字符) */
  textChunkLimit: z.number().int().positive().optional().default(4000),
  
  /** 是否启用 AI Card 流式响应 */
  enableAICard: z.boolean().optional().default(true),

  /** Gateway auth token（Bearer） */
  gatewayToken: z.string().optional(),

  /** Gateway auth password（替代 gatewayToken） */
  gatewayPassword: z.string().optional(),

  /** 媒体文件大小限制 (MB)，默认 100MB */
  maxFileSizeMB: z.number().positive().optional().default(100),

  /** 仅发送最终回复（非流式） */
  replyFinalOnly: z.boolean().optional().default(false),
  
});

export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>;

/**
 * 检查钉钉配置是否已配置凭证
 * @param config 钉钉配置对象
 * @returns 是否已配置 clientId 和 clientSecret
 */
export function isConfigured(config: DingtalkConfig | undefined): boolean {
  return Boolean(config?.clientId && config?.clientSecret);
}

/**
 * 解析钉钉凭证
 * @param config 钉钉配置对象
 * @returns 凭证对象或 undefined
 */
export function resolveDingtalkCredentials(
  config: DingtalkConfig | undefined
): { clientId: string; clientSecret: string } | undefined {
  if (!config?.clientId || !config?.clientSecret) {
    return undefined;
  }
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  };
}
