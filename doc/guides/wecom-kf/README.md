# 微信客服（WeCom KF）接入说明

## 概述

`wecom-kf` 是一个独立的 OpenClaw 渠道，用于把企业微信「微信客服」接入 OpenClaw，使外部微信用户可以通过客服入口与 Agent 对话。

需要注意的是，微信客服虽然在后台要关联一个企业微信自建应用作为“可调用接口的应用”，但它运行时使用的并不是普通自建应用消息接口那套参数模型。当前插件调用微信客服接口时，使用的是：

- `corpId`
- 微信客服 `Secret`
- 回调 `Token`
- 回调 `EncodingAESKey`
- 客服账号 `open_kfid`

而不是普通自建应用常见的：

- `agentId`
- 普通自建应用 `Secret`
- 普通应用消息回调配置

## 当前基础版支持范围

- 单账号配置
- 回调 `GET` / `POST` 校验
- 通过 `sync_msg` 拉取真实消息
- `cursor` 持久化和短期 `msgid` 去重
- 客户文本消息入站
- Agent 文本回复回发
- `enter_session` 欢迎语
- 基础状态与日志

当前不包含：

- 多账号正式运行
- 图片、语音、文件等媒体收发
- 客服账号管理、会话分配、客户画像增强、第三方代运营模式

## 如何使用新插件

### 1. 安装插件

推荐通过 OpenClaw China 聚合包安装，这样后续如果还要接入其他中国区渠道，不需要重复安装：

```bash
openclaw plugins install @xuanyue202/channels
openclaw china setup
openclaw config set gateway.bind lan
```

如果你的环境已经可以直接安装单独渠道包，也可以只装 `wecom-kf`：

```bash
openclaw plugins install @xuanyue202/wecom-kf
openclaw china setup
openclaw config set gateway.bind lan
```

如果你是在当前仓库里开发或本地联调，推荐直接从源码链接安装：

```bash
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
pnpm install
pnpm build

# 二选一：
openclaw plugins install -l ./packages/channels
openclaw plugins install -l ./extensions/wecom-kf

openclaw china setup
openclaw config set gateway.bind lan
```

说明：

- `openclaw china setup` 已支持 `WeCom KF（微信客服）`
- `gateway.bind lan` 的目的是让回调地址更容易被反向代理或内网穿透工具访问
- 如果在 Windows 上遇到 npm 安装兼容性问题，优先使用“源码链接安装”

### 2. 配置插件

推荐方式是直接运行：

```bash
openclaw china setup
```

然后在交互式向导中选择 `WeCom KF（微信客服）`，依次填写：

- `webhookPath`
- `token`
- `encodingAESKey`
- `corpId`
- `corpSecret`
- `openKfId`
- `welcomeText`（可选）

如果你不使用向导，也可以手动编辑 OpenClaw 配置文件中的 `channels.wecom-kf`，配置示例见下文。

### 3. 启动 OpenClaw Gateway

```bash
openclaw gateway --port 18789 --verbose
```

启动后，需要准备一个可以从公网访问到 OpenClaw Gateway 的地址，例如：

```text
https://your-domain.example.com/wecom-kf
```

要求：

- 回调路径必须和 `webhookPath` 一致
- 回调服务必须同时支持 `GET` 和 `POST`
- 微信客服后台保存回调配置时，会先发起一次 `GET` 验证

### 4. 在微信客服后台完成绑定

插件启动后，还需要在微信客服后台把平台配置补齐：

1. 在微信客服管理后台开启 API
2. 将某个企业微信自建应用设置为“可调用接口的应用”
3. 将具体客服账号授权给该应用
4. 确保接待成员处于该应用可见范围内
5. 配置回调 URL、`Token`、`EncodingAESKey`

其中：

- 回调 URL 填公网地址，例如 `https://your-domain.example.com/wecom-kf`
- `Token` 和 `EncodingAESKey` 必须与 OpenClaw 配置完全一致

### 5. 进行联调验证

完成配置后，建议按下面顺序验证：

1. 启动 OpenClaw Gateway
2. 用微信用户进入客服会话或发送一条文本消息
3. 观察 OpenClaw 日志里是否出现 `[wecom-kf]` 相关输出
4. 确认 OpenClaw 能够通过 `sync_msg` 拉到消息并回发文本回复

首版联调通过的最小标准是：

- 微信用户能发进来
- OpenClaw 能收到并路由给 Agent
- Agent 回复能通过微信客服接口回发给用户

### 6. 主动发送时的目标格式

如果后续需要通过 OpenClaw 的渠道发送能力直接给某个外部用户发消息，当前插件识别的目标格式是：

- `user:<external_userid>`
- `wecom-kf:user:<external_userid>`
- `user:<external_userid>@<accountId>`

基础版的核心目标标识是 `external_userid`，不是企业微信内部成员的 `userid`。

## 需要配置哪些参数

当前基础版建议至少配置以下参数：

