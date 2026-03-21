import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@xuanyue202/shared";
import {
  appendQQBotBufferedText,
  combineQQBotBufferedText,
  evaluateReplyFinalOnlyDelivery,
  hasQQBotMarkdownTable,
  isQQBotGroupMessageInterfaceBlocked,
  normalizeQQBotRenderedMarkdown,
  resolveQQBotTextReplyRefs,
  resolveQQBotNoReplyFallback,
  sanitizeQQBotOutboundText,
  sendQQBotMediaWithFallback,
  startQQBotTypingHeartbeat,
  startLongTaskNoticeTimer,
} from "./bot.js";

describe("evaluateReplyFinalOnlyDelivery", () => {
  it("allows non-final tool payload when media exists, and suppresses text", () => {
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "tool",
      hasMedia: true,
      sanitizedText: "语音说明",
    });
    expect(decision).toEqual({ skipDelivery: false, suppressText: true });
  });

  it("skips non-final text-only payload when replyFinalOnly is enabled", () => {
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "tool",
      hasMedia: false,
      sanitizedText: "仅文本",
    });
    expect(decision).toEqual({ skipDelivery: true, suppressText: false });
  });

  it("keeps final event but strips NO_REPLY to empty outbound text", () => {
    const sanitized = sanitizeQQBotOutboundText("NO_REPLY");
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: true,
      kind: "final",
      hasMedia: false,
      sanitizedText: sanitized,
    });
    const textToSend = decision.suppressText ? "" : sanitized;
    expect(decision.skipDelivery).toBe(false);
    expect(textToSend).toBe("");
  });

  it("does not suppress block text when replyFinalOnly is disabled", () => {
    const sanitized = sanitizeQQBotOutboundText("普通文本");
    const decision = evaluateReplyFinalOnlyDelivery({
      replyFinalOnly: false,
      kind: "block",
      hasMedia: false,
      sanitizedText: sanitized,
    });
    const textToSend = decision.suppressText ? "" : sanitized;
    expect(decision).toEqual({ skipDelivery: false, suppressText: false });
    expect(textToSend).toBe("普通文本");
  });
});

