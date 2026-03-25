# OpenClaw-China 新渠道插件接入准备

## 1. 目的

本文基于当前仓库的两个真实实现做总结：

- 单渠道插件：`extensions/qqbot`
- 全渠道聚合包：`packages/channels`

目标不是重复介绍 QQ Bot 业务细节，而是回答这两个更重要的问题：

1. 一个渠道插件自身要如何接入 OpenClaw/Moltbot 风格的宿主。
2. 一个已经完成的渠道插件，要如何再接入 `@openclaw-china/channels` 这个全渠道聚合包。

结论先说：

- `qqbot` 是真正可独立安装的渠道插件。
- `packages/channels` 不是第二套渠道实现，只是一个“聚合注册器”。
- 所以后续新增一个渠道时，要分两步做：
  - 先把 `extensions/<channel-id>` 做成可单独工作的插件。
  - 再把它挂到 `packages/channels` 里，交给聚合包按配置启用。

## 2. QQ 插件自身如何接入宿主

### 2.1 静态声明层

`extensions/qqbot` 有两类关键声明文件。

第一类是 `extensions/qqbot/openclaw.plugin.json`：

- `id: "qqbot"`
- `channels: ["qqbot"]`
- `skills: ["./skills"]`
- `configSchema`

这个文件的作用是让宿主在不执行插件代码的情况下，先知道：

- 这是哪个插件
- 它提供哪个渠道
- 它带哪些 skills
- 它接受什么配置结构

第二类是 `extensions/qqbot/package.json`：

- 包名是 `@openclaw-china/qqbot`
- `openclaw.extensions` / `moltbot.extensions` / `clawdbot.extensions` 都指向 `./dist/index.js`
- 三套元数据里都声明了 `channel.id = "qqbot"`
- 三套元数据里都声明了安装方式 `install.npmSpec = "@openclaw-china/qqbot"`

这说明当前仓库采用的是“三宿主兼容”做法：同一个渠道包同时服务 `openclaw`、`moltbot`、`clawdbot`。

### 2.2 运行时入口层

`extensions/qqbot/index.ts` 是插件真正的入口。

现在它已经切到新版 OpenClaw SDK 入口 helper，职责也更清晰：

1. 导出 `qqbotPlugin` 和相关工具函数，方便单独引用。
2. 通过 `defineChannelPluginEntry(...)` 统一注册 `qqbotPlugin`。
3. 通过 `setRuntime` 把宿主 runtime 注入到插件内部 runtime store。
4. 在 `registerFull(api)` 中注册 `registerChinaSetupCli(api, { channels: ["qqbot"] })` 和 `showChinaInstallHint(api)`。
5. 通过新增的 `setup-entry.ts` 提供 setup-only 轻量入口。

其中真正把渠道接进宿主渠道系统的动作，已经变成由 SDK helper 统一完成：

```ts
export default defineChannelPluginEntry({
  plugin: qqbotPlugin,
  setRuntime: (runtime) => setQQBotRuntime(runtime as unknown as PluginRuntime),
  registerFull(api) {
    registerChinaSetupCli(api, { channels: ["qqbot"] });
    showChinaInstallHint(api);
  },
});
```

同时 `extensions/qqbot/setup-entry.ts` 会导出 `defineSetupPluginEntry(qqbotSetupPlugin)`，让 setup 流程不再提前加载 gateway-heavy runtime。

### 2.3 ChannelPlugin 层

`extensions/qqbot/src/channel.ts` 定义了宿主真正消费的 `qqbotPlugin`。

当前 `qqbotPlugin` 已实现这些能力面：

- `meta`
- `capabilities`
- `messaging`
- `configSchema`
- `reload`
- `setupWizard`
- `config`
- `security`
- `setup`
- `actions`
- `pairing`
- `outbound`
- `gateway`

这说明一个新渠道插件至少不只是“能发消息”就够了。在这个仓库里，更合理的目标是直接把渠道建成一个完整的 `ChannelPlugin` 适配器。

另外，`qqbot` 现在也按新版模式拆成了三层：

- `src/channel.shared.ts`：轻量 shared surface
- `src/channel.setup.ts`：setup-only surface
- `src/channel.ts`：full runtime surface

### 2.4 runtime 桥接层

`extensions/qqbot/src/runtime.ts` 现在改成了官方 `createPluginRuntimeStore(...)`，而不是手写 module-level 单例。

它仍然保留了 QQ Bot 本地需要的 runtime 兼容面，但 runtime 的存储和初始化路径已经对齐 OpenClaw SDK：

- `setQQBotRuntime(next)`
- `getQQBotRuntime()`

也就是说，QQ Bot 现在是“官方 runtime store + 本地兼容类型扩展”，而不是完全手写的 runtime 桥。

当前 `qqbot` 主要依赖宿主 runtime 的这些能力：

- `channel.routing`
- `channel.session`
- `channel.reply`
- `channel.text`
- `system.enqueueSystemEvent`

