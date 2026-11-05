# dsh-codex-bridge

**English summary** — A Cordis Host bundle for DSH Desktop that connects one DSH session
and one Codex CLI thread through a local, plain-text file mailbox. DSH gets two tools
(`codex_bridge_send`, `codex_bridge_status`) and a skill; Codex gets `send.mjs` / `ctl.mjs`.
Delivery is at-least-once, survives restarts, supports STOP and per-session routing, and can
reuse a Codex Desktop thread via `codex queue` when that thread is held by the desktop app.

- Requirements: DSH Desktop (`0.2.0-rc.2` tested), Node.js ≥ 22, Codex CLI (`0.166.0-alpha.6` tested).
- Install: `plugin_manager({ action: "install_bundle", target: "file:<this-directory>" })`,
  then put an `- id: codex-bridge` row (see `cordis.patch.yml`) in the profile patch.
- Test: `npm test` (82 tests, no network, no real Codex needed).
- Security: the mailbox is plaintext and `from` is not authentication. Keep `root` inside the
  Codex working directory, and do not put secrets in messages. See “安全” below.

## 动机

Codex 在复杂问题上更强：跨文件推理、架构取舍、长上下文里保持约束一致。DSH 擅长跑流程、
管文件和执行具体任务。这个插件把两者接起来——DSH 可以把一个架构性问题连同背景发给 Codex，
Codex 在自己的线程里分析后把结论送回 DSH；后续追问继续落在同一个线程，不必每次重述上下文。

它解决的是“同一个问题需要两种能力”的场景，而不是让两个助手互相闲聊：消息有来源、有路由、
有往返上限，答复可回执、可恢复、可停止。

Chinese details follow.

## 中文说明

让**一个指定的 DSH Desktop 会话**与**一个专用的 Codex CLI 会话**通过本地文件邮箱双向通信的
Cordis Host 插件。第一版（阶段一）只做可靠收发、恢复和停止；不共享 Codex 桌面聊天上下文，
不模拟键盘输入，不修改 Codex 内部数据库，也不新增 HTTP 服务或端口。

```
DSH 会话 ──codex_bridge_send──▶ inbox-codex.jsonl ──▶ codex exec / exec resume
   ▲                                                        │
   └────────────── inbox-dsh.jsonl ◀── 最终答复 / send.mjs ──┘
```

## 目录

| 路径 | 用途 |
| --- | --- |
| `index.js` | 插件入口：注册工具、Skill、生命周期 |
| `lib/config.js` | 配置归一化与结构校验 |
| `lib/protocol.js` | 消息格式、hops、提示词头部、requestId |
| `lib/mailbox.js` | 追加锁、原子写、游标、轮转、实例锁、停车 |
| `lib/codex-cli.js` | Codex 参数、异步 spawn、JSONL 解析、探测、进程树终止 |
| `lib/bridge.js` | 调度、投递、恢复、STOP、状态 |
| `lib/skill.js` | 从 `skills/` 读取并注册运行时 Skill |
| `tools/send.mjs` | Codex 侧发送脚本（也复制到邮箱根目录） |
| `tools/ctl.mjs` | 状态 / 停止 / 恢复 / 停车检查 / 人工重试 / 回执查询 |
| `skills/codex-bridge/SKILL.md` | 给 DSH 模型的显式发送说明 |
| `examples/` | Codex 协作目录 AGENTS.md、首次运行说明、配置示例 |
| `test/` | 隔离测试（`node --test`） |

## 配置

