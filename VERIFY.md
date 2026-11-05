# VERIFY — dsh-codex-bridge（阶段一）

本文件只记录**实际执行过**的检查。未执行的写「未验证」，不填空白、不伪造通过。
输出已脱敏：不含凭据、真实模型标识或上游地址；本机路径保留用于复核。

## 0. 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-05 |
| 系统 | Windows（中文），工作目录 `D:\work` |
| Node | `v24.15.0` |
| DSH | `0.2.0-rc.2`；实现位于 `D:\app\deepseek_harness\resources\app.asar` |
| Profile | `C:\Users\<you>\.dsh\profiles\desktop`（本轮**只读**，未修改） |
| Codex 包 | `OpenAI.Codex 26.1029.7803.0` |
| Codex 可执行文件 | `C:\Program Files\WindowsApps\OpenAI.Codex_<version>_x64__<hash>\app\resources\codex.exe`（371,731,248 字节） |
| Codex 版本 | `codex-cli 0.166.0-alpha.6` |

## 1. Codex CLI 接口（真实执行）

| 检查 | 命令 | 脱敏输出 | 结论 | 类型 |
| --- | --- | --- | --- | --- |
| PATH 中没有 codex | `Get-Command codex.exe` | `无法将“codex.exe”项识别为 cmdlet…` | DSHD 不能依赖 PATH，必须显式配置绝对路径 | 真实 |
| 版本 | `codex.exe --version` | `codex-cli 0.166.0-alpha.6` | 版本可解析；插件按 `codex-cli X` 记录 | 真实 |
| 顶层帮助 | `codex.exe --help` | 含 `--no-daemon`（"Run without the shared background server"）、`-s/--sandbox`、`-a/--ask-for-approval`、`-C/--cd`、`-m/--model`；`exec`/`exec resume`/`queue`/`agents` 存在 | 参数顺序可用；不传 `-a` 与任何绕过参数 | 真实 |
| exec 帮助 | `codex.exe exec --help` | `Usage: codex exec [OPTIONS] [PROMPT]`；`--json`、`-o/--output-last-message`、`-s/--sandbox`、`-C/--cd`、`--skip-git-repo-check`、`--ephemeral` | 首次调用语法确定；正文用 stdin（`-`） | 真实 |
| resume 帮助 | `codex.exe exec resume --help` | `Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`；`--last`、`--json`、`-o`、`--ephemeral`、`--worktree`、`--all` | `resume` 未列 `-s`/`-C`；实现用全局 `-s`/`-C`，是否真正生效**未验证** | 真实 |
| queue 帮助 | `codex.exe queue --help` | `Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`；`--resume` 说明“失败的 resume 只告警，命令仍成功” | 退出码不能证明执行完成，故不作默认通道 | 真实 |
| 空 stdin | `printf '' \| codex --no-daemon -s workspace-write -C <dir> exec resume <uuid> --json -o <f> -` | `No prompt provided via stdin.`，退出码 `0`，无输出文件 | 退出码 0 不代表成功；实现要求新输出文件 + `turn.completed` | 真实 |
| 非 git 目录 | 同上，正文 `ping`，不带 `--skip-git-repo-check` | `Not inside a trusted directory and --skip-git-repo-check was not specified.`，退出码 `0` | 协作目录需 `--skip-git-repo-check` | 真实 |
| 恢复不存在的线程 | 正文 `ping` + `--skip-git-repo-check` | `Error: thread/resume: thread/resume failed: no rollout found for thread id … (code -32600)`，退出码 `0` | 恢复失败也退出 0；已映射为 `codex:session-lost` | 真实 |
| 事件字段 | 对二进制做字符串调查 | `thread.started`、`thread_id`、`turn.completed`、`turn.failed`、`item.completed`、`agent_message`、`usage` | JSONL 解析按这些字段名实现；**真实样本未验证** | 真实（静态） |

> 没有调用真实模型。所有 `exec` 探测都在第一次 API 请求前失败（空 stdin / 非 git / 无 rollout），
> 因此不产生模型计费。

