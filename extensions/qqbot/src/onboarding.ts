import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  mergeQQBotAccountConfig,
  normalizeAccountId,
  resolveDefaultQQBotAccountId,
  resolveQQBotCredentials,
  type PluginConfig,
  type QQBotConfig,
} from "./config.js";
import {
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";

function setQQBotCredentials(params: {
  cfg: PluginConfig;
  accountId: string;
  appId: string;
  clientSecret: string;
}): OpenClawConfig {
  const existing = params.cfg.channels?.qqbot ?? {};

  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        qqbot: {
          ...existing,
          enabled: true,
          appId: params.appId,
          clientSecret: params.clientSecret,
        } as QQBotConfig,
      },
    } as OpenClawConfig;
  }

  const accounts = (existing as QQBotConfig).accounts ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      qqbot: {
        ...existing,
        enabled: true,
        accounts: {
          ...accounts,
          [params.accountId]: {
            ...accounts[params.accountId],
            enabled: true,
            appId: params.appId,
            clientSecret: params.clientSecret,
          },
        },
      } as QQBotConfig,
    },
  } as OpenClawConfig;
}

function setQQBotDmPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: "open" | "pairing" | "allowlist",
): OpenClawConfig {
  const existing = (cfg as PluginConfig).channels?.qqbot ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        qqbot: {
          ...existing,
          enabled: true,
          dmPolicy,
        } as QQBotConfig,
      },
    } as OpenClawConfig;
  }

  const accounts = (existing as QQBotConfig).accounts ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qqbot: {
        ...existing,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...accounts[accountId],
            enabled: true,
            dmPolicy,
          },
        },
      } as QQBotConfig,
    },
  } as OpenClawConfig;
}

function setQQBotAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  const existing = (cfg as PluginConfig).channels?.qqbot ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        qqbot: {
          ...existing,
          enabled: true,
          allowFrom,
        } as QQBotConfig,
      },
    } as OpenClawConfig;
  }

  const accounts = (existing as QQBotConfig).accounts ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qqbot: {
        ...existing,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...accounts[accountId],
            enabled: true,
            allowFrom,
          },
        },
      } as QQBotConfig,
    },
  } as OpenClawConfig;
}

function parseAllowFromInput(raw: string): string[] {
  return splitSetupEntries(raw)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptQQBotAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const account = mergeQQBotAccountConfig(params.cfg as PluginConfig, params.accountId);
  const existing = account.allowFrom ?? [];

  await params.prompter.note(
    [
      "通过 QQ Bot openid 设置私聊白名单。",
      "示例:",
      "- user:09f1xxxx",
      "- 09f1xxxx",
    ].join("\n"),
    "QQ Bot 白名单",
  );

  const entry = String(
    await params.prompter.text({
      message: "QQ Bot allowFrom (用户 openid)",
      placeholder: "user:openid-1, openid-2",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "必填"),
    }),
  );

  const unique = [
    ...new Set([
      ...existing.map((value) => String(value).trim()).filter(Boolean),
      ...parseAllowFromInput(entry),
    ]),
  ];

  return setQQBotAllowFrom(params.cfg, params.accountId, unique);
}

async function noteQQBotCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) 打开 QQ 开放平台 (https://q.qq.com/)",
      "2) 创建机器人应用，获取 AppID 和 ClientSecret",
      "3) 在开发设置中配置沙箱成员或测试群",
      "4) 配置完成后可使用 openclaw gateway 启动连接",
      "",
      '命令行也支持：openclaw channels add --channel qqbot --token "AppID:ClientSecret"',
    ].join("\n"),
    "QQ Bot 配置",
  );
}

