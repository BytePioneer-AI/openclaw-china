# 🦞 OpenClaw China — China IM Channels

<p align="center">
  <strong>面向中国 IM 平台的 OpenClaw 扩展插件集合</strong>
</p>

<p align="center">
  <img alt="npm 18m downloads" src="https://raw.githubusercontent.com/BytePioneer-AI/openclaw-china-badges/main/.github/badges/npm-downloads-18m.svg" />
  <img alt="npmmirror total downloads" src="https://raw.githubusercontent.com/BytePioneer-AI/openclaw-china-badges/main/.github/badges/npmmirror-downloads-total.svg" />
  <a href="./package.json"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

OpenClaw China 为 OpenClaw 提供面向中国常用通讯平台的渠道扩展，帮助你把 AI 助手接入钉钉、企业微信、企业微信自建应用、微信客服、微信公众号、QQ 和飞书等渠道。项目聚焦稳定的消息收发、统一的插件接入面，以及尽量低门槛的配置流程。

文档目录：
<p>
  <a href="#快速开始">快速开始</a> •
  <a href="#总体架构">总体架构</a> •
  <a href="#功能支持">功能支持</a> •
  <a href="#更新日志">更新日志</a> •
  <a href="#演示">演示</a> •
  <a href="#-支持我们">💗 支持我们</a> •
  <a href="#加入交流群"><strong>加入交流群</strong></a>
</p>

> **⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐**
> 
>  您的支持是我们持续改进的动力

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
      <td align="center">简单</td>
      <td><a href="doc/guides/wecom/configuration.md">企业微信智能机器人配置指南</a></td>
    </tr>
    <tr>
      <td>企业微信（自建应用-可接入微信）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等</td>
      <td><a href="doc/guides/wecom-app/configuration.md">企业微信自建应用配置指南</a></td>
    </tr>
    <tr>
      <td>微信客服（微信客服-外部微信用户）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等</td>
      <td><a href="doc/guides/wecom-kf/configuration.md">微信客服配置指南</a></td>
    </tr>
    <tr>
      <td>微信公众号（订阅号 / 服务号 / 测试号）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等</td>
      <td><a href="doc/guides/wechat-mp/configuration.md">微信公众号配置指南</a></td>
    </tr>
    <tr>
      <td>飞书（停止维护）</td>
      <td align="center">✅ 可用</td>
      <td align="center">中等</td>
      <td>-</td>
    </tr>
  </tbody>
</table>

## 谁在使用

<p align="center">
  <strong>目前已知已有以下公司 / 团队在使用 OpenClaw China</strong>
</p>

<table align="center">
  <tbody>
    <tr>
      <td align="center" width="200">
        <img src="./doc/images/阿里云.png" alt="阿里云" height="44"><br>
        <strong>阿里云</strong>
      </td>
      <td align="center" width="200">
        <img src="./doc/images/财富云.png" alt="财富云" height="44"><br>
        <strong>财富云</strong>
      </td>
      <td align="center" width="200">
        <img src="./doc/images/火山引擎.png" alt="火山引擎" height="44"><br>
        <strong>火山引擎</strong>
      </td>
    </tr>
  </tbody>
</table>

> 本项目开源且可免费使用。
>
> 如果你的公司或团队也在使用 OpenClaw China，欢迎通过 Issue、PR、交流群或微信留下公司名称 / Logo / 使用场景，帮助我们持续维护项目，也让更多用户看到真实的落地案例。

## 功能支持

更多功能在努力开发中~

**企业微信 3 个渠道 + 微信公众号怎么选**

- `企业微信智能机器人（长连接）`：主要面向企业内部使用，支持企微内部私聊和群聊，不需要公网 IP，部署成本最低。不能接入微信。【企业内使用 | 推荐】

- `企业微信自建应用（可接入普通微信）`：可接入普通微信，不支持群聊，需要公网 IP。【个人使用 | 推荐】

- `微信客服（外部微信用户）`：适合让任意微信用户通过客服入口与企业的 OpenClaw 对话，不支持群聊，需要公网 IP。【企业外部客户使用 | 推荐】

  > 按微信客服官方入口范围，理论上还可承接视频号小店、视频号主页、直播间、微信内网页、公众号菜单、小程序、搜一搜品牌官方区、支付凭证等入口，最终都是跳转到客服对话。

- `微信公众号（订阅号 / 服务号 / 测试号）`：面向公众号粉丝的通用接入方式，支持文本消息收发。订阅号有 5 秒被动回复限制且不支持主动发送；服务号和测试号无限制，支持主动发送消息。需要公网 IP 和域名。