所有运行参数来自 Cordis 配置（`cordis.patch.yml` 的 `config:`）。代码里没有用户路径或真实
会话 ID。缺少必填项时插件保持 `ready:false` 并报告原因，不会让宿主崩溃。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `root` | 空（必填） | 邮箱根目录，**必须位于 `codexWorkingDirectory` 内**，否则 Codex 沙箱写不进去 |
| `dshSessionId` | 空（必填） | 目标 DSH 会话 ID；没有 `routes` 时使用它，工具只对该会话可见 |
| `routes` | 无 | 可选路由表，见下节；设置后每个路由各自绑定一个 DSH 会话和一个 Codex 线程 |
| `deliverySource` | `webhook` | 投递到 DSH 的来源：`webhook` 显示为外部/通知消息；`user` 走 `prompt()` 并保留幂等 `requestId` |
| `deliveryMode` | `followup` | `followup` 等当前回合结束再送达（不打断长任务）；`steer` 立即送达并开新回合 |
| `codexExecutable` | 空（必填） | Codex CLI 的**绝对路径**；启动时验证文件、版本和能力 |
| `codexWorkingDirectory` | 空（必填） | Codex 的工作目录（协作目录），也是邮箱的沙箱根 |
| `codexTimeoutMs` | `900000` | 单次调用超时；超时只终止本插件创建的进程树 |
| `maxHops` | `6` | 达到 `hops >= maxHops` 停车，不再调用模型 |
| `maxAttempts` | `3` | 仅在“尚未看到任何 Codex 事件”时可安全重试 |
| `maxQueueDepth` | `20` | Codex 待处理队列上限；满时发送返回 `busy` |
| `maxMessageBytes` | `32768` | 单条消息上限 |
| `maxMailboxBytes` | `8388608` | 单个邮箱文件上限；满了返回 `busy`，不覆盖未消费数据 |
| `pollIntervalMs` | `2000` | 兜底轮询间隔（watcher 之外） |
| `debounceMs` | `300` | watcher 防抖 |
| `retryBaseMs` | `5000` | 投递失败指数退避基数 |
| `shutdownTimeoutMs` | `4000` | 宿主退出时等待收尾的上限（小于宿主 5 s 强制退出） |
| `model` | 空 | 可选，传给 `exec -m`；空表示不指定 |
| `transport` | `auto` | 路由级：`auto` 先用 `exec`、遇“线程被占用”改走 `queue`；`exec` 只用子进程；`queue` 只走共享 app-server |

`root` 必须绝对路径，且 `path.relative(codexWorkingDirectory, root)` 不能逃出该目录。这是刻意
设计：邮箱要由 Codex 在 `workspace-write` 沙箱内写入，不能靠扩大成全盘写权限解决。

### 路由（双方按 session ID 选会话）

不配 `routes` 时是单路由：一个 DSH 会话 ↔ 一个 Codex 线程（`default`）。要同时对接多组会话：

```yaml
routes:
  - id: default
    dshSessionId: session-00000000-0000-4000-8000-000000000000
    codexWorkingDirectory: D:/codex/collab-a
  - id: research
    dshSessionId: session-11111111-1111-4111-8111-111111111111
    codexWorkingDirectory: D:/codex/collab-b
    model: gpt-5-codex
```

- 每条路由有自己的 Codex 线程绑定（`mailbox/routes.json`），互不复用；路由丢失线程时停车，
  不会自动新建。
- DSH→Codex：工具按调用方会话自动选路由；同一会话拥有多条路由时必须显式传 `route`。
- Codex→DSH：`send.mjs --route <id>` 指定；多路由下不写 `route` 会被停车为 `route-required`。
- 回复继承父消息的路由；显式写了不同路由会被拒绝（`route-mismatch`）。
- 旧配置（只有 `dshSessionId`）自动迁移成 `default` 路由，`session.json` 的线程绑定也会迁移进
  `routes.json`。
- 运维：`ctl.mjs routes` 查看绑定，`ctl.mjs reset-session [route]` 清除某路由线程，
  `ctl.mjs bind <route> <thread-id>` 复用已有线程。

### 绑定到桌面聊天：`transport: queue`

Codex 桌面端打开某个线程时会持有独占写锁，此时 `codex exec resume <thread>` 一定失败：

```text
thread-store conflict: thread <id> already has an active writer
```

