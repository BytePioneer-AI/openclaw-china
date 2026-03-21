import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelMock = vi.fn();
const confirmMock = vi.fn();
const introMock = vi.fn();
const noteMock = vi.fn();
const outroMock = vi.fn();
const selectMock = vi.fn();
const textMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  cancel: (...args: unknown[]) => cancelMock(...args),
  confirm: (...args: unknown[]) => confirmMock(...args),
  intro: (...args: unknown[]) => introMock(...args),
  isCancel: () => false,
  note: (...args: unknown[]) => noteMock(...args),
  outro: (...args: unknown[]) => outroMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  text: (...args: unknown[]) => textMock(...args),
}));

import { registerChinaSetupCli } from "./china-setup.js";
import type { ChannelId } from "./china-setup.js";

type ActionHandler = () => void | Promise<void>;

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type CommandNode = {
  children: Map<string, CommandNode>;
  actionHandler?: ActionHandler;
  command: (name: string) => CommandNode;
  description: (text: string) => CommandNode;
  action: (handler: ActionHandler) => CommandNode;
};

type ConfigRoot = {
  channels?: Record<string, Record<string, unknown>>;
};

const CLI_STATE_KEY = Symbol.for("@xuanyue202/china-cli-state");

function setupTTYMocks(): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  vi.clearAllMocks();
  delete (globalThis as Record<PropertyKey, unknown>)[CLI_STATE_KEY];
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    }
  };
}

function createCommandNode(): CommandNode {
  const node: CommandNode = {
    children: new Map<string, CommandNode>(),
    command(name: string): CommandNode {
      const child = createCommandNode();
      node.children.set(name, child);
      return child;
    },
    description(): CommandNode {
      return node;
    },
    action(handler: ActionHandler): CommandNode {
      node.actionHandler = handler;
      return node;
    },
  };
  return node;
}

async function runSetup(
  initialConfig: ConfigRoot,
  channels: readonly ChannelId[] = ["wecom"]
): Promise<{
  writeConfigFile: ReturnType<typeof vi.fn>;
}> {
  let registrar:
    | ((ctx: { program: unknown; config?: unknown; logger?: LoggerLike }) => void | Promise<void>)
    | undefined;
  const writeConfigFile = vi.fn(async (_cfg: ConfigRoot) => {});

  registerChinaSetupCli(
    {
      runtime: {
        config: {
          writeConfigFile,
        },
      },
        registerCli: (nextRegistrar) => {
          registrar = nextRegistrar;
        },
      },
    { channels }
  );

  const program = createCommandNode();
  await registrar?.({
    program,
    config: initialConfig,
    logger: {},
  });

  const setupCommand = program.children.get("china")?.children.get("setup");
  expect(setupCommand?.actionHandler).toBeTypeOf("function");
  await setupCommand?.actionHandler?.();

  return { writeConfigFile };
}

