import { describe, expect, it, vi, afterEach } from "vitest";
import type { Logger } from "@xuanyue202/shared";
import { startLongTaskNoticeTimer } from "./bot-handler.js";

describe("startLongTaskNoticeTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
  });
});