设计重点仍然是：

- 插件不直接依赖宿主内部源码路径。
- 插件只缓存自己实际需要的 runtime 能力。
- 对 setup-only 生命周期和 full-runtime 生命周期使用同一套 runtime 注入入口。

### 2.5 配置与多账户约定

`extensions/qqbot/src/config.ts` 体现了当前仓库新增渠道时应该沿用的配置模型：

```text
channels.<id>
├── 顶层共享配置
├── defaultAccount
└── accounts.<accountId>
```

对 `qqbot` 来说就是：

```text
channels.qqbot
├── enabled
├── appId
├── clientSecret
├── ...
├── defaultAccount
└── accounts.<accountId>
```

多账户相关 helper 也已经形成固定模式：

- `DEFAULT_ACCOUNT_ID = "default"`
- `listQQBotAccountIds(cfg)`
- `resolveDefaultQQBotAccountId(cfg)`
- `mergeQQBotAccountConfig(cfg, accountId)`
- `resolveQQBotCredentials(config)`

后续新插件建议直接复用这套思想，不要另起一套账户模型。

## 3. QQ 插件如何接入全渠道聚合包

`packages/channels` 对 `qqbot` 的接入本质上是“注册聚合”，不是“逻辑复写”。

### 3.1 先作为依赖接进来

`packages/channels/package.json` 里显式依赖：

```json
"@openclaw-china/qqbot": "2026.3.9-1"
```

这一步的含义很直接：

- 聚合包要先能安装到 `qqbot`
- 才能在入口文件里 import 它

所以以后新增一个插件，第一件同步事项就是把它加到聚合包依赖中。

### 3.2 再把渠道 id 写进聚合包清单

`packages/channels/openclaw.plugin.json` 当前声明：

- `id: "channels"`
- `channels: ["dingtalk", "feishu-china", "wecom", "wecom-app", "qqbot"]`

这里的意义是：

- 宿主把 `@openclaw-china/channels` 当作一个插件包加载时
- 它会知道这个包可以提供哪些 channel id

所以以后新增一个渠道时，聚合包清单也必须补上新 channel id。

### 3.3 在聚合入口里导入“命名导出 + 默认入口”

`packages/channels/src/index.ts` 对 `qqbot` 做了两种导入：

```ts
import {
  qqbotPlugin,
  DEFAULT_ACCOUNT_ID as QQBOT_DEFAULT_ACCOUNT_ID,
  setQQBotRuntime,
  getQQBotRuntime,
} from "@openclaw-china/qqbot";
import qqbotEntry from "@openclaw-china/qqbot";
```

两者分工不同：

- 命名导入：用于重新导出给外部使用。
- 默认导入：用于在聚合包内部直接调用 `qqbotEntry.register(api)`。

这是后续新插件接入聚合包时最应该照搬的模式。

### 3.4 在聚合包里重新导出能力

`packages/channels/src/index.ts` 会把 `qqbot` 的公开能力继续导出，例如：

- `qqbotPlugin`
- `QQBOT_DEFAULT_ACCOUNT_ID`
- `setQQBotRuntime`
- `getQQBotRuntime`
- `QQBotConfig`
- `ResolvedQQBotAccount`
- `QQBotSendResult`

这样做的结果是：

- 用户安装 `@openclaw-china/channels` 后
- 仍然可以通过聚合包访问具体子插件的类型和工具函数

所以新增一个插件时，通常也应把它的公开类型与核心工具一起透传出来。

### 3.5 把新渠道纳入聚合包自己的配置视图

`packages/channels/src/index.ts` 里定义了：

- `MoltbotConfig`
- `SUPPORTED_CHANNELS`
- `channelPlugins`

`qqbot` 接入时实际要改的是这三处：

1. 在 `MoltbotConfig.channels` 下增加 `qqbot?: ChannelConfig`
2. 在 `SUPPORTED_CHANNELS` 中加入 `"qqbot"`
3. 在 `channelPlugins` 映射里增加：

```ts
qqbot: {
  register: (api) => {
    qqbotEntry.register(api);
  },
}
```

这里非常关键的一点是：

- 聚合包没有自己调用 `api.registerChannel({ plugin: qqbotPlugin })`
- 而是继续委托给 `qqbotEntry.register(api)`

这意味着聚合包只关心“何时注册”，不关心“怎么注册”。

### 3.6 聚合包按 `channels.<id>.enabled` 决定是否注册

`registerChannelsByConfig(api, cfg?)` 的流程很明确：

1. 读取 `config?.channels`
2. 遍历 `SUPPORTED_CHANNELS`
3. 取出 `channelsConfig[channelId]`
4. 如果 `!channelConfig?.enabled` 就跳过
5. 如果启用，就执行该渠道对应的 `plugin.register(api)`

因此当用户安装的是 `@openclaw-china/channels` 时，真实行为是：