describe("sendQQBotMediaWithFallback", () => {
  it("falls back to text when remote media send fails", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "qqbot", error: "upload failed" });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m1", timestamp: 1 });
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:123",
      mediaQueue: ["https://example.com/a.mp3"],
      replyToId: "reply-1",
      logger,
      outbound: { sendMedia, sendText },
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]?.text).toContain("https://example.com/a.mp3");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("sendMedia failed"));
  });

  it("does not echo local paths when local media send fails", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "qqbot", error: "upload failed" });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m1", timestamp: 1 });
    const onDelivered = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:123",
      mediaQueue: ["C:\\Users\\Administrator\\.openclaw\\workspace\\converted-image.pdf"],
      replyToId: "reply-1",
      logger,
      onDelivered,
      outbound: { sendMedia, sendText },
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("preserves accountId for media delivery and fallback text", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "qqbot", error: "upload failed" });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m2", timestamp: 2 });
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:bot2-user",
      mediaQueue: ["https://example.com/account-aware.png"],
      replyToId: "reply-2",
      replyEventId: "event-2",
      accountId: "bot2",
      logger,
      outbound: { sendMedia, sendText },
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:bot2-user",
        mediaUrl: "https://example.com/account-aware.png",
        accountId: "bot2",
      })
    );
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:bot2-user",
        text: "📎 https://example.com/account-aware.png",
        accountId: "bot2",
      })
    );
  });

  it("stops remaining media delivery when shouldContinue becomes false", async () => {
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce({ channel: "qqbot", messageId: "m1", timestamp: 1 })
      .mockResolvedValueOnce({ channel: "qqbot", messageId: "m2", timestamp: 2 });
    const sendText = vi.fn().mockResolvedValue({ channel: "qqbot", messageId: "m3", timestamp: 3 });
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await sendQQBotMediaWithFallback({
      qqCfg: {},
      to: "user:bot2-user",
      mediaQueue: ["https://example.com/first.png", "https://example.com/second.png"],
      logger,
      shouldContinue,
      outbound: { sendMedia, sendText },
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/first.png",
      })
    );
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("resolveQQBotTextReplyRefs", () => {
  it("drops passive reply refs for c2c markdown tables", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "user:u-1",
      text: "| col1 | col2 |\n| --- | --- |\n| a | b |",
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "proactive-table-only",
      replyToId: "reply-1",
      replyEventId: "event-1",
    });

    expect(refs).toEqual({
      forceProactive: true,
      replyToId: undefined,
      replyEventId: undefined,
    });
  });

  it("drops passive reply refs for plain c2c text when markdown is enabled", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "user:u-1",
      text: "普通文本回复",
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "proactive-all",
      replyToId: "reply-2",
      replyEventId: "event-2",
    });

    expect(refs).toEqual({
      forceProactive: true,
      replyToId: undefined,
      replyEventId: undefined,
    });
  });

  it("keeps passive reply refs for group markdown tables", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "group:g-1",
      text: "| col1 | col2 |\n| --- | --- |\n| a | b |",
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "proactive-all",
      replyToId: "reply-3",
      replyEventId: "event-3",
    });

    expect(refs).toEqual({
      forceProactive: false,
      replyToId: "reply-3",
      replyEventId: "event-3",
    });
  });

  it("keeps passive reply refs when markdown support is disabled", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "user:u-1",
      text: "# 普通文本回复",
      markdownSupport: false,
      c2cMarkdownDeliveryMode: "proactive-all",
      replyToId: "reply-4",
      replyEventId: "event-4",
    });

    expect(refs).toEqual({
      forceProactive: false,
      replyToId: "reply-4",
      replyEventId: "event-4",
    });
  });

  it("keeps passive reply refs for c2c text when mode is passive", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "user:u-1",
      text: "# 标题\n\n普通文本回复",
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "passive",
      replyToId: "reply-5",
      replyEventId: "event-5",
    });

    expect(refs).toEqual({
      forceProactive: false,
      replyToId: "reply-5",
      replyEventId: "event-5",
    });
  });

  it("keeps passive reply refs for non-table c2c text when mode is proactive-table-only", () => {
    const refs = resolveQQBotTextReplyRefs({
      to: "user:u-1",
      text: "# 标题\n\n普通文本回复",
      markdownSupport: true,
      c2cMarkdownDeliveryMode: "proactive-table-only",
      replyToId: "reply-6",
      replyEventId: "event-6",
    });

    expect(refs).toEqual({
      forceProactive: false,
      replyToId: "reply-6",
      replyEventId: "event-6",
    });
  });
});

describe("hasQQBotMarkdownTable", () => {
  it("detects standard markdown tables", () => {
    expect(hasQQBotMarkdownTable("| col1 | col2 |\n| --- | --- |\n| a | b |")).toBe(true);
  });

  it("ignores bullet lists and plain text", () => {
    expect(hasQQBotMarkdownTable("- item 1\n- item 2")).toBe(false);
    expect(hasQQBotMarkdownTable("普通文本")).toBe(false);
  });
});

describe("appendQQBotBufferedText", () => {
  it("appends distinct buffered segments", () => {
    const buffered = appendQQBotBufferedText(["第一段"], "第二段");
    expect(buffered).toEqual(["第一段", "第二段"]);
  });

  it("collapses cumulative updates into the latest payload", () => {
    const buffered = appendQQBotBufferedText(["第一段"], "第一段\n\n第二段");
    expect(buffered).toEqual(["第一段\n\n第二段"]);
  });

  it("ignores repeated excerpts already covered by buffered text", () => {
    const buffered = appendQQBotBufferedText(["第一段\n\n第二段"], "第二段");
    expect(buffered).toEqual(["第一段\n\n第二段"]);
  });
});

describe("combineQQBotBufferedText", () => {
  it("keeps plain buffered paragraphs separated", () => {
    expect(combineQQBotBufferedText(["第一段", "第二段"])).toBe("第一段\n\n第二段");
  });

  it("reconstructs table rows continued in a later buffered fragment", () => {
    const combined = combineQQBotBufferedText([
      "| 序号 | 公司 | 代表产品 | 一句话 |\n|------|------|----------|--------|\n| 1 | TSMC",
      "7nm/3nm制程 | 世界的芯片工厂 |\n| 2 | 腾讯 | 微信 | 万物皆可微信 |",
    ]);

    expect(combined).toBe(
      "| 序号 | 公司 | 代表产品 | 一句话 |\n" +
        "|------|------|----------|--------|\n" +
        "| 1 | TSMC | 7nm/3nm制程 | 世界的芯片工厂 |\n" +
        "| 2 | 腾讯 | 微信 | 万物皆可微信 |"
    );
  });
});

