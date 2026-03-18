# 企业微信（智能机器人）渠道配置指南

<div align="center">

  <p>
    <strong>⭐ 如果这个项目对你有帮助，请给我们一个Star！⭐</strong><br>
    <em>您的支持是我们持续改进的动力</em>
  </p>
</div>

本文档用于配置 OpenClaw China 的企业微信智能机器人渠道（`wecom`）。

仓库地址：<https://github.com/BytePioneer-AI/openclaw-china>


## 一、在企业微信后台创建智能机器人

### 1. 注册并登录企业微信

访问 <https://work.weixin.qq.com/>，按页面提示注册并进入管理后台。

![企业注册-1](../../images/wecom_register_company_step1.png)
![企业注册-2](../../images/wecom_register_company_step2.png)
![企业注册-3](../../images/wecom_register_company_step3.png)
![企业注册-4](../../images/wecom_register_company_step4.png)

### 2. 创建智能机器人并开启 WebSocket API

![创建机器人-1](../../images/wecom_create_bot_step1.png)
![创建机器人-2](../../images/wecom_create_bot_step2.png)

![创建机器人-3](../../images/image-20260308222851633.png)

![image-20260308223411308](../../images/image-20260308223411308.png)


![image-20260308222753962](../../images/image-20260308222753962.png)

### 3. 机器人二维码

![image-20260308223801195](../../images/image-20260308223801195.png)



## 二、安装 OpenClaw 与插件

### 1. 安装 OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. 初始化网关

```bash
openclaw onboard --install-daemon
```

按向导完成基础初始化即可，渠道配置后面再补。

### 3. 安装渠道插件

**方式一：安装聚合包（推荐）**

```bash
openclaw plugins install @openclaw-china/channels
openclaw china setup
```
仅安装企业微信渠道

```bash
openclaw plugins install @openclaw-china/wecom
```

**方式二：从源码安装，全平台通用**

⚠️ Windows 用户注意：由于 OpenClaw 存在 Windows 兼容性问题（spawn npm ENOENT），npm 安装方式暂不可用，请使用方式二。

```bash
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
pnpm install
pnpm build
openclaw plugins install -l ./packages/channels
openclaw china setup
```


## 三、配置

本文档仅保留推荐的 `ws` 长连接方案。未填写 `mode` 时，插件默认也按 `ws` 处理。

最小可用配置如下。

### 1. `ws` 长连接模式（推荐）

适合没有固定公网 IP、只能主动访问外网的部署环境。

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.mode ws
openclaw config set channels.wecom.botId your-bot-id
openclaw config set channels.wecom.secret your-secret
```

也可以直接编辑配置：

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "ws",
      "botId": "your-bot-id",
      "secret": "your-secret"
    }
  }
}
```

可选项：

- `wsUrl`: 默认 `wss://openws.work.weixin.qq.com`
- `heartbeatIntervalMs`: 心跳间隔，默认 30000
- `reconnectInitialDelayMs`: 首次重连延迟，默认 1000
- `reconnectMaxDelayMs`: 最大重连延迟，默认 30000
- `blockStreaming`: 是否启用分块流式回复，默认 `true`
- `textChunkLimit`: 单次文本块上限，默认 `4000`
- `blockStreamingCoalesce.minChars`: 达到多少字符后优先刷新，默认 `120`
- `blockStreamingCoalesce.maxChars`: 单块聚合上限，默认 `320`
- `blockStreamingCoalesce.idleMs`: 空闲多久强制刷新，默认 `250`
- `chunkMode`: 默认 `length`；设为 `newline` 时会在段落边界更积极地刷新

流式颗粒度参数说明：

| 参数 | 默认值 | 作用 | 调大后的效果 | 调小后的效果 |
| --- | --- | --- | --- | --- |
| `blockStreaming` | `true` | 是否允许模型中间块直接往企微推送 | 关闭后只在更晚阶段出内容，体感更稳但更慢 | 开启后更容易看到中间输出 |
| `textChunkLimit` | `4000` | 单条文本消息的最大长度上限 | 单次可发更长文本，但对“更流式”帮助不大 | 会更早切块，但过小会增加消息更新次数 |
| `blockStreamingCoalesce.minChars` | `120` | 聚合至少这么多字符后更倾向立即刷新 | 更像“大段输出” | 更像“小段连续输出” |
| `blockStreamingCoalesce.maxChars` | `320` | 单块聚合的硬上限 | 每次更新更大、更少 | 每次更新更小、更频繁 |
| `blockStreamingCoalesce.idleMs` | `250` | 模型暂时停顿多久后强制刷新当前缓冲 | 更新更少、等待更久 | 更新更勤，但太小会显得抖 |
| `chunkMode` | `length` | 按长度刷出还是按换行/段落边界刷出 | `length` 更稳 | `newline` 更像“边想边打字” |

推荐调参边界：

- 如果你想要“更明显的等待中输出”，优先调小 `idleMs` 和 `maxChars`
- 如果你想避免企微里更新过于频繁，优先保留 `chunkMode=length`
- `idleMs` 不建议低于 `100`
- `maxChars` 不建议低于 `120`
- `minChars` 不建议高于 `300`，否则又会退回“大块才出字”的体感

如果你希望企业微信更像“实时打字”而不是最后一大块一起出来，推荐这组配置：

```bash
openclaw config set channels.wecom.blockStreaming true
openclaw config set channels.wecom.blockStreamingCoalesce.minChars 120
openclaw config set channels.wecom.blockStreamingCoalesce.maxChars 240
openclaw config set channels.wecom.blockStreamingCoalesce.idleMs 180
```

如果你的回复经常自然分段，还可以再打开按换行刷新的模式：

```bash
openclaw config set channels.wecom.chunkMode newline
```

两组推荐档位：

- 稳定优先
  - `chunkMode=length`
  - `blockStreamingCoalesce.minChars=120`
  - `blockStreamingCoalesce.maxChars=320`
  - `blockStreamingCoalesce.idleMs=250`
- 流式感优先
  - `chunkMode=newline`
  - `blockStreamingCoalesce.minChars=80`
  - `blockStreamingCoalesce.maxChars=180`
  - `blockStreamingCoalesce.idleMs=120`

说明：

- `length` 更稳，更新频率适中，适合作为默认值
- `newline` 更激进，只要模型开始换段就会更快推到企微
- 刷新太频繁会增加企微更新次数，不建议把 `idleMs` 压到 `100` 以下

## 四、启动并验证

调试启动（推荐先用）：

```bash
openclaw gateway --port 18789 --verbose
```

或后台启动：

```bash
openclaw daemon start
```
