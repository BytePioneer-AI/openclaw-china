/**
 * 钉钉机器人 Stream 模式测试脚本 
 */

import { DWClient, TOPIC_ROBOT, EventAck } from "dingtalk-stream";

const CLIENT_ID: string = process.env.DINGTALK_CLIENT_ID || "your_client_id_here";
const CLIENT_SECRET: string = process.env.DINGTALK_CLIENT_SECRET || "your_client_secret_here";

async function main() {
  console.log("🤖 钉钉机器人测试启动...");

  if (CLIENT_ID === "your_client_id_here") {
    console.error("❌ 请先配置环境变量");
    process.exit(1);
  }

  const client = new DWClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    try {
      const data = JSON.parse(res.data);
      
      console.log("\n" + "=".repeat(60));
      console.log("📨 收到消息!");
      console.log("=".repeat(60));
      console.log(`发送者:     ${data.senderNick} (${data.senderId})`);
      console.log(`会话类型:   ${data.conversationType === "1" ? "单聊" : "群聊"}`);
      console.log(`消息类型:   ${data.msgtype}`);
      
      // 根据消息类型解析内容
      switch (data.msgtype) {
        case "text":
          console.log(`文本内容:   ${data.text?.content}`);
          break;
          
        case "audio":
          console.log(`语音时长:   ${data.content?.duration}ms`);
          console.log(`语音识别:   ${data.content?.recognition || "[无识别结果]"}`);
          console.log(`下载码:     ${data.content?.downloadCode}`);
          break;
          
        case "picture":
          console.log(`图片下载码: ${data.content?.downloadCode}`);
          break;
          
        case "richText":
          console.log(`富文本:     ${JSON.stringify(data.content?.richText)}`);
          break;
          
        case "file":
          console.log(`文件名:     ${data.content?.fileName}`);
          console.log(`下载码:     ${data.content?.downloadCode}`);
          break;
          
        case "video":
          console.log(`视频时长:   ${data.content?.duration}ms`);
          console.log(`下载码:     ${data.content?.downloadCode}`);
          break;
          
        default:
          console.log(`未知类型，原始数据:`);
      }
      
      // 打印完整原始数据用于调试
      console.log("\n📋 完整数据:");
      console.log(JSON.stringify(data, null, 2));
      console.log("=".repeat(60) + "\n");

      return EventAck.SUCCESS;
    } catch (err) {
      console.error("❌ 处理消息出错:", err);
      return EventAck.SYSTEM_EXCEPTION;
    }
  });

  console.log("\n🚀 正在连接...\n");
  client.connect();
  console.log("✅ 已连接！发送文字/图片/语音试试\n");
}

main().catch(console.error);
