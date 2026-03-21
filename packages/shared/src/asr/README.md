# ASR 接入说明（供各插件复用）

本文说明如何在任意渠道插件中复用 `@xuanyue202/shared` 的语音转文本能力。

> 当前 QQ 渠道的腾讯云 ASR 仅支持国内网络下启用。

当前已提供：
- 腾讯云录音文件识别极速版（`asr/flash/v1`）
- 统一错误类型（便于插件侧日志和降级）

## 职责边界

`shared` 负责：
- 调用 ASR 服务（签名、请求、响应解析、超时）
- 抛出结构化错误（`ASRError` 及子类）

单个插件负责：
- 平台事件解析（如何识别语音消息）
- 媒体下载（URL/鉴权/大小限制）
- 业务策略（失败是否降级、回复文案、是否中断本次处理）
- 密钥配置（建议保留在插件配置内）

## 可直接使用的导出

```ts
import {
  transcribeTencentFlash,
  ASRError,
  ASRTimeoutError,
  ASRAuthError,
  ASRRequestError,
  ASRResponseParseError,
  ASRServiceError,
  ASREmptyResultError,
} from "@xuanyue202/shared";
```

## 插件接入步骤

1. 在插件配置中增加 ASR 字段（示例）
```ts
asr: {
  enabled?: boolean;
  appId?: string;
  secretId?: string;
  secretKey?: string;
}
```

2. 在入站消息里识别语音附件，并下载到 `Buffer`
- 推荐复用 `shared/media` 的下载能力：
```ts
import { fetchMediaFromUrl } from "@xuanyue202/shared";
```

3. 调用转写
```ts
const transcript = await transcribeTencentFlash({
  audio: media.buffer,
  config: {
    appId: asr.appId,
    secretId: asr.secretId,
    secretKey: asr.secretKey,
    // 可选，默认如下：
    // engineType: "16k_zh",
    // voiceFormat: "silk",
    // timeoutMs: 30000,
  },
});
```

4. 按错误类型做日志与降级
```ts
try {
  // transcribeTencentFlash(...)
} catch (err) {
  if (err instanceof ASRError) {
    logger.warn(
      `asr failed kind=${err.kind} provider=${err.provider} retryable=${err.retryable} msg=${err.message}`
    );
  } else {
    logger.warn(`asr failed: ${String(err)}`);
  }
  // 在这里决定是否回退文本、提示用户、或继续其他链路
}
```

## 错误类型语义

- `ASRTimeoutError`：请求超时，通常可重试
- `ASRAuthError`：鉴权失败（密钥错误/权限问题），通常不可重试
- `ASRRequestError`：请求失败（网络或 HTTP 失败）
- `ASRResponseParseError`：服务返回非 JSON 或格式异常
- `ASRServiceError`：服务端返回业务错误码（`code != 0`）
- `ASREmptyResultError`：识别成功但无文本

## 最佳实践

- 不要把密钥硬编码到仓库；仅通过配置注入。
- 给下载和 ASR 都设置超时与大小上限。
- 将“ASR 失败文案”放在插件侧，不放到 `shared`。
- 先记录结构化日志，再决定业务降级策略。
