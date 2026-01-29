# Moltbot China

![license](https://img.shields.io/badge/license-MIT-green.svg) ![status](https://img.shields.io/badge/status-active-success.svg)

面向中国 IM 平台的 Moltbot 扩展插件集合

⭐ **如果这个项目对你有帮助，请给个 Star 支持一下~** ⭐

[快速开始](#快速开始)

| 平台 | 状态 | 插件 |
|------|:----:|------|
| 钉钉 | ✅ 可用 | `@moltbot-china/dingtalk` |
| 飞书 | 🚧 开发中 | - |
| 企业微信 | 🚧 开发中 | - |
| QQ 机器人 | 🚧 开发中 | - |

## 演示

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

![钉钉机器人演示](doc/images/dingtalk-demo_3.png)



## 快速开始

### 安装

```bash
# Clawdbot
clawdbot plugins install @moltbot-china/dingtalk

# 或 Moltbot
moltbot plugins install @moltbot-china/dingtalk
```



### 钉钉配置

> 📖 **[钉钉企业注册指南](doc/guides/dingtalk/configuration.md)** — 无需材料，通常 5 分钟内完成配置


#### 配置

编辑 `~/.clawdbot/clawdbot.json`（或 `~/.moltbot/moltbot.json`），添加钉钉渠道配置：

```json5
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "dmPolicy": "pairing",
      "groupPolicy": "open",
      "requireMention": true,
      "allowFrom": [],
      "groupAllowFrom": []
    }
  }
}
```

#### 重启 Gateway

```bash
clawdbot gateway restart
# 或
moltbot gateway restart
```

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用 |
| `clientId` | - | 应用的 AppKey（必填） |
| `clientSecret` | - | 应用的 AppSecret（必填） |
| `dmPolicy` | `pairing` | 私聊策略：`open`（任何人）/ `pairing`（需配对）/ `allowlist`（白名单） |
| `groupPolicy` | `allowlist` | 群聊策略：`open`（任何群）/ `allowlist`（白名单）/ `disabled`（禁用） |
| `requireMention` | `true` | 群聊中是否需要 @机器人 |
| `allowFrom` | `[]` | 私聊白名单用户 ID |
| `groupAllowFrom` | `[]` | 群聊白名单群 ID |


## 会话配置

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
clawdbot plugins install -l ./extensions/dingtalk
# 或
moltbot plugins install -l ./extensions/dingtalk
```

配置中添加：

```
  "plugins": {
    "load": {
      "paths": ["/path/to/moltbot-china/extensions/dingtalk"]
    },
    "entries": {
      "dingtalk": { "enabled": true }
    }
  }
```

## License

MIT
