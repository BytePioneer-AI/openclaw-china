# Moltbot China 项目架构设计

## 项目概述

Moltbot China 是一个开源扩展集，为 Moltbot Agent 系统添加中国区消息渠道支持：

- **飞书 (Feishu/Lark)**
- **钉钉 (DingTalk)**
- **企业微信 (WeCom)**
- **QQ 机器人**

每个渠道作为独立插件发布到 npm，用户可按需安装：

```bash
moltbot plugins install @xuanyue202/feishu-china
moltbot plugins install @xuanyue202/dingtalk
# 或
npm install @xuanyue202/feishu-china
```

---

## 四平台 SDK 现状

| 平台 | 官方 SDK | 成熟度 | 实现方案 |
|------|----------|:------:|----------|
| 飞书 | `@larksuiteoapi/node-sdk` | ✅ 成熟 | 使用官方 SDK |
| 钉钉 | `dingtalk-stream-sdk-nodejs` | ✅ 官方维护 | 使用官方 Stream SDK |
| 企业微信 | ❌ 无官方 Node SDK | - | 自封装 HTTP API |
| QQ | `qq-guild-bot` (仅频道) | ⚠️ 有限 | 自封装 HTTP API |

**设计原则**：不强制抽象 SDK 差异，各渠道独立实现，只共享真正通用的业务逻辑。

---

## 项目结构

```
openclaw-china/
├── README.md
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── packages/
│   └── shared/                            # 轻量共享工具（内部使用）
│       ├── package.json                   # "private": true
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           │
│           ├── policy/                    # 策略引擎
│           │   ├── dm-policy.ts           # DM 策略（open/pairing/allowlist）
│           │   ├── group-policy.ts        # 群组策略
│           │   └── allowlist.ts           # 白名单匹配
│           │
│           ├── message/                   # 消息工具
│           │   ├── history.ts             # 历史记录管理
│           │   └── chunker.ts             # 文本分块
│           │
│           ├── http/                      # HTTP 工具
│           │   ├── client.ts              # 通用 HTTP 客户端封装
│           │   └── retry.ts               # 重试策略
│           │
│           └── types/                     # 共享类型
│               └── common.ts              # 通用类型定义
│
└── extensions/
    │
    ├── feishu/                            # @xuanyue202/feishu-china
    │   ├── moltbot.plugin.json
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   └── src/
    │       ├── channel.ts                 # ChannelPlugin 实现
    │       ├── client.ts                  # 飞书 SDK 封装
    │       ├── bot.ts                     # 消息处理
    │       ├── monitor.ts                 # WS/Webhook 连接
    │       ├── send.ts                    # 发送消息
    │       ├── media.ts                   # 媒体处理
    │       ├── outbound.ts                # 出站适配器
    │       ├── config.ts                  # 配置 schema
    │       └── types.ts
    │
    ├── dingtalk/                          # @xuanyue202/dingtalk
    │   ├── moltbot.plugin.json
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   └── src/
    │       ├── channel.ts
    │       ├── client.ts                  # Stream SDK 封装
    │       ├── bot.ts
    │       ├── monitor.ts                 # Stream 连接
    │       ├── send.ts
    │       ├── media.ts
    │       ├── outbound.ts
    │       ├── config.ts
    │       └── types.ts
    │
    ├── wecom/                             # @xuanyue202/wecom
    │   ├── moltbot.plugin.json
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── index.ts
    │   └── src/
    │       ├── channel.ts
    │       ├── api/                       # 自封装 API（无官方 SDK）
    │       │   ├── client.ts              # HTTP 客户端
    │       │   ├── auth.ts                # access_token 管理
    │       │   ├── message.ts             # 消息 API
    │       │   └── media.ts               # 媒体 API
    │       ├── crypto.ts                  # 消息加解密（企微特有）
    │       ├── bot.ts
    │       ├── callback.ts                # 回调服务器
    │       ├── send.ts
    │       ├── outbound.ts
    │       ├── config.ts
    │       └── types.ts
    │
    └── qq/                                # @xuanyue202/qq
        ├── moltbot.plugin.json
        ├── package.json
        ├── tsconfig.json
        ├── index.ts
        └── src/
            ├── channel.ts
            ├── api/                       # 自封装 API
            │   ├── client.ts
            │   ├── auth.ts
            │   ├── message.ts
            │   └── media.ts
            ├── bot.ts
            ├── monitor.ts                 # WebSocket 连接
            ├── send.ts
            ├── outbound.ts
            ├── config.ts
            └── types.ts
```

---

## 共享模块设计

### 共享 vs 不共享

| 共享（packages/shared） | 不共享（各 extension 独立） |
|-------------------------|----------------------------|
| DM/群组策略引擎 | SDK 客户端封装 |
| 白名单匹配逻辑 | 消息格式解析 |
| 历史记录管理 | 连接管理（WS/HTTP/Stream） |
| 文本分块工具 | 媒体上传逻辑 |
| HTTP 重试工具 | 加解密（仅企微需要） |

### 使用示例

```typescript
// extensions/feishu/src/bot.ts
import { DmPolicyEngine, GroupPolicyEngine } from "@xuanyue202/shared";
import { HistoryManager } from "@xuanyue202/shared";

// 使用共享的策略引擎
const dmPolicy = new DmPolicyEngine(config.dmPolicy, config.allowFrom);
if (!dmPolicy.isAllowed(senderId)) {
  return;
}

// 使用共享的历史管理
const history = new HistoryManager(config.historyLimit);
history.record(chatId, message);
```

