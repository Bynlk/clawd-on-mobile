# Android Agent Console

The Android Agent Console is a fork-local, ChatGPT-style interface for AI-agent sessions created by Clawd. The desktop app bundles `node-pty`; users do not install `tmux`, SSH, or another helper.

## Boundaries

- Full read/write control applies only to sessions created from the Android Console or the same managed-session runtime.
- Existing Agent processes launched outside Clawd keep the original state-only mobile behavior.
- The console shows terminal-visible content. A `Thinking` card means text printed by the Agent; it is not hidden model reasoning.
- History is a bounded in-memory ring owned by the desktop process. Restarting Clawd clears all managed sessions and history.
- Android can only select an installed and enabled Agent plus a directory supplied by the desktop allowlist. The protocol rejects arbitrary commands and arbitrary paths.

## Enable and use

1. Pair Android with the desktop over LAN or a self-hosted Relay.
2. Open **Settings → Agent Console**, read the privacy warning, and enable content sync.
3. Open **Console**, choose an Agent and allowed project directory, then create a session.
4. Acquire control before sending normal messages, raw keys, resize commands, or an interrupt.

The timeline renders user and assistant text, terminal-visible Thinking, tools and results, permissions, status, code, unified diffs, and a raw-terminal fallback. Long output is collapsed and every code/log/diff/terminal card can be copied.

## History and multi-device behavior

Every record has a per-session sequence. Android acknowledges only the highest contiguous sequence, caches out-of-order deltas, and requests gaps from desktop history. Reconnecting in the same desktop run restores the available history; an eviction reset replaces stale Android history with the current ring.

Input, resize, and interrupt requests receive an explicit command-result frame or a request-correlated error. Permission resolution is broadcast to every phone so only the first desktop/mobile response remains actionable.

Multiple paired phones may observe the same session. Exactly one stable Android device identity holds the input lease. Switching sessions, disconnecting, disabling sync, or lease timeout releases control. Commands are never queued while disconnected and fail visibly if the lease or running process is unavailable.

## Privacy and Relay

Content sync is off by default and subscribed per paired phone. Enabling it can send source code, commands, local paths, terminal output, and secrets to that phone. One phone disabling its subscription does not change another phone's choice. Disable it when full content is not needed and revoke devices or rotate the mobile/Relay token if a device is lost.

Relay is an opaque forwarder: it keeps one PC connection and a bounded set of phone connections per token, forwards frames, and stores no console payload or history. A public Relay must be served through WSS/TLS. Pairing tokens remain required; there is no additional application-layer end-to-end encryption.

## Failure behavior

- Android or Relay disconnection does not kill the desktop PTY process.
- A PTY, parser, or Hook failure falls back to terminal-visible raw output.
- Hook enrichment is only attached when a managed session can be identified uniquely; ambiguous events are not guessed.
- Desktop remains the local fallback for input and approvals.

## Developer verification

Desktop focused tests cover the store, PTY runtime, normalizer, protocol, lease, Relay forwarding, frame bounds, and lifecycle wiring. Android CI uses JDK 17 and runs `testDebugUnitTest`, `lintDebug`, and `assembleDebug`. Electron packaging runs `npm run rebuild:native` on Windows, macOS, and Linux and unpacks `node-pty` from ASAR for its native binary.
