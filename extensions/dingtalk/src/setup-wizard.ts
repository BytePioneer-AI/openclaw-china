import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { splitSetupEntries } from "openclaw/plugin-sdk/setup";

import {
  DEFAULT_ACCOUNT_ID,
  listDingtalkAccountIds,
  mergeDingtalkAccountConfig,
  normalizeAccountId,
  resolveDefaultDingtalkAccountId,
  resolveDingtalkCredentials,
  type DingtalkConfig,
  type PluginConfig,
} from "./config.js";
import {
  applyDingtalkAccountPatch,
  resolveDingtalkDmConfigKeys,
  setDingtalkAllowFrom,
  setDingtalkDmPolicy,
  setDingtalkGroupPolicy,
} from "./setup-helpers.js";

function isDingtalkConfigured(cfg: PluginConfig): boolean {
  return listDingtalkAccountIds(cfg).some((accountId) =>
    Boolean(resolveDingtalkCredentials(mergeDingtalkAccountConfig(cfg, accountId))),
  );
}

async function noteDingtalkCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) 访问钉钉开放平台 (open.dingtalk.com)",
      "2) 创建企业内部应用",
      "3) 在“凭证与基础信息”页面获取 AppKey 和 AppSecret",
      "4) 在“机器人与消息推送”中启用机器人能力",
      "5) 选择 Stream 或 Webhook 模式接收消息",
      "6) 发布应用或添加到测试群",
    ].join("\n"),
    "钉钉凭证配置",
  );
}

async function promptDingtalkAllowFrom(params: {
  cfg: PluginConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<PluginConfig> {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  const existing = mergeDingtalkAccountConfig(params.cfg, resolvedAccountId).allowFrom ?? [];

  await params.prompter.note(
    [
      "通过 staffId 或 unionId 设置钉钉私聊白名单。",
      "可以输入逗号、分号或换行分隔的多个值。",
    ].join("\n"),
    "钉钉白名单",
  );

  const result = await params.prompter.text({
    message: "钉钉白名单 (用户 ID)",
    placeholder: "user-1, user-2",
    initialValue: existing.join(", "),
    validate: (value) => {
      const entries = splitSetupEntries(String(value ?? ""));
      return entries.length > 0 ? undefined : "请至少输入一个用户 ID";
    },
  });

  if (typeof result !== "string") {
    return params.cfg;
  }

  const allowFrom = splitSetupEntries(result);
  return setDingtalkAllowFrom(params.cfg, resolvedAccountId, allowFrom);
}

const dingtalkDmPolicy: ChannelSetupDmPolicy = {
  label: "DingTalk",
  channel: "dingtalk",
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  resolveConfigKeys: (_cfg, accountId) => resolveDingtalkDmConfigKeys(accountId),
  getCurrent: (cfg, accountId) =>
    mergeDingtalkAccountConfig(cfg as PluginConfig, normalizeAccountId(accountId)).dmPolicy ?? "open",
  setPolicy: (cfg, policy, accountId) =>
    setDingtalkDmPolicy(
      cfg as PluginConfig,
      normalizeAccountId(accountId),
      policy === "pairing" || policy === "allowlist" ? policy : "open",
    ),
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptDingtalkAllowFrom({
      cfg: cfg as PluginConfig,
      prompter,
      accountId,
    }),
};

export const dingtalkSetupWizard: ChannelSetupWizard = {
  channel: "dingtalk",
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs app credentials",
    configuredHint: "已配置",
    unconfiguredHint: "需要应用凭证",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isDingtalkConfigured(cfg as PluginConfig),
    resolveStatusLines: ({ cfg, configured }) => {
      if (!configured) {
        return ["DingTalk: 需要配置应用凭证"];
      }

      const defaultAccountId = resolveDefaultDingtalkAccountId(cfg as PluginConfig);
      return [
        defaultAccountId === DEFAULT_ACCOUNT_ID
          ? "DingTalk: 已配置"
          : `DingTalk: 已配置 (default=${defaultAccountId})`,
      ];
    },
  },
  credentials: [],
  resolveAccountIdForConfigure: ({ accountOverride, cfg }) =>
    normalizeAccountId(accountOverride ?? resolveDefaultDingtalkAccountId(cfg as PluginConfig)),
  finalize: async ({ cfg, accountId, prompter }) => {
    const resolvedAccountId = normalizeAccountId(accountId);
    const current = mergeDingtalkAccountConfig(cfg as PluginConfig, resolvedAccountId);
    let next = cfg as PluginConfig;

    if (!resolveDingtalkCredentials(current)) {
      await noteDingtalkCredentialHelp(prompter);
    }

    let keepExisting = false;
    if (resolveDingtalkCredentials(current)) {
      keepExisting = await prompter.confirm({
        message: "钉钉凭证已配置，是否保留？",
        initialValue: true,
      });
    }

    if (!keepExisting) {
      const clientId = await prompter.text({
        message: "请输入钉钉 AppKey (clientId)",
        initialValue: current.clientId,
        validate: (value) => (value?.trim() ? undefined : "必填"),
      });
      if (typeof clientId !== "string") {
        return { cfg };
      }

      const clientSecret = await prompter.text({
        message: "请输入钉钉 AppSecret (clientSecret)",
        initialValue: current.clientSecret,
        validate: (value) => (value?.trim() ? undefined : "必填"),
      });
      if (typeof clientSecret !== "string") {
        return { cfg };
      }

      next = applyDingtalkAccountPatch(next, resolvedAccountId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
    }

    const connectionMode = await prompter.select({
      message: "钉钉连接模式",
      options: [
        { value: "stream", label: "Stream" },
        { value: "webhook", label: "Webhook" },
      ],
      initialValue: current.connectionMode ?? "stream",
    });
    if (connectionMode === "stream" || connectionMode === "webhook") {
      next = applyDingtalkAccountPatch(next, resolvedAccountId, { connectionMode });
    }

    const enableAICard = await prompter.confirm({
      message: "是否启用 AI Card 流式响应？",
      initialValue: current.enableAICard ?? false,
    });
    next = applyDingtalkAccountPatch(next, resolvedAccountId, { enableAICard });

    const groupPolicy = await prompter.select({
      message: "群聊策略",
      options: [
        { value: "open", label: "开放" },
        { value: "allowlist", label: "白名单" },
        { value: "disabled", label: "禁用" },
      ],
      initialValue: current.groupPolicy ?? "open",
    });
    if (groupPolicy === "open" || groupPolicy === "allowlist" || groupPolicy === "disabled") {
      next = setDingtalkGroupPolicy(next, resolvedAccountId, groupPolicy);
    }

    return { cfg: next, accountId: resolvedAccountId };
  },
  dmPolicy: dingtalkDmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        enabled: false,
      } as DingtalkConfig,
    },
  }),
};