```json
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      "webhookPath": "/wecom-kf",
      "corpId": "ww1234567890abcdef",
      "corpSecret": "your-wecom-kf-secret",
      "openKfId": "wkABCDEF1234567890",
      "token": "your-callback-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "welcomeText": "你好，我是 AI 客服，请问有什么可以帮你？",
      "dmPolicy": "open"
    }
  }
}
```

其中：

- `enabled`：是否启用该渠道
- `webhookPath`：OpenClaw 暴露的回调路径；不填时基础版默认 `/wecom-kf`
- `corpId`：企业 ID
- `corpSecret`：微信客服 `Secret`
- `openKfId`：客服账号 ID，即 `open_kfid`
- `token`：回调验签使用的 Token
- `encodingAESKey`：回调解密使用的 43 位密钥
- `welcomeText`：可选，收到 `enter_session` 事件时发送欢迎语
- `dmPolicy`：可选，控制允许哪些外部用户进入 DM 路由

## 哪些是硬要求

当前插件要进入“已配置”并注册 webhook，至少需要这些参数：

- `corpId`
- `corpSecret`
- `token`
- `encodingAESKey`

同时实际部署时还应配置：

- `webhookPath`

建议一并配置：

- `openKfId`

原因是：

- `openKfId` 用于发送消息时标识具体客服账号
- 首版冷启动拉取游标时也会优先按 `open_kfid` 建立消费位置
- 如果完全没有 `openKfId`，某些主动发送场景会失败

## 参数从哪里获取

### 1. `corpId`

来自微信客服管理后台的企业信息。

官方原始说明见：
- `doc/guides/wecom-kf/doc/kf接口文档/开发指引.md`

### 2. `corpSecret`

这里填写的是“微信客服 Secret”，不是普通自建应用 Secret。

官方文档明确写明：

- 微信客服 `Secret` 可在“微信客服管理后台 -> 开发配置”获取
- `access_token` 由企业 ID 和微信客服 `Secret` 产生
- `gettoken` 接口中的 `corpsecret` 字段说明就是“微信客服Secret”

对应原文位置：
- [开发指引](./doc/kf接口文档/开发指引.md)

### 3. `token`

这是你在微信客服后台配置回调 URL 时，自定义填写的回调签名 Token。

它的作用是：

- 校验请求是否来自微信客服
- 防止回调内容被伪造或篡改

### 4. `encodingAESKey`

这是你在微信客服后台配置回调 URL 时，自定义填写的消息加密密钥。

它的作用是：

- 解密微信客服推送过来的回调消息体

### 5. `openKfId`

这是客服账号 ID，即 `open_kfid`。

它用于：

- 作为发送消息时指定的客服账号身份
- 区分不同客服账号的消息拉取和游标

如果后续不确定具体值，可通过微信客服账号相关接口补查；但基础版接入时，建议直接在后台确认并配置。

## 为什么还要配置自建应用

这是最容易混淆的一点。

当前官方约束是：

1. 微信客服后台必须指定某个企业微信自建应用作为“可调用接口的应用”
2. 具体客服账号要授权给这个应用
3. 接待成员要在该应用的可见范围内

这说明：

- 自建应用在平台侧是授权载体
- 但插件运行时并不直接用普通自建应用的 `agentId` 或普通应用 `Secret` 调微信客服接口

换句话说：

- 后台上：需要一个自建应用承接权限
- 配置上：当前 `wecom-kf` 插件不需要额外填写普通自建应用的 `agentId`、普通应用 `Secret`
- 运行时：实际调用微信客服 API 时，使用的是 `corpId + 微信客服 Secret`

## 当前实现是否需要普通自建应用参数

当前基础版 `wecom-kf` 插件不要求填写以下字段：

- `agentId`
- 普通自建应用 `Secret`
- 普通自建应用消息回调 Token
- 普通自建应用消息回调 EncodingAESKey

原因不是这些后台对象不存在，而是它们不属于当前微信客服 API 调用所需的运行时参数。

## 后台前置条件

在代码可运行之前，还需要满足这些后台条件：

1. 企业已在微信客服管理后台开通并启用 API
2. 已将某个自建应用配置为“可调用接口的应用”
3. 具体客服账号已授权给该应用
4. 客服账号对应的接待成员处于该应用可见范围内
5. 回调服务支持 `HTTP GET` 和 `HTTP POST`
6. 回调 URL 可以被公网访问

如果这些前置条件不满足，即使本地配置完整，接口也可能无法真正收发消息。

## 已知限制

- 微信客服回调只发通知，不直接携带完整消息体
- 插件需要从回调中取出 `token` 和可选 `open_kfid`，再调用 `sync_msg`
- 文本回发受 48 小时窗口和最多 5 条消息限制
- 单条文本最多 2048 字节，因此插件会做纯文本降级和分片
- 欢迎语依赖 `welcome_code`，需在事件触发后 20 秒内调用一次

## 相关文档

- [配置说明](./configuration.md)
- [开发背景](./doc/开发背景.md)
- [开发计划](./doc/开发计划.md)
- [微信客服官方接口文档](./doc/kf接口文档/)
