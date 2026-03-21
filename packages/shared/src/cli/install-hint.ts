import type { ChannelId } from "./china-setup.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ChinaInstallHintApiLike = {
  logger?: LoggerLike;
  config?: unknown;
  [key: string]: unknown;
};

const PROJECT_REPO = "https://github.com/BytePioneer-AI/openclaw-china";
const INSTALL_SETUP_COMMAND = "openclaw china setup";
const START_GATEWAY_COMMAND = "openclaw gateway --port 18789 --verbose";
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_LINK = "\u001b[1;4;96m";
const ANSI_BORDER = "\u001b[92m";
const SUPPORTED_CHANNELS: readonly ChannelId[] = [
  "dingtalk",
  "feishu-china",
  "wecom",
  "wecom-app",
  "wecom-kf",
  "wechat-mp",
  "qqbot",
];
const CHINA_INSTALL_HINT_SHOWN_KEY = Symbol.for("@xuanyue202/china-install-hint-shown");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyEnabledChinaChannel(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }

  const channels = config.channels;
  if (!isRecord(channels)) {
    return false;
  }

  return SUPPORTED_CHANNELS.some((channelId) => {
    const channelConfig = channels[channelId];
    return isRecord(channelConfig) && channelConfig.enabled === true;
  });
}

function hasShownInstallHint(): boolean {
  const root = globalThis as Record<PropertyKey, unknown>;
  return root[CHINA_INSTALL_HINT_SHOWN_KEY] === true;
}

function markInstallHintShown(): void {
  const root = globalThis as Record<PropertyKey, unknown>;
  root[CHINA_INSTALL_HINT_SHOWN_KEY] = true;
}

export function showChinaInstallHint(api: ChinaInstallHintApiLike): void {
  if (hasShownInstallHint() || hasAnyEnabledChinaChannel(api.config)) {
    return;
  }
  markInstallHintShown();

  const lines = [
    `${ANSI_BORDER}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${ANSI_RESET}`,
    "  OpenClaw China Channels 已就绪!",
    `${ANSI_BORDER}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${ANSI_RESET}`,
    "",
    "项目仓库:",
    `  ${ANSI_LINK}${PROJECT_REPO}${ANSI_RESET}`,
    "",
    "⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐",
    "",
    "下一步（配置引导）:",
    "  1. 运行交互式配置向导",
    `     ${ANSI_BOLD}${INSTALL_SETUP_COMMAND}${ANSI_RESET}`,
    "  2. 按提示填写渠道凭据并保存配置",
    "  3. 启动网关并观察日志",
    `     ${START_GATEWAY_COMMAND}`,
  ];

  if (api.logger?.info) {
    for (const line of lines) {
      api.logger.info(line);
    }
    return;
  }
  if (api.logger?.warn) {
    for (const line of lines) {
      api.logger.warn(line);
    }
  }
}