## 2. DSH 接口（只读源码核实）

| 检查 | 证据 | 结论 | 类型 |
| --- | --- | --- | --- |
| 懒取控制器 | 一个现有哨兵插件的 `ctx.get('sessionController')` | 沿用，不用 `inject` | 静态 |
| `resolveAgent` | `dsh-api-session-controller/lib/index.js` | 返回 `{agent}` 或 `{error:{code}}`；不存在时不改投 | 静态 |
| `prompt` 幂等 | `lib/index.js:831-833` + `hasPromptRequest`（`source.rpcId === requestId`） | 稳定 `requestId` 重试不会插入第二条消息 | 静态 |
| `prompt` 返回 | 同上 | `{accepted:true}` 或 `{error}`；只有 accepted 才推进游标 | 静态 |
| 取消语义 | `cancel({sessionId})` | 需要活会话；不丢弃已入队 inbox | 静态 |
| 工具注册 | `dsh-tools/lib/index.js` `register(definition, options)` | 接受普通定义对象；返回精确 disposer；`when` 每模型步求值 | 静态 |
| 会话级限制 | `dsh-agent/lib/index.js:643`（agent id === session id） | `when: ({agent}) => agent.id === dshSessionId` 可限制到目标会话 | 静态 |
| Skill 注册 | `dsh-skill` `validateRuntimeSkill` | `{name, description, content}` 即可；返回 disposer | 静态 |
| 异步 disposer | `cordis` 4.1.0 `runDisposable`/fiber dispose | `ctx.effect(() => async () => …)` 会被等待 | 静态 |
| 宿主退出等待 | `dsh/lib/profile-boot-*.js`：`PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3` | 最多等 5 s，插件自设 `shutdownTimeoutMs` 4000 ms | 静态 |
| 安装入口 | `plugin_manager` README | `install_bundle` 安装并选中 bundle，自动应用 `dsh.bundle.patch`，**不要**再手工 insert | 静态 |

## 3. 隔离测试（真实执行）

命令：

```powershell
cd D:\work\codex-bridge
node --test "test/*.test.mjs"
```

脱敏输出（尾部）：

```text
ℹ tests 82
ℹ pass 82
ℹ fail 0
```

覆盖对照（规格 §13）：

| 要求 | 用例 |
| --- | --- |
| 重复加载和单实例 | `lifecycle.test.mjs`「starting twice…」「stop closes the watcher…」；`cli.test.mjs`「a second bridge on the same root…」；`mailbox.test.mjs` 实例锁独占 |
| 并发追加、半行、坏行 | `mailbox.test.mjs` 12 路并发追加、半行、轮转；`cli.test.mjs` 6 个独立进程同时 `send.mjs` 后逐行 JSON 可解析；`bridge-delivery.test.mjs` 坏 JSON/坏对象/半行不堵后续 |
| 成功、失败、取消时的游标 | `bridge-delivery.test.mjs` 接受推进 / 失败保留 / STOP 不推进；`bridge-codex.test.mjs` STOP 中止后游标仍为 0 |
| 重启去重及回复恢复 | `bridge-codex.test.mjs`「restart mid-call…」「restart with a saved reply…」 |
| 不确定执行不自动重跑 | 同上「timeout is parked as delivery-uncertain…」 |
| hops 上限 | `bridge-codex.test.mjs`「hop limit parks…」；`protocol.test.mjs` hops 1001 拒绝；`cli.test.mjs` 父 hops 3 → 子 4 |
| STOP 暂停恢复 | `bridge-delivery.test.mjs` STOP 暂停/删除后恢复；`lifecycle.test.mjs` watcher 感知 STOP、恢复后处理下一条；`cli.test.mjs` STOP 存在时 `send.mjs` 拒绝（exit 3） |
| 队列背压 | `bridge-codex.test.mjs` `maxQueueDepth:1` → `busy`；`cli.test.mjs` 满邮箱退出码 2 |
| watcher、定时器、在途、测试进程清理 | `lifecycle.test.mjs` `watcher === null`、`interval === null`、`debounceTimer === null`、stop 幂等；测试临时目录统一 `t.after` 删除 |
| 错误 sessionId 不崩溃 | `bridge-delivery.test.mjs`「wrong dshSessionId stays not-ready…」；`index.test.mjs` 不完整配置不抛异常 |
| 工具/ Skill 注册 | `index.test.mjs` 两个工具、`when` 只对目标会话为真、Skill 注册与释放 |
| 参数构造 | `codex-cli.test.mjs` 固定顺序、`resume`、无 `--last`/`--ephemeral`/绕过参数、每次新输出文件 |
| webhook 投递来源 | `index.test.mjs`「webhook delivery attaches an external source…」断言 `source.kind='webhook'`、`deliveryId`、`followup` 一次、`prompt` 零次；`user` 模式断言幂等 `requestId` |
| 路由解析与授权 | `routing.test.mjs` 调用方自动选路由、他人路由 `route-forbidden`、多路由缺 `route` 停车 `route-required`、未知路由 `route-unknown` |
| 回复路由继承 | `routing.test.mjs`「replies inherit the parent route…」回复继承 `beta`、显式矛盾路由 `route-mismatch` |
| 每路由线程绑定 | `routing.test.mjs`「each route resumes its own Codex thread」`alpha` 带 `resume`、`beta` 新线程；丢失线程 `route-session-lost` |
| 旧配置迁移 | `routing.test.mjs`「a legacy session.json binding migrates into the default route」 |

