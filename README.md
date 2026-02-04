# OpenClaw China

面向中国 IM 平台的 OpenClaw 扩展插件集合

⭐ 如果这个项目对你有帮助，请给个Star支持一下~

[快速开始](#快速开始) · [演示](#演示) · [配置选项](#配置选项) · [开发](#开发)

| 平台 | 状态 |
|------|:----:|
| 钉钉 | ✅ 可用 |
| 飞书 | ✅ 可用 |
| 企业微信（智能机器人） | ✅ 可用 |
| 企业微信（自建应用-可接入普通微信） | ✅ 可用 |
| QQ 机器人 | 🚧 开发中 |


## 功能支持

更多功能支持在努力开发中~

**【全网首发】钉钉支持文件接受和发送**

| 功能 | 钉钉 | 飞书 | 企业微信智能机器人 | 企业微信自建应用（可接入普通微信） |
|------|:----:|:----:|:------------------:|:----------------:|
| 文本消息 | ✅ | ✅ | ✅ | ✅ |
| Markdown | ✅ | ✅ | ✅ | ✅ |
| 流式响应 | ✅ | 🚧 开发中 | ✅ stream 回调 | ❌ |
| 图片/文件 | ✅  | ✅可接收 | ✅ 可接收 | ✅ 主动发送（支持网络 URL 和本地文件） |
| 语音消息 | ✅  | 🚧 开发中 | ✅ 仅接收（语音文本） | ✅ 仅接收 |
| 私聊 | ✅ | ✅ | ✅ | ✅ |
| 群聊 | ✅ | ✅ | ✅ | ✅ |
| @机器人检测 | ✅ | ✅ | ❌（未显式解析@） | ❌ |
| 多账户 | 🚧 开发中 | 🚧 开发中 | ✅ | ✅ |
| 主动发送消息 | ✅ | ✅ | ❌ | ✅（文本、图片、Markdown） |
| 连接方式 | Stream 长连接 | WebSocket 长连接 | HTTPS 回调 | HTTPS 回调 |
| Access Token 缓存 | - | - | - | ✅（2 小时有效期） |

> 💡 **钉钉 AI Card** 支持打字机效果的流式输出，体验最佳。启用方式：`enableAICard: true`
>
> 💡 **飞书 Markdown 卡片** 启用方式：`sendMarkdownAsCard: true`
>
> 💡 **企业微信智能机器人** 仅支持被动回复模式，不支持主动发送消息
>
> 💡 **企业微信自建应用** 支持主动发送消息，需要配置 `corpId`、`corpSecret`、`agentId`

## 2.4 更新

1. 钉钉、飞书支持定时任务（主动发送消息）。
2. 修复钉钉语音发送问题，当前可正常发送语音。
3. 之前默认只发送最终回复文本，但部分任务等待较长；现开放参数 `replyFinalOnly`（默认 `false`）以控制是否仅发送最终结果。

## 快速开始

### 1) 安装

> 飞书、企业微信保姆文档编写中，现在最容易配置的是钉钉，建议先尝试钉钉。

#### 方式一：从 npm 安装

**安装统一包（包含所有渠道）**

```bash
openclaw plugins install @openclaw-china/channels
```

**或者：安装单个渠道（不要和统一包同时安装）**

```bash
openclaw plugins install @openclaw-china/dingtalk
```

```bash
openclaw plugins install @openclaw-china/feishu
```

```bash
openclaw plugins install @openclaw-china/wecom
```

#### 更新插件

```bash
openclaw plugins update channels
```


#### 方式二：从源码安装（全平台通用）

> ⚠️ **Windows 用户注意**：由于 OpenClaw 存在 Windows 兼容性问题（`spawn npm ENOENT`），npm 安装方式暂不可用，请使用方式二。

```bash
git clone https://github.com/BytePioneer-AI/moltbot-china.git
cd moltbot-china
pnpm install
pnpm build
openclaw plugins install -l ./packages/channels
```

#### 更新源码

```bash
git pull origin main
pnpm install
pnpm build
```

> 链接模式下构建后即生效，重启 Gateway 即可。

> ℹ️ 如果你使用的是旧名称 **clawbot**，请使用 `@openclaw-china/channels@0.1.12`。

### 2) 配置渠道

#### 钉钉

> 📖 **[钉钉企业注册指南](doc/guides/dingtalk/configuration.md)** — 无需材料，5 分钟内完成配置

```bash
openclaw config set channels.dingtalk.enabled true
openclaw config set channels.dingtalk.clientId dingxxxxxx
openclaw config set channels.dingtalk.clientSecret your-app-secret
openclaw config set channels.dingtalk.enableAICard false
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

**可选高级配置**

如果你需要更细粒度控制（例如私聊/群聊策略或白名单），可以在 `~/.openclaw/openclaw.json` 中按需添加：

```json5
{
  "channels": {
    "dingtalk": {
      "dmPolicy": "open",          // open | allowlist
      "groupPolicy": "open",       // open | allowlist | disabled
      "requireMention": true,
      "allowFrom": [],
      "groupAllowFrom": []
    }
  }
}
```


#### 企业微信（自建应用-可接入微信）

由[@RainbowRain9 Cai Hongyu](https://github.com/RainbowRain9)提供

> 📖 **[企业微信自建应用配置指南](doc/guides/wecom-app/configuration.md)** — 支持主动发送消息

企业微信自建应用支持主动发送消息，需要额外配置 `corpId`、`corpSecret`、`agentId`：

```bash
openclaw config set channels.wecom-app.enabled true
openclaw config set channels.wecom-app.webhookPath /wecom-app
openclaw config set channels.wecom-app.token your-token
openclaw config set channels.wecom-app.encodingAESKey your-43-char-encoding-aes-key
openclaw config set channels.wecom-app.corpId your-corp-id
openclaw config set channels.wecom-app.corpSecret your-app-secret
openclaw config set channels.wecom-app.agentId 1000002
```

**与智能机器人的区别**

| 功能 | 智能机器人 (wecom) | 自建应用 (wecom-app) |
|------|:------------------:|:--------------------:|
| 被动回复 | ✅ | ✅ |
| 主动发送消息 | ❌ | ✅ |
| 需要 corpSecret | ❌ | ✅ |
| 需要 IP 白名单 | ❌ | ✅ |
| 配置复杂度 | 简单 | 中等 |


#### 企业微信（智能机器人）

> 企业微信智能机器人（API 模式）通过公网 HTTPS 回调接收消息，仅支持被动回复

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.webhookPath /wecom
openclaw config set channels.wecom.token your-token
openclaw config set channels.wecom.encodingAESKey your-43-char-encoding-aes-key
```

**注意事项**

- `webhookPath` 必须为公网 HTTPS 可访问路径（如 `https://your.domain/wecom`）
- `encodingAESKey` 必须为 43 位字符
- 如遇回调校验失败，先确认 Token/EncodingAESKey 与后台一致



#### 飞书

> 飞书应用需开启机器人能力，并使用「长连接接收消息」模式

openclaw:

```bash
openclaw config set channels.feishu.enabled true
openclaw config set channels.feishu.appId cli_xxxxxx
openclaw config set channels.feishu.appSecret your-app-secret
openclaw config set channels.feishu.sendMarkdownAsCard true
```


### 3) 调试模式启动

```bash
openclaw gateway --port 18789 --verbose
```

## 演示

以下为钉钉渠道效果示例：

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

![钉钉机器人演示](doc/images/dingtalk-demo_3.png)

## 配置选项

> 通用字段适用于所有渠道；渠道专用字段仅在对应渠道生效。

### 通用字段

| 选项 | 说明 |
|------|------|
| `enabled` | 是否启用 |
| `dmPolicy` | 私聊策略：`open`（任何人）/ `allowlist`（白名单） |
| `groupPolicy` | 群聊策略：`open`（任何群）/ `allowlist`（白名单）/ `disabled`（禁用） |
| `requireMention` | 群聊中是否需要 @机器人 |
| `allowFrom` | 私聊白名单用户 ID |
| `groupAllowFrom` | 群聊白名单群 ID |
| `maxFileSizeMB` | 媒体文件大小限制 (MB)，默认 100 |
| `replyFinalOnly` | 仅发送最终回复（非流式），默认 `false` |


### 会话配置（可选）

`session.dmScope` 控制不同用户的会话隔离方式：

| 值 | 说明 |
|----|------|
| `main` | 所有用户共享同一会话（不推荐） |
| `per-peer` | **推荐**，按用户 ID 隔离 |
| `per-channel-peer` | 按渠道 + 用户隔离 |

## 开发

适合需要二次开发或调试的场景：

```bash
# 克隆仓库
git clone https://github.com/BytePioneer-AI/moltbot-china.git
cd moltbot-china

# 安装依赖并构建
pnpm install
pnpm build

# 以链接模式安装（修改代码后实时生效）
openclaw plugins install -l ./packages/channels
```

**示例配置（开发环境）**

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/OpenClaw-china/packages/channels"]
    },
    "entries": {
      "channels": { "enabled": true }
    }
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret"
    },
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxx",
      "appSecret": "your-app-secret"
    },
    "wecom": {
      "enabled": true,
      "webhookPath": "/wecom",
      "token": "your-token",
      "encodingAESKey": "your-43-char-encoding-aes-key"
    },
    "wecom-app": {
      "enabled": true,
      "webhookPath": "/wecom-app",
      "token": "your-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "corpId": "your-corp-id",
      "corpSecret": "your-app-secret",
      "agentId": 1000002
    }
  }
}
```

对OpenClaw用法、插件感兴趣的可以加群交流。

- 安装问题可以加群询问
- 提PR时遇到开发问题加群询问
- 项目架构细节加群询问
- 插件**BUG**建议提交**issue**

**欢迎同学们一起开发~**


<img width="611" height="854" alt="4d16a9f91778b4ad0153c40733ae3042" src="https://github.com/user-attachments/assets/607c9df3-4569-4534-81e4-2fd4579dd504" />



## License

MIT
