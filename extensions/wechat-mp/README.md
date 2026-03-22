# @openclaw-china/wechat-mp

`wechat-mp` 是一个独立的微信公众号（订阅号 / 服务号）渠道插件，用于把公众号消息接入 OpenClaw。

## 功能特性

### 入站消息

| 消息类型 | 支持状态 | 说明 |
|---------|---------|------|
| 文本消息 | ✅ | 完整支持，自动处理超长分割 |
| 图片消息 | ✅ | 返回图片 URL 和 MediaId |
| 语音消息 | ✅ | 支持 ASR 自动转文字 |
| 视频消息 | ✅ | 返回视频 MediaId |
| 短视频消息 | ✅ | 返回短视频 MediaId |
| 位置消息 | ✅ | 返回经纬度和地址 |
| 链接消息 | ✅ | 返回标题、描述和 URL |
| 事件消息 | ✅ | subscribe/unsubscribe/scan/click/view |

### 主动发送

| 发送类型 | 支持状态 | 说明 |
|---------|---------|------|
| 文本消息 | ✅ | 支持超长自动分割 |
| 模板消息 | ✅ | 业务通知消息 |
| 图片消息 | ✅ | 自动上传并发送 |
| 语音消息 | ✅ | 自动上传并发送 |
| 视频消息 | ✅ | 自动上传并发送 |

### 高级功能

- **语音转文字 (ASR)**: 集成腾讯云语音识别，自动将语音转为文字
- **重试机制**: 支持指数退避重试，处理网络波动和限流
- **时间窗口检查**: 48小时交互窗口检测，发送前权限验证
- **Markdown 渲染**: 自动转换为公众号友好的纯文本格式

## 配置示例

### 基础配置

```json
{
  "channels": {
    "wechat-mp": {
      "enabled": true,
      "webhookPath": "/wechat-mp",
      "appId": "wx1234567890abcdef",
      "appSecret": "your-app-secret",
      "token": "your-callback-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "messageMode": "safe",
      "replyMode": "active",
      "activeDeliveryMode": "split",
      "renderMarkdown": true,
      "welcomeText": "你好，欢迎关注。"
    }
  }
}
```

### 完整配置（含 ASR）

```json
{
  "channels": {
    "wechat-mp": {
      "enabled": true,
      "webhookPath": "/wechat-mp",
      "appId": "wx1234567890abcdef",
      "appSecret": "your-app-secret",
      "token": "your-callback-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "messageMode": "safe",
      "replyMode": "active",
      "activeDeliveryMode": "split",
      "renderMarkdown": true,
      "welcomeText": "你好，欢迎关注。",
      "dmPolicy": "open",
      "allowFrom": [],
      "retryConfig": {
        "maxRetries": 3,
        "initialDelay": 1000,
        "maxDelay": 10000,
        "backoffMultiplier": 2
      },
      "asr": {
        "enabled": true,
        "appId": "腾讯云 AppId",
        "secretId": "腾讯云 SecretId",
        "secretKey": "腾讯云 SecretKey",
        "engineType": "16k_zh",
        "timeoutMs": 30000
      }
    }
  }
}
```

### 多账号配置

```json
{
  "channels": {
    "wechat-mp": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "appId": "wx-main-account",
          "appSecret": "main-secret",
          "token": "main-token"
        },
        "sub": {
          "appId": "wx-sub-account",
          "appSecret": "sub-secret",
          "token": "sub-token"
        }
      }
    }
  }
}
```

## 配置字段说明

### 基础配置

| 字段 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| `enabled` | boolean | 否 | 是否启用，默认 true |
| `webhookPath` | string | 否 | 回调路径，默认 `/wechat-mp` |
| `appId` | string | 是 | 公众号 AppId |
| `appSecret` | string | 条件 | 主动发送必填 |
| `token` | string | 是 | 回调 Token |
| `encodingAESKey` | string | 条件 | safe/compat 模式必填 |
| `messageMode` | string | 否 | 消息模式：`plain` / `safe` / `compat` |
| `replyMode` | string | 否 | 回复模式：`passive` / `active` |
| `activeDeliveryMode` | string | 否 | 主动发送模式：`split` / `merged` |
| `renderMarkdown` | boolean | 否 | 是否渲染 Markdown，默认 true |
| `welcomeText` | string | 否 | 关注欢迎语 |
| `dmPolicy` | string | 否 | DM 策略：`open` / `pairing` / `allowlist` / `disabled` |
| `allowFrom` | string[] | 否 | 允许的用户列表 |