这不是线程丢失。`transport: auto`（默认）会在看到这条错误后自动改用 `codex queue` 把消息
排进同一个线程，再从该线程的 rollout JSONL（`~/.codex/sessions/.../rollout-*-<id>.jsonl`）
读回最终答复。实测：入队到答复约 11 s，答复以普通 `reply` 写回邮箱。

代价与边界：

- 被排队的回合在**桌面线程自己的工作目录和权限配置**里执行，不是 `codexWorkingDirectory`；
  绑定桌面聊天等于把该聊天的执行环境交给桥。
- `queue` 只保证“已入队”，桥以 rollout 里出现本消息 `id` 的回合并收到 `task_complete` 为完成；
  期间桥无法中止该回合，超时按 `delivery-uncertain` 停车，不自动重跑。
- 若线程真的不存在（`no rollout found`），仍按 `session-lost` 停车，**不会**新建线程替代；
  需要运维 `ctl.mjs reset-session <route>` 明确解除绑定。

## 安装

阶段一不在本机 profile 上安装；阶段二由用户执行。当前版本的 `plugin_manager` 是 Host 工具
（不是命令行），对应操作：

```text
plugin_manager({ action: "list_bundles" })
plugin_manager({ action: "install_bundle", target: "<本包目录或包名>" })
plugin_manager({ action: "set_bundle", target: "dsh-codex-bridge", enabled: false })   # 禁用
plugin_manager({ action: "set_bundle", target: "dsh-codex-bridge", enabled: true })    # 启用
plugin_manager({ action: "remove_bundle", target: "dsh-codex-bridge" })                # 卸载
```

安装时 `plugin_manager` 会写入 profile 的 `package.json`/`cordis.patch.yml`。本包
`package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，补丁里已有一条 `insert`
（`id: codex-bridge`）。**不要再手工加一条 insert**，否则同一个插件会加载两次。

安装后编辑 profile 中该条目的 `config`（或通过 Host 的配置页）填入上表参数；
`examples/cordis.patch.example.yml` 是一份完整的配置示例。修改 profile 后按当前 Host 的
HMR/重启规则生效。

## 两个工具

只对 `routes` 里的 DSH 会话可见（`when: ({agent}) => routeSessions.has(agent.id)`）：

- `codex_bridge_send(text, replyTo?, route?)` → `{status, id, hops, route, queueDepth}` 或
  `{status: "busy"|"rejected"|"error", code}`。成功只表示**已写入邮箱**，不表示 Codex 已读或已回复。
- `codex_bridge_status(route?)` → 实例、ready 及原因、各路由的 Codex 会话 ID、当前消息、子进程、
  队列深度、停车数、最后错误代码、STOP 状态。

普通 DSH 文本回答**不会**自动转发；只有模型显式调用发送工具才会产生消息。

## Codex 侧

`tools/send.mjs` 与 `tools/ctl.mjs`（连同 `lib/` 副本）会被复制到 `<root>/tools/`，在协作目录内可直接运行：

```powershell
node .\codex-bridge\tools\send.mjs --to dsh --file .\msg.txt
'状态如何？' | node .\codex-bridge\tools\send.mjs --to dsh
node .\codex-bridge\tools\send.mjs --to dsh --file .\reply.txt --reply-to <消息ID>
```

正文永远走文件或 stdin，不拼进命令行。退出码：`0` 已入队/重复，`2` busy，`3` 拒绝，
`4` 错误；stdout 只输出一行 JSON。

```powershell
node .\codex-bridge\tools\ctl.mjs status
node .\codex-bridge\tools\ctl.mjs stop
node .\codex-bridge\tools\ctl.mjs resume
node .\codex-bridge\tools\ctl.mjs parked
node .\codex-bridge\tools\ctl.mjs retry <消息ID> [--confirm-uncertain]
node .\codex-bridge\tools\ctl.mjs receipt <你发出的消息ID>   # 查回执与执行线程答复
node .\codex-bridge\tools\ctl.mjs reset-session
```

## 文件协议

```text
<root>/
  inbox-dsh.jsonl      Codex → DSH
  inbox-codex.jsonl    DSH → Codex
  cursor-dsh           已确认被 DSH 接收入队的字节偏移
  cursor-codex         已完成的 DSH 消息字节偏移
  state.json           可读状态快照（不是唯一事实源）
  instance.lock        单实例锁（pid/instanceId/startedAt）
  processing.json      当前正在处理的消息
  parked.jsonl         停车记录（含原因）
  events.jsonl         脱敏事件日志
  session.json         Codex 会话 ID / 丢失 / 重置标记
  replies/<id>.txt|json 已保存的最终答复
  out/<id>.jsonl       每次调用独立的原始 JSONL
  archive/             人工重试时归档的停车记录
  tools/               复制过来的 send.mjs 及其依赖
  STOP                 存在即暂停新投递与新调用
