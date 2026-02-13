# 更新内容

## 2026-02-13

### wecom-app

- 增强语音转写（ASR）能力
  - 入站 `voice` 消息优先走云端 ASR 转写。
  - 转写成功后在消息体追加识别文本（`[recognition] ...`）。
  - ASR 失败时自动回退到企业微信原生 `Recognition` 字段（若存在）。

- 增强语音发送兼容（wav/mp3 → amr）
  - 新增 `voiceTranscode.enabled` 配置。
  - 发送 `wav/mp3` 时，若检测到 `ffmpeg`，自动转码为 `amr` 再按语音发送。
  - 若无 `ffmpeg` 或转码失败，自动降级为文件发送，保证消息可达。

- 调试日志增强（含脱敏）
  - 新增通用入站日志与解密后诊断日志（敏感字段脱敏）。
  - 用于排查回调 payload 与运行态加载路径问题。

- 说明
  - 位置信息（location）能力仍在调试验证中，暂未标记为已完成能力。

- 相关代码范围
  - `extensions/wecom-app/src/monitor.ts`
  - `extensions/wecom-app/src/bot.ts`
  - `extensions/wecom-app/src/types.ts`
  - `extensions/wecom-app/src/config.ts`
  - `extensions/wecom-app/openclaw.plugin.json`