## 4. 静态检查

| 检查 | 命令 | 输出 | 结论 |
| --- | --- | --- | --- |
| 语法 | `node --check index.js lib/*.js tools/*.mjs` | 全部通过 | 无语法错误 |
| 打包清单 | 人工核对 `package.json` `files` | 含 index/lib/patch/tools/skills/examples/locale/icon/README/VERIFY | 运行时文件齐全 |
| 补丁 | `cordis.patch.yml` | `- insert: - id: codex-bridge, name: dsh-codex-bridge` | 单条注册；与包名一致 |

## 5. 阶段二：真实 profile 与真实 Codex（2026-11-05 01:42–01:47）

已安装到 profile `C:\Users\<you>\.dsh\profiles\desktop`，目标会话
`session-00000000-0000-4000-8000-000000000000`，协作目录 `D:/work/codex-collab`。
安装前备份在 `codex-bridge/phase2-backup/`。

| 检查 | 证据 | 结论 | 类型 |
| --- | --- | --- | --- |
| plugin_manager 安装 | `install_bundle target:"file:.../codex-bridge"` → `application: applied`；首次因缺 `inject` 失败，加 `export const inject = ['tools']` 后通过 | 安装/启用可用；真实宿主会在激活时校验服务依赖 | 真实 |
| 配置热加载 | 在 profile `cordis.patch.yml` 追加 `- id: codex-bridge` + config，约 2 s 后 `mailbox/state.json` 出现 | HMR 对 bundle 行生效，无需重启宿主 | 真实 |
| 就绪状态 | `instance.ready: true`，`dsh.sessionReady: true`，`codex.ready: true`，`codex.version: 0.166.0-alpha.6` | 真实探测通过 | 真实 |
| Codex → DSH 投递 | `send.mjs --to dsh` 写入 `inbox-dsh.jsonl`，事件 `delivered`，`cursor-dsh: 0 → 207`；正文以用户消息到达本会话 | 入队后推进游标；约 **0.32 s**（17:43:32.061 → 17:43:32.384Z） | 真实 |
| DSH 工具 → Codex 回复 | `codex_bridge_send` 返回 `queued id=a305be00… hops=2`；事件 `codex-start` → `codex-spawn pid=86264` → `session-recorded` → `completed chars=11`；回复文件内容 `bridge-pong` | 真实 `codex exec` 调用成功，约 **6 s** | 真实 |
| 自动回复 DSH | 回复 `cbace1d5…` 事件 `delivered`，`hops: 3`，以用户消息到达本会话 | 双向闭环成立 | 真实 |
| 同一 Codex 会话恢复 | 第二次调用后 `codex.sessionId` 仍为 `<codex-thread-id>`；`~/.codex/sessions/2026/11/05/` 只有该 thread 一个 rollout 文件（30 行），第二次回复 `second-pong` | 第二次调用确实 resume 同一 thread | 真实 |
| Codex 主动发送 | 两次 `send.mjs` 由 Codex 侧进程发起并成功入队 | Codex 侧入口可用 | 真实 |
| STOP 暂停 | `ctl stop` 后事件 `stop-observed`；待处理消息停在 `cursor-dsh: 603`；`send.mjs` 退出码 3（`stop`）；工具返回 `{status:"rejected",code:"stop"}` | STOP 同时阻断工具与 CLI，不推进游标 | 真实 |
| STOP 恢复 | `ctl resume` 后 `stop-cleared`，待处理消息 `delivered`，`cursor-dsh: 603 → 786` | 恢复后只投递一次 | 真实 |
| 错误 sessionId | 把 `dshSessionId` 改为不存在的 id：`ready: false`，原因 `dsh:session-not-found`，Codex 仍 ready；未投递 | 不崩溃、不误投 | 真实 |
| 重启不重复 | 禁用/启用 bundle、改配置各触发一次 dispose+apply：`instance.id` 与 `startedAt` 更新；`codex.sessionId` 保留；`inbox-dsh` 行数 4、`cursor-dsh` 786 不变；无新的 `codex-start` | 插件级重启不重跑、不重投 | 真实 |
| 卸载 | `remove_bundle` → `application: applied`，Skill 从目录消失；`instance.lock` 被删除 | 卸载会停实例并释放锁 | 真实 |
| 重新安装 | `remove_bundle` 后 `install_bundle` → `applied`，helper 重新复制为修复后的版本 | 可反复装卸 | 真实 |

