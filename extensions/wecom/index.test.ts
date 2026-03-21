import { describe, expect, it, vi } from "vitest";

vi.mock("@xuanyue202/shared", () => ({
  registerChinaSetupCli: vi.fn(),
  showChinaInstallHint: vi.fn(),
}));

import plugin from "./index.js";

function registerWecomPlugin(config?: {
  mode?: "webhook" | "ws";
  webhookPath?: string;
  accounts?: Record<string, { mode?: "webhook" | "ws"; webhookPath?: string }>;
}): string[] {
  const routes: string[] = [];

  plugin.register({
    registerChannel: () => {},
    registerHttpRoute: (params) => {
      routes.push(params.path);
    },
    config: {
      channels: {
        wecom: config,
      },
    },
  });

  return routes.sort((a, b) => a.localeCompare(b));
}

describe("wecom plugin route registration", () => {
  it("defaults omitted mode to ws and skips webhook routes", () => {
    const routes = registerWecomPlugin();

    expect(routes).toEqual(["/wecom-media"]);
  });

  it("registers webhook routes only when webhook mode is explicit", () => {
    const routes = registerWecomPlugin({
      mode: "webhook",
      webhookPath: "/wecom-custom",
    });

    expect(routes).toEqual(["/wecom-custom", "/wecom-media"]);
  });
});