| 功能 | 钉钉 | 飞书 | QQ | 企业微信<br />智能机器人<br />长连接 | 企业微信自建应用<br />（可接入普通微信） | 微信客服<br />（外部微信用户） | 微信公众号 |
|------|:----:|:----:|:--:|:------------------:|:----------------:|:---------------:|:---------:|
| 文本消息 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Markdown | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 流式响应 | ✅ | - | ✅ | ✅ | ❌ | ❌ | ❌ |
| 图片/文件 | ✅  | ✅ | ✅ | ✅ | ✅ | ⚠️<br />开发中 | ⚠️<br />开发中 |
| 语音消息 | ✅ | - | ✅ | ✅ | ✅ | ⚠️<br />开发中 | ⚠️<br />开发中 |
| 私聊 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 群聊 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 多账户 | ✅ | -  | ✅ | ✅ | ✅ | ⚠️<br />开发中 | ⚠️<br />开发中 |
| 主动发送消息<br />（定时任务） | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️<br />开发中 | ⚠️<br />开发中 |

> 说明：QQ 不支持平台原生 token 级流式输出，但在私聊里配合 `replyFinalOnly=false` 与 `/verbose on` 时，assistant 过渡说明和 tool 日志会按真实生成顺序分条实时回发。
>
> `qqbot` 在 QQ 私聊里处理长 Markdown 表格时，会优先缓冲连续的结构化内容，再按“完整表头 + 完整行”安全切分；续块会自动补回表头。如果上游流式把同一行拆成几段，插件也会先在本地合并后再发送，尽量避免把半截表格直接发给 QQ。
>
> `wecom-kf` 当前已支持外部微信用户文本会话闭环和 `enter_session` 欢迎语；多账户、文件收发、定时任务仍在开发中。
>
> `wechat-mp` 当前已支持文本消息收发、slash command 透传（`CommandAuthorized=true`）、被动回复闭环、Markdown 降级（`renderMarkdown`），以及 `activeDeliveryMode` 控制的主动发送（`split` 逐条 / `merged` 合并），超长消息自动按字节限制智能分片；图片、语音、视频等全量媒体收发以及 OAuth / JS-SDK / 自定义菜单仍在规划中。

## 更新日志

<details>
<summary><strong>点击展开更新日志</strong></summary>

### 2026-03-20

- `wechat-mp` 新增 Markdown 降级功能，可通过 `renderMarkdown` 配置项控制是否将 Markdown 转换为公众号友好的纯文本格式；setup 向导同步新增降级选项。
- `wechat-mp` 新增超长消息自动分割功能，解决公众号客服消息 2048 字节限制问题：
  - 新增 `getUtf8ByteLength` 和 `splitTextByByteLimit` 工具函数
  - 优先在自然边界处分割：段落 `\n\n` → 分割线 `---` → 换行 `\n` → 句末标点 → 空格
  - 确保不截断多字节字符（中文等），分割后逐条发送
  - 新增 14 个单元测试覆盖字节计算和分割逻辑
- `wecom` 对外状态上报现在会暴露更完整的 runtime snapshot；长连接 `ws` 模式的底层 `ready` 状态也会正确映射为 `connected`，减少状态面板和探测结果误报“未连接”的情况。
- Merge PR #193：`dingtalk` 现在会向 Gateway 透传 `x-openclaw-message-channel` 与 `x-openclaw-session-key` 请求头，修复缺少渠道标识时被默认识别为 `webchat`、导致 Agent 看到错误渠道信息的问题。

### 2026-03-19

- `dingtalk` 优化了实时回复投递链路，减少处理中间消息堆积到任务结束后再集中发送的问题。
- `dingtalk` 更新了 reply dispatcher 接入方式，对齐 QQ 的实时分发思路。
- 新增 `wechat-mp` 微信公众号渠道，打通首版最小闭环：支持回调 `GET/POST` 验证、`plain / safe / compat` 三种消息模式、文本消息入站与标准化、基础事件（subscribe/unsubscribe/scan/click/view）分发、`passive` 被动回复和 `active` 主动发送 skeleton。
- `wechat-mp` 现在会把 slash command 显式标记为 `CommandAuthorized=true`，并支持 `activeDeliveryMode`：`split` 按日志 / chunk 逐条主动发送，`merged` 在 reply pipeline 结束后合并为一条主动消息；`passive` 模式仍保持单次 HTTP 回包。
- `openclaw china setup` 和统一渠道包现在已支持 `WeChat MP（微信公众号）`，可直接录入 `appId`、`appSecret`、回调 `token` / `encodingAESKey`、`messageMode`、`replyMode` 等参数，并补齐相关类型与测试。
- 发布脚本新增 `wechat-mp` 到统一发布流程。
- 新增并完善微信公众号配置指南，覆盖订阅号/服务号/测试号三种接入路径、主动发送模式说明和使用场景截图。
- `wecom-kf` 配置向导。
- 修复 workspace 依赖与版本配置问题，减少本地联调和发布时的版本错配。

### 2026-03-18

