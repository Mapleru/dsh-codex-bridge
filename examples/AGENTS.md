# AGENTS.md — Codex 协作目录示例

> 这是**示例**。请复制到专用的 Codex 协作目录（例如 `D:\codex-collab`）作为该目录的
> `AGENTS.md`。**不要覆盖任何已有项目的 AGENTS.md**；如果目标目录已有该文件，把下面
> 「Codex 桥」一节手工并入。

## Codex 桥

本目录通过本地文件邮箱与一个 DSH 会话双向通信。邮箱根目录在本目录内（例如
`<本目录>\mailbox`），由 DSH 插件维护。只使用 Node 内置模块，不需要安装依赖。

### 发送消息给 DSH

正文放在文件里，或用 stdin；**不要把正文拼进命令行**：

```powershell
node .\mailbox\tools\send.mjs --to dsh --file .\msg.txt
'状态如何？' | node .\mailbox\tools\send.mjs --to dsh
```

回复某条 DSH 消息时带上它的 id：

```powershell
node .\mailbox\tools\send.mjs --to dsh --file .\reply.txt --reply-to <消息ID>
```

返回 `{"status":"queued","id":"...","hops":1}` 表示已写入邮箱；`busy` 表示邮箱满，
稍后重试，不要循环重试；`rejected` 表示请求无效（STOP、超长、未知 replyTo 等）。

### 接收 DSH 消息

DSH 的消息会以用户消息形式到达，头部形如：

```
[codex-bridge]
id: <uuid>
route: <id|default>
hops: 2
replyTo: <uuid|null>

<body>
```

收到后按普通任务处理。要回复，用上面的 `--reply-to <id>`。

配置了 `routes` 时，用 `--route <id>` 选择目标；回复自动继承父消息的路由，不要写不同的值。

### 状态与停止

```powershell
node .\mailbox\tools\ctl.mjs status
node .\mailbox\tools\ctl.mjs stop     # 暂停新投递与新的 Codex 调用
node .\mailbox\tools\ctl.mjs resume   # 恢复
node .\mailbox\tools\ctl.mjs parked   # 停车记录
node .\mailbox\tools\ctl.mjs routes     # 各路由绑定的 Codex thread
node .\mailbox\tools\ctl.mjs receipt <你发出的消息ID>   # 查 DSH 回执与执行线程答复
node .\mailbox\tools\ctl.mjs bind <route> <thread-id>   # 复用已有 thread
```

> 注意：如果你从 **Codex 桌面会话**直接运行 `send.mjs`，DSH 的回复会写进绑定的 CLI 线程，
> 桌面会话本身看不到；用 `ctl.mjs receipt <消息ID>` 或读 `mailbox/replies/` 核对回执。

### 边界

- 不要删除或改写 `inbox-*.jsonl`、`cursor-*`、`processing.json`；只通过 `send.mjs`
  追加消息。
- 邮箱保存明文正文；不要发送密钥、凭据或不应落盘的内容。
- `from` 字段只是协议标记，不是身份认证。
- 不要为了让脚本可写而扩大沙箱到全盘；邮箱根目录应位于本协作目录内。