describe("china setup wecom", () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = setupTTYMocks();
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it("stores ws-only credentials for wecom setup", async () => {
    selectMock.mockResolvedValueOnce("wecom");
    textMock.mockResolvedValueOnce("bot-123").mockResolvedValueOnce("secret-456");
    confirmMock.mockResolvedValueOnce(false);

    const { writeConfigFile } = await runSetup({
      channels: {
        wecom: {
          webhookPath: "/legacy-wecom",
          token: "legacy-token",
          encodingAESKey: "legacy-aes-key",
        },
      },
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wecomConfig = savedConfig.channels?.wecom;

    expect(wecomConfig?.enabled).toBe(true);
    expect(wecomConfig?.mode).toBe("ws");
    expect(wecomConfig?.botId).toBe("bot-123");
    expect(wecomConfig?.secret).toBe("secret-456");
    expect(wecomConfig?.webhookPath).toBeUndefined();
    expect(wecomConfig?.token).toBeUndefined();
    expect(wecomConfig?.encodingAESKey).toBeUndefined();

    const promptMessages = textMock.mock.calls.map((call) => {
      const firstArg = call[0] as { message?: string } | undefined;
      return firstArg?.message ?? "";
    });
    expect(promptMessages).toEqual(["WeCom botId（ws 长连接）", "WeCom secret（ws 长连接）"]);
  });

  it("marks wecom as configured when botId and secret already exist", async () => {
    let selectOptions: Array<{ label?: string; value?: string }> = [];
    selectMock.mockImplementationOnce(async (params: { options?: Array<{ label?: string; value?: string }> }) => {
      selectOptions = params.options ?? [];
      return "cancel";
    });

    const { writeConfigFile } = await runSetup({
      channels: {
        wecom: {
          botId: "existing-bot",
          secret: "existing-secret",
        },
      },
    });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(selectOptions.some((option) => option.label === "WeCom（企业微信-智能机器人）（已配置）")).toBe(true);
  });
});

describe("china setup wechat-mp", () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = setupTTYMocks();
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it("stores wechat-mp callback and account config", async () => {
    selectMock
      .mockResolvedValueOnce("wechat-mp")
      .mockResolvedValueOnce("safe")
      .mockResolvedValueOnce("passive");
    confirmMock.mockResolvedValueOnce(true); // renderMarkdown enabled (default)
    textMock
      .mockResolvedValueOnce("/wechat-mp")
      .mockResolvedValueOnce("wx-test-appid")
      .mockResolvedValueOnce("wx-test-secret")
      .mockResolvedValueOnce("callback-token")
      .mockResolvedValueOnce("encoding-aes-key")
      .mockResolvedValueOnce("欢迎关注");

    const { writeConfigFile } = await runSetup({}, ["wechat-mp"]);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wechatMpConfig = savedConfig.channels?.["wechat-mp"];

    expect(wechatMpConfig?.enabled).toBe(true);
    expect(wechatMpConfig?.webhookPath).toBe("/wechat-mp");
    expect(wechatMpConfig?.appId).toBe("wx-test-appid");
    expect(wechatMpConfig?.appSecret).toBe("wx-test-secret");
    expect(wechatMpConfig?.token).toBe("callback-token");
    expect(wechatMpConfig?.encodingAESKey).toBe("encoding-aes-key");
    expect(wechatMpConfig?.messageMode).toBe("safe");
    expect(wechatMpConfig?.replyMode).toBe("passive");
    expect(wechatMpConfig?.welcomeText).toBe("欢迎关注");
    expect(wechatMpConfig?.renderMarkdown).toBe(true);
  });

  it("stores activeDeliveryMode when replyMode is active", async () => {
    selectMock
      .mockResolvedValueOnce("wechat-mp")
      .mockResolvedValueOnce("safe")
      .mockResolvedValueOnce("active")
      .mockResolvedValueOnce("split");
    textMock
      .mockResolvedValueOnce("/wechat-mp-active")
      .mockResolvedValueOnce("wx-active-appid")
      .mockResolvedValueOnce("wx-active-secret")
      .mockResolvedValueOnce("active-token")
      .mockResolvedValueOnce("active-aes-key")
      .mockResolvedValueOnce("welcome");

    const { writeConfigFile } = await runSetup({}, ["wechat-mp"]);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wechatMpConfig = savedConfig.channels?.["wechat-mp"];

    expect(wechatMpConfig?.enabled).toBe(true);
    expect(wechatMpConfig?.replyMode).toBe("active");
    expect(wechatMpConfig?.activeDeliveryMode).toBe("split");
  });

  it("stores renderMarkdown when explicitly disabled", async () => {
    selectMock
      .mockResolvedValueOnce("wechat-mp")
      .mockResolvedValueOnce("safe")
      .mockResolvedValueOnce("active")
      .mockResolvedValueOnce("merged");
    confirmMock.mockResolvedValueOnce(false); // Disable renderMarkdown
    textMock
      .mockResolvedValueOnce("/wechat-mp-no-md")
      .mockResolvedValueOnce("wx-no-md-appid")
      .mockResolvedValueOnce("wx-no-md-secret")
      .mockResolvedValueOnce("no-md-token")
      .mockResolvedValueOnce("no-md-aes-key")
      .mockResolvedValueOnce("welcome");

    const { writeConfigFile } = await runSetup({}, ["wechat-mp"]);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wechatMpConfig = savedConfig.channels?.["wechat-mp"];

    expect(wechatMpConfig?.enabled).toBe(true);
    expect(wechatMpConfig?.activeDeliveryMode).toBe("merged");
    expect(wechatMpConfig?.renderMarkdown).toBe(false);
  });

  it("defaults renderMarkdown to true when not explicitly disabled", async () => {
    selectMock
      .mockResolvedValueOnce("wechat-mp")
      .mockResolvedValueOnce("safe")
      .mockResolvedValueOnce("passive");
    confirmMock.mockResolvedValueOnce(true); // Keep renderMarkdown enabled (default)
    textMock
      .mockResolvedValueOnce("/wechat-mp-default-md")
      .mockResolvedValueOnce("wx-default-appid")
      .mockResolvedValueOnce("wx-default-secret")
      .mockResolvedValueOnce("default-token")
      .mockResolvedValueOnce("default-aes-key")
      .mockResolvedValueOnce("welcome");

    const { writeConfigFile } = await runSetup({}, ["wechat-mp"]);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wechatMpConfig = savedConfig.channels?.["wechat-mp"];

    expect(wechatMpConfig?.enabled).toBe(true);
    // setup writes the value explicitly, even when it's the default true
    expect(wechatMpConfig?.renderMarkdown).toBe(true);
  });
});