- `dingtalk` 统一了回复阶段的媒体提取与文本清理逻辑。AI Card 流式预览、最终完成卡片和普通回复现在共用同一套预处理：会先从回复文本中提取本地图片/文件、去重后单独发送，并清理残留的本地路径或 Markdown 媒体语法，减少正文夹带文件路径、重复发送媒体或预览与最终内容不一致的情况。
- `wecom` 智能机器人长连接 `ws` 模式使用平台原生 thinking 占位，体验更佳。
- Merge PR #183：强化 `wecom` 长连接关闭时的清理流程。停止或断开连接时会进入短暂的优雅关闭窗口，抑制预期的 websocket `1006` / `invalid frame` 噪声，并及时清理残留回复上下文，降低停机、重连阶段的误报和脏状态风险。
- `qqbot` 继续收紧了 QQ 私聊 Markdown 表格的安全切分。长表格现在会尽量按完整行贪心装箱，放不下下一整行时再提前断开，续块自动重复表头，减少“表头丢失”或“半行被切断”的情况。
- `qqbot` 新增结构化 Markdown 续片合并逻辑。即使上游流式输出把同一行表格拆成多段，插件也会先按列数和上下文把碎片拼回去，再统一进入安全分片，降低 `| 1-50kg | ...` 这类中间列碎片直接发出的风险。
- `qqbot` 放松了宽表自动收紧策略。默认 `auto` 安全分片仍会保留字节余量，但不再过度保守，10 列左右的长表格通常能在保持稳定渲染的前提下减少消息条数。

### 2026-03-17

- `qqbot` 优化了 QQ 私聊长思考时的 `对方正在输入中` 指示。收到 C2C 消息后会先发一次 typing，并支持通过配置切换为不续发、按空档续发或固定间隔续发。
- 同步补充文档说明：这项能力对应 QQ 平台的 typing 指示，不等同于客户端自己的临时 loading 气泡常驻；如果你希望长思考时更早给用户稳定的可见反馈，建议把 `channels.qqbot.longTaskNoticeDelayMs` 调低到 `5000` 到 `10000`。
- `wecom` 智能机器人长连接 `ws` 模式现已支持本地图片、文件、语音、视频的原生媒体发送。
- Merge PR #148：调整 `wecom` 长连接消息的占位 ACK 时机。现在只有消息真正被 OpenClaw 接收并开始分发后，才会回发 `⏳` 占位，减少“实际未受理却先显示处理中”的误导。
- `wecom` 新增内置 `wecom-doc` skill，支持创建和编辑企业微信文档、智能表格。

### 2026-03-16

- 新增 `wecom-kf` 微信客服渠道，打通首版最小闭环：支持回调 `GET/POST` 验证、`sync_msg` 拉取真实消息、外部微信用户文本消息入站、Agent 文本回复回发，以及 `enter_session` 欢迎语。
- `openclaw china setup` 和统一渠道包现在已支持 `WeCom KF（微信客服）`，可直接录入 `corpId`、微信客服 `Secret`、回调 `Token` / `EncodingAESKey`、`openKfId` 等参数，并补齐相关类型与测试。

### 2026-03-15
- `qqbot` 新增 `停止` / `/stop` 快速通道。当前任务正在执行时，这类中断命令会绕过本地排队立即发送给 OpenClaw，并丢弃同一会话里尚未处理的排队消息，减少“停不下来还继续串消息”的情况。
- `qqbot` 新增 `c2cMarkdownChunkStrategy`，默认 `markdown-block`。QQ 私聊 Markdown 现在会优先按标题、表格、引用、分割线、代码块和正文块这些安全边界切分；如需兼容旧的纯长度切分行为，可切回 `length`。

### 2026-03-14
- `qqbot` 新增私聊用户显示名别名映射 `displayAliases`。首期仅对 direct 用户生效，支持 `user:<openid>`、`<openid>`、`senderId` 等键名，方便按已有联系人信息覆盖默认显示名。
- `qqbot` 现在会优先使用 `~/.openclaw/qqbot/data/known-targets.json` 里的 `displayName` 作为私聊用户显示名；如果没有，再回退到 `displayAliases`，最后才使用稳定 ID，减少多账号和备注名场景下的识别成本。
- `qqbot` 新增内置 `qqbot-contact-send` skill，并会随插件自动注册到新会话的 `<available_skills>`。模型可直接基于 `known-targets.json` 按联系人备注/显示名解析发送对象，并默认优先使用当前会话的 `accountId` 过滤目标，降低误发给同名联系人的风险。
- `qqbot` 在 QQ 私聊里开启 `/verbose on` 且 `replyFinalOnly=false` 后，assistant 的普通过渡说明和工具日志现在都会实时发送，并按真实生成顺序交错出现，不会再出现“日志先刷完、说明最后补发”的时序错乱。

### 2026-03-13
- `qqbot` 现在能看懂 QQ 私聊里的“引用上一条消息”。用户问“这个是什么”“你刚才说的哪个文件”时，模型会一起参考被引用的那条内容来回答。
- 引用内容会自动缓存在本地 `~/.openclaw/qqbot/data/ref-index.jsonl`，就算网关重启，之前的引用关系也还能继续识别。
- 被引用的内容不只支持纯文本，也支持图片、语音、视频、文件这类消息的摘要；如果本地确实找不到旧消息，也不会再把“原始内容不可用”这种占位词喂给模型。

