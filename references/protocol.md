# Known-working persistent terminal protocol

Verified locally on OpenCode **v2.1.2**, Node **v24.18.0**, 2026-10-22.
This is a troubleshooting reference, not a prerequisite to operating terminals.
The helper uses only Node built-ins and the `opencode` CLI.

## Resources and authentication

These TUI terminals are session-scoped persistent PTYs, not `/api/shell`
commands or location-scoped `/api/pty` sessions.

| Operation | Method and path |
| --- | --- |
| List | `GET /api/experimental/session/{sessionID}/terminal` |
| Create | `POST /api/experimental/session/{sessionID}/terminal` |
| Metadata | `GET /api/experimental/persistent-pty/{ptyID}` |
| Snapshot | `GET /api/experimental/persistent-pty/{ptyID}/snapshot` |
| Resize only | `PUT /api/experimental/persistent-pty/{ptyID}` |
| Terminate/remove | `DELETE /api/experimental/persistent-pty/{ptyID}` |
| WebSocket ticket | `POST /api/experimental/persistent-pty/{ptyID}/connect-token` |
| WebSocket | `/api/experimental/persistent-pty/{ptyID}/connect` |

Use `OPENCODE_SESSION_ID` for the current conversation. Use `opencode api`
for authenticated HTTP requests; it resolves the shared service automatically.
`opencode service status` supplies the WebSocket server address, not credentials.
For an explicitly selected other server, pass the same `--server URL` to all
helper operations. The CLI handles its authentication environment.

Do **not** add `--server` just to repeat the default local service URL: that
selects explicit-server authentication and can fail with "requires a password"
even when implicit shared-service requests work. Do not print or scrape secrets.

Create payload: `{"args":[],"title":"Shared work","env":{},"cwd":"/absolute/path"}`.
Omitting `command` uses the default shell. Snapshot JSON has `data.info`,
`data.text`, `data.cursor`, and a base64 `data.checkpoint`. The helper drops
the checkpoint from screen reads. A shell may overwrite the requested title.
The verified server's update handler **only resizes**: `size` is required and
title updates are ignored. Renaming existing terminals is unsupported. Do not
try title updates or inject shell escape sequences as a workaround. This was
confirmed by a live update and inspection of the installed update handler.

## Input connection

1. Read a snapshot. Retain `info.output.tail` and the live dimensions.
2. Request a ticket with the header **`x-opencode-ticket:1`**. Without it,
   the verified server returns HTTP 403. The ticket is short-lived/single-use.
3. Connect with Node's built-in WebSocket, using the same server, `ws:` or
   `wss:`, and these query parameters:
   - `ticket`: returned ticket; never log it.
   - `cursor`: the snapshot's output tail, to avoid replaying all history.
   - `attachment_id`: a unique ID for this connection.
   - `takeover=true`: deliberately take controller ownership for input.
   - `input_protocol=1`: dimension-aware binary input.
4. Set `binaryType = "arraybuffer"`. String messages are JSON control events;
   binary messages are terminal output. Do not parse output as control JSON.
5. Wait for `attached`, requiring `role: "controller"`, `inputProtocol: 1`,
   and matching terminal/session IDs. Then wait for `replay_complete`.
6. Send a binary frame:

   | Offset | Encoding | Meaning |
   | --- | --- | --- |
   | 0 | uint8 = `1` | Input operation (`0` would request control only) |
   | 1–2 | uint16 big-endian | Live columns, 1–65535 |
   | 3–4 | uint16 big-endian | Live rows, 1–65535 |
   | 5 onward | UTF-8 bytes | Input, with `\r` for Enter when requested |

7. Observe briefly, close the WebSocket, then read a snapshot. Disconnecting
   does not close the terminal, stop its foreground command, or prove that
   the previous TUI controller was restored.

The helper refuses input if the output tail changed between snapshot and
attachment. This catches some concurrent activity, but cannot make simultaneous
human/agent editing safe. Cooperate by taking turns.

## Targeted failure handling

- **No session ID:** invoke from an OpenCode session; do not select another
  conversation's ID from process/database inspection.
- **No matching terminal:** list the current session. If the user is on a
  known standalone/remote server, use that server explicitly. An empty list
  is not evidence that the API is unavailable.
- **403 when issuing ticket:** ensure the exact header above is present;
  do not attempt to bypass authentication or origin checks.
- **WebSocket/handshake failure:** read the terminal first. If no input was
  sent, diagnose the reported connection/controller/protocol error.
- **Failure after send:** delivery/execution is uncertain. Read before any
  retry; never automatically send the same command again.
- **No foreground shell:** `run` intentionally refuses application input.
  Read the screen and use `send` only for an authorized interactive action.
- **Output missing from snapshot:** it may have scrolled off-screen, or the
  command may still be running. Do not rerun solely to obtain its output.
- **Actual version/schema mismatch:** consult the current V2 API reference at
  <https://opencode.ai/v2/docs/api> and update/test the helper once. Routine
  operations should not repeat schema discovery or executable inspection.

Limits: screen snapshots rather than a complete transcript; no reliable command
exit-status tracking; no automated restoration of prior controller ownership.
The snapshot endpoint accepts no windowing or cursor parameter, so the helper
slices `data.text` locally (`--lines`, `--all`); `run --rc` synthesises an exit
code from a nonce marker appended to the command text, and reports it absent
rather than guessing.
