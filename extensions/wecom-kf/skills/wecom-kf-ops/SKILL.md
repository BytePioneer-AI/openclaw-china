---
name: wecom-kf-ops
description: 微信客服（wecom-kf）渠道运维与使用技能包。用于：定位并回发图片/语音/文件/视频；使用 saved: 稳定路径做 OCR/MCP/二次处理；规范 target 格式（wecom-kf:user:<externalUserId> / user:<externalUserId> / 裸ID / @accountId）；排查发送失败；配置入站媒体保留策略、语音转码策略与 ASR 语音识别。
---

# wecom-kf 运维/使用规范（本地技能）

本技能针对 OpenClaw + 微信客服（wecom-kf）环境提供可复用的"怎么做"步骤。

## 0) 快速判断：你要做哪一类事？

- **A. 回发媒体（图片/录音/文件/视频）**：需要拿到本地路径 + 正确的 `target`（通常 `user:<externalUserId>`）
- **B. 从消息里拿 saved: 路径做 OCR/二次处理**：使用 `saved:/.../inbound/YYYY-MM-DD/...` 的稳定路径
- **C. 修复"找不到图片/自动删除"**：检查 wecom-kf 的 `inboundMedia.keepDays/dir/maxBytes`
- **D. 语音发不出去**：优先 `.amr/.speex`，或开启 `voiceTranscode.enabled`
- **E. 语音识别不工作**：检查 `asr.enabled` 及腾讯云 ASR 凭证配置

---

## 1) target 与 replyTo（最容易踩坑）

### 1.1 target 是什么
使用 `message.send` 向 wecom-kf 发消息时，必须提供可解析 target（否则会报 `Action send requires a target.`）。

常见可用形式：
- `target: "wecom-kf:user:<externalUserId>"`
- `target: "user:<externalUserId>"`
- `target: "<externalUserId>"`（裸 ID，插件会按用户 ID 处理）
- `target: "user:<externalUserId>@<accountId>"`（多账号场景）

