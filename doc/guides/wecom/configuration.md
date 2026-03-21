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
openclaw plugins install @xuanyue202/channels
openclaw china setup
```
仅安装企业微信渠道

```bash
openclaw plugins install @xuanyue202/wecom
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

## 四、启动并验证

调试启动（推荐先用）：

```bash
openclaw gateway --port 18789 --verbose
```

或后台启动：

```bash
openclaw daemon start
```

