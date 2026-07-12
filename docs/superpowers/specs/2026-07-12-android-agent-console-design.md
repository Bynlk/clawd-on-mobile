# Android Agent Console Design

## Goal

Add an Android-only, ChatGPT-style console to this fork. It lets a paired phone view and control Clawd-managed AI-agent sessions without requiring users to install `tmux`, SSH, or other external software.

## Scope and boundaries

- All work stays in this fork; no upstream API, repository, or hosted service is required.
- The desktop app bundles its PTY implementation. Users install no additional tooling.
- Full read/write control applies to sessions created and managed by Clawd. Existing sessions launched outside Clawd retain the current state-only mobile behavior.
- The console shows terminal-visible content only. It must not claim to expose hidden model reasoning.
- History exists only while the desktop process runs. Restarting Clawd clears it.
- The Android app supports multiple sessions and switching between them.
- Android creates sessions by selecting from the desktop's existing installed/enabled agent list and an allowlisted/recent working directory. It must not accept arbitrary shell commands or arbitrary host paths.
- Content sync is off by default. Enabling it syncs all managed-session content.
- The user-operated Relay only forwards frames and must not persist message content. The connection still uses TLS/WSS and pairing tokens; there is no separate application-layer end-to-end encryption requirement.
- There is one Android console surface, not a separate terminal screen. Semantic messages use chat cards; unparsable terminal output uses an inline raw-terminal card.

## User experience

The console has a session switcher and one chronological virtualized message list per session.

- User input renders as a right-aligned message.
- Terminal-visible agent thinking and replies render as left-aligned rich-text messages.
- Agent hooks enrich messages as tool calls, tool results, permission requests, and status changes when they can be correlated with the active PTY session.
- Tool calls are collapsible cards. Code and logs are monospace blocks with copy support.
- Diffs use a mobile-first unified view: a file header, addition/deletion counts, red deleted lines, green added lines, and per-file expansion for long changes.
- A normal composer submits an agent message. A compact terminal-control mode sends raw keyboard input such as Ctrl+C and arrow keys.
- Android can request approval, interrupt a managed session, and create a session from a supported agent and an allowed working directory.
- Multiple phones may observe a session. Exactly one device holds its input lease at a time. The lease holder can send input; all others are read-only until it releases or loses the lease.

## Desktop architecture

### Managed-session runtime

Create a focused desktop managed-session module that starts a supported agent in a bundled PTY. It owns:

- the PTY process and terminal dimensions;
- a session id, agent id, working directory, start time, and running state;
- the append-only in-memory terminal event history;
- bounded history eviction per session;
- writes from the active Android input lease holder;
- interrupt and process-exit handling.

The module exposes events rather than directly depending on the mobile server. The mobile integration subscribes to those events and broadcasts them.

### Content normalization

The PTY byte stream is the source of truth for every supported agent. A normalizer converts it into ordered event records:

- `terminal_delta` for raw ANSI-aware terminal content;
- `user_input` for input written by Android;
- `assistant_text` for recognizable agent-visible response text;
- `thinking` for recognizable terminal-visible thinking text;
- `tool_call`, `tool_result`, and `diff` when a hook or safe parser supplies structure;
- `status`, `permission`, and `exit`.

The normalizer must never discard text merely because it cannot classify it. It emits a `terminal_delta` fallback. Hook events refine PTY content but are not required for an agent to remain usable.

### History and flow control

Each record receives a monotonic `sequence` number scoped to its managed session. The desktop keeps a bounded in-memory record ring and sends:

1. a session list;
2. paged history chunks when Android opens a session or reconnects;
3. live ordered deltas afterward.

Message chunks have a bounded payload size below the Relay's frame limit. Android acknowledges the highest applied sequence. On reconnect, the desktop retransmits records after that sequence; if they have been evicted, it sends a history-reset marker and the available ring.

Commands are never queued for later execution. If the target is disconnected, lacks the input lease, or is no longer running, the command fails visibly.

## Protocol additions

All messages include `sessionId`, `sequence` where applicable, and a timestamp. Proposed message families are:

```text
managed_sessions_snapshot
managed_session_history_chunk
managed_session_delta
managed_session_ack
managed_session_create
managed_session_interrupt
managed_session_input
managed_session_input_lease_acquire
managed_session_input_lease_release
managed_session_input_lease_changed
managed_session_error
```

The mobile server authenticates all of these with the existing mobile token and applies per-client message and payload limits. Relay forwarding remains opaque to the content model.

## Android architecture

Add a managed-session repository above the existing `StreamingClient`. It maintains per-session ordered record state, requests history, acknowledges chunks, and exposes connection, input-lease, and command-result flows to Compose.

Add a console destination that reuses the existing connection lifecycle and presents:

- a session picker;
- a lazy event timeline with rich-text renderers;
- a composer and raw-terminal control sheet;
- approval and interrupt actions;
- a managed-session create sheet populated only from desktop-provided agent and directory choices.

The foreground service retains the WebSocket connection. In the background it does not eagerly render console records; it preserves connection state and permission/task notifications. Returning to the console requests the missing history range.

## Security and privacy

- Content sync uses an explicit, default-off preference with a warning that code, commands, paths, and secrets may be sent to the paired phone.
- Public Relay deployment requires WSS/TLS. Token-bearing URLs must not be logged; authentication uses the Authorization header where possible.
- Paired devices are individually identifiable. The desktop can revoke a device and rotate the mobile/relay token.
- Relay services do not store console contents or history.
- Desktop remains the safe fallback: a Relay, PTY, or Android failure must not terminate the agent or prevent local terminal use.

## Compatibility and failure behavior

- First release fully supports managed sessions only; externally launched terminal sessions remain state-only.
- Agent-specific formatting is best-effort. Every agent still has raw-terminal fallback.
- Hook-originated approvals are first-writer-wins across desktop and mobile. Losing clients receive the resolved state.
- PTY native modules must be built, code-signed, and tested for the supported Electron targets: Windows, macOS, and Linux.
- On Android, long histories use bounded state and lazy rendering. Large outputs are chunked and may be collapsed by default.

## Acceptance criteria

1. A user can enable content sync, select an installed/enabled agent and an allowed directory on Android, and create a Clawd-managed session.
2. The Android console shows complete in-memory history for that session after reconnecting during the same desktop run.
3. Android can send a message, raw terminal input, an interrupt, and an approval to its managed session.
4. Two phones can read the same session but cannot write concurrently.
5. A structured hook event renders as a tool, permission, or diff card when available; unsupported output remains readable as raw terminal content.
6. Restarting Clawd clears managed-session history and reports no stale sessions to Android.
7. Disconnecting Relay or Android leaves the desktop agent process usable locally.