> **注意：** `externalUserId` 是一串由字母、数字、点、横线和下划线组成的内部 ID（匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`），绝不是用户的微信昵称。请务必使用通过事件上报（`bot.ts` / `monitor.ts`）抓取到的真实用户 ID。

### 1.2 主动发送时间窗口
企业微信客服 API 有严格的时间窗口限制：
- **用户主动发消息后 48 小时内允许主动回复，且窗口内最多 5 条。**
- 超出窗口或条数限制，企微会返回业务错误（如 45015/45047），系统无法突破。

### 1.3 事件响应消息（欢迎语）
- 使用回调事件中的 `welcome_code` 调用 `send_msg_on_event` 接口，**不受 48 小时窗口和条数限制**。
- 适用于用户进入会话、首次关注等事件场景。

### 1.4 replyTo 怎么用
- 由于微信客服为单流会话机制，通常无需指定 `replyTo` 也能回复。
- 建议带上原始 `message_id` 用于打通追踪链路，但不改变企微单流会话的展现。

### 1.5 Unknown target 怎么办（排查步骤）
若报 `Unsupported target for WeCom KF`：
1) 确认 target 格式是否合法（只支持私聊，不支持 `group:` 格式）。
2) 尝试 `wecom-kf:user:<id>` / `user:<id>` / `<id>` 三种格式。
3) 多账号时追加 `@accountId`，例如：`user:alice@default`。
4) 让对方在微信里再发一条消息，以便系统记录真实标识。
5) 从以下来源抓取真实的 `externalUserId`：
   - OpenClaw / wecom-kf 插件日志（`~/.openclaw/logs/`）
   - 或把收到消息时的原始字段/报错日志贴出来反推。

---

## 2) 媒体文件在哪里？（图片/录音/文件/视频）

### 2.1 入站媒体（推荐稳定路径）
wecom-kf 会把入站媒体归档到：
- `inboundMedia.dir/YYYY-MM-DD/`
- 默认（跨平台）：`~/.openclaw/media/wecom-kf/inbound/YYYY-MM-DD/`

消息正文会出现：
- `[image] saved:/.../inbound/YYYY-MM-DD/img_...jpg`
- `[voice] saved:/.../inbound/YYYY-MM-DD/voice_...amr`
- `[file] saved:/.../inbound/YYYY-MM-DD/file_...pdf`
- `[video] saved:/.../inbound/YYYY-MM-DD/video_...mp4`

语音 ASR 识别成功后，还会追加一行：
- `[recognition] 识别出的文字内容`

这些 saved 路径可用于：OCR、回发、复用。

### 2.2 临时目录（不建议依赖）
- `/tmp/wecom-kf-media/` 只作为下载中转，不保证长期存在。
- 文件在归档完成后会从临时目录移走或删除。

---

## 3) 回发图片/文件/录音/视频（标准做法）

### 3.1 回发图片（注意：必须是真图片格式）
使用 `message` 工具：
- `channel: "wecom-kf"`
- `target: "user:<externalUserId>"`
- `path: "<本地文件路径>"`
- `replyTo: "<message_id>"`（可选但推荐）

**格式要求（踩坑高发）：**
- 优先使用真正的图片格式：`.png` / `.jpg` / `.jpeg` / `.gif` / `.bmp` / `.webp`
- `.svg` 会被**按文件发送**，不走图片通道。
  - 若需"图片预览"：请先把 svg 转 png 再发。

### 3.2 回发录音（语音格式坑）
- **推荐格式**：`.amr` / `.speex`（企微原生支持的语音格式）
- `.wav/.mp3/.ogg/.m4a/.aac/.flac` 等非原生格式不能直接作为"语音消息(voice)"发送。

**自动兜底（语音转码）**
- 可开启 `voiceTranscode.enabled`（默认开启）：
  - 系统存在 `ffmpeg` 时：遇到非原生格式会 **自动转码为 amr** 再按 voice 发送
  - 没有 `ffmpeg` 时：会 **自动降级为 file 发送**（保证可达）
  - 若 `mediaUrl` 是远程 URL 且需要转码：会先下载到临时目录再转码

配置示例（openclaw.json）：
```jsonc
{
  "channels": {
    "wecom-kf": {
      "voiceTranscode": {
        "enabled": true,
        "prefer": "amr"
      }
    }
  }
}
```

**手动转码示例（ffmpeg）**
```bash
ffmpeg -i in.wav -ar 8000 -ac 1 -c:a amr_nb out.amr
```

### 3.3 回发视频
- 支持格式：`.mp4` / `.avi` / `.mov` / `.wmv` / `.mkv` / `.flv` / `.webm` / `.m4v`
- 和图片类似，系统会先上传为临时素材获取 `media_id` 再发送。

### 3.4 回发文件
- 任意格式的文件都可以通过 file 类型发送。
- 先写到本地文件（如 `/tmp/xxx.md`），再用 `message.send` 的 `path` 作为附件发送。

---

## 4) 发送失败的排障清单

### 4.1 `Action send requires a target`
- 说明 target 缺失：补 `target:"user:..."`.

### 4.2 `Unsupported target for WeCom KF`
- Target 格式完全无效，例如混入了空格、特殊字符或使用了 `group:` 格式。
- 必须使用 `user:<externalUserId>`，且 ID 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`。

### 4.3 `Account not configured for sending`
- 缺少 `corpId` / `corpSecret` / `openKfid` 任一项时会出现。
- 这类错误先修配置，不是 target 问题。

### 4.4 API 反馈 45015 / 45047 等企微业务报错
- 极其常见：超过 48 小时互动窗口、窗口内超过 5 条消息限制、向不存在的用户发送、或微信客服账号由于未认证/超限额被封锁。
- 此类问题为业务硬性规定，系统/Agent 无法突破。

### 4.5 图片发不出去但文件存在
- 核对文件大小是否超出渠道限制（默认 10MB）。
- 若是 inbound 归档文件：确保 OpenClaw 进程对该文件可读。

### 4.6 语音转码/发送失败
- 确认 `ffmpeg` 是否已安装且在 PATH 中。
- 如果 ffmpeg 不可用，插件会自动降级为 file 发送。
- 远程 URL 语音文件会先下载到临时目录再转码。