### 2026-03-12
- `qqbot` 在 QQ 私聊里开启 `/verbose on` 且 `replyFinalOnly=false` 后，执行过程中的工具输出和日志会边跑边发，一条一条实时出现，不会再等到最后一起发。
- 如果你保持 `replyFinalOnly=true`，行为还是和以前一样：普通过程日志不发，只发最终文本结果；但图片、语音这类媒体结果照样能正常发出。

### 2026-03-11
- `dingtalk` 默认关闭 `AI Card` 流式响应。配置默认值、入站处理和 `openclaw china setup` 向导的推荐选项已统一改为 `enableAICard=false`；如需继续使用，可再显式开启。
- `qqbot` 优化了 QQ 私聊里的 Markdown 回复，标题、引用、列表、图片这些格式更接近原文，不容易被改坏。
- 文档里补充了 `c2cMarkdownDeliveryMode` 的使用建议。如果你遇到“带表格的回复显示很乱”，直接用 `proactive-all` 会更稳。
- 现在带表格的内容默认整条一次发出，减少被 QQ 截断、拆坏格式的问题。

### 2026-03-10
- `dingtalk` 新增流式输出支持，并补齐网关认证配置。`openclaw china setup` 和钉钉接入文档现在支持录入 `channels.dingtalk.gatewayToken`；当流式调用因网关认证失败中断时，错误提示也会直接引导检查 `channels.dingtalk.gatewayToken` 或全局 `gateway.auth.token`。
- 修复 `wecom-app` 开启 `/verbose on` 后“中间过程一直不发、最后一次性刷屏”的问题。现在长任务执行时会持续回消息，能更早看到进度。
- 同步补充了 `wecom-app` 的验证步骤和排查说明，升级后更容易自查有没有生效。

### 2026-03-09
- `qqbot` 现在可以直接走标准配置流程接入和关闭，不用再自己额外拼一套配置步骤。
- `qqbot` 新增“已知目标”记录和主动发送能力。机器人见过的用户或群会被记下来，后面可以直接给指定对象主动发文字或媒体。

### 2026-03-08
- 主要：** `wecom` 智能机器人新增长连接 `ws` 模式 **，无需 IP 即可配置，并且体验更佳。【全网首发！企微官方3月8日支持长连接模式，本项目当天即支持】
- 主要：** `dingtalk` 新增多账号支持 **，完善默认账号解析、账号配置管理、监控与出站逻辑，并补充多账号测试与配置文档。
- Merge PR #131：修复入站媒体归档在跨分区移动时的 EXDEV 失败问题，避免归档后路径失效，提升共享媒体链路与 `wecom-app` 的稳定性。
- `qqbot` 增强回复可靠性与入站媒体处理，完善回复、发送与客户端链路，并补强相关测试覆盖。
- 修复 `wecom` 多账号多 Agent 场景下入站路由未透传 `accountId` 的问题，避免 `bindings.match.accountId` 失效后消息错误落到默认 Agent。

### 2026-03-07

- Merge PR #127：进一步修复心跳 ACK 上报逻辑，避免通道在无用户消息期间被错误判定为失活。
- `qqbot` 新增长任务通知能力，支持配置延迟时间，提升长耗时任务场景下的交互反馈。
- `qqbot` 支持文件上传与文件名参数，并优化媒体发送链路，补强相关测试覆盖。
- `dingtalk` 新增长任务通知，并将非 AI 回复切换为直接分发，减少回复链路复杂度。
- 文档补充腾讯云 ASR 仅支持国内网络环境的使用提示。

### 2026-03-05

- `qqbot` 在 `msg_id` 失效场景下回退使用 `event_id`，提升定时与异步回发稳定性。
- 优化定时任务稳定性：提醒类任务统一采用 sessionTarget="isolated" + 固定 delivery.channel/to/accountId，避免投递串会话。
- 强化 Cron 创建提示词：明确要求将执行期约束写入 payload.message（仅纯文本、禁止调用工具、禁止手动发送）。

### 2026-03-03

- Merge PR #101：`qqbot` 新增多账户能力，覆盖配置、连接管理与令牌缓存。
- Merge PR #89：修复 `replyFinalOnly=true` 场景下 QQ 工具媒体投递，并支持语音转换。
- Merge 分支 `pr-105`：修复 WeCom / WeCom App webhook 路由注册，并支持多个 webhook 路径。
- 发布脚本新增固定版本控制选项，并同步 README 中 WeCom 问题说明。

### 2026-03-02

- Merge PR #96：修复发送文本消息时的账号检查逻辑。
- Merge PR #95：修复 `wecom-app` 在多账户配置下的消息路由错误。
- `wecom` 渠道增强 XML 解析能力，支持更多消息类型与 CDATA 处理。
- 优化 `wecom-app` 消息发送逻辑，提升发送稳定性。

