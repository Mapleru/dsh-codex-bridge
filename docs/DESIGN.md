# Codex bridge — 实现计划与本机证据（阶段一）

日期：2026-11-05。开发目录：`D:\work\codex-bridge`。
本文件只记录**已在本机核实**的事实；未核实的都标“未验证”。

## 1. 环境

| 项 | 值 | 证据 |
|---|---|---|
| DSH | `0.2.0-rc.2` | `D:\app\deepseek_harness\resources\app.asar` 内 `dsh/package.json` |
| Node | `v24.15.0` | `node --version` |
| Profile | `C:\Users\<you>\.dsh\profiles\desktop` | `$DSH_PROFILE_DIR` / 目录存在 |
| Profile bundles | `@deepseek-ai/dsh-base`、`dsh-web-app`、`dshmarket`、`dsh-whale-widget`、`dsh-ops`、`billion-context`、`cc-safety-net` | profile `package.json` |
| 现有哨兵 | `desktop-feishu-wake`（session 1）、`desktop-session2-wake`（session 2） | profile `cordis.patch.yml` L54–101 |

阶段一**没有**修改 profile、没有安装 bundle、没有启停宿主、没有调用真实模型。

## 2. Codex CLI 核实（2026-11-05）

### 2.1 路径与版本

```
PS> Get-Command codex.exe
Get-Command : The term 'codex.exe' is not recognized ...
```

本会话的 PATH（bash 与 pwsh 都试过）没有 `codex`。直接调用已安装的 WindowsApps 包：

```
PS> & 'C:\Program Files\WindowsApps\OpenAI.Codex_<version>_x64__<hash>\app\resources\codex.exe' --version
codex-cli 0.166.0-alpha.6
```

- 该文件 371,731,248 字节，2026-11-04 15:03。
- 路径含版本号 `26.1029.7803.0`，**不写死进代码**；运行时由 `codexExecutable` 指定并做文件/版本/能力检查。
- 旧路径 `C:\Users\<you>\.codex\.sandbox-bin\codex.exe` 未再引用。

### 2.2 帮助（摘要）

`codex --help`：

- 子命令含 `exec`、`exec resume`、`queue`、`agents`、`app-server`、`exec-server` 等。
- 全局选项含 `--no-daemon`（"Run without the shared background server"）、`-s/--sandbox [read-only|workspace-write|danger-full-access]`、`-a/--ask-for-approval [on-request|never]`、`-C/--cd`、`--add-dir`、`-m/--model`、`-c/--config`。

`codex exec --help`：

- `PROMPT` 省略或为 `-` 时从 stdin 读；"If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block"。
- 支持 `-s/--sandbox`、`-C/--cd`、`--add-dir`、`--json`、`-o/--output-last-message <FILE>`、`--ephemeral`、`--skip-git-repo-check`、`-m`、`-c`、`-i`、`--output-schema`、`--color`。

`codex exec resume --help`：

```
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
```

- 支持 `-c`、`-m`、`-i`、`--json`、`-o`、`--ephemeral`、`--skip-git-repo-check`、`--worktree`、`--all`、`--thread-source`。
- **不列出** `-s/--sandbox`、`-C/--cd`、`-a/--ask-for-approval`、`--add-dir`。

`codex queue --help`：

```
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
```

- `--resume` 的说明明确写着失败只产生 warning、命令仍成功。**不能用退出码证明执行完成**，所以第一版不把 queue 作为默认路径。

### 2.3 参数组合实测（只做参数解析，不调用模型）

以下命令都用一个**不存在的 session id**，因此不会产生真实模型回合：

```
printf '' | codex --no-daemon -s workspace-write -C <dir> exec resume 00000000-0000-0000-0000-000000000000 --json -o /tmp/cbtest/out.txt -
→ stderr: No prompt provided via stdin.
→ exit 0，无输出文件
```

```
printf 'ping' | codex --no-daemon -s workspace-write -C <dir> exec resume 00000000-0000-0000-0000-000000000000 --json -o /tmp/cbtest/out2.txt -
→ stderr: Not inside a trusted directory and --skip-git-repo-check was not specified.
→ exit 0，无输出文件
```

```
printf 'ping' | codex --no-daemon -s workspace-write -C <dir> exec resume 00000000-0000-0000-0000-000000000000 --skip-git-repo-check --json -o /tmp/cbtest/out3.txt -
→ stderr: Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)
→ exit 0，无输出文件
```