```

一行一个 JSON（UTF-8，无 BOM）：

```json
{"id":"<uuid>","at":"<ISO8601>","from":"dsh|codex","to":"codex|dsh","kind":"message|reply","text":"...","hops":1,"replyTo":null}
```

- 只消费完整换行记录；末尾半行留给下一次。
- 无效记录连同原始行与原因写入 `parked.jsonl`，不永久堵队列。
- 追加使用跨进程锁文件 + 进程内串行队列；锁只在属主进程死亡或锁文件不可读且超过 3 秒时接管。
- 游标和状态用“临时文件 + fsync + rename”替换。
- 邮箱满了返回 `busy`，不静默丢弃；`busy` 不进入互回循环。
- 每个入站文件先消费到 `cursor` 才允许轮转；轮转文件在 `archive/` 下。

## 投递与恢复语义

至少区分这些状态（`replies/<id>.json` 和 `processing.json`）：

`pending` → `running` → `reply_saved` → `completed`，以及 `delivery_uncertain` / `parked`。

- **Codex → DSH**：按消息的 `route` 找到目标会话后投递。`deliveryMode: followup`（默认）把消息排到
  当前回合之后（`delivered` 表示已排入下一回合，不打断长任务），`steer` 立即送达并开新回合；`deliverySource: webhook`（默认）走
  `agent.followup`/`agent.steer`，`source.kind = 'webhook'`，界面显示为外部/通知消息；这条路径
  没有 `requestId` 幂等，桥自己用 `delivered.jsonl` 去重，存在一个“已投递、游标未落盘”的
  至少一次窗口。`deliverySource: user` 用稳定 `requestId = codex-bridge:<消息ID>` 调
  `prompt({mode:'queue'})`，只有返回 `accepted:true` 才推进 `cursor-dsh`。`delivered` 只表示
  接收入队，不表示模型已回复。失败保留并退避；会话不存在记录 `resolve-failed`，不改投其他会话。
- **DSH → Codex**：按路由选线程调用；调用前先写 `processing.json`；成功先把答复写入
  `replies/`，再追加到 `inbox-dsh.jsonl`，再写完成记录，最后推进 `cursor-codex`。不同路由
  串行（同一时刻只有一个 Codex 调用），各自恢复各自的线程。
- **回执落在哪**：桥的 DSH→Codex 方向只写进路由绑定的 Codex 线程（`codex exec`）。
  如果你在 Codex 桌面会话里直接运行 `send.mjs`，桌面会话本身收不到桥的回复；用
  `ctl.mjs receipt <消息ID>` 查“DSH 已回复什么、执行线程又答复了什么”，或直接读
  `mailbox/replies/`。
- 重启时：`retry-wait` 且没有任何事件 → 可安全重试；已有保存答复 → 直接复用，不再调用模型；
  已看到事件但没有完成 → 标记 `delivery-uncertain`，**不自动重跑**（可能有副作用）。
- 不承诺 exactly-once。崩溃可能发生在“外部已执行、确认未落盘”之间；这时需要人工
  `ctl.mjs parked` 检查，确认后用 `retry --confirm-uncertain`。

## STOP

创建 `<root>/STOP` 后：

- 不开始新的投递或 Codex 调用，不推进待处理游标；
- 取消在途的 DSH 投递和本插件发起的 Codex 调用（终止自己的进程树，不按进程名全局杀）；
- 已产生的结果保留；无法撤回已入队的 DSH 请求时，状态和文档都明确说明；
- 删除 `STOP` 后恢复。被 STOP 打断且已看到事件的工作按 `delivery-uncertain` 停车，需人工确认。

## 单实例

`instance.lock` 独占创建；同一进程重复 `apply` 也有进程内注册表兜底。活实例持锁时其他实例
只记录 `instance:locked` 并保持惰性，不消费邮箱。只释放属于自己的锁；不会仅凭锁文件“很旧”抢锁。

## 隐私与权限

- 邮箱会**持久保存明文消息正文**；不要发送密钥、凭据或不应落盘的内容。
- `events.jsonl` 只记录事件、时间、消息 ID、字符数、状态、错误代码和必要 PID；不记录正文、
  环境变量全集、认证信息或原始 CLI stderr。
- `from` 字段只是协议标记，**不是密码学身份认证**；同一用户权限下的其他进程可以伪造来源。
- 邮箱根目录应位于 Codex 协作目录内，配合 `workspace-write` 使用；不要为了“让脚本能写”
  把沙箱扩到全盘。
- 清理：先 `ctl stop`，确认无在途调用后删除整个邮箱根目录（或归档后删除）。
  `replies/`、`out/`、`parked.jsonl` 都含正文，按敏感数据处理。

## 已知限制与未验证项

- **已在本机真实跑通**（2026-11-05，证据见 `VERIFY.md` §5）：plugin_manager 安装/禁用/卸载、
  真实 Codex 调用与自动回复、同一 thread 恢复、Codex 主动发送、STOP 暂停与恢复、错误
  `dshSessionId`、插件级重启不重复。Codex 需已登录（`codex login status`）。
- **宿主进程退出未验证**：空载 3 s / 执行中 5 s 内退出需要重启桌面宿主，会终止当前会话，
  留给用户操作。插件侧 `shutdownTimeoutMs: 4000`，dispose 会关闭 watcher、清定时器、
  终止本进程树并释放实例锁（禁用 bundle 时实测锁文件立即删除）。
- **取消是否停止模型工作**：已用 `--no-daemon` 让工作留在本进程树，超时/STOP 用
  `taskkill /F /T /PID` 终止；是否能阻止 Codex 内部已开始的回合，真实宿主未单独验证。
- **Codex 桌面线程与 CLI 互斥**：目标 thread 若正被 Codex 桌面会话打开，`codex exec resume` 会报
  `thread-store conflict ... already has an active writer`；桥会把该路由标记丢失并停车。
  绑定目标应是 CLI 自己创建/可写的线程，或先关闭桌面里的那个会话。
- **`file:` 安装是目录复制**：改完本包代码后，必须 `remove_bundle` 再 `install_bundle`
  才会更新 profile 副本与 `<root>/tools/` 里的 helper；只改源目录不会自动生效。
- 未实现：Codex `queue` 调用方式（退出码不能证明完成）、`agents` 查询、HTTP 服务、
  自动把普通回答转发给 Codex。
- **多路由已做真实验证（2026-11-05 12:29）**：临时挂两个路由（默认路由 + 第二个 DSH 会话
  `session-11111111-…`），两条都 `dshReady:true`；本会话调用 `route:"second"` 被拒
  `route-forbidden`；Codex 侧 `send.mjs --route second` 投递成功。验证后已恢复单路由。
  未压测两个 Codex thread 同时长跑。
- **webhook 来源的界面显示**：`agent.steer` + `source.kind='webhook'` 已能唤醒空闲会话并把
  消息送进会话（头部带 `route:`）；`followup` 会等当前回合结束再送达（实测延迟 8 分钟），`steer` 立即送达；默认用 `steer`。消息在
  对话流里显示为“收到外部事件”（已在真实桌面端确认）。