---

## 各渠道模块职责

### 通用模块（每个渠道都有）

| 文件 | 职责 |
|------|------|
| `channel.ts` | 实现 `ChannelPlugin` 接口，定义元数据、能力、生命周期 |
| `bot.ts` | 消息事件处理，解析入站消息，分发到 Agent |
| `send.ts` | 发送消息 API 封装 |
| `outbound.ts` | 实现 `ChannelOutboundAdapter`，统一出站接口 |
| `config.ts` | Zod 配置 schema 定义 |
| `types.ts` | 类型定义 |

### 渠道特有模块

| 渠道 | 特有模块 | 说明 |
|------|----------|------|
| 飞书 | `client.ts`, `monitor.ts` | SDK 封装，WS/Webhook 连接 |
| 钉钉 | `client.ts`, `monitor.ts` | Stream SDK 封装 |
| 企业微信 | `api/*`, `crypto.ts`, `callback.ts` | 自封装 API，消息加解密，回调服务器 |
| QQ | `api/*`, `monitor.ts` | 自封装 API，WebSocket 连接 |

---

## 配置结构

所有渠道遵循统一的配置模式：

```yaml
channels:
  feishu-china:
    enabled: true
    appId: "cli_xxx"
    appSecret: "secret"
    domain: "feishu"              # feishu | lark
    connectionMode: "websocket"   # websocket | webhook
    dmPolicy: "pairing"           # open | pairing | allowlist
    groupPolicy: "allowlist"      # open | allowlist | disabled
    requireMention: true
    allowFrom: []
    groupAllowFrom: []

  dingtalk:
    enabled: true
    clientId: "xxx"
    clientSecret: "secret"
    connectionMode: "stream"      # stream | webhook
    dmPolicy: "pairing"
    groupPolicy: "allowlist"

  wecom:
    enabled: true
    webhookPath: "/wecom"
    token: "callback_token"
    encodingAESKey: "aes_key"
    receiveId: ""
    dmPolicy: "pairing"
    groupPolicy: "open"
    requireMention: true

  qq:
    enabled: true
    appId: "xxx"
    token: "token"
    appSecret: "secret"
    sandbox: false
    dmPolicy: "pairing"
    groupPolicy: "allowlist"
```

---

## 插件清单示例

每个插件必须包含 `moltbot.plugin.json`：

```json
{
  "id": "feishu-china",
  "name": "Feishu",
  "description": "飞书/Lark 消息渠道插件",
  "version": "0.1.0",
  "channels": ["feishu-china"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean" },
      "appId": { "type": "string" },
      "appSecret": { "type": "string" },
      "domain": { "type": "string", "enum": ["feishu", "lark"] },
      "connectionMode": { "type": "string", "enum": ["websocket", "webhook"] },
      "dmPolicy": { "type": "string", "enum": ["open", "pairing", "allowlist"] },
      "groupPolicy": { "type": "string", "enum": ["open", "allowlist", "disabled"] }
    }
  },
  "uiHints": {
    "appId": { "label": "App ID" },
    "appSecret": { "label": "App Secret", "sensitive": true }
  }
}
```

---

## package.json 配置示例

```json
{
  "name": "@xuanyue202/feishu-china",
  "version": "0.1.0",
  "type": "module",
  "description": "Moltbot Feishu/Lark channel plugin",
  "license": "MIT",
  "files": ["index.ts", "src", "moltbot.plugin.json"],
  "moltbot": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "feishu-china",
      "label": "Feishu",
      "selectionLabel": "Feishu/Lark (飞书)",
      "docsPath": "/channels/feishu-china",
      "blurb": "飞书/Lark 企业消息",
      "aliases": ["lark"],
      "order": 70
    },
    "install": {
      "npmSpec": "@xuanyue202/feishu-china",
      "localPath": ".",
      "defaultChoice": "npm"
    }
  },
  "dependencies": {
    "@xuanyue202/shared": "workspace:*",
    "@larksuiteoapi/node-sdk": "^1.30.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "moltbot": "^1.0.0",
    "typescript": "^5.7.0"
  },
  "peerDependencies": {
    "moltbot": ">=1.0.0"
  },
  "bundledDependencies": ["@xuanyue202/shared"]
}
```

---

## 依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                         moltbot                              │
│                    (Agent 系统宿主)                          │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ peerDependency
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ @xuanyue202│   │ @xuanyue202│   │ @xuanyue202│
│   /feishu     │   │   /dingtalk   │   │   /wecom      │  ...
└───────────────┘   └───────────────┘   └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │ workspace:*
                              ▼
                    ┌───────────────┐
                    │ @xuanyue202│
                    │   /shared     │
                    │  (bundled)    │
                    └───────────────┘
```

---

## 开发工作流

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/xxx/openclaw-china.git
cd openclaw-china

# 安装依赖
pnpm install

# 构建共享包
pnpm -F @xuanyue202/shared build

# 开发某个渠道
pnpm -F @xuanyue202/feishu-china dev
```

### 发布

```bash
# 发布单个渠道
cd extensions/feishu
pnpm publish --access public

# 或使用 changeset 批量发布
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

---

## 参考资料

- [Moltbot 插件开发文档](./moltbot/moltbot-plugin.md)
- [Moltbot 插件清单规范](./moltbot/moltbot-plugin-manifest.md)
- [Moltbot 渠道概览](./moltbot/moltbot-channels.md)
- [Clawdbot Feishu 参考实现](./reference-projects/clawdbot-feishu/)