describe("china setup wecom-kf", () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = setupTTYMocks();
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it("stores only the initial wecom-kf callback setup fields", async () => {
    selectMock.mockResolvedValueOnce("wecom-kf");
    textMock
      .mockResolvedValueOnce("/kf-hook")
      .mockResolvedValueOnce("callback-token")
      .mockResolvedValueOnce("encoding-aes-key")
      .mockResolvedValueOnce("ww-test-corp")
      .mockResolvedValueOnce("wk-test")
      .mockResolvedValueOnce("");

    const { writeConfigFile } = await runSetup({}, ["wecom-kf"]);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const wecomKfConfig = savedConfig.channels?.["wecom-kf"];

    expect(wecomKfConfig?.enabled).toBe(true);
    expect(wecomKfConfig?.webhookPath).toBe("/kf-hook");
    expect(wecomKfConfig?.token).toBe("callback-token");
    expect(wecomKfConfig?.encodingAESKey).toBe("encoding-aes-key");
    expect(wecomKfConfig?.corpId).toBe("ww-test-corp");
    expect(wecomKfConfig?.openKfId).toBe("wk-test");
    expect(wecomKfConfig?.corpSecret).toBeUndefined();
    expect(wecomKfConfig?.apiBaseUrl).toBeUndefined();
    expect(wecomKfConfig?.welcomeText).toBeUndefined();
    expect(wecomKfConfig?.dmPolicy).toBeUndefined();
    expect(wecomKfConfig?.allowFrom).toBeUndefined();

    const promptMessages = textMock.mock.calls.map((call) => {
      const firstArg = call[0] as { message?: string } | undefined;
      return firstArg?.message ?? "";
    });
    expect(promptMessages).toEqual([
      "Webhook 路径（默认 /wecom-kf）",
      "微信客服回调 Token",
      "微信客服回调 EncodingAESKey",
      "corpId",
      "open_kfid",
      "微信客服 Secret（最后填写；首次接入可先留空）",
    ]);

    const noteMessages = noteMock.mock.calls.map((call) => {
      const firstArg = call[0] as string | undefined;
      return firstArg ?? "";
    });
    expect(
      noteMessages.some((message) =>
        message.includes(
          "配置文档：https://github.com/BytePioneer-AI/openclaw-china/tree/main/doc/guides/wecom-kf/configuration.md"
        )
      )
    ).toBe(true);
    expect(
      noteMessages.some((message) =>
        message.includes("corpSecret 会作为最后一个参数询问；首次接入可先留空，待回调 URL 校验通过并点击“开始使用”后再补")
      )
    ).toBe(true);
  });
});

describe("china setup dingtalk", () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = setupTTYMocks();
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it("stores gateway token when dingtalk AI Card streaming is enabled", async () => {
    let registrar:
      | ((ctx: { program: unknown; config?: unknown; logger?: LoggerLike }) => void | Promise<void>)
      | undefined;
    const writeConfigFile = vi.fn(async (_cfg: ConfigRoot) => {});

    registerChinaSetupCli(
      {
        runtime: {
          config: {
            writeConfigFile,
          },
        },
        registerCli: (nextRegistrar) => {
          registrar = nextRegistrar;
        },
      },
      { channels: ["dingtalk"] }
    );

    selectMock.mockResolvedValueOnce("dingtalk");
    textMock.mockResolvedValueOnce("ding-app-key");
    textMock.mockResolvedValueOnce("ding-app-secret");
    confirmMock.mockResolvedValueOnce(true);
    textMock.mockResolvedValueOnce("gateway-token-123");

    const program = createCommandNode();
    await registrar?.({
      program,
      config: {
        gateway: {
          auth: {
            token: "global-token",
          },
        },
      },
      logger: {},
    });

    const setupCommand = program.children.get("china")?.children.get("setup");
    expect(setupCommand?.actionHandler).toBeTypeOf("function");
    await setupCommand?.actionHandler?.();

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const savedConfig = writeConfigFile.mock.calls[0]?.[0] as ConfigRoot;
    const dingtalkConfig = savedConfig.channels?.dingtalk;

    expect(dingtalkConfig?.enabled).toBe(true);
    expect(dingtalkConfig?.clientId).toBe("ding-app-key");
    expect(dingtalkConfig?.clientSecret).toBe("ding-app-secret");
    expect(dingtalkConfig?.enableAICard).toBe(true);
    expect(dingtalkConfig?.gatewayToken).toBe("gateway-token-123");

    const promptMessages = textMock.mock.calls.map((call) => {
      const firstArg = call[0] as { message?: string } | undefined;
      return firstArg?.message ?? "";
    });
    expect(promptMessages).toContain(
      "OpenClaw Gateway Token（流式输出必需；留空则使用全局 gateway.auth.token）"
    );
  });
});
