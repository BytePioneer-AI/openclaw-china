export type ASRErrorKind =
  | "timeout"
  | "auth"
  | "request"
  | "response_parse"
  | "service"
  | "empty_result";

export class ASRError extends Error {
  constructor(
    message: string,
    public readonly kind: ASRErrorKind,
    public readonly provider: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ASRError";
  }
}

export class ASRTimeoutError extends ASRError {
  constructor(provider: string, public readonly timeoutMs: number) {
    super(`ASR request timeout after ${timeoutMs}ms`, "timeout", provider, true);
    this.name = "ASRTimeoutError";
  }
}

export class ASRAuthError extends ASRError {
  constructor(provider: string, message: string, public readonly status?: number) {
    super(message, "auth", provider, false);
    this.name = "ASRAuthError";
  }
}

export class ASRRequestError extends ASRError {
  constructor(
    provider: string,
    message: string,
    public readonly status?: number,
    public readonly bodySnippet?: string
  ) {
    super(message, "request", provider, true);
    this.name = "ASRRequestError";
  }
}

export class ASRResponseParseError extends ASRError {
  constructor(
    provider: string,
    public readonly bodySnippet: string,
    public readonly status?: number
  ) {
    super("ASR response is not valid JSON", "response_parse", provider, false);
    this.name = "ASRResponseParseError";
  }
}

export class ASRServiceError extends ASRError {
  constructor(provider: string, message: string, public readonly serviceCode?: number) {
    super(message, "service", provider, false);
    this.name = "ASRServiceError";
  }
}

export class ASREmptyResultError extends ASRError {
  constructor(provider: string) {
    super("ASR returned empty transcript", "empty_result", provider, false);
    this.name = "ASREmptyResultError";
  }
}