### 2026-02-28

- 修复企业微信插件异常重启循环问题，提升整体运行稳定性。

### 2026-02-26

- 新增安装提示能力，降低首次安装和排障成本。
- `openclaw china setup` 新增交互式配置向导，减少手动配置步骤。

### 2026-02-25

- Merge PR #73：`wecom-app` 支持以视频播放器形式发送 MP4 视频（`3c32173`）。
- Merge PR #65：钉钉日志补充 `userId/groupId`，便于定向投递排障（`a293250`）。

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


#### 方式一：从 npm 安装

**安装统一包（包含所有渠道）**

```bash
openclaw plugins install @openclaw-china/channels
openclaw china setup
```

**或者：安装单个渠道（不要和统一包同时安装）**

```bash
openclaw plugins install @openclaw-china/dingtalk
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/feishu-china
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/qqbot
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/wecom-app
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/wecom-kf
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/wechat-mp
openclaw china setup
```

```bash
openclaw plugins install @openclaw-china/wecom
openclaw china setup
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
openclaw china setup
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

> 推荐：优先使用「配置向导」`openclaw china setup` 完成配置。下面的 `openclaw config set ...` 为手动配置示例。

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
<summary><strong>企业微信（微信客服-外部微信用户）</strong></summary>

> 📖 **[微信客服配置指南](doc/guides/wecom-kf/configuration.md)** — 适合让外部微信用户通过客服入口与 Agent 对话

微信客服运行时使用的是微信客服 API 参数，不是普通自建应用的 `agentId` / 应用 `Secret`：

```bash
openclaw config set channels.wecom-kf.enabled true
openclaw config set channels.wecom-kf.webhookPath /wecom-kf
openclaw config set channels.wecom-kf.token your-token
openclaw config set channels.wecom-kf.encodingAESKey your-43-char-encoding-aes-key
openclaw config set channels.wecom-kf.corpId your-corp-id
openclaw config set channels.wecom-kf.corpSecret your-wecom-kf-secret
openclaw config set channels.wecom-kf.openKfId your-open-kfid
openclaw config set channels.wecom-kf.welcomeText "你好，我是 AI 客服，请问有什么可以帮你？"
```

**注意事项**

- 需要先在微信客服后台完成回调 URL 校验并点“开始使用”，通常之后才会显示微信客服 `corpSecret`
- 后台仍需要关联一个企业微信自建应用作为“可调用接口的应用”，但插件配置里不需要填写普通自建应用的 `agentId`
- 当前已支持文本入站、文本回发和 `enter_session` 欢迎语；多账户、文件收发、定时任务正在开发中

</details>

<details>
<summary><strong>微信公众号（订阅号 / 服务号 / 测试号）</strong></summary>

> 📖 **[微信公众号配置指南](doc/guides/wechat-mp/configuration.md)** — 支持订阅号、服务号和测试号

**订阅号 / 服务号 / 测试号怎么选**

| | 订阅号 | 服务号 | 测试号 |
|--|--------|--------|--------|
| **适合场景** | 个人开发者、内容推送 | 企业正式运营 | 开发调试、快速验证 |
| **回复限制** | 5 秒内必须回复 | 无时间限制 | 无时间限制（服务号权限） |
| **主动发送** | ❌ 不支持 | ✅ 客服消息接口 | ✅ 客服消息接口 |
| **推荐回复模式** | `passive` | `active` | `active` |
| **获取方式** | 微信公众平台注册 | 微信公众平台注册 + 企业认证 | [测试号申请](https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login)，扫码即用 |
| **需要公网 IP** | ✅ | ✅ | ✅ |

> **推荐**：如果没有企业认证服务号，建议先用**测试号**跑通，它拥有服务号权限且无需认证。正式上线后再切换到认证服务号。

**最小配置（plain 模式）**

```bash
openclaw config set channels.wechat-mp.enabled true
openclaw config set channels.wechat-mp.webhookPath /wechat-mp
openclaw config set channels.wechat-mp.appId wx1234567890abcdef
openclaw config set channels.wechat-mp.token your-callback-token
openclaw config set channels.wechat-mp.messageMode plain
openclaw config set channels.wechat-mp.replyMode passive
```

**推荐配置（服务号 / 测试号）**

```bash
openclaw config set channels.wechat-mp.enabled true
openclaw config set channels.wechat-mp.webhookPath /wechat-mp
openclaw config set channels.wechat-mp.appId wx1234567890abcdef
openclaw config set channels.wechat-mp.appSecret your-app-secret
openclaw config set channels.wechat-mp.token your-callback-token
openclaw config set channels.wechat-mp.encodingAESKey your-43-char-encoding-aes-key
openclaw config set channels.wechat-mp.messageMode safe
openclaw config set channels.wechat-mp.replyMode active
openclaw config set channels.wechat-mp.activeDeliveryMode split
```

**消息模式**

- `plain`：明文收发，适合调试
- `safe`：密文收发，推荐生产使用（需额外配置 `encodingAESKey`）
- `compat`：兼容模式，密文优先处理

**回复模式**

- `passive`：5 秒窗口内 HTTP 直接回包（订阅号唯一选择）
- `active`：通过客服消息 API 主动发送（服务号 / 测试号推荐，需额外配置 `appSecret`）

**主动发送模式**

- `activeDeliveryMode=split`：每个非空日志 / chunk 单独发一条消息
- `activeDeliveryMode=merged`：等待 reply pipeline 结束后合并成一条消息
- 仅 `replyMode=active` 时生效；`passive` 时始终单次 HTTP 回包

**注意事项**

- 仅支持 80 或 443 端口，需要域名或内网穿透工具将流量导向 Gateway
- 订阅号受到 5 秒回复限制，且不支持主动发送消息，必须使用 `passive` 模式
- 服务号无回复限制，推荐使用 `active` 模式以获取更完整的能力体验

**当前已实现**

- 文本消息收发（入站 + 被动回复 / 主动发送）
- 基础事件处理（关注 / 取关 / 扫码 / 菜单点击 / 菜单跳转）
- `plain / safe / compat` 三种消息加解密模式
- `passive / active` 两种回复模式
- access_token 获取、缓存、自动刷新
- 重复消息抑制（msgid 去重）

**开发中 / 规划中**

- 图片、语音、视频等全量媒体消息收发
- OAuth 网页授权
- JS-SDK
- 自定义菜单与二维码
- 模板消息
- 多账号交互式配置
- 更完整的主动发送运营能力

> 更完整说明见：`doc/guides/wechat-mp/configuration.md`

</details>

<details>
<summary><strong>QQ</strong></summary>

> 📖 **[QQ 渠道配置指南](https://github.com/BytePioneer-AI/openclaw-china/blob/main/doc/guides/qqbot/configuration.md)**

```bash
openclaw config set channels.qqbot.enabled true
openclaw config set channels.qqbot.appId your-app-id
openclaw config set channels.qqbot.clientSecret your-app-secret
openclaw config set channels.qqbot.markdownSupport true
openclaw config set channels.qqbot.c2cMarkdownDeliveryMode proactive-all
openclaw config set channels.qqbot.c2cMarkdownChunkStrategy markdown-block
openclaw config set channels.qqbot.typingHeartbeatMode idle
openclaw config set channels.qqbot.typingHeartbeatIntervalMs 5000
openclaw config set channels.qqbot.typingInputSeconds 60
openclaw config set channels.qqbot.autoSendLocalPathMedia false

