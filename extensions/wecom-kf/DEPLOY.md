# WeCom KF (微信客服) 插件 — 手动部署指南

## 1. 前置要求

| 项目 | 要求 |
|------|------|
| Node.js | >= 18 |
| Moltbot | >= 0.1.0（宿主框架） |
| ffmpeg | 可选，语音转码需要 |

## 2. 构建部署包

在开发机上执行：

```bash
cd extensions/wecom-kf
pnpm build
```

构建完成后，需要的文件：

```
wecom-kf/
├── dist/
│   ├── index.js          # 主入口（ESM，已内联 shared + zod，无额外 npm 依赖）
│   ├── index.d.ts        # 类型声明
│   └── index.js.map      # sourcemap
├── openclaw.plugin.json   # 插件配置 schema
└── package.json           # 包元信息
```

打包压缩：

```bash
# 在项目根目录
tar czf wecom-kf-deploy.tar.gz \
  -C extensions/wecom-kf dist/ openclaw.plugin.json package.json DEPLOY.md
```

> `@openclaw-china/shared` 和 `zod` 已通过 tsup `noExternal` 内联到 `dist/index.js`，目标机器无需安装这两个包。

## 3. 目标机器部署

### 3.1 上传 & 解压

```bash
scp wecom-kf-deploy.tar.gz user@target:/opt/moltbot/
ssh user@target
cd /opt/moltbot
mkdir -p wecom-kf && tar xzf wecom-kf-deploy.tar.gz -C wecom-kf
```

### 3.2 安装到 Moltbot

```bash
# 方式 A: 作为 npm 本地包安装（推荐）
cd /opt/moltbot
npm install ./wecom-kf

# 方式 B: 直接拷贝到 extensions 目录
cp -r wecom-kf /opt/moltbot/extensions/
```

### 3.3 安装可选依赖（语音转码）

如需语音转码，二选一：

```bash
# 选项 1：安装内置 ffmpeg 二进制
cd wecom-kf && npm install ffmpeg-static

# 选项 2：使用系统 ffmpeg
# Ubuntu/Debian
apt install -y ffmpeg
# CentOS/RHEL
yum install -y ffmpeg
```

## 4. 配置

插件支持两种配置方式：**环境变量**（仅默认账户）和 **Moltbot 配置文件**。

### 4.1 环境变量（快速启动）

```bash
# ===== 必填：回调验证 =====
export WECOM_KF_TOKEN="your-callback-token"
export WECOM_KF_ENCODING_AES_KEY="your-encoding-aes-key"

# ===== 必填：企微 API 调用（用于发送消息） =====
export WECOM_KF_CORP_ID="your-corp-id"
export WECOM_KF_CORP_SECRET="your-app-secret"
export WECOM_KF_OPEN_KFID="wkAJ_XXXXX"

# ===== 可选 =====
export WECOM_KF_API_BASE_URL="https://qyapi.weixin.qq.com"
```

### 4.2 Moltbot 配置文件（推荐生产环境）

在 Moltbot 的配置中（`moltbot.config.json` 或等效配置）添加：

```jsonc
{
  "channels": {
    "wecom-kf": {
      "enabled": true,

      // ── 回调验证（企微后台生成） ──
      "token": "your-callback-token",
      "encodingAESKey": "your-encoding-aes-key",

      // ── 企微 API ──
      "corpId": "your-corp-id",
      "corpSecret": "your-app-secret",
      "openKfid": "wkAJ_XXXXX",

      // ── 可选配置 ──
      "webhookPath": "/wecom-kf",
      "apiBaseUrl": "https://qyapi.weixin.qq.com",
      "welcomeText": "你好，有什么可以帮你的？",
      "dmPolicy": "open",
      "allowFrom": [],

      // ── 入站媒体 ──
      "inboundMedia": {
        "enabled": true,
        "dir": "/data/media/wecom-kf/inbound",
        "maxBytes": 10485760,
        "keepDays": 7
      },

      // ── 语音转码（需要 ffmpeg） ──
      "voiceTranscode": {
        "enabled": true,
        "prefer": "amr"
      },

      // ── ASR 语音识别（腾讯云，可选） ──
      "asr": {
        "enabled": false,
        "appId": "your-tencent-asr-appid",
        "secretId": "your-tencent-secret-id",
        "secretKey": "your-tencent-secret-key",
        "engineType": "16k_zh",
        "timeoutMs": 10000
      }
    }
  }
}
```