### 重试配置 (`retryConfig`)

| 字段 | 类型 | 默认值 | 说明 |
|-----|------|-------|------|
| `maxRetries` | number | 3 | 最大重试次数 |
| `initialDelay` | number | 1000 | 初始延迟（毫秒） |
| `maxDelay` | number | 10000 | 最大延迟（毫秒） |
| `backoffMultiplier` | number | 2 | 退避乘数 |

### ASR 配置 (`asr`)

| 字段 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| `enabled` | boolean | 否 | 是否启用 ASR |
| `appId` | string | 是 | 腾讯云 AppId |
| `secretId` | string | 是 | 腾讯云 SecretId |
| `secretKey` | string | 是 | 腾讯云 SecretKey |
| `engineType` | string | 否 | 引擎类型，默认 `16k_zh` |
| `timeoutMs` | number | 否 | 超时时间，默认 30000 |

## API 使用示例

### 发送文本

```typescript
import { wechatMpOutbound } from "@openclaw-china/wechat-mp";

// 发送文本
await wechatMpOutbound.sendText({
  cfg,
  to: "user:openid123",
  text: "Hello, World!"
});
```

### 发送模板消息

```typescript
await wechatMpOutbound.sendTemplate({
  cfg,
  to: "user:openid123",
  templateId: "template_id_here",
  data: {
    first: { value: "您好，您有新的通知" },
    keyword1: { value: "订单号：123456" },
    keyword2: { value: "已发货" },
    remark: { value: "点击查看详情" }
  },
  url: "https://example.com/order/123456"
});
```

### 发送媒体消息

```typescript
import { readFileSync } from "fs";

// 发送图片
await wechatMpOutbound.sendMedia({
  cfg,
  to: "user:openid123",
  mediaType: "image",
  buffer: readFileSync("./image.jpg"),
  filename: "image.jpg"
});

// 发送语音
await wechatMpOutbound.sendMedia({
  cfg,
  to: "user:openid123",
  mediaType: "voice",
  buffer: readFileSync("./voice.amr"),
  filename: "voice.amr"
});

// 发送视频
await wechatMpOutbound.sendMedia({
  cfg,
  to: "user:openid123",
  mediaType: "video",
  buffer: readFileSync("./video.mp4"),
  filename: "video.mp4"
});
```

### 检查发送能力

```typescript
// 检查用户是否在 48 小时交互窗口内
const capability = await wechatMpOutbound.checkCapability({
  cfg,
  to: "user:openid123"
});

if (!capability.canSend) {
  console.log(`无法发送：${capability.reason}`);
}

// 检查时间窗口
const inWindow = wechatMpOutbound.checkTimeWindow({
  config: { mode: "business" } // 工作时间 9:00-18:00
});
```

### 记录用户交互

```typescript
// 在处理入站消息时调用，用于 48 小时窗口跟踪
await wechatMpOutbound.recordInteraction({
  cfg,
  openId: "openid123"
});
```

## 联调要点

1. **回调配置**：公众号后台服务器地址指向网关回调地址
2. **消息模式**：
   - `plain`：明文模式，最小链路验证
   - `safe`：加密模式，需要 `encodingAESKey`
   - `compat`：兼容模式，同时支持明文和加密
3. **主动发送**：必须配置 `appSecret`
4. **回复模式**：
   - `passive`：5 秒内 HTTP 回包
   - `active`：使用客服消息 API 主动发送
5. **消息长度**：2048 字节限制，超长自动分割
6. **语音识别**：
   - 方法一：公众号后台开启"语音识别"功能
   - 方法二：配置 `asr` 使用腾讯云 ASR

## 开发测试

```bash
# 构建
pnpm -F @openclaw-china/wechat-mp build

# 测试
pnpm -F @openclaw-china/wechat-mp test

# 类型检查
pnpm -F @openclaw-china/wechat-mp typecheck
```

## 文档入口

- 开发计划：`doc/guides/wechat-mp/doc/开发计划.md`
- 配置指南：`doc/guides/wechat-mp/configuration.md`
- 微信官方文档：`doc/guides/wechat-mp/doc/mp接口文档/`