# 如果你希望长思考时更早出现稳定的可见消息，可选：
openclaw config set channels.qqbot.longTaskNoticeDelayMs 5000
```

也可以直接使用一条命令完成接入：

```bash
openclaw channels add --channel qqbot --token "AppID:ClientSecret"
```

（可选）开启语音转文本（腾讯云 Flash ASR）：

```bash
openclaw config set channels.qqbot.asr.enabled true
openclaw config set channels.qqbot.asr.appId your-tencent-app-id
openclaw config set channels.qqbot.asr.secretId your-tencent-secret-id
openclaw config set channels.qqbot.asr.secretKey your-tencent-secret-key
```

如果你希望回复里保留本地证据路径文本，而不是把 `/root/.openclaw/media/qqbot/inbound/...jpeg` 自动再次作为图片发送，可设置：

```bash
openclaw config set channels.qqbot.autoSendLocalPathMedia false
```

私聊 C2C Markdown 渲染建议：

- 如果你希望 QQ 私聊尽量完整渲染标题、引用、分割线、任务列表、表格等 Markdown，建议显式开启：

```bash
openclaw config set channels.qqbot.markdownSupport true
openclaw config set channels.qqbot.c2cMarkdownDeliveryMode proactive-all
openclaw config set channels.qqbot.c2cMarkdownChunkStrategy markdown-block
```

- `c2cMarkdownDeliveryMode` 只控制私聊 Markdown 走被动发送还是主动发送：
- `passive`：整条 C2C Markdown 回复保持被动发送
- `proactive-table-only`：仅当回复里出现 Markdown 表格时，整条 C2C 回复改走主动发送
- `proactive-all`：所有 C2C Markdown 回复统一改走主动发送
- `c2cMarkdownChunkStrategy` 只控制长 Markdown 的切分方式：
- `markdown-block`：默认值。优先按标题、表格、引用、分割线、代码块、列表和正文块这些安全边界切分；`replyFinalOnly=false` 时还会先合并连续的结构化 Markdown，再把 tool/log 文本按原顺序单独发出
- `length`：回退旧行为，继续按长度直接切分
- 这套安全切分只作用于 `markdownSupport=true` 的 QQ 私聊/C2C Markdown；群聊、频道和普通文本发送保持原样

补充说明：

- QQ 私聊现在会尽量续发 QQ 平台提供的“对方正在输入中”指示，减少长任务期间完全没反馈的情况
- `typingHeartbeatMode` 控制续发策略：`none` 只发首个 typing，`idle` 只在回复空档续发，`always` 会固定间隔续发到整轮回复结束
- `typingHeartbeatIntervalMs` 和 `typingInputSeconds` 分别控制续发周期与单次 QQ typing 有效时长
- 这不等于 QQ 客户端自己的临时 loading 气泡会一直保留，那部分不是插件能完全控制的
- 如果你希望用户更早看到稳定的可见消息，优先把 `longTaskNoticeDelayMs` 调低到 `5000` 到 `10000`
- 在 QQ 私聊启用 Markdown transport（`markdownSupport=true`）后，开启 `/verbose on` 且 `replyFinalOnly=false` 时，非 final 的工具/日志输出会即时回发，一个日志一个消息
- 如果同时开启 `replyFinalOnly=true`，非 final 纯文本日志仍会被抑制，只保留最终回复；媒体类工具结果不受影响
- 如果你发现“不带表格时基本正常，但带表格后标题、引用、任务列表不稳定”，优先使用 `proactive-all`；这通常是 QQ 被动回复接口本身的渲染限制

引用消息上下文（REFIDX）：

- QQ 的引用事件通常只返回 `REFIDX_*` 索引，不直接返回被引用消息全文；`qqbot` 现在会自动从本地索引中恢复引用内容并注入 AI 上下文
- 入站和出站私聊消息中的 `ref_idx` 会自动建索引，默认落盘到 `~/.openclaw/qqbot/data/ref-index.jsonl`
- 引用恢复支持文本和媒体摘要（图片 / 语音 / 视频 / 文件）
- 如果某条历史引用在本地缓存中不存在，插件仍会保留引用关系，但不会把占位文本直接透传给模型

主动发送与已知目标：

- 已知目标默认保存到 `~/.openclaw/qqbot/data/known-targets.json`
- 旧版 `~/.openclaw/data/qqbot/known-targets.json` 会在首次访问时自动迁移到新路径
- 注册表会记录通过策略校验的 `user:` / `group:` / `channel:` 目标
- 可以直接手工编辑其中的 `displayName`，把它当成 QQ 私聊用户的正式备注
- 私聊入站显示名会优先取 `known-targets.json` 里已有的 `displayName`；如果没有，再回退到 `displayAliases`，最后才使用平台 ID
- 推荐主动发送时使用 `user:` 与 `group:` 目标

```ts
import {
  listKnownQQBotTargets,
  sendProactiveQQBotMessage,
} from "@openclaw-china/qqbot";

