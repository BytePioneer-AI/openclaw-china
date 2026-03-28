export type QQBotPartialReplyPayload = { text?: string };

export type QQBotReplyOptions = {
  disableBlockStreaming?: boolean;
  onPartialReply?: (payload: QQBotPartialReplyPayload) => Promise<void> | void;
  [key: string]: unknown;
};

export interface PluginRuntime {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  channel?: {
    routing?: {
      resolveAgentRoute?: (params: {
        cfg: unknown;
        channel: string;
        accountId?: string;
        peer: { kind: string; id: string };
      }) => { sessionKey: string; accountId: string; agentId?: string };
    };
    session?: {
      resolveStorePath?: (store: unknown, params: { agentId?: string }) => string | undefined;
      readSessionUpdatedAt?: (params: { storePath: string; sessionKey: string }) => number | null;
      recordSessionMetaFromInbound?: (params: {
        storePath: string;
        sessionKey: string;
        ctx: unknown;
        groupResolution?: unknown;
        createIfMissing?: boolean;
      }) => Promise<unknown>;
      updateLastRoute?: (params: {
        storePath: string;
        sessionKey: string;
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
        deliveryContext?: unknown;
        ctx?: unknown;
        groupResolution?: unknown;
      }) => Promise<unknown>;
      recordInboundSession?: (params: {
        storePath: string;
        sessionKey: string;
        ctx: unknown;
        updateLastRoute?: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        };
        onRecordError?: (err: unknown) => void;
      }) => Promise<void>;
    };
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcher?: unknown;
        replyOptions?: QQBotReplyOptions;
      }) => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
      dispatchReplyWithDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: unknown, info?: { kind?: string }) => Promise<void> | void;
          onError?: (err: unknown, info: { kind: string }) => void;
          onSkip?: (payload: unknown, info: { kind: string; reason: string }) => void;
          onReplyStart?: () => Promise<void> | void;
          humanDelay?: unknown;
        };
        replyOptions?: QQBotReplyOptions;
      }) => Promise<unknown>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: unknown, info?: { kind?: string }) => Promise<void> | void;
          onError?: (err: unknown, info: { kind: string }) => void;
          onSkip?: (payload: unknown, info: { kind: string; reason: string }) => void;
          onReplyStart?: () => Promise<void> | void;
          humanDelay?: unknown;
        };
        replyOptions?: QQBotReplyOptions;
      }) => Promise<unknown>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      createReplyDispatcher?: (params: unknown) => unknown;
      createReplyDispatcherWithTyping?: (params: unknown) => {
        dispatcher: unknown;
        replyOptions?: unknown;
        markDispatchIdle?: () => void;
      };
      resolveHumanDelayConfig?: (cfg: unknown, agentId?: string) => unknown;
      resolveEffectiveMessagesConfig?: (cfg: unknown) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: unknown) => string;
      formatInboundEnvelope?: (params: unknown) => string;
    };
    text?: {
      resolveTextChunkLimit?: (params: {
        cfg: unknown;
        channel: string;
        defaultLimit?: number;
      }) => number;
      resolveChunkMode?: (cfg: unknown, channel: string) => unknown;
      resolveMarkdownTableMode?: (params: { cfg: unknown; channel: string; accountId?: string }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
      chunkTextWithMode?: (text: string, limit: number, mode: unknown) => string[];
      chunkMarkdownText?: (text: string, limit: number) => string[];
    };
  };
  system?: {
    enqueueSystemEvent?: (message: string, options?: unknown) => void;
  };
  [key: string]: unknown;
}

let runtime: PluginRuntime | null = null;

export function setQQBotRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized. Ensure the plugin is registered.");
  }
  return runtime;
}

export function isQQBotRuntimeInitialized(): boolean {
  return runtime !== null;
}

export function clearQQBotRuntime(): void {
  runtime = null;
}
