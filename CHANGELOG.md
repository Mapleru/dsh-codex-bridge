# Changelog

## 0.1.0 — 2026-11-05

First public version.

- Bidirectional local-file mailbox between one DSH session and one Codex CLI thread.
- Tools `codex_bridge_send` / `codex_bridge_status`, runtime skill `codex-bridge`.
- At-least-once delivery with a stable reply id, restart recovery and parking.
- STOP / resume, single-instance lock, mailbox rotation, hop limit, queue depth limit.
- Per-session routing (`routes`) with reply inheritance and caller authorization.
- `transport: auto` falls back to `codex queue` for threads held by the Codex desktop app.
- `tools/send.mjs` and `tools/ctl.mjs` helpers (status, stop, parked, retry, receipt, bind).