```text
加载 channels 聚合插件
  -> channelsPlugin.register(api)
    -> registerChannelsByConfig(api)
      -> 发现 channels.qqbot.enabled === true
        -> qqbotEntry.register(api)
          -> api.registerChannel({ plugin: qqbotPlugin })
```

也就是说：

- `qqbot` 对宿主的最终注册方式没有变
- 只是外面多包了一层“按配置决定是否启用”的聚合入口

## 4. 新增一个渠道插件时，需要改哪些地方

下面这个清单是从 `qqbot -> channels` 的真实接入路径反推出来的。

### 4.1 先把单插件做完整

在 `extensions/<channel-id>` 至少准备这些文件：

- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- `src/channel.ts`
- `src/config.ts`
- `src/runtime.ts`

最低要求如下：

- `openclaw.plugin.json` 里有 `id`、`channels`、`configSchema`
- `package.json` 里有 `openclaw.extensions`
- `package.json` 里有 `openclaw.channel`
- `index.ts` 默认导出插件对象，并在 `register(api)` 里调用 `api.registerChannel({ plugin })`
- `src/channel.ts` 导出真正的 `ChannelPlugin`

如果目标是和当前仓库保持一致，还应补上：

- `moltbot` 元数据
- `clawdbot` 元数据
- `install` 元数据
- `registerChinaSetupCli`
- `showChinaInstallHint`

### 4.2 再接入聚合包

在 `packages/channels` 至少同步这几处：

1. `package.json`
   - 增加对新渠道包的依赖
2. `openclaw.plugin.json`
   - 把新 channel id 加入 `channels` 数组
3. `src/index.ts`
   - 导入新渠道的命名导出
   - 导入新渠道默认入口
   - 重新导出类型和工具
   - 扩展 `MoltbotConfig.channels`
   - 把新 channel id 加入 `SUPPORTED_CHANNELS`
   - 在 `channelPlugins` 里加上 `register: (api) => newEntry.register(api)`

如果漏掉其中任何一处，结果会不同：

- 漏依赖：聚合包编译失败或运行时无法 import
- 漏清单：宿主静态识别不到该 channel id
- 漏 `SUPPORTED_CHANNELS`：聚合包不会遍历到该渠道
- 漏 `channelPlugins` 映射：即使启用也无法注册

### 4.3 配置约定不要改

新插件建议继续使用当前仓库约定：

- 渠道配置放在 `channels.<id>`
- 多账户配置放在 `channels.<id>.accounts.<accountId>`
- 默认账户标识使用 `"default"`

这样才能无缝融入 `channels` 聚合包和共享 CLI。

## 5. 推荐接入顺序

为了减少返工，建议按下面顺序开发新渠道：

1. 先在 `extensions/<id>` 内部完成单插件闭环
2. 确保可以直接安装该单插件并完成 `registerChannel`
3. 补齐 `configSchema`、`config`、`outbound`
4. 如果有入站能力，再补 `gateway`
5. 最后再把它挂进 `packages/channels`

原因是：

- 单插件闭环完成前，聚合包没有调试价值
- 聚合包只是“装配层”，不适合承载协议调试

## 6. 建议直接复用的模板

如果后续新增一个渠道插件，最值得直接照抄 `qqbot` 的有四块：

1. `index.ts`
   - 保持薄入口，只做注册和 runtime 注入
2. `src/channel.ts`
   - 把渠道能力集中定义在一个 `ChannelPlugin` 对象里
3. `src/config.ts`
   - 固化多账户模型和配置合并逻辑
4. `packages/channels/src/index.ts`
   - 用“命名导出 + 默认入口 + `SUPPORTED_CHANNELS` + `channelPlugins`”完成聚合接入

## 7. 当前仓库里值得注意的一点

从源码目录看，`packages/channels` 根目录当前只有：

- `openclaw.plugin.json`
- `package.json`
- `src/*`

但 `packages/channels/package.json` 的 `files` 里还声明了：

- `moltbot.plugin.json`
- `clawdbot.plugin.json`

源码树中暂未看到这两个文件。

这不影响本文总结的接入链路，但在后续发布新插件或补充聚合包清单时，建议顺手核对这类“声明和实际文件是否一致”的问题。

## 8. 最终结论

`qqbot` 接入 `@openclaw-china/channels` 的方式可以用一句话概括：

先把 `qqbot` 做成一个可独立注册的标准渠道插件，再由聚合包把它作为依赖导入，并在 `channels.qqbot.enabled` 为 `true` 时转调 `qqbotEntry.register(api)`。

因此后续新增一个渠道时，最稳妥的做法不是直接改聚合包，而是遵循下面的分层：

1. 在 `extensions/<id>` 内实现完整单插件。
2. 保证它自己就能执行 `api.registerChannel({ plugin })`。
3. 再在 `packages/channels` 里补依赖、补导入、补导出、补 `SUPPORTED_CHANNELS`、补 `channelPlugins`。

只要遵循这个分层，新渠道就能同时支持：

- 单独安装
- 聚合安装
- 多宿主兼容