结论（已实测）：

1. 全局 `--no-daemon`、`-s workspace-write`、`-C <dir>` 放在子命令**之前**时，`exec resume` 接受它们。
2. 非 git 协作目录必须加 `--skip-git-repo-check`。
3. **resume 失败仍 exit 0**；空 stdin 也 exit 0。退出码必须和“新输出文件 + `turn.completed` 事件”联合判断。
4. `-o` 在失败时不会留下文件；每次调用必须用新的文件名。
5. Codex 把会话叫 “thread”。

### 2.4 JSONL 事件字段（本机二进制字符串证据）

在 `codex.exe` 中找到连续字符串块：

```
ThreadEvent ThreadStarted type thread.started TurnStarted turn.started TurnCompleted turn.completed
TurnFailed turn.failed ItemStarted item.started ItemUpdated item.updated ItemCompleted item.completed
error items query action results changes server arguments ... usage input_tokens cached_input_tokens output_tokens reasoning_output_tokens
```

以及 `thread_id`、`codex.thread.started`。

阶段一按以下**明确字段**解析，不做正则猜字段：

- 会话 ID：`type === "thread.started"` 且顶层 `thread_id` 为字符串。
- 完成：`type === "turn.completed"`。
- 失败：`type === "turn.failed"` 或 `type === "error"`。
- 兜底正文：`type === "item.completed"` 且 `item.type === "agent_message"` 且 `item.text` 为字符串（仅当 `-o` 文件为空时使用）。

真实事件样本仍未验证（阶段二第一件事就是保存一份脱敏样本）。

### 2.5 共享后台与取消

- `codex agents` 的描述是 "Browse all agent sessions on the shared local app-server daemon"，说明 Codex 有自己的共享后台。
- 顶层存在 `--no-daemon`。本插件每次调用都传 `--no-daemon`，使工作归属本插件启动的客户端，超时/STOP 时用 `taskkill /F /T /PID` 终止该客户端进程树。
- **未验证**：杀掉 `--no-daemon` 客户端是否一定停止模型侧工作。阶段二必须用真实回合验证；在验证前文档只声明“终止本插件创建的进程树”，不声明“模型工作已停止”。
- 不按进程名杀 codex，不停止共享后台。

## 3. DSH 接口核实

### 3.1 现有哨兵（只读）

`C:\Users\<you>\.dsh\profiles\desktop\desktop-feishu-wake.mjs`：

- 惰性控制器：`const controller = () => { try { return ctx.get('sessionController'); } catch { return undefined; } };`
- 投递：`sessions.resolveAgent(sessionId)` → `sessions.prompt({requestId: crypto.randomUUID(), sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone:'Asia/Shanghai'}, new AbortController().signal)`。
- 失败回退 `agent.steer(...)`；规范明确这是缺陷，本插件**不用 steer**。
- L81 无条件写游标；本插件只在确认接收入队后推进。
- L100–103 `ctx.effect(() => () => { close watchers; clearInterval(timer); })`。

### 3.2 sessionController

`@deepseek-ai/dsh-api-session-controller/lib/index.js`（从 app.asar 解出）：

- `resolveAgent(sessionId)` 返回 `{agent}` 或 `{error: RemoteError<...>}`。
- `prompt()` 入口在 L831–833：
  ```js
  async prompt(request, source) {
    const agent = await this.resolveAgent(request.sessionId);
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
  ```
- `hasPromptRequest`（L1011–1022）在 `agent.inbox.nextTurn`、`agent.inbox.nextStep` 和 `session.snapshotEvents()` 的 `user/message` 事件里查找 `source.kind === 'user' && source.rpcId === request.requestId`。
- 因此 `requestId` 是持久化的 `rpcId`；**同一个 requestId 重试返回原来的 acceptance，不会重复插入**。本插件用 `codex-bridge:<messageId>` 作为稳定 requestId。
- `prompt` 返回 `{accepted:true}`；失败抛 `RemoteError`。
- `cancel({sessionId})` 需要活会话；取消不会丢弃已排队 inbox。本插件不主动 cancel DSH 回合。
- `state({sessionId})` 可读 `{cursor, active, running, queue, pendingInput}`；本插件只把它用于诊断（未在阶段一依赖）。

### 3.3 工具注册

`@deepseek-ai/dsh-tools/lib/index.js`：

