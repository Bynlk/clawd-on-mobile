# wg-bin — bundled userspace WireGuard binaries

The desktop in-app tunnel (`src/wg-pc-tunnel.js`) brings up the PC side of the
WireGuard relay **itself**, with no jump to an external WireGuard client and no
manual conf import (D-UX). To do that without depending on a preinstalled
client or a kernel module, we bundle a userspace implementation:

| file | role |
|------|------|
| `<platform>/wireguard-go` (`wireguard.exe` on Windows) | creates the userspace TUN interface |
| `<platform>/wg` | applies the tunnel conf via `wg setconf` (Linux/macOS) |

`<platform>` matches Node's `process.platform`: `linux`, `darwin`, `win32`.
electron-builder copies this whole tree into the packaged app resources
(`package.json` → `build.extraResources`), and
`resolveWgGoPath` / `resolveWgToolPath` look for the binaries under
`resources/wg-bin/<platform>/`. At dev time (unpackaged) the tunnel falls back
to `wireguard-go` / `wg` on `PATH`.

## These binaries are NOT committed

`wireguard-go` (MIT) and `wireguard-tools`'s `wg` (GPL-2.0) are fetched from
their upstream releases at packaging time rather than vendored into git. Run,
before building the desktop app:

```sh
# Linux x64 — point at trusted release artifacts + their sha256
WG_GO_LINUX_X64_URL=...   WG_GO_LINUX_X64_SHA256=... \
WG_TOOL_LINUX_X64_URL=... WG_TOOL_LINUX_X64_SHA256=... \
node scripts/fetch-wg-binaries.js linux x64
```

The fetch script verifies the sha256 before writing and marks the files
executable. If a binary is missing at build time the app still runs — the
tunnel just falls back to a `PATH` lookup and reports EX-10 if nothing is found.