### 路由与外部来源（2026-11-05 12:21–12:28 实测）

| 检查 | 证据 | 结论 | 类型 |
| --- | --- | --- | --- |
| 外部来源投递 | `72d3e69b…` 用 `agent.followup` 投递，事件 `delivered` 于 04:22:23Z，当前回合结束后（约 8 分钟）才出现在会话里；改用 `agent.steer` 后 `55949c98…` 以用户消息到达，头部为 `[codex-bridge] / id / route: default / hops: 1` | `followup` 先入队、当前回合结束后才送达（同一条消息 8 分钟后才出现在会话里）；`steer` 立即送达并带路由头 | 真实 |
| 不打断当前回合 | `deliveryMode: followup`（默认）下，`92bdb417…` 于 05:01:37.920Z 记录 `delivered`，而当时本会话正在执行长回合，回合未被打断；消息在回合结束后才作为用户回合出现 | `followup` 只排队、不抢占；`delivered` 语义是“已排入下一回合” | 真实 |
| 新路由建线程 | `225a615b…`（route `default`）→ `codex-start` 04:27:36.5Z → `completed` 04:27:41.7Z，回复 `route-ok`；`routes.json` 记录新 thread `<codex-thread-id>` | 无绑定时新建 thread 并落盘到该路由 | 真实 |
| 同路由恢复 | `6dc6dc1b…` 再次调用，thread 仍为 `<thread-id>`，`~/.codex/sessions/2026/11/05/` 未新增 rollout（仍只有 `rollout-2026-11-05T12-27-36-<thread-id>.jsonl`），回复 `resume-ok` | 第二次调用 resume 同一 thread，不新开 | 真实 |
| 运行中游标回退 | 伪造 parked 记录后 `ctl retry 6dc6dc1b…`：`cursor-codex` 2711 → 2457（行首，不是行尾）；事件 `cursor-rewound` → 重新 `codex-start`；回复 id 仍为 `3d116115…`，随即 `delivery-deduped` | `retry` 在运行中的桥上立即生效；回复 id 稳定且邮箱账本阻止重复投递 | 真实 |
| 双路由同时就绪 | 临时配置 `routes: [default, second]`（second = `session-11111111-1111-4111-8111-111111111111`）：`ready:true`，两条路由 `dshReady:true`，各自独立 `codexSessionId` | 一个实例可服务多个 DSH 会话 | 真实 |
| 跨会话授权 | 本会话（仅拥有 default）调用 `codex_bridge_send route:"second"` → `{status:"error",code:"route-forbidden",route:"second"}` | 不能借别人的路由投递 | 真实 |
| Codex 侧选会话 | `send.mjs --to dsh --route second` → `{status:"queued",...,"route":"second"}`；事件 `delivered`；`inbox-dsh` 记录 `route:"second"` | Codex 侧按路由投递到另一 DSH 会话 | 真实 |
| 绑定到桌面占用线程 | `ctl bind default <thread-id>` 后发送 `5eb17649…`：05:30:23.679Z `codex-start`（新绑定确实生效）→ 05:30:25.043Z `session-lost`；直接用 CLI 复现为 `thread-store conflict: ... already has an active writer` | CLI 不能 resume 被 Codex 桌面会话占用的 thread；桥按设计停车且不新开线程 | 真实 |
| 占用线程的 `queue` 兜底 | 同一绑定下发送 `1fe256c4…`：05:44:25.626Z `codex-start transport:auto` → 05:44:26.737Z `codex-queue-fallback` → 05:44:27.293Z `codex-queued`（`<thread-id>`）→ 05:44:38.065Z `completed`（15 字符，`QUEUE-BRIDGE-OK`）→ 05:44:38.438Z 投递回 DSH，`hops:2`；绑定仍是 `<thread-id>` | 线程被桌面占用时，`transport:auto` 改用共享 app-server 入队并从 rollout 读回答复；不新建线程 | 真实 |
| 队列回合确实进入桌面线程 | `~/.codex/sessions/2026/11/05/rollout-*-<thread-id>.jsonl` 新增 `task_started`（`turn_trigger:"queue"`）、用户消息（正文含 `[codex-bridge]` 头）、`AgentMessage`、`task_complete` | 入队不是写本地队列文件，而是真的在该线程执行一轮 | 真实 |
| 最终回归（重装后） | `d0430c20…`（route default，绑定 `<thread-id>`）：05:47:28.928Z `codex-start transport:auto` → 05:47:28.980Z `codex-spawn pid 93244` → 05:47:29.868Z `codex-queue-fallback` → 05:47:30.109Z `codex-queued`（`<thread-id>`）→ 05:47:37.267Z `completed`（14 字符，`FINAL-QUEUE-OK`）→ 05:47:37.299Z 投递回 DSH；`ctl receipt` 同时给出回复 id `73afbda2…` | 重装后的最终构建在桌面占用线程上仍走 queue 兜底并成功回信 | 真实 |
| 成功回合清除旧错误码 | 旧 `routes.json` 残留 `code:"codex:session-lost"`；`ctl bind` 与成功回合都会删除 `code`/`lastErrorCode`；隔离测试 `a successful turn clears a stale route error code` | 路由恢复后不再挂着过期的丢失标记 | 真实（含修复） |
| `queue` 中文正文 | Node `spawn` 传 `--message` 的中文/全角标点，rollout 中逐码点核对（`编码…`）无损坏 | 不经 shell 拼串时 UTF-8 参数完整 | 真实 |
| 改绑清除丢失标记 | 修复前 `ctl bind` 保留 `lostAt`，路由会直接停车；修复后 bind 删除 `lostAt`/`unavailableAt`，随后 `BIND-STATUS-OK` 在 `<thread-id>` 上成功返回 | 改绑后路由立即可用 | 真实 |
| 运行中改绑（缺陷→修复） | `ctl bind default <thread-id>` 于 05:17:29.458Z 写入；紧接着的一条消息仍用内存里的旧绑定 `<thread-id>` 执行，完成时把 `routes.json` 覆盖回旧值（05:17:30.102Z）。修复：`pumpCodex`/`send` 前 `syncRoutesFromDisk()`；`processing.codexSessionId` 固定本次目标；完成时若磁盘绑定已变则保留新值并记 `binding-kept`。新增 2 例测试，73/73 通过 | 改绑不再被在途调用覆盖 | 真实（含修复） |
| 重装后回归 | 重新 `remove_bundle`/`install_bundle` 后，`f7d9ff46…` → 05:06:42.900Z `completed`，回复 `ROUTE-STILL-OK`（thread `<thread-id>`），05:06:42.956Z 投递回本会话 | 新版（`deliveryMode`/`receipt`）装上后往返仍通 | 真实 |
| 回执查询 | `ctl receipt 4c5ebde4…` → DSH 回复 `45af6633…`（05:02:38Z）+ 执行线程答复 `2e8b169e…`（05:02:47Z） | 不读原始 JSONL 也能核对双向回执 | 真实 |
| 回执落点 | 桌面 Codex 会话跑 `send.mjs` 时，桥回复只进绑定的 CLI 线程；本地留存的回执记录包含完整链路 | 桌面会话看不到桥回复，需 `receipt` 或 `replies/` 核对 | 真实 |
| 路由授权/缺省/未知/回复继承 | `test/routing.test.mjs` 8 例：调用者单一路由自动选中、跨会话 `route-forbidden`、多路由未指定 `route-required`、未知 `route-unknown`、回复继承父路由与 `route-mismatch`、已丢失路由 `route-session-lost`、旧 `session.json` 迁移、每路由独立 resume | 路由语义按 Codex 复审的 8 条约束实现 | 隔离 |