const qqbotDmPolicy: ChannelSetupDmPolicy = {
  label: "QQ Bot",
  channel: "qqbot",
  policyKey: "channels.qqbot.dmPolicy",
  allowFromKey: "channels.qqbot.allowFrom",
  resolveConfigKeys: (_cfg, accountId) => {
    const normalized = normalizeAccountId(accountId);
    if (normalized === DEFAULT_ACCOUNT_ID) {
      return {
        policyKey: "channels.qqbot.dmPolicy",
        allowFromKey: "channels.qqbot.allowFrom",
      };
    }
    return {
      policyKey: `channels.qqbot.accounts.${normalized}.dmPolicy`,
      allowFromKey: `channels.qqbot.accounts.${normalized}.allowFrom`,
    };
  },
  getCurrent: (cfg, accountId) =>
    mergeQQBotAccountConfig(cfg as PluginConfig, normalizeAccountId(accountId)).dmPolicy ?? "open",
  setPolicy: (cfg, policy, accountId) =>
    setQQBotDmPolicy(
      cfg,
      normalizeAccountId(accountId),
      policy === "pairing" || policy === "allowlist" ? policy : "open",
    ),
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptQQBotAllowFrom({
      cfg,
      prompter,
      accountId: normalizeAccountId(accountId),
    }),
};

function isQQBotConfigured(cfg: OpenClawConfig): boolean {
  return listQQBotAccountIds(cfg as PluginConfig).some((accountId) =>
    Boolean(resolveQQBotCredentials(mergeQQBotAccountConfig(cfg as PluginConfig, accountId))),
  );
}

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel: "qqbot",
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs app credentials",
    configuredHint: "已配置",
    unconfiguredHint: "需要 AppID 和 ClientSecret",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isQQBotConfigured(cfg),
    resolveStatusLines: ({ cfg, configured }) => {
      if (!configured) {
        return ["QQ Bot: 需要 AppID 和 ClientSecret"];
      }

      const accountIds = listQQBotAccountIds(cfg as PluginConfig);
      const configuredAccountId = accountIds.find((accountId) =>
        Boolean(resolveQQBotCredentials(mergeQQBotAccountConfig(cfg as PluginConfig, accountId))),
      );
      const defaultAccountId = resolveDefaultQQBotAccountId(cfg as PluginConfig);

      return [
        configuredAccountId && configuredAccountId !== DEFAULT_ACCOUNT_ID
          ? `QQ Bot: 已配置 (${configuredAccountId})`
          : `QQ Bot: 已配置${defaultAccountId !== DEFAULT_ACCOUNT_ID ? ` (default=${defaultAccountId})` : ""}`,
      ];
    },
  },
  credentials: [],
  resolveAccountIdForConfigure: ({ accountOverride, cfg }) =>
    normalizeAccountId(accountOverride ?? resolveDefaultQQBotAccountId(cfg as PluginConfig)),
  finalize: async ({ cfg, accountId, prompter }) => {
    const resolvedAccountId = normalizeAccountId(accountId);
    const merged = mergeQQBotAccountConfig(cfg as PluginConfig, resolvedAccountId);
    const configured = Boolean(resolveQQBotCredentials(merged));

    let next = cfg;
    if (!configured) {
      await noteQQBotCredentialHelp(prompter);
    } else {
      const keepCurrent = await prompter.confirm({
        message:
          resolvedAccountId === DEFAULT_ACCOUNT_ID
            ? "QQ Bot 凭证已配置，是否保留当前配置？"
            : `账户 ${resolvedAccountId} 的 QQ Bot 凭证已配置，是否保留当前配置？`,
        initialValue: true,
      });

      if (keepCurrent) {
        return { cfg: next };
      }
    }

    const appId = String(
      await prompter.text({
        message: "请输入 QQ Bot AppID",
        placeholder: "例如: 102146862",
        initialValue: typeof merged.appId === "string" ? merged.appId : undefined,
        validate: (value) => (String(value ?? "").trim() ? undefined : "AppID 不能为空"),
      }),
    ).trim();

    const clientSecret = String(
      await prompter.text({
        message: "请输入 QQ Bot ClientSecret",
        placeholder: "你的 ClientSecret",
        validate: (value) => (String(value ?? "").trim() ? undefined : "ClientSecret 不能为空"),
      }),
    ).trim();

    next = setQQBotCredentials({
      cfg: next as PluginConfig,
      accountId: resolvedAccountId,
      appId,
      clientSecret,
    });

    return { cfg: next };
  },
  dmPolicy: qqbotDmPolicy,
  disable: (cfg) =>
    ({
      ...cfg,
      channels: {
        ...cfg.channels,
        qqbot: {
          ...(cfg.channels?.qqbot ?? {}),
          enabled: false,
        } as QQBotConfig,
      },
    }) as OpenClawConfig,
};
