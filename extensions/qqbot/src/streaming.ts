import {
  allocateMsgSeq,
  getAccessToken,
  QQBotStreamContentType,
  QQBotStreamInputMode,
  QQBotStreamInputState,
  sendC2CStreamMessage,
} from "./client.js";

type QQBotStreamingLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export type QQBotStreamingControllerParams = {
  appId: string;
  clientSecret: string;
  openid: string;
  messageId: string;
  eventId: string;
  throttleMs?: number;
  minThrottleMs?: number;
  logger?: QQBotStreamingLogger;
  logPrefix?: string;
  onFirstChunk?: () => void | Promise<void>;
};

const DEFAULT_THROTTLE_MS = 500;
const DEFAULT_MIN_THROTTLE_MS = 300;

export class QQBotStreamingController {
  private readonly params: QQBotStreamingControllerParams;
  private readonly throttleMs: number;
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private latestText = "";
  private lastSentText = "";
  private streamMsgId: string | undefined;
  private msgSeq: number | undefined;
  private index = 0;
  private lastPartialLength = 0;
  private lastSendAt = 0;
  private sessionSentChunkCount = 0;
  private sessionShouldFallbackToStatic = false;
  private firstChunkNotified = false;
  private replyOrdinal = 0;
  private disposed = false;

  constructor(params: QQBotStreamingControllerParams) {
    this.params = params;
    const throttle = params.throttleMs ?? DEFAULT_THROTTLE_MS;
    const minThrottle = params.minThrottleMs ?? DEFAULT_MIN_THROTTLE_MS;
    this.throttleMs = Math.max(throttle, minThrottle);
  }

  get hasSuccessfulChunk(): boolean {
    return this.sessionSentChunkCount > 0;
  }

  get shouldFallbackToStatic(): boolean {
    return this.sessionShouldFallbackToStatic && this.sessionSentChunkCount === 0;
  }

  get hasObservedPartial(): boolean {
    return this.lastPartialLength > 0;
  }

