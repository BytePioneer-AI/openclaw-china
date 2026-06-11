---
name: wecom-app-ops
description: 企业微信自建应用（wecom-app）运维与使用技能包。用于：定位并回发图片/语音/文件；使用 saved: 稳定路径做 OCR/MCP/二次处理；规范 target（wecom-app:user:xxx / user:xxx / 裸ID / @accountId）；排查发送失败；配置入站媒体保留策略与语音转码策略。
---

# wecom-app 运维/使用规范（本地技能）

本技能针对你这套 OpenClaw + 企业微信自建应用（wecom-app）环境，提供可复用的“怎么做”步骤。

## 0) 快速判断：你要做哪一类事？

- **A. 回发媒体（图片/录音/文件）**：需要拿到本地路径 + 正确的 `target`（通常 `user:<name>`）
- **B. 从消息里拿 saved: 路径做 OCR/二次处理**：使用 `saved:/.../inbound/YYYY-MM-DD/...` 的稳定路径
- **C. 修复“找不到图片/自动删除”**：检查 wecom-app 的 `inboundMedia.keepDays/dir/maxBytes`
- **D. 语音发不出去**：优先 `.amr/.speex`，或开启 `voiceTranscode.enabled`

---

## 1) target 与 replyTo（最容易踩坑）

### 1.1 target 是什么
使用 `message.send` 向 wecom-app 主动发消息时，必须提供可解析 target（否则会报 `Action send requires a target.`）。

常见可用形式（以本环境为准）：
- `target: "wecom-app:user:<userId>"`
- `target: "user:<userId>"`
- `target: "<userId>"`（裸 ID，插件会按用户 ID 处理）
- `target: "user:<userId>@<accountId>"`（多账号场景）

> 注意：当前 wecom-app 出站实现以用户私聊为主，运维侧不要依赖 `chatid:<id>` 作为通用 target 格式。

### 1.2 replyTo 怎么用
- 如果你要“回复当前对话”，优先使用消息的 `message_id` 作为 `replyTo`。
- `replyTo` 不是 target；target 仍然要填。

### 1.3 Unknown target 怎么办（排查步骤）
- 显示名（比如 `CaiHongYu`）不一定能被解析。
- 优先尝试：`target: "user:CaiHongYu"`

若仍报 `Unknown target`：
1) 先确认是 **私聊** 还是 **群聊**：
  - 私聊：使用 `user:<userId>`（推荐）
  - 群聊：本技能默认不走该路径（请先确认插件是否已实现对应目标解析）
2) 让对方（或你自己）在企业微信里再发一条消息（任意内容），以便系统记录真实标识。
3) 从以下任意来源抓取真实的 `userId/chatId`：
   - OpenClaw / wecom-app 插件日志（`~/.openclaw/logs/`）
   - 或把“收到消息时的原始字段/报错日志”贴出来，我来反推。
4) 拿到真实值后再发：
  - `target: "user:<userId>"`（或 `wecom-app:user:<userId>`）

---

## 2) 媒体文件在哪里？（图片/录音/文件）

### 2.1 入站媒体（推荐稳定路径）
wecom-app 现在会把入站媒体归档到：
- `inboundMedia.dir/YYYY-MM-DD/`
- 默认（跨平台）：`~/.openclaw/media/wecom-app/inbound/YYYY-MM-DD/`

消息正文会出现：
- `[image] saved:/.../inbound/YYYY-MM-DD/img_...jpg`
- `[voice] saved:/.../inbound/YYYY-MM-DD/voice_...amr`

这条 saved 路径用于：OCR、回发、复用。

### 2.2 临时目录（不建议依赖）
- `/tmp/wecom-app-media/` 只作为下载中转，不保证长期存在。
- Windows 也同理：临时目录仅中转，不作为业务引用路径。

---

## 3) 回发图片/文件/录音（标准做法）

### 3.1 回发图片（注意：必须是真图片格式）
使用 `message` 工具：
- `channel: "wecom-app"`
- `target: "user:<name>"`
- `path: "<本地文件路径>"`
- `replyTo: "<message_id>"`（可选但推荐）

**格式要求（踩坑高发）：**
- 优先使用真正的图片格式：`.png` / `.jpg` / `.jpeg`
- `.svg` 在企业微信里通常不会按“图片消息”展示。
  - 新版本插件会把 `.svg` **按文件发送**，避免误走图片通道。
  - 若你需要“图片预览”：请先把 svg 转 png 再发（可选工具：`rsvg-convert` / ImageMagick `convert` / 或用脚本生成 PNG 兜底）。

### 3.2 回发录音（语音格式坑）
- **推荐格式**：`.amr`（你收到的入站语音也通常是 amr）
- `.wav/.mp3` 在企业微信自建应用里经常无法作为“语音消息(voice)”发送。

**自动兜底（新功能）**
- 你可以开启 `voiceTranscode.enabled=true`：
  - 系统存在 `ffmpeg` 时：遇到 wav/mp3 会 **自动转码为 amr** 再按 voice 发送
  - 没有 `ffmpeg` 时：会 **自动降级为 file 发送**（保证可达）
  - 若 `mediaUrl` 是远程 URL，当前实现会直接走 file 降级（不做“下载后再转码”）

