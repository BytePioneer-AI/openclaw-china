# @xuanyue202/wechat-mp

`wechat-mp` 是一个独立的微信公众号（订阅号 / 服务号）渠道插件，用于把公众号消息接入 OpenClaw。

## P0 已实现范围

- 单账号配置
- `GET` / `POST` 回调接入
- `plain / safe / compat` 基础处理边界
- `access_token` 获取、缓存、刷新
- 文本消息入站
- 基础事件（`subscribe / unsubscribe / scan / click / view`）标准化
- 统一 routing / session / buffered reply dispatch 接入
- 5 秒内 passive reply 主路径
- active outbound skeleton
- 超长消息自动分割（2048 字节限制，智能边界分割）
- Markdown 渲染与格式转换
- setup / aggregate / install hint 接线

## P1 / P2 暂未完成

- 完整媒体消息收发
- OAuth / JS-SDK / 菜单 / 二维码全量业务能力
- 多账号运行时完善
- 更完整的主动发送能力与运营接口

## 配置示例

```json
{
  "channels": {
    "wechat-mp": {
      "enabled": true,
      "webhookPath": "/wechat-mp",
      "appId": "wx1234567890abcdef",
      "appSecret": "your-app-secret",
      "token": "your-callback-token",
      "encodingAESKey": "your-43-char-encoding-aes-key",
      "messageMode": "safe",
      "replyMode": "active",
      "activeDeliveryMode": "split",
      "renderMarkdown": true,
      "welcomeText": "你好，欢迎关注。"
    }
  }
}
```

## 联调要点

1. 公众号后台把服务器地址指向你的网关回调地址。
2. `plain` 模式可先做最小链路验证；`safe/compat` 需要 `encodingAESKey`。
3. 如果需要 active outbound，必须额外配置 `appSecret`。
4. `replyMode=active` 时可用 `activeDeliveryMode` 控制主动发送行为：
   - `split`：每个日志 / chunk 单独发一条消息
   - `merged`：等待 reply pipeline 结束后合并成一条消息发送
5. `replyMode=passive` 时始终单次 HTTP 回包，`activeDeliveryMode` 不生效。
6. `renderMarkdown` 控制 Markdown 格式渲染：
   - `true`（默认）：自动将 Markdown 转换为公众号友好的纯文本格式
   - `false`：保留原始 Markdown 格式，不做转换
7. **消息长度限制**：公众号客服消息 API 有 2048 字节限制，超长消息会自动分割：
   - 优先在自然边界处分割：段落 `\n\n` → 分割线 `---` → 换行 `\n` → 句末标点 → 空格
   - 分割后的消息逐条发送，确保不截断中文字符
8. 推荐先用：

```bash
pnpm -F @xuanyue202/wechat-mp build
pnpm -F @xuanyue202/wechat-mp test
```

## 文档入口

- 开发计划：`doc/guides/wechat-mp/doc/开发计划.md`
- 配置指南：`doc/guides/wechat-mp/configuration.md`