const targets = listKnownQQBotTargets({ accountId: "default" });

await sendProactiveQQBotMessage({
  cfg: {
    channels: {
      qqbot: {
        appId: "your-app-id",
        clientSecret: "your-app-secret",
      },
    },
  },
  to: targets[0]?.target ?? "user:your-openid",
  text: "这是一条主动发送的 QQ 消息",
});
```

如果 QQ 私聊里经常只能看到 `openid`，推荐先在 `~/.openclaw/qqbot/data/known-targets.json` 里手工补 `displayName` 作为正式备注；也可以继续在配置里补 alias：

```json
{
  "channels": {
    "qqbot": {
      "displayAliases": {
        "user:u-123456": "Alice"
      },
      "accounts": {
        "bot2": {
          "displayAliases": {
            "user:u-123456": "Alice (bot2)"
          }
        }
      }
    }
  }
}
```

QQBot 插件现在也会随包自动提供 `qqbot-contact-send` skill：

- 插件启用后，新会话会自动在 `<available_skills>` 中看到 `qqbot-contact-send`
- 不需要再把 `extensions/qqbot/skills/qqbot-contact-send` 手工复制到 workspace 或 `~/.openclaw/skills`
- 如果 workspace 或 `~/.openclaw/skills` 里存在同名 skill，仍按 OpenClaw 的正常优先级覆盖插件内置版本

</details>

<details>
<summary><strong>企业微信（智能机器人）</strong></summary>

> 📖 **[企业微信智能机器人配置指南](doc/guides/wecom/configuration.md)**

> 企业微信智能机器人推荐使用长连接 `ws` 模式，无需公网 IP

```bash
openclaw config set channels.wecom.enabled true
openclaw config set channels.wecom.mode ws
openclaw config set channels.wecom.botId your-bot-id
openclaw config set channels.wecom.secret your-bot-secret
```

**注意事项**

- 未填写 `mode` 时，默认也是 `ws`
- `botId` 和 `secret` 需要从企业微信智能机器人后台获取
- `ws` 模式现已支持本地图片、文件、语音、视频的原生媒体发送；其中图片是否走原生发送可通过 `wsImageReplyMode` 控制
- 如需旧版公网回调方式，请改用完整配置指南中的 `webhook` 模式说明

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
> ps: 此为最初版本的演示效果，当前已完美支持Markdown格式。

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

![钉钉机器人演示](doc/images/dingtalk-demo_3.png)

## 推荐项目

<details>
<summary><strong>点击展开推荐项目</strong></summary>

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

</details>


## 开发

<details>
<summary><strong>点击展开开发指南</strong></summary>

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
openclaw china setup
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
      "botId": "your-bot-id",
      "secret": "your-bot-secret"
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

</details>

<details>
<summary><strong>点击展开总体架构</strong></summary>


### 总体架构

> 当前架构分为宿主、统一通道聚合、各渠道插件和 shared 基础能力层。

```mermaid
%%{init: {"markdownAutoWrap": false, "flowchart": {"htmlLabels": false, "wrappingWidth": 1200}}}%%
flowchart TD
    %% 1. 核心宿主层 (Pill Shape)
    HOST(["🦞 OpenClaw"]):::host

    %% 2. 调度中心 (Rounded Rectangle)
    subgraph Dispatcher [" 核心调度与分发中心 "]
        direction TB
        CH("📦 @openclaw-china/channels"):::aggregate
    end

    %% 3. 插件网格 (利用子图内部布局)
    subgraph PluginGrid [" 多渠道插件生态 (Plugins) "]
        direction LR
        DT("DingTalk"):::plugin
        FE("Feishu"):::plugin
        QQ("QQBot"):::plugin
        WC("WeCom"):::plugin
        WA("WeCom App"):::plugin
    end

    %% 4. 基础设施层 (Rounded Rectangle)
    subgraph SharedLayer [" 基础设施层 (Shared) "]
        direction TB
        SH("🛠️ @openclaw-china/shared"):::shared
    end

    %% --- 核心连接逻辑 ---
    HOST ==>|Bootstrapping| CH
    CH -.->|Dynamic Registration| DT
    CH -.->|Dynamic Registration| FE
    CH -.->|Dynamic Registration| QQ
    CH -.->|Dynamic Registration| WC
    CH -.->|Dynamic Registration| WA
    DT & FE & QQ & WC & WA ==>|Dependencies| SH

    %% --- 样式定义 ---
    classDef host fill:#ebf5ff,stroke:#2563eb,stroke-width:2px,color:#1e40af,font-weight:bold
    classDef aggregate fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#166534,font-weight:bold
    classDef plugin fill:#ffffff,stroke:#64748b,stroke-width:1.5px,color:#334155
    classDef shared fill:#f8fafc,stroke:#334155,stroke-width:2px,stroke-dasharray: 5 5,color:#0f172a,font-weight:bold
    style Dispatcher fill:#f8fafc,stroke:#e2e8f0,stroke-dasharray: 5 5,color:#64748b,rx:10,ry:10
    style PluginGrid fill:#fffcf9,stroke:#fed7aa,stroke-dasharray: 5 5,color:#9a3412,rx:10,ry:10
    style SharedLayer fill:#f8fafc,stroke:#e2e8f0,stroke-dasharray: 5 5,color:#64748b,rx:10,ry:10