---

## 5) 入站媒体保留策略（产品级默认）

- `inboundMedia.keepDays`：默认 7 天（延迟清理，不会"回复后立刻删"）
- `inboundMedia.dir`：可自定义归档目录（默认 `~/.openclaw/media/wecom-kf/inbound`）
- `inboundMedia.maxBytes`：单个媒体大小限制（默认 10MB）
- `inboundMedia.enabled`：默认 `true`，设为 `false` 关闭入站媒体下载归档

要修改：编辑 `openclaw.json` 的 `channels.wecom-kf.inboundMedia`。

可复制模板：
```json
{
  "channels": {
    "wecom-kf": {
      "inboundMedia": {
        "enabled": true,
        "keepDays": 7,
        "maxBytes": 10485760
      }
    }
  }
}
```

---

## 6) ASR 语音识别配置

wecom-kf 支持腾讯云极速 ASR（Flash 模式），收到语音消息后自动转写为文字。

### 6.1 配置示例
```json
{
  "channels": {
    "wecom-kf": {
      "asr": {
        "enabled": true,
        "appId": "<腾讯云 AppId>",
        "secretId": "<SecretId>",
        "secretKey": "<SecretKey>",
        "engineType": "16k_zh",
        "timeoutMs": 10000
      }
    }
  }
}
```

### 6.2 ASR 行为
- 语音下载归档后，自动调用腾讯云 Flash ASR 接口识别。
- 识别成功：消息正文追加 `[recognition] 转写文字`。
- 识别失败：向用户回复兜底提示"当前语音功能未启动或识别失败，请稍后重试"，并附带接口错误（截断 500 字符）。
- 支持格式自动检测：amr/speex/silk/mp3/wav/ogg/m4a/aac/flac。

### 6.3 排障
- `asr.enabled` 未设为 `true`：不会触发识别。
- 缺少 `appId/secretId/secretKey` 任一项：不会触发识别。
- 识别结果为空：可能是音频质量问题或引擎类型不匹配，尝试调整 `engineType`。

---

## 7) 文本与流式发送行为（实现对齐）

- wecom-kf webhook 会先返回 stream 占位，再在后台推送最终内容。
- 推送前会做 Markdown 降级（`stripMarkdown`）：标题转为【】标记、粗体/斜体去标记、代码块缩进、列表转点号、链接展开、表格对齐、引用去前缀。
- 企业微信客服单条文本限制 2048 bytes，超出会自动按字节分段发送。

---

## 8) MCP OCR（识别图片文字）

当用户说"识别图片内容"，用 `mcporter` 调用：
- `zai-mcp-server.extract_text_from_screenshot(image_source: <saved-path>, prompt: <说明>)`

前提：必须拿到**真实存在的文件路径**（建议用 inbound saved 路径）。

---

## 9) 必要配置项速查

| 配置项 | 用途 | 必填 |
|--------|------|------|
| `token` | Webhook 回调验证 | 是（接收消息） |
| `encodingAESKey` | 消息加解密 | 是（接收消息） |
| `corpId` | 企业 ID | 是（发送消息） |
| `corpSecret` | 客服应用 Secret | 是（发送消息） |
| `openKfid` | 客服账号 ID | 是（发送消息） |
| `webhookPath` | Webhook 路径 | 默认 `/wecom-kf` |
| `dmPolicy` | 私聊策略 | 默认 `open`（可选 `pairing`/`allowlist`/`disabled`） |
| `allowFrom` | 白名单 | 当 dmPolicy 为 `allowlist` 时生效 |
| `welcomeText` | 欢迎语 | 可选 |

环境变量兜底（仅 default 账户）：
- `WECOM_KF_TOKEN` / `WECOM_KF_ENCODING_AES_KEY`
- `WECOM_KF_CORP_ID` / `WECOM_KF_CORP_SECRET` / `WECOM_KF_OPEN_KFID`
- `WECOM_KF_API_BASE_URL`

---

## 参考
- 企微客服 API 官方文档: https://developer.work.weixin.qq.com/document/path/94677
- 事件响应消息: https://developer.work.weixin.qq.com/document/path/95122
