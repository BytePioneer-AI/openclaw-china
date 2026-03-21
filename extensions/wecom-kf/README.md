# @xuanyue202/wecom-kf

`wecom-kf` 是一个独立的微信客服渠道插件，用于把外部微信用户的客服会话接入 OpenClaw/Moltbot。

基础版范围：

- 单账号配置
- 回调 GET/POST 验证
- `sync_msg` 拉取真实消息
- `cursor` 持久化和短期 `msgid` 去重
- 客户文本消息入站
- Agent 文本回复回发
- `enter_session` 欢迎语
- 基础状态与日志

不在基础版范围内：

- 多账号运行
- 图片/语音/文件收发
- 客服账号管理、客户资料增强、第三方代运营模式

## 配置示例

```json
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      "webhookPath": "/wecom-kf",
      "token": "your-callback-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "corpId": "ww1234567890abcdef",
      "corpSecret": "your-wecom-kf-secret",
      "openKfId": "wkABCDEF1234567890",
      "welcomeText": "你好，我是 AI 客服，请问有什么可以帮你？",
      "dmPolicy": "open"
    }
  }
}
```

## 后台前置条件

1. 在微信客服管理后台开启 API。
2. 将某个自建应用配置成“可调用接口的应用”。
3. 将具体客服账号授权给该应用。
4. 确保接待成员在该应用的可见范围内。
5. 回调 URL 支持 `GET` 和 `POST`，且可被公网访问。

## 已知限制

- 微信客服回调只发通知，不直接携带完整消息体。
- 文本回发受 48 小时窗口和最多 5 条消息限制。
- 单条文本最多 2048 字节，因此插件会做纯文本降级和分片。
- 欢迎语依赖 `welcome_code`，需在事件触发后 20 秒内调用一次。
