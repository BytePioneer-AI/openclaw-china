
# 企业微信（客服）渠道配置指南

<div align="center">

  <p>
    <strong>⭐ 如果这个项目对你有帮助，请给我们一个Star！⭐</strong><br>
    <em>您的支持是我们持续改进的动力</em>
  </p>
</div>

本文档用于配置 OpenClaw China 的微信客服渠道（`wecom-kf`）。

仓库地址：<https://github.com/BytePioneer-AI/openclaw-china>

> 当前 `wecom-kf` 已支持基础文本对话闭环。
>
> 以下能力正在开发中，计划未来几天逐步支持：
>
> - 多账户
> - 文件收发
> - 定时任务



## 最短接入步骤

1. 在微信客服后台创建客服账号，记下 `openKfId`。
2. 在微信客服后台的“企业信息”页记下 `corpId`。
3. 在企业微信后台准备一个自建应用，并在微信客服后台把它设为“可调用接口的应用”。
4. 启动 OpenClaw Gateway，让一个公网可访问地址指向你的 `webhookPath`。
5. 在微信客服后台填写回调 URL、`Token`、`EncodingAESKey`。
6. 让回调验证通过，再点击“完成/开始使用”。
7. 回到后台获取微信客服 `corpSecret`。
8. 把 `corpSecret` 配进 OpenClaw，重启后联调。




## 一、创建客服并连接

### 1. 注册并登录企业微信

访问 <https://work.weixin.qq.com/>，按页面提示注册并进入管理后台。

![企业注册-1](../../images/wecom_register_company_step1.png)
![企业注册-2](../../images/wecom_register_company_step2.png)
![企业注册-3](../../images/wecom_register_company_step3.png)
![企业注册-4](../../images/wecom_register_company_step4.png)

### 2. 创建客服

网址：https://kf.weixin.qq.com/

请注意，我们一共需要下面这些数据：

```
"webhookPath": "/wecom-kf", # 回调路径，默认即可
"token": "xxx",
"encodingAESKey": "xxx",
"corpId": "xxx",  # 企业 ID
"corpSecret": "xxx", # 配置好API后才获取
"openKfId":"xxx"
```

#### 2.1 企业 ID

获取 `corpId`

![image-20260316213631468](../../images/image-20260316213631468.png)



#### 2.2 创建客服账号

![image-20260316213115948](../../images/image-20260316213115948.png)



#### 2.3 获取 openKfId

在客服内

![image-20260316213910127](../../images/image-20260316213910127.png)



### 3. 配置API

![image-20260316214020817](../../images/image-20260316214020817.png)

> 到这一步先不要点完成，记住 Token、EncodingAESKey。请跳转到第二步

![image-20260316214253420](../../images/image-20260316214253420.png)



## 二、安装官方 OpenClaw 与插件

### 1. 安装 OpenClaw

样例命令，或者你已经通过其他方式安装完毕

```bash
npm install -g openclaw@latest
```

### 2. 初始化网关

```bash
openclaw onboard --install-daemon
```

按向导完成基础初始化即可，渠道配置选择忽略。

### 3. 安装渠道插件

**方式一：安装聚合包（推荐）**

```bash
openclaw plugins install @xuanyue202/channels
openclaw china setup
openclaw config set gateway.bind lan
```
仅安装微信客服渠道

```bash
openclaw plugins install @xuanyue202/wecom-kf
openclaw config set gateway.bind lan
```

**方式二：从源码安装，全平台通用**

⚠️ Windows 用户注意：由于 OpenClaw 存在 Windows 兼容性问题（spawn npm ENOENT），npm 安装方式暂不可用，请使用方式二。

```bash
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
pnpm install
pnpm build
openclaw plugins install -l ./packages/channels
openclaw config set gateway.bind lan
openclaw china setup
```


## 三、配置



### 1. 除corpSecret以外的配置

> 推荐使用「配置向导」：`openclaw china setup`

```bash
openclaw config set channels.wecom-kf.enabled true
openclaw config set channels.wecom-kf.webhookPath /wecom-kf
openclaw config set channels.wecom-kf.token xxx
openclaw config set channels.wecom-kf.encodingAESKey xxx
openclaw config set channels.wecom-kf.corpId xxx
openclaw config set channels.wecom-kf.openKfId xxx
openclaw config set gateway.bind lan
```



### 2. 启动 OpenClaw

```
openclaw gateway --port 18789 --verbose
```



### 3. 点击完成

![image-20260316214852846](../../images/image-20260316214852846.png)



### 4. 获取 corpSecret

点击完成后会跳转到下面页面。获取 `corpSecret`

![image-20260316215004638](../../images/image-20260316215004638.png)



配置：

```
openclaw config set channels.wecom-kf.corpSecret xxx
```

然后重启 OpenClaw，即可实现对话。





## 四、接入

![image-20260316225233966](../../images/image-20260316225233966.png)

![image-20260316225259910](../../images/image-20260316225259910.png)





## 参数

| 字段             | 是否必需 | 说明                                     |
| ---------------- | -------- | ---------------------------------------- |
| `enabled`        | 是       | 启用渠道                                 |
| `webhookPath`    | 建议     | 回调路径，默认 `/wecom-kf`               |
| `token`          | 是       | 微信客服回调 Token                       |
| `encodingAESKey` | 是       | 微信客服回调 EncodingAESKey              |
| `corpId`         | 是       | 企业 ID                                  |
| `corpSecret`     | 是       | 微信客服 Secret，不是自建应用 Secret     |
| `openKfId        | 建议     | 客服账号 ID，对应 `open_kfid`            |
| `welcomeText`    | 否       | `enter_session` 欢迎语，当前仅支持纯文本 |



