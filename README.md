# wechat-agent-bridge

[English](README.en.md) | 简体中文

[![Version](https://img.shields.io/badge/version-0.4.0-07c160)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/chenshize/wechat-agent-bridge)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/chenshize/wechat-agent-bridge?style=social)](https://github.com/chenshize/wechat-agent-bridge/stargazers)

**把微信变成 Codex 与 Claude Code 的本地远程工作台。** 在手机上发送需求、截图、文件、语音或视频，让 Agent 在你自己的电脑和项目目录里工作；随时切换后端、模型、思考级别、工作区和权限，并把结果与产物安全地发回微信。

它不只是把一条消息转给 CLI：真实 Codex thread / Claude Code session 可以跨切换和重启继续，任务与回复有持久恢复机制，附件会安全缓存，文件只会在你明确执行 `/send` 后外发。

> 如果这个项目让你少开一次远程桌面、少守一次长任务，欢迎点一个 **Star**。它能帮助更多需要“微信里用本地 Coding Agent”的开发者发现这个项目。

> [!WARNING]
> 这是一个会以你的本地用户身份启动 coding agent 的远程入口。发送者白名单只能限制谁能触发桥接，不能让危险指令本身变安全。请使用专用工作区，保留默认的 `workspace` access，只在完全理解风险时启用 `/access full` 或 `WECHAT_BRIDGE_ALLOW_ALL=1`。

本项目不使用 OpenClaw 作为 Agent 运行时，也没有直接导入 `@tencent-weixin/openclaw-weixin`。它独立实现微信 ClawBot 所需的一小部分 iLink HTTP/CDN 协议，用本机已登录的 `codex` 和 `claude` CLI 执行任务。

## 为什么值得安装

- **离开电脑也能继续开发**：在通勤、开会或休息时从微信提交任务、看进度、停止任务、补发结果。
- **一个入口同时使用两个 Agent**：`/codex` 与 `/claude-code` 秒切，并分别保留原生会话，不会把两个后端的上下文混在一起。
- **手机原生输入**：文本、截图、文件、微信语音转写和视频都能进入同一任务；连续发送的上下文会自动合并。
- **不是“发出后听天由命”**：桥崩溃或网络波动后，未开始的任务、已完成的回复和待发送文件都能按各自安全边界恢复。
- **默认克制，按需放权**：发送者白名单、安全工作区、`read-only / workspace / full`、显式 `/send` 和敏感路径拦截共同降低远程误操作风险。

典型使用方式：

```text
/claude-code
分析这个报错截图并给出修复方案

/codex
按刚才的需求修改代码并运行测试

/status
/artifacts
/send 1
```

## 0.4.0 能做什么

- **双 Agent 与真会话恢复**：Codex thread 和 Claude Code session 分别保存；切换回来会调用各自 CLI 的原生 resume，而不是把聊天记录重新拼进提示词。
- **Agent Lane 与账号隔离**：每个账号下的“微信发送者 + Agent + 工作区真实路径 + access 模式”拥有独立 Lane；peer 设置、会话、inbox、outbox、去重和产物记录不会跨账号串用。
- **持久入站任务队列**：服务端批次会先写入本地 inbox 再推进游标；`received` / `queued` 任务重启后自动恢复，`running` / `failed` / `interrupted` 任务保留给用户通过 `/retry` 显式重试；Agent 已完成但回复尚未接纳时进入 `completed`，只补发结果，不会重跑 Agent。
- **冻结执行配置与受控并发**：工作消息首次分类时就冻结 Agent、工作区、access、模型和思考级别，包括附件尚未下载成功的消息；同一发送者保持串行，全实例默认最多同时运行 2 个 Agent。
- **可靠收发**：轮询失败指数退避；整个状态目录只允许一个桥实例；出站按发送者限频、有限重试，并把未送达消息保存到 outbox，等下一条有效上下文到来时补发。
- **安全工作区与 access**：通过 `/cd`、`/ws` 管理真实路径校验后的工作区，通过 `/access` 在 `read-only`、`workspace`、`full` 间切换。
- **入站媒体**：接收并解密微信图片、文件、语音和视频；语音自带的文字转写也会作为文本送入本轮任务。
- **安全产物发送**：Agent 完成后用 `/artifacts` 查看本轮新近文件，再用 `/send` 显式发送；不会因为模型在回复中写了一个路径就自动外发文件。
- **动态状态**：`/status`、`/model`、`/think` 会按当前 Agent 显示模型、思考级别、Lane、工作区、权限和队列。

### Agent Lane 如何工作

Lane 位于账号命名空间内，身份由以下四项共同决定：

```text
微信账号命名空间 ×（微信发送者 × codex/claude-code × 工作区真实路径 × access 模式）
```

Codex Lane 保存真实 `threadId`，Claude Code Lane 保存真实 `sessionId`。切换 Agent、工作区或 access 后，再切回原组合就会继续原会话；`/new` 只归档并清除当前 Lane。只有上游明确报告旧 thread/session 不存在、且本轮尚未产生文本、思考或工具活动时，桥才会清除失效引用并自动新建一次会话；已有执行活动时会保留给 `/retry`，避免重复副作用。

Lane 的 key 不包含模型和思考级别，但每个入站任务会把 `provider`、`cwd`、`accessMode`、`model`、`effort` 一起冻结到 durable inbox。消息排队后再执行 `/model`、`/think`、`/cd`、`/access` 或切换 Agent，只影响后续消息，不会改变已经排队的任务；冻结配置不同的连续消息也不会合并到同一个 Agent turn。

## 功能展示

<p align="center">
  <img src="docs/images/feature-agent-response.png" width="360" alt="在微信中查看 Agent 执行进度和回答">
  <img src="docs/images/feature-model-controls.png" width="360" alt="在微信中查看和切换模型及思考级别">
</p>

## 环境要求

- Node.js 22+
- 已安装并登录 `codex` 和/或 `claude` CLI
- 一个可供 Agent 使用的独立项目目录；不要把主目录、系统目录或整个下载目录当作工作区

只使用一个 Agent 也可以，未安装的另一个 CLI 会在调用或 `/doctor` 时显示不可用。

## 五分钟开始使用

```bash
git clone https://github.com/chenshize/wechat-agent-bridge.git
cd wechat-agent-bridge
npm ci
npm run check
```

确认本机至少有一个已经登录的 Coding Agent CLI：

```bash
codex --version
claude --version
```

然后连接微信并启动：

```bash
npm run login
WECHAT_BRIDGE_CWD=/absolute/path/to/project npm run run
```

在微信中发送 `/status`，再直接发送你的第一个开发任务。`npm run check` 会进行入口文件语法检查和完整测试；`npm run doctor` 可以检查账号、工作区、Codex 与 Claude Code CLI 状态。

也可以直接从 GitHub 安装全局 CLI：

```bash
npm install -g git+https://github.com/chenshize/wechat-agent-bridge.git
wechat-agent-bridge doctor
wechat-agent-bridge login
WECHAT_BRIDGE_CWD=/absolute/path/to/project wechat-agent-bridge run
```

源码安装更方便审阅代码、运行测试和参与贡献；全局安装更适合只想快速使用的开发者。

## 接入微信 ClawBot

1. 在微信中打开“插件”页面，找到“微信 ClawBot”并进入详情。

   <p align="center">
     <img src="docs/images/setup-clawbot-plugin.png" width="360" alt="微信插件页面中的微信 ClawBot">
   </p>

2. 在运行桥接服务的电脑上执行：

```bash
npm run login
```

   本项目不需要执行 ClawBot 详情页里展示的 OpenClaw 安装命令。

3. 在 ClawBot 详情页点击“开始扫一扫”，扫描终端显示的二维码并确认连接。

   <p align="center">
     <img src="docs/images/setup-clawbot-scan.png" width="360" alt="微信 ClawBot 详情和开始扫一扫入口">
   </p>

4. 登录完成后，先准备一个专用项目目录，再启动桥接：

```bash
WECHAT_BRIDGE_CWD=/absolute/path/to/project npm run run
```

默认只处理扫码登录返回的微信 `userId` 发来的消息。其他发送者必须显式加入 `WECHAT_BRIDGE_ALLOW_FROM`。

## 运行与升级

```bash
npm run run
```

新安装的凭据和状态默认保存在：

```text
~/.wechat-agent-bridge
```

可以用 `WECHAT_BRIDGE_STATE_DIR` 指定其他目录。

### 从 0.2.x 升级

- 如果 `~/.weixin-codex-bridge` 已存在且未显式设置状态目录，0.4.0 会继续使用它；已有账号、token、同步游标、模型设置和旧对话文件不会被搬走或删除。
- 常用的 `WEIXIN_CODEX_*` 旧环境变量仍作为兼容别名读取；新部署应改用 `WECHAT_BRIDGE_*`。
- Agent Lane 是 0.4.0 新状态。升级后的第一条消息会创建真实 Codex thread 或 Claude Code session，之后即可跨切换、跨重启恢复。
- 0.4.0 的桥接默认 access 是 `workspace`，不再默认完全权限。确有需要时在微信中显式执行 `/access full`。
- 同一个状态目录现在使用全安装单实例锁，而不是每账号一个锁。升级前请先停止旧桥进程；即使选择不同账号，也不能在同一个 `WECHAT_BRIDGE_STATE_DIR` 中同时运行两个桥。确需并行运行多个账号时，应使用彼此独立的状态目录。

## 微信指令

| 指令 | 作用 |
| --- | --- |
| `/codex` | 切换到 Codex；存在匹配 Lane 时继续原 thread |
| `/claude-code` | 切换到 Claude Code；存在匹配 Lane 时继续原 session |
| `/status` | 查看 Agent、模型、思考级别、access、工作区、Lane、入站队列、待补发消息和最近产物 |
| `/model` | 查看当前 Agent 的模型和可选项 |
| `/model <name>` | 切换当前 Agent 的模型 |
| `/think` | 查看当前 Agent 的思考级别和可选项 |
| `/think <level>` | 切换当前 Agent 的思考级别 |
| `/new` | 停止当前任务、清空排队消息并为当前 Lane 开启新会话 |
| `/reset` | `/new` 的别名 |
| `/stop` | 停止当前任务，取消尚未执行的入站任务和仍未被 outbox 接纳的完成回复；不会清除当前 Lane，也不会删除已经耐久接纳的待补发结果或文件 |
| `/queue` | 查看当前任务、等待消息、异常中断和待补发消息数量 |
| `/retry` | 按接收顺序重新提交当前发送者的 `failed` / `interrupted` 任务；已入队任务保留冻结配置 |
| `/pwd` | 查看当前工作区 |
| `/cd <path>` | 切换工作区；支持绝对路径和相对当前工作区的路径 |
| `/ws list` | 列出命名工作区 |
| `/ws save <name> [path]` | 保存当前工作区或指定路径 |
| `/ws use <name>` | 切换到命名工作区 |
| `/ws remove <name>` | 移除命名记录，不删除磁盘目录 |
| `/access` | 查看当前 access 模式 |
| `/access read-only\|workspace\|full` | 切换 access；下一条消息进入对应 Lane |
| `/artifacts` | 查看当前工作区内最近一次 Agent 任务生成或修改的可发送文件 |
| `/send <编号>` | 发送 `/artifacts` 列表中的文件 |
| `/send <相对路径>` | 显式发送当前工作区内的文件；路径含空格时可加引号 |
| `/doctor` | 在微信中查看版本、CLI、账号、状态目录、Lane 和 outbox 状态 |
| `/help` | 查看帮助 |

兼容别名：`/claude`、`/models`、`/reasoning`、`/workspace`。Claude Code 的思考级别为 `low`、`medium`、`high`、`xhigh`、`max`；模型支持 `sonnet`、`opus`、`haiku` 等别名，也可以填写 Claude Code 接受的完整模型 ID。Codex 的模型与思考级别来自本机 Codex 模型缓存，实际列表以 `/model`、`/think` 为准。

桥接指令只会在一条**不带附件**的消息中识别。带附件的 `/send` 等文字会作为普通 Agent 请求处理。

## 工作区与 access 模式

### 工作区边界

`/cd` 和 `/ws` 会解析真实路径并拒绝：

- 文件系统根目录、用户主目录、整个 `Desktop` 或 `Downloads`；
- macOS/Linux 的系统目录和临时目录；
- 不存在的路径、普通文件，以及无法安全解析的路径。

这些检查可以减少误把范围过大的目录交给 Agent，但**不会检查项目目录里的每一个文件是否敏感**。请仍然使用专用目录，不要在其中保存不应被 Agent 读取的凭据。

### access 映射

| 模式 | Codex | Claude Code |
| --- | --- | --- |
| `read-only` | `--sandbox read-only`，不询问审批 | `--permission-mode plan` |
| `workspace`（默认） | `--sandbox workspace-write`，不询问审批 | `--permission-mode acceptEdits` |
| `full` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |

> [!IMPORTANT]
> **Claude Code 的 `workspace` 不是操作系统沙箱。**它只是映射为 Claude Code 的 `acceptEdits` 权限模式，并不从 OS 层把读写范围强制锁在当前目录。`read-only` 同样依赖 Claude Code 的 `plan` 模式。需要强隔离时，请另外使用低权限系统账号、容器或虚拟机。

`WECHAT_BRIDGE_CODEX_ARGS` 和 `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` 是完整 argv 覆盖，不是追加参数。使用后，内置的 access、模型、JSON 流和 resume 参数都可能被替换，从而影响 Lane 恢复、进度解析或安全性；只建议熟悉两个 CLI 的用户使用。

## 消息排队与可靠性

### 入站队列

- 每次长轮询拿到一个服务端批次后，桥会先把其中所有已授权的用户消息原子写入账号专属的 `<stateDir>/inbox/`，再保存新的同步游标。这样，即使进程在分发批次中途退出，游标之后的消息仍可从本地 inbox 恢复。
- inbox 状态为 `received` 或 `queued` 的任务会在启动时按接收顺序自动恢复。已经进入 `running` 的任务在进程停止或下次启动时改为 `interrupted`；Agent/队列执行失败则标记为 `failed`。后两类不会自动重跑，必须由对应发送者执行 `/retry`。
- Agent 结果先原子写成 `completed`，回复的每个分片被微信送达或耐久 outbox 接纳后才进入 `done`；重启只继续补发，不再执行 Agent。用户通过 `/stop` / `/new` 清出的未启动任务进入终态 `cancelled`。`done` / `cancelled` 记录默认保留 24 小时后清理；损坏的 inbox 会被隔离，桥拒绝覆盖原文件。
- 每个发送者仍是严格串行；空闲时 650 ms 内的连续消息会合并，运行期间的新消息进入下一轮。全实例 Agent 并发默认上限为 2，等待发送者按公平顺序取得执行槽。
- 工作消息首次分类时就冻结 Agent、工作区、access、模型和思考级别，并在附件下载前持久化。修改设置只作用于以后收到的消息；配置快照不同的消息不会合批。
- 默认每个发送者最多等待 20 条内存调度项，超过后会标记为可恢复的 `failed` 并要求先清理队列。`/stop` 和 `/new` 会把尚未执行的任务标记为 `cancelled` 并清出队列，避免重启时复活。

### 至少一次与副作用安全

durable inbox 采用 **at-least-once（至少一次）取向**，不是 exactly-once。`received` / `queued` 可以自动重放；`running` / `failed` 刻意要求 `/retry`，因为 Agent 可能已经写过文件、执行过命令或调用过外部服务，只是来不及写入 `done`。因此，崩溃边界上的任务在重试后可能产生重复副作用。

重试前应先检查工作区、Git 状态和外部系统。对重要任务优先使用确定性文件名、临时文件加原子重命名、数据库事务、API 幂等键或“先检查再创建”的提示。`/retry` 会使用当前微信消息的有效投递上下文，但对已经完成入队的任务保留原来的冻结配置。

### 轮询与出站补发

- 微信长轮询同步游标、账号 inbox 和已完成消息 ID 持久化，降低重连或 API 重放造成的重复执行。
- 网络或 API 失败时使用带抖动的指数退避，成功后恢复正常轮询。
- 出站文本、图片和文件按发送者串行发送，默认间隔 2.5 秒，并对可重试错误进行有限重试和短时熔断。
- 未送达记录原子写入 `<stateDir>/outbox/`，默认保留 24 小时。上下文 token 失效时，会等待该用户的下一条消息，用新上下文再次补发。最终 Agent 回复使用独立的关键消息容量，并在执行 Agent 前预留空间；损坏或不兼容的 outbox 会被隔离并 fail-closed，绝不会用空队列覆盖原文件。

这是尽力而为的本地桥，不提供跨微信、Agent CLI、文件系统和外部服务的分布式事务。重要操作仍应通过 `/status`、代码仓库状态或本机日志确认。

## 入站图片、文件、语音和视频

桥接会从微信官方 CDN 下载加密内容，在本地解密后按内容识别 MIME 类型，并以内容哈希命名缓存到 `<stateDir>/media-cache/`。缓存目录权限设为仅当前用户可访问，默认最多保留 100 个文件或 24 小时。未完成 inbox 任务引用的附件会被 **pin**，不会因 TTL 或数量裁剪提前删除；因此积压附件任务时，缓存可能暂时超过 100 个文件，直到对应任务完成并进入后续清理。

当前固定边界：

- 单个解密后附件最多 25 MiB；
- 每条微信消息最多 8 个附件；
- 每条消息附件合计最多 50 MiB；
- 只接受微信官方 HTTPS API/CDN 主机。

后端行为有所不同：

- Codex：图片通过原生 `--image` 参数传入；非图片附件会以安全缓存路径加入本轮提示词，由 Codex 按需使用工具读取，但不会伪装成原生附件。
- Claude Code：附件的本地缓存路径会写入本轮提示词，由 Claude Code 按需读取；能否理解某种格式取决于 Claude Code 及其可用工具。
- 语音：若微信消息附带文字转写，转写会加入文本；若同时有音频媒体，也按附件处理。
- 视频：桥接负责接收和缓存，不承诺 Agent 一定具备音视频解析能力。

## 产物与文件发送

Agent 每轮结束后，桥会在当前工作区内记录本轮开始后新建或修改的最近文件。它不会自动外发这些文件：

```text
/artifacts
/send 1
/send "reports/final report.pdf"
```

`/send` 会重新解析真实路径，要求目标是当前工作区内的普通文件，并默认阻止 `.env`、`.ssh`、`.gnupg`、私钥、证书、credentials、secret 和 token 类路径。通过检查后，桥会在读取前后再次核对文件身份和元数据，把当时授权的字节复制到私有 `<stateDir>/outbound-spool/`，并记录大小与 SHA-256；outbox 同时保存快照身份与完整性元数据。每次真正上传前都会重新校验 UUID 路径、manifest、普通文件身份、大小和 SHA-256，并直接上传本次校验读出的字节，关闭校验到读取之间的替换窗口。即使原工作区文件稍后被修改或删除，补发仍使用用户执行 `/send` 时看到的版本。默认有效上传上限是 25 MiB。

spool 目录和快照目录使用 `0700`，payload 与 manifest 使用 `0600`。发送成功、发送被判定为不可恢复、显式清理 outbox，或 outbox 记录达到 TTL 被裁剪后，桥会删除相应快照；`/stop` / `/new` 不会静默丢弃已经接纳的快照。spool 是安全补发所需的**第二份完整文件内容**，因此仍应保护状态目录并留意磁盘占用。

`WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS=1` 可以关闭敏感路径拦截，风险很高；`WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES` 可用于降低 `/send` 的选择上限，但微信上传硬上限仍为 25 MiB。

本机终端的 `send-image` / `send-file` 是显式管理员操作，不受工作区和敏感文件名拦截：

```bash
node src/cli.js send-image /absolute/path/to/image.png
node src/cli.js send-file /absolute/path/to/report.pdf
```

默认发给登录时记录的 `userId`；可以临时指定接收人：

```bash
WECHAT_BRIDGE_TO='user@im.wechat' node src/cli.js send-file /absolute/path/to/report.pdf
```

## 环境变量

保存过的微信指令设置通常优先于默认环境变量。修改 `WECHAT_BRIDGE_CWD`、`WECHAT_BRIDGE_ACCESS_MODE` 或 `WECHAT_BRIDGE_DEFAULT_AGENT` 后，已有发送者的单独设置不会被覆盖。

### 核心设置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_BRIDGE_STATE_DIR` | `~/.wechat-agent-bridge`，有旧目录时沿用旧目录 | 凭据、Lane、peer 设置、游标、去重、durable inbox、outbox、outbound spool、媒体缓存和运行日志目录 |
| `WECHAT_BRIDGE_ACCOUNT_ID` | 最近登录账号 | 多账号时选择要运行的账号 |
| `WECHAT_BRIDGE_ALLOW_FROM` | 登录返回的 `userId` | 逗号分隔的发送者白名单；会与登录用户合并 |
| `WECHAT_BRIDGE_ALLOW_ALL` | `0` | `1` 表示接受任意发送者，强烈不建议 |
| `WECHAT_BRIDGE_CWD` | 启动目录 | 新发送者的初始安全工作区 |
| `WECHAT_BRIDGE_ACCESS_MODE` | `workspace` | 新发送者的初始 `read-only` / `workspace` / `full` |
| `WECHAT_BRIDGE_DEFAULT_AGENT` | `codex` | 新发送者的初始 `codex` / `claude-code` |
| `WECHAT_BRIDGE_TIMEOUT_MS` | `600000` | 单次 Agent 任务超时 |
| `WECHAT_BRIDGE_CODEX_DEFAULT_MODEL` | 本机 Codex 缓存首项 | Codex 初始模型 |
| `WECHAT_BRIDGE_CLAUDE_CODE_MODEL` | Claude 设置或 `sonnet` | Claude Code 初始模型 |
| `WECHAT_BRIDGE_CLAUDE_CODE_EFFORT` | `high` | Claude Code 初始思考级别 |
| `WECHAT_BRIDGE_CODEX_ARGS` | 空 | 完整覆盖 Codex argv，专家选项 |
| `WECHAT_BRIDGE_CLAUDE_CODE_ARGS` | 空 | 完整覆盖 Claude Code argv，专家选项 |

### 队列、轮询与反馈

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_BRIDGE_INPUT_DEBOUNCE_MS` | `650` | 空闲/上一轮结束后合并连续消息的窗口 |
| `WECHAT_BRIDGE_MAX_PENDING_MESSAGES` | `20` | 每个发送者最多等待的入站消息数 |
| `WECHAT_BRIDGE_MAX_CONCURRENT_AGENTS` | `2` | 单个桥实例内同时运行的 Agent 总数；同一发送者始终串行 |
| `WECHAT_BRIDGE_POLL_BACKOFF_BASE_MS` | `1000` | 轮询失败退避起点 |
| `WECHAT_BRIDGE_POLL_BACKOFF_MAX_MS` | `30000` | 轮询失败退避上限 |
| `WECHAT_BRIDGE_SEND_INTERVAL_MS` | `2500` | 同一发送者的最小出站间隔 |
| `WECHAT_BRIDGE_SEND_MAX_RETRIES` | `2` | 出站调度器的额外重试次数 |
| `WECHAT_BRIDGE_SEND_MAX_PENDING` | `200` | 普通耐久出站记录上限 |
| `WECHAT_BRIDGE_SEND_CRITICAL_RESERVE` | `512` | 为已完成 Agent 回复预留的耐久分片容量；空间不足时不会启动新 Agent |
| `WECHAT_BRIDGE_REPLY_CHUNK_LENGTH` | `1200` | 长回复分片字符数，最小 200 |
| `WECHAT_BRIDGE_TYPING_HEARTBEAT_MS` | `15000` | 微信输入状态心跳；`0` 关闭心跳 |
| `WECHAT_BRIDGE_STREAM_PROGRESS_MIN_INTERVAL_MS` | `5000` | 工具进度消息最小间隔 |
| `WECHAT_BRIDGE_STREAM_PROGRESS_MAX_ITEMS` | `3` | 每次工具进度合并的最多项目数 |
| `WECHAT_BRIDGE_PROGRESS_INTERVAL_MS` | `45000` | 长任务状态提醒间隔；`0` 关闭 |

### 登录、文件和高级设置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WECHAT_BRIDGE_LOGIN_TIMEOUT_MS` | `480000` | 扫码登录等待时间 |
| `WECHAT_BRIDGE_BOT_TYPE` | `3` | ClawBot 登录 bot type；通常无需修改 |
| `WECHAT_BRIDGE_BOT_AGENT` | `WechatAgentBridge/0.4.0` | iLink `bot_agent` 标识；通常无需修改 |
| `WECHAT_BRIDGE_MAX_OUTBOUND_FILE_BYTES` | `26214400` | `/send` 文件选择上限；只建议向下调整 |
| `WECHAT_BRIDGE_ALLOW_SENSITIVE_ARTIFACTS` | `0` | `1` 允许 `/send` 选择疑似凭据文件，风险很高 |
| `WECHAT_BRIDGE_TO` | 登录用户 | 仅用于本机 `send-image` / `send-file` 的接收人 |

## 诊断与本地状态

```bash
npm run doctor
```

终端诊断会遮蔽账号 ID，不打印 token。运行事件记录在 `<stateDir>/runs/YYYY-MM-DD.jsonl`，peer ID 使用哈希，带 token/secret/password 等字段会被过滤。

关键持久目录包括：

```text
accounts/          账号凭据与同步游标
peers/ lanes/      账号隔离后的 peer 设置与 Agent 会话引用
inbox/             账号专属入站状态机和冻结任务快照
outbox/            账号专属待补发操作
outbound-spool/    /send 创建的私有内容快照
media-cache/       入站附件缓存；未完成任务会 pin 引用文件
runs/              脱敏结构化运行日志
```

0.4.0 使用原子 JSON 写入并尽量将敏感状态设为 `0600`、目录设为 `0700`；这减少了半写状态和同机误读，但不能替代磁盘加密、系统账号隔离或主机安全。

## 安全边界

- 默认白名单、工作区检查和 access 都是纵深防御，不是远程执行不受信任输入的安全证明。
- `full` 允许 Agent 访问工作区之外的本机资源；Claude `workspace` 也不是 OS 沙箱。
- 微信账号或允许发送者一旦被接管，攻击者可能向本机 Agent 下达命令。
- 入站附件内容本身不可信。不要让 Agent 在高权限模式下直接执行附件中的脚本或宏。
- `/send` 只防常见越界和敏感文件名；它无法判断普通文件内容里是否含有密钥或隐私。
- durable inbox 只能防止任务静默丢失，不能提供 exactly-once；执行 `/retry` 前必须考虑此前可能已经发生的文件、Git、数据库或外部 API 副作用。
- `outbound-spool/` 包含通过 `/send` 授权文件的完整副本，在发送成功、清理或过期前应按敏感数据保护。
- 自定义 CLI argv 可以绕过桥接默认 access；修改前请用 `npm run doctor` 和本机 CLI 验证。

发现安全问题时，请不要在公开 Issue 中粘贴 token、账号 ID 或原始聊天日志；请按 [安全策略](SECURITY.md) 私密报告。

## Roadmap

后续版本会优先围绕“开发者在微信里真正完成一次任务闭环”，而不是单纯增加更多聊天指令：

- 使用另一个 Agent 对最近改动执行只读 `/review`，并支持 Codex ↔ Claude Code 任务交接；
- 自动发现本机 Git 仓库，用项目名而不是手机上难输入的绝对路径切换；
- 为任务提供隔离工作区、变更摘要和安全 `/undo`；
- 把 Issue/PR/CI 链接、报错截图和语音整理成可执行的开发任务。

欢迎通过 Issue 分享最需要的工作流；如果你愿意参与实现，请先阅读 [贡献指南](CONTRIBUTING.md)。

## 说明

- 使用期间需要保持桥接进程运行。
- 本项目是独立社区项目，与腾讯、微信、Anthropic 或 OpenAI 无隶属或官方认可关系。
- 微信 iLink/ClawBot 协议可能变化；遇到登录或收发异常，请先运行 `npm run doctor` 并查看本地运行日志。

## 许可证

[MIT](LICENSE)