describe("normalizeQQBotRenderedMarkdown", () => {
  it("unwraps explicit markdown fences so non-table markdown can render", () => {
    const text = "```markdown\n# 标题\n\n这是 `行内代码`\n\n> 引用\n\n---\n```";
    expect(normalizeQQBotRenderedMarkdown(text)).toBe(
      "# 标题\n\n这是 `行内代码`\n\n> 引用\n\n---"
    );
  });

  it("unwraps explicit markdown fences with nested code blocks when outer fence is longer", () => {
    const text =
      "````markdown\n# 标题\n\n```ts\nconst answer = 42;\n```\n\n| col1 | col2 |\n| --- | --- |\n| a | b |\n````";
    expect(normalizeQQBotRenderedMarkdown(text)).toBe(
      "# 标题\n\n```ts\nconst answer = 42;\n```\n\n| col1 | col2 |\n| --- | --- |\n| a | b |"
    );
  });

  it("unwraps markdown fences around tables", () => {
    const text = "下面是表格：\n\n```markdown\n| col1 | col2 |\n| --- | --- |\n| a | b |\n```";
    expect(normalizeQQBotRenderedMarkdown(text)).toBe(
      "下面是表格：\n\n| col1 | col2 |\n| --- | --- |\n| a | b |"
    );
  });

  it("keeps non-table fenced code blocks unchanged", () => {
    const text = "```ts\nconsole.log('hello');\n```";
    expect(normalizeQQBotRenderedMarkdown(text)).toBe(text);
  });
});

describe("resolveQQBotNoReplyFallback", () => {
  it("returns fallback text for mentioned group messages when nothing was delivered", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "group",
        mentionedBot: true,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: false,
    });

    expect(fallback).toBe("我在。你可以直接说具体一点。");
  });

  it("does not return fallback once a visible reply was delivered", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "group",
        mentionedBot: true,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: true,
    });

    expect(fallback).toBeUndefined();
  });

  it("does not return fallback for direct messages", () => {
    const fallback = resolveQQBotNoReplyFallback({
      inbound: {
        type: "direct",
        mentionedBot: false,
        content: "1",
        attachments: undefined,
      },
      replyDelivered: false,
    });

    expect(fallback).toBeUndefined();
  });
});

describe("isQQBotGroupMessageInterfaceBlocked", () => {
  it("detects platform temporary ban errors", () => {
    expect(
      isQQBotGroupMessageInterfaceBlocked(
        'HTTP 500: Internal Server Error - {"message":"机器人存在安全风险，群内消息接口被临时封禁","code":304103}'
      )
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isQQBotGroupMessageInterfaceBlocked("HTTP 500: Internal Server Error")).toBe(false);
  });
});

describe("startQQBotTypingHeartbeat", () => {
  it("renews typing every interval and stops after dispose", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(undefined);

    const heartbeat = startQQBotTypingHeartbeat({
      intervalMs: 5000,
      renew,
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(2);

    heartbeat.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(renew).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("waits for an idle gap before renewing typing", async () => {
    vi.useFakeTimers();
    let idle = false;
    const renew = vi.fn().mockResolvedValue(undefined);

    startQQBotTypingHeartbeat({
      intervalMs: 5000,
      shouldRenew: () => idle,
      renew,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).not.toHaveBeenCalled();

    idle = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("stops typing renewals cleanly and swallows renewal failures", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockRejectedValue(new Error("temporary failure"));

    const heartbeat = startQQBotTypingHeartbeat({
      intervalMs: 5000,
      renew,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(1);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(renew).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("startLongTaskNoticeTimer", () => {
  it("sends notice after configured delay", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    startLongTaskNoticeTimer({
      delayMs: 30000,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(29999);
    expect(sendNotice).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendNotice).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("cancels notice once a real reply is delivered", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    const timer = startLongTaskNoticeTimer({
      delayMs: 30000,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(10000);
    timer.markReplyDelivered();
    await vi.advanceTimersByTimeAsync(20000);

    expect(sendNotice).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("treats zero delay as disabled", async () => {
    vi.useFakeTimers();
    const sendNotice = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() } as unknown as Logger;

    startLongTaskNoticeTimer({
      delayMs: 0,
      logger,
      sendNotice,
    });

    await vi.advanceTimersByTimeAsync(60000);
    expect(sendNotice).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
