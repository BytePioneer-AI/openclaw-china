# QQ 渠道配置指南
<div align="center">

  <p>
    <strong>⭐ 如果这个项目对你有帮助，请给我们一个Star！⭐</strong><br>
    <em>您的支持是我们持续改进的动力</em>
  </p>
</div>

本文档用于 QQ 开放平台机器人在 OpenClaw China 中的部署与配置。

仓库地址：<https://github.com/BytePioneer-AI/openclaw-china>  

<p align="center">
  <img src="../../images/qqbot-showcase-01.jpg" alt="QQ Bot 展示图 1" width="32%" />
  <img src="../../images/qqbot-showcase-02.jpg" alt="QQ Bot 展示图 2" width="32%" />
  <img src="../../images/qqbot-showcase-03.jpg" alt="QQ Bot 展示图 3" width="32%" />

</p>

## 一、获取 QQ 机器人凭证

### 1. 注册并登录 QQ 开放平台

访问 [QQ 开放平台](https://q.qq.com/#/register)，按提示完成注册并登录。

<p align="center"><img src="../../images/qq-register.png" alt="QQ 注册入口" width="80%" /></p>

注册完成后进入控制台，按页面指引继续。

<p align="center"><img src="../../images/qq-console.png" alt="QQ 控制台" width="80%" /></p>
<p align="center"><img src="../../images/qq-console-steps.png" alt="QQ 控制台步骤" width="80%" /></p>

### 2. 创建机器人应用

进入 [应用管理](https://q.qq.com/#/apps)，选择“机器人”类型创建应用。

<p align="center"><img src="../../images/qq-bot-entry.png" alt="机器人入口" width="80%" /></p>

创建完成后点击进入应用详情页。

### 3. 获取 AppID / AppSecret

在应用详情页获取 `AppID` 与 `AppSecret`，用于配置 OpenClaw。

<p align="center"><img src="../../images/qq-app-credentials.png" alt="AppID 与 AppSecret" width="80%" /></p>

### 4. 开通权限与添加成员

<p align="center"><img src="../../images/qq-permissions.png" alt="权限配置" width="80%" /></p>

可选：将机器人加入测试群，便于在 QQ 群中调试。

<p align="center"><img src="../../images/qq-add-to-group.png" alt="添加到群聊" width="80%" /></p>

**点击二维码，扫描后可直接进入QQ机器人对话窗口。**

![image-20260228224035048](../../images/image-20260228224035048.png)



---

## 二、安装 OpenClaw

### 1. 安装 OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. 安装 OpenClaw China 全渠道插件（方式一：npm）

```bash
openclaw plugins install @openclaw-china/channels
openclaw china setup
```


### 3. 安装 OpenClaw China 全渠道插件（方式二：从源码安装，全平台通用）

⚠️ Windows 用户注意：由于 OpenClaw 存在 Windows 兼容性问题（spawn npm ENOENT），npm 安装方式暂不可用，请使用方式二。

```bash
git clone https://github.com/BytePioneer-AI/openclaw-china.git
cd openclaw-china
pnpm install
pnpm build
openclaw plugins install -l ./packages/channels
openclaw china setup
```

更新源码（用于后续升级）：

```bash
git pull origin main
pnpm install
pnpm build
```

---

## 三、配置

### 1. 配置 QQ 渠道

> 推荐使用「配置向导」：`openclaw china setup`
>
> 如果你已经拿到 `AppID` 和 `ClientSecret`，也可以直接执行：
>
> ```bash
> openclaw channels add --channel qqbot --token "AppID:ClientSecret"
> ```

```bash
openclaw config set channels.qqbot.enabled true
openclaw config set channels.qqbot.appId your-app-id
openclaw config set channels.qqbot.clientSecret your-app-secret


# 下面这些不需要配置，默认即可
openclaw config set channels.qqbot.dmPolicy open
openclaw config set channels.qqbot.groupPolicy open
openclaw config set channels.qqbot.requireMention true
openclaw config set channels.qqbot.textChunkLimit 1500
openclaw config set channels.qqbot.replyFinalOnly false
openclaw config set channels.qqbot.c2cMarkdownDeliveryMode proactive-table-only
openclaw config set channels.qqbot.autoSendLocalPathMedia true
openclaw config set channels.qqbot.longTaskNoticeDelayMs 30000
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

如果你只是想先把 QQ 机器人跑起来，前 3 行基本就够了，后面这些配置大多数场景保持默认即可。

### 2. 配置项说明

先看最常用的：

- 必填：`enabled`、`appId`、`clientSecret`
- 通常保持默认即可：`dmPolicy`、`groupPolicy`、`requireMention`、`textChunkLimit`
- 需要调交互体验时再看：`replyFinalOnly`、`c2cMarkdownDeliveryMode`、`autoSendLocalPathMedia`、`longTaskNoticeDelayMs`

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| enabled | boolean | true | 打开或关闭 QQ 渠道 |
| appId | string | - | QQ 机器人后台里的 `AppID` |
| clientSecret | string | - | QQ 机器人后台里的 `AppSecret` |
| displayAliases | object | - | 私聊用户显示名 alias 映射。首期仅对 direct 用户生效，支持键 `user:<openid>`、`<openid>`、`senderId` |
| dmPolicy | string | "open" | 谁可以直接私聊机器人。`open` 全开放，`pairing` 只允许已配对来源，`allowlist` 只允许白名单 |
| groupPolicy | string | "open" | 群里谁可以触发机器人。`open` 全开放，`allowlist` 只允许白名单，`disabled` 直接关闭群聊处理 |
| requireMention | boolean | true | 群里是否必须先 `@` 机器人，它才回复 |
| allowFrom | string[] | [] | 私聊白名单；只有在 `dmPolicy=allowlist` 时才需要配 |
| groupAllowFrom | string[] | [] | 群聊白名单；只有在 `groupPolicy=allowlist` 时才需要配 |
| textChunkLimit | number | 1500 | 单条消息允许的最大文本长度；超出后会自动拆成多条 |
| replyFinalOnly | boolean | false | 是否只发最终答案。`false` 时，QQ 私聊配合 `/verbose on` 会把 assistant 过渡说明和 tool 日志按真实顺序实时分条回发；`true` 时不发普通中间文本，但图片、语音这类媒体结果仍可正常发送 |
| c2cMarkdownDeliveryMode | string | "proactive-table-only" | QQ 私聊里 Markdown 用什么方式发。默认只在“带表格”时切到更稳的方式；如果格式老是乱，可以改成 `proactive-all` |
| autoSendLocalPathMedia | boolean | true | 是否把回复里的本地图片路径自动当成图片发出去。关掉后，路径会原样保留在文本里 |
| longTaskNoticeDelayMs | number | 30000 | 多久还没正式回复，就先补一句“我还在处理”。设为 `0` 可关闭 |



### 2.1 引用消息上下文（REFIDX）

在 QQ 私聊里，用户经常会“引用上一条消息再追问一句”。如果平台没有把原文一并带过来，机器人就可能不知道用户在说哪一条。

现在 `qqbot` 会自动把这类被引用的历史消息找回来，再一起交给模型理解。实际效果就是：

- 用户发“这个是什么”“你刚才说的是哪个文件”这类追问时，机器人更容易答对
- 就算引用的是图片、语音、视频、文件，也会尽量恢复出可读摘要
- 这项能力默认开启，不需要额外配置开关

默认存储位置：

```text
~/.openclaw/qqbot/data/ref-index.jsonl
```

补充说明：

- 入站和出站私聊消息都会自动建立索引
- 网关重启后会从这个文件继续恢复
- 当前只支持 QQ 私聊，不处理群聊和频道里的引用
- 如果本地确实找不到那条旧消息，插件仍然知道“这是一次引用”，但不会把“原始内容不可用”这类占位词直接喂给模型


### 3. 常见场景：保留证据路径为文本

如果你希望 Agent 回复里直接显示本地证据路径，而不是把路径再次自动当成图片发送，关闭该开关即可：

```bash
openclaw config set channels.qqbot.autoSendLocalPathMedia false
```

关闭后，像下面这样的回复会保留为普通文本：

```text
证据 / 文件路径：基于你发来的图片 /root/.openclaw/media/qqbot/inbound/2026-03-09/qqbot-inbound-1773071123194-0yuqbk.jpeg
```

说明：

- `autoSendLocalPathMedia=true`：裸本地图片路径会自动作为媒体发送
- `autoSendLocalPathMedia=false`：裸本地图片路径保留为文本
- 显式 `MEDIA:` 指令仍会继续按媒体发送

### 3.1 私聊 Markdown 渲染策略

如果你发现 QQ 私聊里的标题、表格、引用块显示不稳定，可以调这个配置：

```bash
openclaw config set channels.qqbot.c2cMarkdownDeliveryMode proactive-all
```

什么时候选哪个值：

- `passive`：尽量按普通回复方式发送。如果你很在意“回复关系”而且格式本身没问题，可以用它
- `proactive-table-only`：默认值。平时按普通方式发，只有检测到表格时才切到更稳的方式
- `proactive-all`：所有私聊 Markdown 都走更稳的方式发。如果你经常遇到标题、引用、分割线、表格显示不对，优先试这个

### 3.2 私聊实时回发语义

- 默认 `replyFinalOnly=false` 时，QQ 私聊里的 assistant 过渡说明和 tool/verbose 日志都会实时发出，并按真实生成顺序交错出现
- 你应该看到“说明 -> 日志 -> 说明 -> 日志”这类自然交错，而不是所有日志先发完、最后再补说明
- 如果你把 `replyFinalOnly=true` 打开，普通中间文本就不发了，只保留最终答案；媒体结果不受影响
- 这套实时回发语义当前只覆盖 QQ 私聊/C2C，群聊和频道仍保持现有行为

### 3.3 验证 `/verbose on` 实时输出

建议在升级后做一次快速自检：

1. 在 QQ 私聊里发送 `/verbose on`
2. 再发送一个会触发工具调用、长任务或文件处理的请求
3. 观察回包是否符合预期

预期结果：

- `replyFinalOnly=false`：assistant 过渡说明、verbose/tool 日志都会按处理过程逐条回发，顺序和实际生成顺序一致
- 你会看到说明消息和工具日志自然交错，而不是“工具日志先刷完，说明类消息最后补发”
- 最终答复仍会单独发送，不会把前面的日志重新合并
- `replyFinalOnly=true`：非 final 纯文本日志不会单独发送，但媒体类工具结果仍可投递

### 4. 多账户配置

如需配置多个 QQ 机器人，可以使用 `accounts` 对象（键为账户 ID）：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "defaultAccount": "bot1",
      "accounts": {
        "bot1": {
          "name": "主机器人",
          "appId": "1234567890",
          "clientSecret": "secret-1",
          "displayAliases": {
            "user:u-alice": "Alice"
          },
          "markdownSupport": true,
          "dmPolicy": "open",
          "groupPolicy": "open",
          "autoSendLocalPathMedia": false
        },
        "bot2": {
          "name": "备用机器人",
          "appId": "0987654321",
          "clientSecret": "secret-2",
          "markdownSupport": false
        }
      }
    }
  }
}
```

> 提示：
> - 顶层配置（如 `enabled`、`dmPolicy`）作为默认值，账户内配置会覆盖顶层配置。
> - `defaultAccount` 指定默认使用的账户 ID，不配置时默认为 `"default"`。
> - 账户内未指定的字段会继承顶层配置。
> - `displayAliases` 也是同样的规则；同一个 alias key 同时出现在顶层和账户内时，以账户内为准。
> - 已知目标、引用缓存等本地数据也会按 `accountId` 分开记录，避免多个机器人串数据。

多 agent 分流（bindings）示例：
```json
{
  "bindings": [
    { "agentId": "main", "match": { "channel": "qqbot", "accountId": "bot1" } },
    { "agentId": "work", "match": { "channel": "qqbot", "accountId": "bot2" } }
  ]
}
```
> 说明：如果只用默认 `main`，可以不配置 `bindings`；多账号分流到不同 agent 时必须配置。

---

## 四、启动服务

调试模式（建议先用这个，方便看日志）：

```bash
openclaw gateway --port 18789 --verbose
```

后台运行：

```bash
openclaw daemon start
```

---

## 五、能力与限制

- 支持文本消息、图片、语音和部分文件能力；其中私聊能力比群聊更完整
- QQ 官方接口对媒体能力本身有限制，尤其是群聊和频道，所以有些文件类型会自动降级成“文本提示 + 链接/路径”
- 频道消息暂不支持直接发媒体，会退回成文本 + URL
- QQ 本身不支持真正的平台级 token 流式输出；但在私聊里可以通过多条消息的方式，把 assistant 过渡说明和工具过程实时交错发出来
- 私聊支持识别“引用上一条消息”，引用内容默认从 `~/.openclaw/qqbot/data/ref-index.jsonl` 恢复
- 定时提醒直接走 OpenClaw 自带 cron，不需要额外接别的服务
- 插件会自动记录通过策略校验的已知用户/群，方便后面主动发送时直接复用

## 六、主动发送与已知目标

`qqbot` 现在支持主动发送，也就是不一定非要等用户先发消息，你也可以按目标主动发给某个用户或群。

### 1. 已知目标注册表

- 默认存储文件：`~/.openclaw/qqbot/data/known-targets.json`
- 旧版 `~/.openclaw/data/qqbot/known-targets.json` 会在首次访问时自动迁移到新路径
- 机器人见过、并且通过策略校验的用户或群，会自动记录到这里
- 多账号场景会按 `accountId` 分开记录
- 你可以手工编辑其中的 `displayName`，把它当成 QQ 私聊用户的正式备注源
- 私聊用户的 `displayName` 会优先使用 `known-targets.json` 里已有的 `displayName`；如果没有，再回退到 `displayAliases`，最后使用 `openid/senderId`
- 目标格式如下：
  - 私聊用户：`user:<c2cOpenid>`
  - QQ 群：`group:<group_openid>`
  - QQ 频道：`channel:<channel_id>`
- 真正用于主动发送时，优先使用 `user:` 和 `group:`；`channel:` 目前主要用于展示和发现

### 2. 查询已知目标

```ts
import { listKnownQQBotTargets } from "@openclaw-china/qqbot";

const targets = listKnownQQBotTargets({ accountId: "default" });
console.log(targets);
```

返回项结构如下：

```ts
interface KnownQQBotTarget {
  accountId: string;
  kind: "user" | "group" | "channel";
  target: string;
  displayName?: string;
  sourceChatType: "direct" | "group" | "channel";
  firstSeenAt: number;
  lastSeenAt: number;
}
```

### 3. 主动发送消息

```ts
import { sendProactiveQQBotMessage } from "@openclaw-china/qqbot";

const cfg = {
  channels: {
    qqbot: {
      appId: "your-app-id",
      clientSecret: "your-app-secret",
    },
  },
};

await sendProactiveQQBotMessage({
  cfg,
  to: "user:your-openid",
  text: "这是一条主动发送的 QQ 消息",
});

await sendProactiveQQBotMessage({
  cfg,
  to: "group:your-group-openid",
  text: "附件已生成",
  mediaUrl: "https://example.com/report.png",
});
```

> 说明：
> - 这里调用的是和日常回复同一套发送链路，所以文本和媒体行为保持一致
> - 当前不提供“给全部已知目标群发”的能力，避免误操作造成批量发送

---

## 七、内置 Skill（自动加载）

`qqbot` 插件现在会随包提供插件级 skill：`qqbot-contact-send`。

- 目录位置：`extensions/qqbot/skills/qqbot-contact-send`
- 只要 `qqbot` 插件处于启用状态，新会话就会自动把这个 skill 加入 `<available_skills>`
- 无需再把该目录手工复制到 `<workspace>/skills` 或 `~/.openclaw/skills`
- 如果 workspace 或全局技能目录里已经有同名 skill，仍按 OpenClaw 默认优先级覆盖插件内置版本

这个 skill 主要用于：

- 基于 `~/.openclaw/qqbot/data/known-targets.json` 按联系人名解析 QQBot 发送目标
- 默认优先使用当前会话的 `accountId` 过滤联系人，降低多账号误发风险
- 生成可直接传给 `message` tool 的发送参数

如果你刚安装或升级了插件但还没看到该 skill，建议：

1. 确认 `qqbot` 插件已启用
2. 新开一个会话，或重启一次 gateway

---

## 八、可选操作：开启语音转文本

如果你希望 QQ 语音消息可以自动转文字后再交给 Agent 处理，可按下面步骤配置腾讯云 ASR（录音文件识别极速版）。

> [!IMPORTANT]
> 当前 QQ 渠道的腾讯云 ASR 仅支持国内网络下启用。

### 1. 开通 ASR 服务

访问腾讯云语音识别产品页并点击“立即使用”：  
https://cloud.tencent.com/product/asr

说明：腾讯云 ASR 提供每月免费额度（以腾讯云控制台最新计费规则为准），额度如下：
- 录音文件识别极速版（`asr/flash/v1`）：5 小时/月

![qq-asr-free-quota](../../images/qq-asr-free-quota.png)

### 2. 创建 API 密钥

进入腾讯云控制台语音识别页（或对应 API 密钥管理页）创建密钥，获取：
- `appId`
- `secretId`
- `secretKey`

控制台入口：  
https://console.cloud.tencent.com/asr

![qq-asr-console-entry](../../images/qq-asr-console-entry.png)

![qq-asr-api-keys](../../images/qq-asr-api-keys.png)

### 3. 在 OpenClaw 中配置

```bash
openclaw config set channels.qqbot.asr.enabled true
openclaw config set channels.qqbot.asr.appId your-tencent-app-id
openclaw config set channels.qqbot.asr.secretId your-tencent-secret-id
openclaw config set channels.qqbot.asr.secretKey your-tencent-secret-key
```





### 4. 计费文档

请仔细查看腾讯云计费文档。

https://cloud.tencent.com/document/product/1093/35686?from=console_document_search#58abe873-a924-4b4d-b056-59510b66c4d3

![qq-asr-pricing-doc](../../images/qq-asr-pricing-doc.png)
