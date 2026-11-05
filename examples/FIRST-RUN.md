# 首次 Codex 请求引导（示例）

在 Codex 协作目录里开始第一轮之前，确认三件事：CLI 可用、沙箱可写邮箱、会话 ID 会被记录。

## 1. 确认 CLI（在用户终端，不是 DSH 宿主）

```powershell
Get-Command codex.exe
codex --version
```

如果没有 `codex` 命令，用安装包里的实际 exe 路径，填到插件配置 `codexExecutable`。
路径含应用版本号，升级后会变；不要让插件写死。

## 2. 邮箱位置

DSH 插件配置里的 `root` 必须位于 `codexWorkingDirectory` 内，例如：

```yaml
root: D:\codex-collab\codex-bridge
codexWorkingDirectory: D:\codex-collab
```

这样 Codex 的 `workspace-write` 沙箱能写邮箱，不需要放宽到全盘。

## 3. 第一条消息

1. 在 DSH 里调用 `codex_bridge_status`，确认 `instance.ready` 为 `true`。
2. 调用 `codex_bridge_send` 发送第一条消息。
3. 插件用 `codex exec --json -o <新文件> -` 启动一次 Codex 回合；首次会自动创建线程。
4. 回合结束后，回复写入 `inbox-dsh.jsonl`，DSH 接收后消息头部带有 `id` 与 `hops`。
5. 第二次发送时，插件用 `codex exec resume <thread-id>` 恢复到同一个线程。

## 4. 验证会话连续

`codex_bridge_status` 的 `codex.sessionId` 在第一轮完成后应为一个 UUID；第二轮之后
仍是同一个 UUID，才说明恢复到了同一会话。取不到 ID 时状态会显示
`sessionIdUnavailable`，不要假定连续。

## 5. 遇到阻塞

- `attention` 非空：认证或审批需要人工处理，不要绕过。
- `stop: true`：`STOP` 文件存在；`node tools/ctl.mjs resume` 恢复。
- `parked` 增长：用 `node tools/ctl.mjs parked` 查看原因；`delivery-uncertain` 需要人工
  确认后 `retry --confirm-uncertain`。
