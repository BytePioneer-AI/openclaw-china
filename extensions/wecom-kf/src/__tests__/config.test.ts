/**
 * 微信客服渠道配置 - 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeAccountId,
  listWecomKfAccountIds,
  resolveDefaultWecomKfAccountId,
  resolveWecomKfAccount,
  listEnabledWecomKfAccounts,
  resolveDmPolicy,
  resolveAllowFrom,
  resolveApiBaseUrl,
  DEFAULT_ACCOUNT_ID,
  type PluginConfig,
} from "../config.js";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("normalizeAccountId", () => {
    it("应返回 'default' 当输入为空时", () => {
      expect(normalizeAccountId("")).toBe(DEFAULT_ACCOUNT_ID);
      expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
      expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
      expect(normalizeAccountId("  ")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("应保留非空值并去除空白", () => {
      expect(normalizeAccountId("  my-account  ")).toBe("my-account");
    });
  });

  describe("listWecomKfAccountIds", () => {
    it("无 accounts 时应返回默认账户", () => {
      const cfg: PluginConfig = {};
      expect(listWecomKfAccountIds(cfg)).toEqual([DEFAULT_ACCOUNT_ID]);
    });

    it("应列出所有已配置的账户 ID 并排序", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            accounts: {
              beta: {},
              alpha: {},
            },
          },
        },
      };
      expect(listWecomKfAccountIds(cfg)).toEqual(["alpha", "beta"]);
    });
  });

  describe("resolveDefaultWecomKfAccountId", () => {
    it("应使用显式指定的 defaultAccount", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            defaultAccount: "my-kf",
            accounts: {
              "my-kf": {},
            },
          },
        },
      };
      expect(resolveDefaultWecomKfAccountId(cfg)).toBe("my-kf");
    });

    it("无 defaultAccount 时应返回第一个账户", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            accounts: {
              beta: {},
              alpha: {},
            },
          },
        },
      };
      expect(resolveDefaultWecomKfAccountId(cfg)).toBe("alpha");
    });
  });

  describe("resolveWecomKfAccount", () => {
    it("应从环境变量回退默认账户配置", () => {
      process.env.WECOM_KF_CORP_ID = "env-corp-id";
      process.env.WECOM_KF_CORP_SECRET = "env-corp-secret";
      process.env.WECOM_KF_OPEN_KFID = "1000004";
      process.env.WECOM_KF_TOKEN = "env-token";
      process.env.WECOM_KF_ENCODING_AES_KEY = "env-aes-key";

      const cfg: PluginConfig = {};
      const account = resolveWecomKfAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.corpId).toBe("env-corp-id");
      expect(account.corpSecret).toBe("env-corp-secret");
      expect(account.openKfid).toBe("1000004");
      expect(account.receiveId).toBe("env-corp-id");
      expect(account.token).toBe("env-token");
      expect(account.canSend).toBe(true);
    });

    it("应合并顶层配置和账户级配置", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            corpId: "my-corp",
            corpSecret: "global-secret",
            token: "global-token",
            encodingAESKey: "global-aes",
            accounts: {
              "kf-1": {
                corpSecret: "override-secret",
                openKfid: "1000005",
              },
            },
          },
        },
      };

      const account = resolveWecomKfAccount({ cfg, accountId: "kf-1" });
      expect(account.corpId).toBe("my-corp");
      expect(account.corpSecret).toBe("override-secret");
      expect(account.openKfid).toBe("1000005");
      expect(account.token).toBe("global-token");
      expect(account.canSend).toBe(true);
    });

    it("缺少关键配置时 canSend 应为 false", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            corpId: "my-corp",
            token: "token",
            encodingAESKey: "key",
          },
        },
      };

      const account = resolveWecomKfAccount({ cfg });
      expect(account.canSend).toBe(false);
    });

    it("enabled 为 false 时账户应被禁用", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            enabled: false,
            corpId: "corp",
            corpSecret: "secret",
            openKfid: "1000004",
            token: "t",
            encodingAESKey: "k",
          },
        },
      };

      const account = resolveWecomKfAccount({ cfg });
      expect(account.enabled).toBe(false);
    });
  });

  describe("listEnabledWecomKfAccounts", () => {
    it("应只返回启用的账户", () => {
      const cfg: PluginConfig = {
        channels: {
          "wecom-kf": {
            token: "t",
            encodingAESKey: "k",
            accounts: {
              a: { enabled: true },
              b: { enabled: false },
              c: {},
            },
          },
        },
      };

      const enabled = listEnabledWecomKfAccounts(cfg);
      expect(enabled.length).toBe(2);
      expect(enabled.map((a) => a.accountId).sort()).toEqual(["a", "c"]);
    });
  });

  describe("resolveDmPolicy", () => {
    it("默认应为 'open'", () => {
      expect(resolveDmPolicy({})).toBe("open");
    });

    it("应使用显式指定的策略", () => {
      expect(resolveDmPolicy({ dmPolicy: "pairing" })).toBe("pairing");
      expect(resolveDmPolicy({ dmPolicy: "disabled" })).toBe("disabled");
    });
  });

  describe("resolveAllowFrom", () => {
    it("默认应为空列表", () => {
      expect(resolveAllowFrom({})).toEqual([]);
    });

    it("应返回配置的允许列表", () => {
      expect(resolveAllowFrom({ allowFrom: ["wmUser1", "wmUser2"] })).toEqual(["wmUser1", "wmUser2"]);
    });
  });

  describe("resolveApiBaseUrl", () => {
    it("默认应为企微官方 API 地址", () => {
      expect(resolveApiBaseUrl({})).toBe("https://qyapi.weixin.qq.com");
    });

    it("应使用自定义地址并移除末尾斜杠", () => {
      expect(resolveApiBaseUrl({ apiBaseUrl: "https://proxy.example.com/" })).toBe("https://proxy.example.com");
    });
  });
});
