/**
 * 企业微信插件运行时管理
 */

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
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcher?: unknown;
        replyOptions?: unknown;
      }) => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }) => Promise<void>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      createReplyDispatcher?: (params: unknown) => unknown;
      createReplyDispatcherWithTyping?: (params: unknown) => {
        dispatcher: unknown;
        replyOptions?: unknown;
        markDispatchIdle?: () => void;
      };
      resolveHumanDelayConfig?: (cfg: unknown, agentId?: string) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: {
        channel: string;
        from: string;
        previousTimestamp?: number;
        envelope?: unknown;
        body: string;
      }) => string;
    };
    session?: {
      resolveStorePath?: (store: unknown, params: { agentId?: string }) => string | undefined;
      readSessionUpdatedAt?: (params: { storePath?: string; sessionKey: string }) => number | null;
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
    text?: {
      resolveMarkdownTableMode?: (params: { cfg: unknown; channel: string; accountId?: string }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
    };
  };
  system?: {
    enqueueSystemEvent?: (message: string, options?: unknown) => void;
  };
  [key: string]: unknown;
}

let runtime: PluginRuntime | null = null;

export function setWecomRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWecomRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeCom runtime not initialized. Make sure the plugin is properly registered with Moltbot.");
  }
  return runtime;
}

export function tryGetWecomRuntime(): PluginRuntime | null {
  return runtime;
}

export function isWecomRuntimeInitialized(): boolean {
  return runtime !== null;
}

export function clearWecomRuntime(): void {
  runtime = null;
}