### 4.3 多账户配置

当需要一个 Moltbot 实例服务多个客服账号时：

```jsonc
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      "corpId": "shared-corp-id",
      "corpSecret": "shared-secret",
      "defaultAccount": "sales",
      "accounts": {
        "sales": {
          "openKfid": "wkAJ_SALES",
          "token": "token-for-sales",
          "encodingAESKey": "aes-key-for-sales",
          "webhookPath": "/wecom-kf/sales",
          "welcomeText": "欢迎咨询销售！"
        },
        "support": {
          "openKfid": "wkAJ_SUPPORT",
          "token": "token-for-support",
          "encodingAESKey": "aes-key-for-support",
          "webhookPath": "/wecom-kf/support",
          "welcomeText": "技术支持为您服务！"
        }
      }
    }
  }
}
```

> 顶层的 `corpId`、`corpSecret` 等字段作为所有账户的默认值，每个账户可覆盖。

## 5. 企微后台配置

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)
2. 进入 **应用管理** → **微信客服**
3. 创建客服账号，记录 `open_kfid`（如 `wkAJ_XXXXX`）
4. 在 **API接收消息** 中配置：
   - **URL**: `https://your-domain.com/wecom-kf`（与 `webhookPath` 一致）
   - **Token**: 填入 `token` 值
   - **EncodingAESKey**: 填入 `encodingAESKey` 值
5. 记录 **CorpID**（企业信息页面）和 **Secret**（应用详情页面）

## 6. 配置参数速查

### 必填参数

| 参数 | 环境变量 | 说明 |
|------|----------|------|
| `token` | `WECOM_KF_TOKEN` | 回调 Token |
| `encodingAESKey` | `WECOM_KF_ENCODING_AES_KEY` | 回调加密密钥 |
| `corpId` | `WECOM_KF_CORP_ID` | 企业 ID |
| `corpSecret` | `WECOM_KF_CORP_SECRET` | 应用 Secret |
| `openKfid` | `WECOM_KF_OPEN_KFID` | 客服账号 ID |

### 可选参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `webhookPath` | Webhook 路径 | `/wecom-kf` |
| `apiBaseUrl` | 企微 API 地址 | `https://qyapi.weixin.qq.com` |
| `welcomeText` | 首次进入欢迎语 | — |
| `dmPolicy` | 消息策略 (`open` / `pairing` / `allowlist` / `disabled`) | `open` |
| `allowFrom` | 白名单列表（`dmPolicy=allowlist` 时生效） | `[]` |
| `inboundMedia.enabled` | 启用入站媒体下载 | `true` |
| `inboundMedia.dir` | 媒体存储路径 | `~/.openclaw/media/wecom-kf/inbound` |
| `inboundMedia.maxBytes` | 单文件最大字节 | `10485760` (10MB) |
| `inboundMedia.keepDays` | 媒体保留天数 | `7` |
| `voiceTranscode.enabled` | 启用语音转码 | — |
| `voiceTranscode.prefer` | 转码格式 | `amr` |
| `asr.enabled` | 启用语音识别 | `false` |
| `asr.appId` | 腾讯云 ASR AppId | — |
| `asr.secretId` | 腾讯云 ASR SecretId | — |
| `asr.secretKey` | 腾讯云 ASR SecretKey | — |
| `asr.engineType` | ASR 引擎 | `16k_zh` |
| `asr.timeoutMs` | ASR 超时毫秒 | `10000` |

## 7. 验证

启动 Moltbot 后，检查日志中是否出现：

```
[wecom-kf] channel registered
[wecom-kf] webhook listening on /wecom-kf
```

然后在企微后台的回调配置中点击「验证」按钮，确认回调 URL 可达。

## 8. 常见问题

**Q: 目标机器需要安装 `@openclaw-china/shared` 或 `zod` 吗？**
不需要。这两个包已通过 tsup 的 `noExternal` 选项内联到 `dist/index.js` 中。

**Q: 语音转码不工作？**
确认 `ffmpeg` 可用：运行 `ffmpeg -version`。或在 `wecom-kf/` 目录下执行 `npm install ffmpeg-static`。

**Q: 回调验证失败？**
检查 `token` 和 `encodingAESKey` 是否与企微后台一致，以及 Webhook URL 是否可被企微服务器访问（需公网可达）。