  async onPartialReply(text: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return;

      if (this.lastPartialLength > 0 && text.length < this.lastPartialLength) {
        this.logInfo(
          `reply boundary detected (${text.length} < ${this.lastPartialLength}), starting new stream session`
        );
        await this.finalizeCurrentReply();
        this.resetReplyState();
      }

      this.lastPartialLength = text.length;
      this.latestText = text;

      if (!text.trim() || this.sessionShouldFallbackToStatic) {
        return;
      }

      if (!this.streamMsgId) {
        await this.ensureStreamingStarted();
        return;
      }

      this.scheduleFlush();
    });
  }

  async finalize(): Promise<void> {
    await this.enqueue(async () => {
      await this.finalizeCurrentReply();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearFlushTimer();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task, async (err) => {
      this.logError(`stream queue recovered after error: ${String(err)}`);
      await task();
    });
    return this.chain;
  }

  private async ensureStreamingStarted(): Promise<void> {
    if (this.disposed || this.streamMsgId || this.sessionShouldFallbackToStatic) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startStreaming();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startStreaming(): Promise<void> {
    if (!this.latestText.trim()) {
      return;
    }

    try {
      this.msgSeq ??= allocateMsgSeq(`stream:${this.params.messageId}:${this.replyOrdinal}`);
      const response = await this.sendChunk({
        content: this.latestText,
        inputState: QQBotStreamInputState.GENERATING,
      });

      if (!response.id) {
        throw new Error("QQ stream response missing stream message id");
      }

      this.streamMsgId = response.id;
      this.lastSentText = this.latestText;
      this.lastSendAt = Date.now();
      this.sessionSentChunkCount += 1;
      this.index += 1;
      await this.notifyFirstChunk();

      if (this.latestText !== this.lastSentText) {
        this.scheduleFlush();
      }
    } catch (err) {
      this.sessionShouldFallbackToStatic = true;
      this.logWarn(`failed to start stream session, falling back to static: ${String(err)}`);
    }
  }

  private async flushNow(): Promise<void> {
    if (
      this.disposed ||
      !this.streamMsgId ||
      this.sessionShouldFallbackToStatic ||
      !this.latestText.trim() ||
      this.latestText === this.lastSentText
    ) {
      return;
    }

    try {
      await this.sendChunk({
        content: this.latestText,
        inputState: QQBotStreamInputState.GENERATING,
      });
      this.lastSentText = this.latestText;
      this.lastSendAt = Date.now();
      this.sessionSentChunkCount += 1;
      this.index += 1;
      await this.notifyFirstChunk();
    } catch (err) {
      this.logWarn(`failed to flush stream chunk: ${String(err)}`);
    }
  }

  private scheduleFlush(): void {
    if (this.disposed || this.flushTimer || !this.streamMsgId || this.sessionShouldFallbackToStatic) {
      return;
    }

    const elapsed = Date.now() - this.lastSendAt;
    if (elapsed >= this.throttleMs) {
      void this.enqueue(async () => {
        await this.flushNow();
      });
      return;
    }

    const waitMs = this.throttleMs - elapsed;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue(async () => {
        await this.flushNow();
      });
    }, waitMs);
    this.flushTimer.unref?.();
  }

  private async finalizeCurrentReply(): Promise<void> {
    this.clearFlushTimer();
    if (this.startPromise) {
      await this.startPromise;
    }

    if (!this.streamMsgId) {
      return;
    }

    const finalText = (this.latestText || this.lastSentText).trim() ? this.latestText || this.lastSentText : this.lastSentText;
    if (!finalText) {
      this.resetStreamSession();
      return;
    }

    try {
      await this.sendChunk({
        content: finalText,
        inputState: QQBotStreamInputState.DONE,
      });
      this.lastSentText = finalText;
      this.lastSendAt = Date.now();
      this.sessionSentChunkCount += 1;
      this.index += 1;
    } catch (err) {
      this.logWarn(`failed to finalize stream session: ${String(err)}`);
    } finally {
      this.resetStreamSession();
    }
  }

  private async sendChunk(params: {
    content: string;
    inputState: number;
  }): Promise<{ id?: string }> {
    const msgSeq = this.msgSeq ?? allocateMsgSeq(`stream:${this.params.messageId}:${this.replyOrdinal}`);
    this.msgSeq = msgSeq;
    const accessToken = await getAccessToken(this.params.appId, this.params.clientSecret);
    const response = await sendC2CStreamMessage({
      accessToken,
      openid: this.params.openid,
      request: {
        input_mode: QQBotStreamInputMode.REPLACE,
        input_state: params.inputState as 1 | 10,
        content_type: QQBotStreamContentType.MARKDOWN,
        content_raw: params.content,
        event_id: this.params.eventId,
        msg_id: this.params.messageId,
        msg_seq: msgSeq,
        index: this.index,
        ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      },
    });

    if (response.code && response.code > 0) {
      throw new Error(`QQ stream API error ${response.code}: ${response.message ?? "unknown error"}`);
    }

    return {
      id: typeof response.id === "string" ? response.id : undefined,
    };
  }

  private async notifyFirstChunk(): Promise<void> {
    if (this.firstChunkNotified) {
      return;
    }
    this.firstChunkNotified = true;
    try {
      await this.params.onFirstChunk?.();
    } catch (err) {
      this.logWarn(`onFirstChunk hook failed: ${String(err)}`);
    }
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private resetReplyState(): void {
    this.replyOrdinal += 1;
    this.lastPartialLength = 0;
    this.latestText = "";
    this.lastSentText = "";
    this.sessionSentChunkCount = 0;
    this.sessionShouldFallbackToStatic = false;
    this.firstChunkNotified = false;
    this.resetStreamSession();
  }

  private resetStreamSession(): void {
    this.streamMsgId = undefined;
    this.msgSeq = undefined;
    this.index = 0;
    this.lastSendAt = 0;
    this.clearFlushTimer();
  }

  private logInfo(message: string): void {
    const next = `${this.params.logPrefix ?? "[qqbot:streaming]"} ${message}`;
    this.params.logger?.info?.(next);
  }

  private logWarn(message: string): void {
    const next = `${this.params.logPrefix ?? "[qqbot:streaming]"} ${message}`;
    (this.params.logger?.warn ?? this.params.logger?.info)?.(next);
  }

  private logError(message: string): void {
    const next = `${this.params.logPrefix ?? "[qqbot:streaming]"} ${message}`;
    this.params.logger?.error?.(next);
  }
}
