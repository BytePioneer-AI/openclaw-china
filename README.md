<p align="center">
  <strong style="font-size: 32px;">🧧🏮🎆 春 节 快 乐 🎆🏮🧧</strong><br>
  <strong>恭喜发财 · 万事如意 · 马年大吉</strong>
</p>

# 🦞 OpenClaw China — China IM Channels

<p align="center">
  <strong>面向中国 IM 平台的 OpenClaw 扩展插件集合</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#功能支持">功能支持</a> •
  <a href="#更新日志">更新日志</a> •
  <a href="#演示">演示</a> •
  <a href="#推荐项目">推荐项目</a> •
  <a href="#配置选项">配置选项</a> •
  <a href="#开发">开发</a> •
  <a href="#加入交流群">加入交流群</a>
</p>
<p align="center">
  <strong>⭐ 如果这个项目对你有帮助，请给我们一个Star！⭐</strong><br>
  <em>您的支持是我们持续改进的动力</em>
</p>
<p align="center">
  <strong>🤖 推荐：<a href="https://github.com/BytePioneer-AI/clawmate">ClawMate</a></strong> — 为 OpenClaw 添加有温度的角色伴侣
</p>
<table align="center">
  <thead>
    <tr>
      <th>平台</th>
      <th>状态</th>
      <th>配置复杂度</th>
      <th>配置指南</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>钉钉</td>
      <td align="center">✅ 可用</td>
      <td align="center">简单</td>
      <td><a href="doc/guides/dingtalk/configuration.md">钉钉企业注册指南</a></td>
    </tr>
       <tr>
      <td>QQ 机器人</td>
      <td align="center">✅ 可用</td>
      <td align="center">简单</td>
      <td><a href="doc/guides/qqbot/configuration.md">QQ 渠道配置指南</a></td>
    </tr>
     <tr>
      <td>企业微信（智能机器人）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等</td>
      <td><a href="doc/guides/wecom/configuration.md">企业微信智能机器人配置指南</a></td>
    </tr>
    <tr>
      <td>企业微信（自建应用-可接入微信）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等+</td>
      <td><a href="doc/guides/wecom-app/configuration.md">企业微信自建应用配置指南</a></td>
    </tr>
    <tr>
      <td>飞书</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等+</td>
      <td>-</td>
    </tr>


  </tbody>
</table>


## 功能支持

更多功能在努力开发中~

- **【全网首发】钉钉、QQ、企微支持文件接受和发送**
- **【全网首发】钉钉、QQ、飞书、企微支持定时任务**

| 功能 | 钉钉 | 飞书 | QQ | 企业微信<br />智能机器人 | 企业微信自建应用<br />（可接入普通微信） |
|------|:----:|:----:|:--:|:------------------:|:----------------:|
| 文本消息 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Markdown | ✅ | ✅ | ✅ | ✅ | ✅ |
| 流式响应 | ✅ | - | ❌ | ✅ | ❌ |
| 图片/文件 | ✅  | ✅<br />（仅发送） | ✅<br />（仅图片） | ✅  | ✅<br />（出站任意类型；入站允许图片、音视频、定位、语音） |
| 语音消息 | ✅ | - | ✅ | ✅ | ✅ |
| 私聊 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 群聊 | ✅ | ✅ | ✅ | ✅ | ✅ |
| @机器人检测 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 多账户 | 🚧 | 🚧 | 🚧 | ✅ | ✅ |
| 主动发送消息<br />（定时任务） | ✅ | ✅ | ✅ | ❌ | ✅（文本、图片、Markdown） |
| 连接方式 | Stream | WebSocket | - | HTTPS 回调 | HTTPS 回调 |
| Access Token 缓存 | - | - | - | - | ✅（2 小时有效期） |

## 更新日志

<details>
<summary><strong>点击展开更新日志</strong></summary>

### 2026-02-15

- 优化企业微信智能机器人的文件发送能力，支持发送多种文件类型。

### 2026-02-14

1. 企业微信支持接入腾讯云 ASR 服务，实现语音转文本。
2. 企业微信自建应用支持在微信侧发送定位，OpenClaw 可读取定位对应的具体位置。
3. 修复企业微信插件无法执行特殊命令的问题（如 `/new`）。
4. 新增企业微信插件定时任务能力。