### 阶段二仍未验证

- **界面外部徽标（已确认）**：`source.kind='webhook'` 投递的消息在 Web UI 中显示为
  “收到外部事件”，由维护者 2026-11-05 目视确认。
- **宿主进程退出（未测，维护者决定不做）**：空载退出 3 s 内消失、执行中退出 5 s 内消失。
  2026-11-05 两次尝试重启测量；第一次观察进程随宿主被杀，第二次已拿到宿主停止时刻
  （`06:02:26.631Z`）但缺“退出动作起点”，数据不足以判定耗时；维护者随后决定不再重启验证。
  插件侧已设 `shutdownTimeoutMs: 4000`，dispose 会关闭 watcher、清定时器、杀本进程树并
  释放锁（禁用时实测锁文件立即删除）；`stop()` 开头现会写 `shutdown-begin` 事件，日后
  要测可直接用“该事件 → 宿主进程消失”的差值。
- 真实宿主下“执行中退出”：STOP 中断真实模型回合已由隔离测试覆盖，真实宿主未测。
- 循环上限的真实触发：hops 由程序计算，隔离测试覆盖；真实多次往返未跑到上限。
- `transport: queue` 的“写回桌面 UI 的即时性”未单独测：桌面聊天在下一帧/重开时显示，
  桥只保证线程事件与 rollout 落盘；界面刷新时机未验证。
- 双路由只用临时配置验证了“就绪/授权/投递”，验证后已恢复单路由；两个 Codex thread 同时长跑未压测。

## 6. 已知失败/限制（如实记录）

- `codex.exe` 不在 PATH；插件必须配置绝对路径，否则 `ready:false`（`codex:not-ready`）。
- `exec resume` 帮助未列 `-s`/`-C`；参数能被解析，但沙箱继承未验证。
- 退出码不足以判断成功；实现额外要求“新输出文件 + 解析到 `turn.completed` + 非空答复”。
- 不承诺 exactly-once；`delivery-uncertain` 需人工确认后重试。
- 邮箱为明文，`from` 不是身份认证。
- 本机 `node --test test/`（目录形式）在 Node 24.15.0/Windows 下会误当模块加载；已改用
  `node --test "test/*.test.mjs"`。
