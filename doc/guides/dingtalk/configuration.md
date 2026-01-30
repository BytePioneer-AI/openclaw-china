## 钉钉

### 1. 创建企业

不需要任何材料。

手机、电脑端操作类似：

1. 钉钉右上角点击 “创建或加入企业”

   > <img src="../../images/dingtalk_create_enterprise_button.png" alt="Create Enterprise Button" style="zoom:50%;" />

2. 选择 “企业”

3. 选择 “创建企业/团队”

4. 随便输入一些信息

   > <img src="../../images/dingtalk_enterprise_info_form.png" alt="Enterprise Info Form" style="zoom:50%;" />









### 2. 登录 [开发者平台](https://open.dingtalk.com/)

网址：https://open-dev.dingtalk.com/

点击右上角头像进行企业切换，切换到刚创建的。

<img src="../../images/dingtalk_switch_enterprise.png" alt="Switch Enterprise" style="zoom:50%;" />

### 3. 创建应用

点击主页的 “创建应用”

![Create App Button](../../images/dingtalk_create_app_button.png)

![App Type Selection](../../images/dingtalk_app_type_selection.png)

![App Creation Form](../../images/dingtalk_app_creation_form.png)

输入相关信息，点击发布

![App Publish](../../images/dingtalk_app_publish.png)



### 4. 获取 clientId / clientSecret

![Credentials](../../images/dingtalk_credentials.png)

### 5. 启用 AI Card 流式输出（可选）

在 OpenClaw 配置中显式开启：

```json
{
  "channels": {
    "dingtalk": {
      "enableAICard": true
    }
  }
}
```

说明：
- 设置 `"enableAICard": true` 后，钉钉将使用 AI Card 流式输出。
- 需要在钉钉应用权限中开通 `Card.Instance.Write` 和 `Card.Streaming.Write`。
- 如果未开启权限或不启用 AI Card，也不影响正常对话；系统会回退到普通消息，并在日志中给出权限申请指引链接。