</details>

## 快速开始

### 1) 安装

> 其他保姆文档编写中，现在最容易配置的是钉钉，建议先尝试钉钉。

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
openclaw plugins install @openclaw-china/feishu-china
```

```bash
openclaw plugins install @openclaw-china/qqbot
```

```bash
openclaw plugins install @openclaw-china/wecom-app
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
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
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

<details>
<summary><strong>钉钉</strong></summary>

> 📖 **[钉钉企业注册指南](doc/guides/dingtalk/configuration.md)** — 无需材料，5 分钟内完成配置

```bash
openclaw config set channels.dingtalk.enabled true
openclaw config set channels.dingtalk.clientId dingxxxxxx
openclaw config set channels.dingtalk.clientSecret your-app-secret
openclaw config set channels.dingtalk.enableAICard false
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

**可选高级配置**

如果你需要更细粒度控制（例如私聊策略或白名单），可以在 `~/.openclaw/openclaw.json` 中按需添加：

```json5
{
  "channels": {
    "dingtalk": {
      "dmPolicy": "open",          // open | pairing | allowlist
      "groupPolicy": "open",       // open | allowlist | disabled
      "allowFrom": [],
      "groupAllowFrom": []
    },
    "wecom-app": {
      "dmPolicy": "open",          // open | pairing | allowlist | disabled
      "allowFrom": []
    }
  }
}
```

</details>

<details>
<summary><strong>企业微信（自建应用-可接入微信）</strong></summary>

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

（可选）开启语音转文本（腾讯云 Flash ASR）：

```bash
openclaw config set channels.wecom-app.asr.enabled true
openclaw config set channels.wecom-app.asr.appId your-tencent-app-id
openclaw config set channels.wecom-app.asr.secretId your-tencent-secret-id
openclaw config set channels.wecom-app.asr.secretKey your-tencent-secret-key
```

**与智能机器人的区别**

| 功能 | 智能机器人 (wecom) | 自建应用 (wecom-app) |
|------|:------------------:|:--------------------:|
| 被动回复 | ✅ | ✅ |
| 主动发送消息 | ❌ | ✅ |
| 支持群聊 | ✅ | ❌（专注于私聊） |
| 需要 corpSecret | ❌ | ✅ |
| 需要 IP 白名单 | ❌ | ✅ |
| 配置复杂度 | 简单 | 中等 |

**wecom-app 已实现功能清单（摘要）**

- 入站：支持 JSON/XML 回调、验签与解密、长文本分片（2048 bytes）、stream 占位/刷新（5s 规则下缓冲）。
- 入站媒体：image/voice/file/mixed 自动落盘，消息体写入 `saved:` 稳定路径；按 `keepDays` 延迟清理。
  - 设计动机：避免使用 `/tmp` 造成"收到后很快被清理"，确保 OCR/MCP/回发等二次处理有稳定路径可依赖。
- 语音识别：支持接入腾讯云 Flash ASR（录音文件识别极速版）将语音转写为文本。
- 出站：支持主动发送文本与媒体；支持 markdown→纯文本降级（stripMarkdown）。
- 路由与目标：支持多种 target 解析（`wecom-app:user:..` / `user:..` / 裸 id / `@accountId`），减少 Unknown target。
- 策略与多账号：支持 defaultAccount/accounts；dmPolicy/allowlist；inboundMedia(开关/dir/maxBytes/keepDays)。

> 更完整说明见：`doc/guides/wecom-app/configuration.md`

**（可选）安装 wecom-app 专用 Skill**

企业微信自建应用可配套使用 `wecom-app-ops`（target/replyTo/回发图片/录音/文件、OCR/MCP、排障、媒体保留策略）。

安装方式（推荐：Workspace 级）：

```bash
# 在你的项目目录（workspace）下
mkdir -p ./skills
cp -a ~/.openclaw/extensions/openclaw-china/extensions/wecom-app/skills/wecom-app-ops ./skills/
```

或安装方式（全局）：

```bash
mkdir -p ~/.openclaw/skills
cp -a ~/.openclaw/extensions/openclaw-china/extensions/wecom-app/skills/wecom-app-ops ~/.openclaw/skills/
```

> 说明：Workspace > 全局（`~/.openclaw/skills`）> 内置 skills。复制后无需重启网关。

</details>

<details>
<summary><strong>QQ</strong></summary>

> 📖 **[QQ 渠道配置指南](https://github.com/BytePioneer-AI/openclaw-china/blob/main/doc/guides/qqbot/configuration.md)**

```bash
openclaw config set channels.qqbot.enabled true
openclaw config set channels.qqbot.appId your-app-id
openclaw config set channels.qqbot.clientSecret your-app-secret
openclaw config set channels.qqbot.markdownSupport false
```

（可选）开启语音转文本（腾讯云 Flash ASR）：

```bash
openclaw config set channels.qqbot.asr.enabled true
openclaw config set channels.qqbot.asr.appId your-tencent-app-id
openclaw config set channels.qqbot.asr.secretId your-tencent-secret-id
openclaw config set channels.qqbot.asr.secretKey your-tencent-secret-key
```

</details>

MarkDown需申请相关权限。

<details>
<summary><strong>企业微信（智能机器人）</strong></summary>

> 📖 **[企业微信智能机器人配置指南](doc/guides/wecom/configuration.md)**

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

</details>

<details>
<summary><strong>飞书</strong></summary>

> 飞书应用需开启机器人能力，并使用「长连接接收消息」模式

openclaw:

```bash
openclaw config set channels.feishu-china.enabled true
openclaw config set channels.feishu-china.appId cli_xxxxxx
openclaw config set channels.feishu-china.appSecret your-app-secret
openclaw config set channels.feishu-china.sendMarkdownAsCard true
```

</details>

### 3) 调试模式启动

```bash
openclaw gateway --port 18789 --verbose
```

## 演示

以下为钉钉渠道效果示例：

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

![钉钉机器人演示](doc/images/dingtalk-demo_3.png)

## 推荐项目

### 🤖 ClawMate - OpenClaw 角色伴侣插件

> 为 OpenClaw 添加一个有温度的角色伴侣

[ClawMate](https://github.com/BytePioneer-AI/clawmate) 是一个为 OpenClaw 设计的角色伴侣插件，让你的 AI 助手拥有视觉形象和情感温度。

**核心功能**
- ⏰ **时间感知** — 场景和穿搭随时间自动切换（早晨、上课、午休、傍晚、深夜）
- 📸 **情境生图** — 根据对话内容和当前状态生成写实自拍
- 💬 **主动发图** — 日常聊天中随机发自拍表示关心
- 👥 **多角色** — 内置角色 + 对话创建自定义角色
- 🎨 **多图像服务** — 支持阿里云百炼、火山引擎 ARK、fal.ai、OpenAI 兼容接口

**快速安装**
```bash
npx github:BytePioneer-AI/clawmate
```

**应用场景**：个人伴侣、虚拟导师、智能客服、专业顾问

了解更多：[https://github.com/BytePioneer-AI/clawmate](https://github.com/BytePioneer-AI/clawmate)

## 配置选项

> 通用字段适用于所有渠道；渠道专用字段仅在对应渠道生效。

### 通用字段

| 选项 | 说明 |
|------|------|
| `enabled` | 是否启用 |
| `dmPolicy` | 私聊策略：`open`（任何人）/ `allowlist`（白名单） |
| `groupPolicy` | 群聊策略：`open`（任何群）/ `allowlist`（白名单）/ `disabled`（禁用） |
| `allowFrom` | 私聊白名单用户 ID |
| `groupAllowFrom` | 群聊白名单群 ID |
| `maxFileSizeMB` | 媒体文件大小限制 (MB)，默认 100 |


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
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china

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
    "qqbot": {
      "enabled": true,
      "appId": "your-app-id",
      "clientSecret": "your-app-secret"
    },
    "feishu-china": {
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

## 加入交流群

对 OpenClaw 用法、插件感兴趣的可以扫码加入微信群交流。

- 安装问题可以加群询问
- 提PR时遇到开发问题加群询问
- 项目架构细节加群询问
- 插件**BUG**建议提交**issue**

**欢迎同学们一起开发~**



<img src="https://github.com/user-attachments/assets/697c25f4-7734-4f22-9c3b-36c287457bb8" alt="二维码" width="50%" />




## License

MIT
