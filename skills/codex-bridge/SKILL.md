---
name: codex-bridge
description: Send an explicit message to the dedicated Codex CLI collaboration session and answer its messages, through the local file mailbox.
whenToUse: Use when the user asks you to consult, hand work to, or reply to Codex, or when a message arrives with a [codex-bridge] header and you need to answer it explicitly.
---

# Codex bridge

A dedicated Codex CLI thread is connected to this session through a local file
mailbox. Nothing is forwarded automatically: only an explicit tool call moves a
message across.

## Sending

Call `codex_bridge_send` with `text`. The tool returns:

- `{status:"queued", id, hops, queueDepth}` — persisted in `inbox-codex.jsonl`;
  Codex will pick it up on its next turn.
- `{status:"busy", code, message}` — the mailbox or queue is full. Nothing was
  dropped; tell the user and retry later. Do not loop on busy.
- `{status:"rejected", code, message}` — invalid request (STOP active, message
  too large, unknown reply target, missing config). Report the code.

To answer a Codex message that has an `id`, pass `replyTo: "<that id>"`. The
bridge computes `hops = parent.hops + 1`; you cannot set `hops` yourself.

## Receiving

Codex messages arrive as user messages with this header:

```
[codex-bridge]
id: <uuid>
hops: 2
replyTo: <uuid|null>

<body>
```

An arriving message is already recorded in the mailbox. To answer it, call
`codex_bridge_send` with `replyTo` set to its `id`. A normal text answer is
**not** forwarded; if the user wants Codex to see it, send it explicitly.

## Status

Call `codex_bridge_status` to read readiness and queue state. Important fields:

- `instance.ready` / `instance.reasons` — `ready:false` means the bridge is not
  usable; report the reason codes instead of retrying blindly.
- `codex.sessionId` — the dedicated Codex thread. `null` means no Codex turn has
  completed yet.
- `queue.dshToCodex` / `queue.codexToDsh` — pending records.
- `stop` — `true` while `STOP` exists; sending is rejected.
- `attention` / `lastErrorCode` — authentication or approval problems that need
  a human; never bypass them.

## Rules

- Do not claim a message was delivered. `queued` only means it is in the
  mailbox; a Codex answer arrives later as a new message.
- Do not invent message ids. Only use ids that appear in received messages or
  in tool output.
- One Codex turn runs at a time. Long work may take minutes; check status
  rather than resending.
- Loops are bounded: when `hops` reaches the configured `maxHops`, the message
  is parked instead of being sent again.