```

</details>

## 💗 支持我们

这是一个公益项目，感谢支持。项目由我们利用业余时间持续开发和维护，后续也会继续更新迭代并提供支持。

如果你愿意支持这个项目，**欢迎帮忙宣传**，并点亮项目**右上角的 Star**。

![Star openclaw-china](./doc/images/openclaw-china-star.gif)


## 加入交流群

对 OpenClaw 用法、插件感兴趣的可以扫码加入微信群交流。

- 安装问题可以加群询问
- 提PR时遇到开发问题加群询问
- 项目架构细节加群询问
- 插件**BUG**建议提交**issue**

**欢迎同学们一起开发~**

<img src="https://github.com/user-attachments/assets/db7b33fb-5e47-4fa5-ad87-5750536324bc" alt="二维码" width="50%" />

<img src="https://github.com/user-attachments/assets/2f31d8ad-2c30-415a-8c30-73d5449793b1" alt="二维码" width="50%" />



如果二维码过期，可以加下我微信备注说明来意：a28417416

## Star 趋势

<p align="center">
  <a href="https://www.star-history.com/#BytePioneer-AI/openclaw-china&Date">
    <picture>
      <source
        media="(prefers-color-scheme: dark)"
        srcset="https://api.star-history.com/svg?repos=BytePioneer-AI/openclaw-china&type=Date&theme=dark"
      />
      <source
        media="(prefers-color-scheme: light)"
        srcset="https://api.star-history.com/svg?repos=BytePioneer-AI/openclaw-china&type=Date"
      />
      <img
        alt="Star History Chart"
        src="https://api.star-history.com/svg?repos=BytePioneer-AI/openclaw-china&type=Date"
      />
    </picture>
  </a>
</p>

## License

MIT