- `register(definition, options)`（L433–445）要求 `output.render`，`assertSupportedJsonSchema(output.schema)`，返回精确 disposer。
- `when` 在每次模型步求值（L551）：`enabled = registration?.when === void 0 || await registration.when(context)`；false 时工具不出现在 schema，也不能执行。
- 纯 JSON Schema 可直接作为 `parameters` / `output.schema`；`defineTool` 只是可选封装。
- `restrict()` 只能在 agent 作用域调用；全局注册 + `when` 是限制到单会话的正确方式。
- agent id 等于 session id：`dsh-agent/lib/index.js:643` `if (id !== agent.session.id) throw ...`。因此 `when: ({agent}) => agent?.id === config.dshSessionId` 有效。

### 3.4 生命周期

- Cordis 4.1.0 `effect()` 支持异步 disposer；fiber dispose 会 await 每个 disposable（`cordis/lib/index.js:469–479, 696–701`）。
- 宿主 `profile-boot-e2mS45fC.js`：`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`；`createProcessShutdown` 先起 5 秒定时器，再 `dispose`。因此宿主最多等约 5 秒；本插件 `shutdownTimeoutMs` 默认 4000，留余量。
- Electron 桌面壳是否另有等待**未验证**；阶段二用“宿主退出后 3 秒/5 秒内进程消失”验收。

### 3.5 配置 schema 与 bundle

- `@deepseek-ai/schemastery` 提供 `Schema.object/string/number/boolean`、`.default()`、`.required()`、`.description()`。
- bundle = `package.json` 声明 `dsh.bundle.patch`；patch 为 `- insert: - id/name/config`。
- `plugin_manager install_bundle` 负责安装 + 选中 bundle，bundle patch 自己插入入口；**再手写 insert 会加载两次**。
- profile 覆盖行的形式是顶层 `- id: <row-id>` + `config:`（现有 `cordis.patch.yml` L4–50 已证明）。
- `plugin_manager` 的 `list_plugins/list_bundles/set_plugin/set_bundle/remove_bundle` 语义见其 README；阶段一不执行。

## 4. 设计决策

| 决策 | 理由 |
|---|---|
| 调用参数：`--no-daemon -s workspace-write -C <cwd> exec [resume <id>] --skip-git-repo-check --json -o <新文件> -` | 2.3 已实测这些全局参数与 resume 组合可解析；`--no-daemon` 让工作归属本插件客户端；`-s workspace-write` 是明确权限；`--skip-git-repo-check` 允许非 git 协作目录 |
| 正文只走 stdin | 不拼 shell，不进 argv |
| 成功 = 新 `-o` 文件非空 + 解析到 `turn.completed` | 退出码在空 stdin、resume 失败时都是 0（2.3 实测） |
| 首次会话 ID 取 `thread.started.thread_id` | 二进制字符串证据；取不到则 not-ready + 明确报告，不伪造连续会话 |
| 不用 `--last`、`--ephemeral`、`--dangerously-bypass-approvals-and-sandbox`、`-a never` | 规范禁止；避免恢复到用户其他会话或绕过审批 |
| `root` 必须等于或位于 `codexWorkingDirectory` 之内 | Codex 的 `workspace-write` 才能写邮箱；不靠扩大全盘权限解决 |
| 不自动切换/fork 会话；resume 失败 → not-ready + 人工 `reset-session` | 规范要求；不静默换会话 |
| DSH 投递只用 `mode:'queue'` + 稳定 requestId | 已核实幂等 acceptance；steer 语义不可靠 |
| 单实例 = 文件锁 + 进程内 root 注册表 | 同进程重复 apply 也不双消费；活 pid 持锁时惰性 |
| 追加锁 = `open('wx')` + pid/年龄判活 + rename 接管 | 多进程（DSH 插件、Codex 的 node 脚本）共享邮箱 |
| 所有状态写入 = 临时文件 + fsync + rename | 游标/状态可靠替换 |
| 超时/STOP/dispose 只杀本插件创建的 pid 树 | 不按进程名全局杀 |
| 无回复但已 `thread.started` → `delivery_uncertain`，不自动重跑 | 外部可能已执行；避免副作用重复 |
| 已保存回复 → 重启直接复用，不再调模型 | 规范要求 |
| 队列满/邮箱满 → 返回 `busy`，不丢消息 | 背压显式化 |
| 事件日志只记元数据 | 隐私要求；正文只在邮箱/停车记录 |