配置示例（openclaw.json）：
```jsonc
{
  "channels": {
    "wecom-app": {
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

- 其他流程同图片。

### 3.3 回发 README/文本为“文件形式”
- 先写到临时文件（如 `/tmp/xxx.md`）
- 再用 `message.send` 的 `path` 作为附件发送。

---

## 4) 发送失败的排障清单

### 4.1 `Action send requires a target`
- 说明 target 缺失：补 `target:"user:..."`。

### 4.2 `Unknown target` / 发送 ok=false
- 优先确认 target 是否能解析（`user:<name>` vs 内部 id）。
- 尝试 `wecom-app:user:<id>` / `user:<id>` / `<id>` 三种格式。
- 多账号时追加 `@accountId`，例如：`user:alice@default`。
- 检查附件路径是否存在（文件是否被清理）。

### 4.3 `Account not configured for active sending`
- 缺少 `corpId` / `corpSecret` / `agentId` 任一项时会出现。
- 这类错误先修配置，不是 target 问题。

### 4.4 图片发不出去但文件存在
- 核对文件大小是否超出渠道限制。
- 若是 inbound 归档文件：确保 OpenClaw 进程对该文件可读。

---

## 5) 入站媒体保留策略（产品级默认）

- `inboundMedia.keepDays`：默认 7 天（延迟清理，不会“回复后立刻删”）
- `inboundMedia.dir`：可自定义归档目录
- `inboundMedia.maxBytes`：单个媒体大小限制（默认 10MB）

要修改：编辑 `openclaw.json` 的 `channels.wecom-app.inboundMedia`。

可复制模板：
```json
{
  "channels": {
    "wecom-app": {
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

## 6) 文本与流式发送行为（实现对齐）

- wecom-app webhook 会先返回 stream 占位，再在后台推送最终内容。
- 推送前会做 Markdown 降级（`stripMarkdown`）。
- 企业微信单条文本限制 2048 bytes，超出会自动分段发送。

---

## 7) Block Streaming：显示中间 Assistant Text（流式中间块）

### 7.1 默认行为：只显示最终结果
默认情况下（不配置本节参数），wecom-app **只会在 Agent 完成后一次性推送最终回复**。  
即使模型在生成过程中产生了多段“中间文本”，用户也看不到这些中间块。

原因：
- `blockStreamingDefault` 默认未开启或走框架默认策略；
- 即使开启 block streaming，若 `blockStreamingBreak` 与模型事件节奏不匹配、chunk/coalesce 阈值偏大，也可能表现为“只看到最终一条”。

### 7.2 开启中间块显示
若希望企微**逐步展示**正在生成的中间内容（一条一条实时显示），需要在 `openclaw.json` 的 `agents.defaults` 下配置：

```jsonc
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "message_end",
      "blockStreamingChunk": {
        "minChars": 80,
        "maxChars": 800,
        "breakPreference": "newline"
      },
      "blockStreamingCoalesce": {
        "minChars": 40,
        "maxChars": 800,
        "idleMs": 1000
      }
    }
  }
}
```

#### 参数说明

| 参数 | 含义 | 默认值 |
|---|---|---|
| `blockStreamingDefault` | 是否启用 block 流式输出 | `"off"` |
| `blockStreamingBreak` | 刷新时机：`"text_end"` 每段文本结束刷一次；`"message_end"` 整条消息结束刷一次 | `"text_end"` |
| `blockStreamingChunk.minChars` | 单个候选块最小字符数（不到这个长度倾向继续缓冲） | `800` |
| `blockStreamingChunk.maxChars` | 单个候选块最大字符数（超过强制切开） | `1200` |
| `blockStreamingChunk.breakPreference` | 切分偏好：`paragraph` / `newline` / `sentence` | `"paragraph"` |
| `blockStreamingCoalesce.minChars` | 合并器最小缓冲字符数 | `800` |
| `blockStreamingCoalesce.maxChars` | 合并后最大字符数（受 chunk.maxChars 约束） | `1200` |
| `blockStreamingCoalesce.idleMs` | 合并器空闲等待时间(ms)，超时无新内容则刷出 | `1000` |

#### 推荐配置（稳定优先）
```jsonc
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "message_end",
      "blockStreamingChunk": { "minChars": 80, "maxChars": 800, "breakPreference": "newline" },
      "blockStreamingCoalesce": { "minChars": 40, "maxChars": 800, "idleMs": 1000 }
    }
  }
}
```

#### 更灵敏配置（更多中间块，但更碎）
把阈值调小、idle 调低即可（适合调试/体验）：

- `blockStreamingChunk.minChars`: `40~80`
- `blockStreamingCoalesce.idleMs`: `150~300`

### 7.3 常见现象

- **完全看不到中间块**：先确认 `blockStreamingDefault: "on"` 且服务已重启；其次检查 `canSendActive`（需配齐 corpId/corpSecret/agentId）。
- **消息乱序（后发先至）**：当前插件已实现按 target 全局串行发送队列，同一用户的消息应有序；若仍乱序，通常是网络侧抖动或企业微信客户端渲染顺序问题。
- **只收到最后一条**：可能是 `coalesce.idleMs` 偏大 + 模型输出很快（所有内容在一个 message_end 内合并发出）；可降低 idleMs 或改 `breakPreference: "text_end"` 提高刷新频率。

---

## 8) MCP OCR（识别图片文字）

当用户说“记得调用 mcp 识别图片”，用 `mcporter` 调用：
- `zai-mcp-server.extract_text_from_screenshot(image_source: <saved-path>, prompt: <说明>)`

前提：必须拿到**真实存在的文件路径**（建议用 inbound saved 路径）。

---

## 参考
- 详细示例与常用模板见：`references/wecom-app-examples.md`
