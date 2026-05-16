cc-connect-clawd sidecar binaries
=================================

Electron packaged builds copy this directory to:

  resources/sidecars/cc-connect-clawd/

Place built sidecar binaries in platform/architecture directories:

  windows-x64/cc-connect-clawd.exe
  windows-arm64/cc-connect-clawd.exe
  darwin-x64/cc-connect-clawd
  darwin-arm64/cc-connect-clawd
  linux-x64/cc-connect-clawd
  linux-arm64/cc-connect-clawd

Clawd release builds fetch the pinned public fork release with:

  npm run fetch:sidecars

The fetch script downloads release archives from
`rullerzhou-afk/cc-connect-clawd`, verifies `checksums.txt`, and extracts the
binaries into this directory layout. Do not use upstream latest artifacts.

The resolver uses Go-style OS names (`windows`, `darwin`, `linux`) and
Electron/Node architecture names (`x64`, `arm64`). Source runs use this same
layout under the repo-local `bin/cc-connect-clawd/` directory.

For development, `CLAWD_CC_CONNECT_CLAWD_PATH` takes precedence. It may point
directly to a sidecar executable, or to a directory containing
`cc-connect-clawd` / `cc-connect-clawd.exe`.