## 5. 额外文件（在规范列表之外，均说明用途）

| 文件 | 用途 |
|---|---|
| `session.json` | 持久化 Codex thread id 与最近一次成功时间；state.json 只是展示 |
| `replies/<id>.txt` | 该消息的最终回复正文（跨重启复用） |
| `replies/<id>.json` | 完成记录：状态、replyTo、hops、sessionId、时间 |
| `out/<id>-<ts>-<rand>.txt` | 每次调用的 `-o` 文件，新文件 |
| `archive/` | 已消费邮箱、events/parked 的轮转归档，受总量上限约束 |
| `.append.lock` | 多进程追加锁 |
| `tools/send.mjs` | 启动时从 bundle 复制到 root（若缺失或内容不同），让 Codex 在协作目录直接运行 `node tools/send.mjs` |

## 6. 状态机（DSH → Codex）

```
pending (inbox-codex 行)
  → running (processing.json 已持久化)
  → reply_saved (replies/<id>.txt 已落盘)
  → completed (已追加 inbox-dsh + replies/<id>.json + cursor-codex 前进)
失败分支：
  - spawn 失败 / 未产生任何事件 → 退避重试，最多 maxAttempts
  - 已产生事件但无 turn.completed / 超时 / STOP / dispose → delivery_uncertain
  - turn.failed / 认证/审批阻塞 → parked (needs-attention)
  - hops >= maxHops / 坏行 → parked
恢复：
  - 有 replies/<id>.txt → 复用，不调模型
  - 无回复 → delivery_uncertain，不自动重跑
人工：ctl retry <id> / confirm <id> / parked / reset-session
```

## 7. 测试计划（隔离，无宿主、无真实模型）

1. 单实例：同 root 两个 Bridge；活 pid 锁；死 pid 接管；只释放自己的锁。
2. 并发追加：8 个子进程 × 20 条，锁协议下全部行可解析。
3. 半行：写入无换行前缀，读取不消费；补换行后消费。
4. 坏行：停车记录 + 原因；后续合法行继续。
5. 成功/失败/取消游标：注入 runner，断言游标只在确认后前进。
6. 重启去重与回复恢复：预置 processing + replies，start 不调 runner。
7. 不确定不重跑：预置 threadStarted 无回复，start 只停车。
8. hops 上限：hops=6 直接停车，runner 零调用。
9. STOP：暂停不推进；删除后恢复。
10. 背压：队列满返回 busy；邮箱满返回 busy。
11. 清理：start/stop 后子进程 3 秒内退出；watcher/定时器全部关闭。
12. 错误 sessionId：resolveAgent 返回 not-found，不崩溃、不投递、记录 resolve-failed。
13. 命令行：send.mjs 文件/stdin、replyTo、hop-limit、busy；正文不在 argv。
14. JSONL 解析：构造事件 → session id / completed；无 completed 不算成功。
15. 参数构造：断言含/不含哪些参数。
16. 根目录校验：root 在 cwd 外 → not-ready。

测试用 `node --test`，全部临时目录，不触碰 profile。

## 8. 阶段二待验（不在本轮）

- `plugin_manager` 安装/禁用/查询；HMR 或重启生效。
- Codex 真实 `exec` / `exec resume` 的事件样本与 `thread_id` 字段。
- 真实 ping 5 秒内被 DSH 接收入队；回复单独计时。
- 第二次 resume 用真实 ID 证明连续性。
- Codex 主动 `send.mjs` → DSH。
- 重启不重复处理；崩溃点实测。
- 宿主空载 3 秒内退出；执行中 5 秒内退出且本插件工作停止。
- 杀掉 `--no-daemon` 客户端是否停止模型侧工作。
- Codex 沙箱能否写邮箱/执行 `tools/send.mjs`。
- 审批/认证阻塞时 needs-attention 的真实表现。

## 9. 未实现 / 已知限制

- 不保证 exactly-once；崩溃窗口按 `delivery_uncertain` 处理。
- 不实现 DSH 回合取消；已入队 DSH 请求无法撤回。
- 不实现 queue / agents / app-server 路径。
- 不做跨机器、不做 HTTP、不做认证 token。
- `from` 不是密码学身份；同用户可写文件即可伪造。
- Windows 以外的进程树终止实现了 POSIX 分支，但未实测。
