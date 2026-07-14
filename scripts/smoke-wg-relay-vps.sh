#!/usr/bin/env bash
# Destructive staging-only smoke test for the one-click WireGuard Relay VPS flow.

set -Eeuo pipefail
export LANG=C LC_ALL=C
umask 077

[ "$#" -eq 0 ] || {
  printf 'Usage: set CLAWD_TEST_VPS_HOST/USER/PORT, then run %s with no arguments.\n' "$0" >&2
  exit 64
}

: "${CLAWD_TEST_VPS_HOST:?CLAWD_TEST_VPS_HOST is required}"
: "${CLAWD_TEST_VPS_USER:?CLAWD_TEST_VPS_USER is required}"
: "${CLAWD_TEST_VPS_PORT:?CLAWD_TEST_VPS_PORT is required}"

VPS_HOST="${CLAWD_TEST_VPS_HOST}"
VPS_USER="${CLAWD_TEST_VPS_USER}"
VPS_PORT="${CLAWD_TEST_VPS_PORT}"

if ! [[ "${VPS_HOST}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$ ]] ||
  [[ "${VPS_HOST}" == *..* || "${VPS_HOST}" == *:::* ]]; then
  printf 'CLAWD_TEST_VPS_HOST is invalid.\n' >&2
  exit 64
fi
if ! [[ "${VPS_USER}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  printf 'CLAWD_TEST_VPS_USER is invalid.\n' >&2
  exit 64
fi
if ! [[ "${VPS_PORT}" =~ ^[0-9]+$ ]] ||
  [ "$((10#${VPS_PORT}))" -lt 1 ] || [ "$((10#${VPS_PORT}))" -gt 65535 ]; then
  printf 'CLAWD_TEST_VPS_PORT is invalid.\n' >&2
  exit 64
fi

for command in go install mktemp node ssh tar; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'Missing local prerequisite: %s\n' "${command}" >&2
    exit 69
  }
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[ -d "${PROJECT_ROOT}/node_modules/ws" ] || {
  printf 'Run npm install before the VPS smoke test.\n' >&2
  exit 69
}

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/clawd-wg-relay-smoke.XXXXXX")"
CONTROL_ROOT="$(mktemp -d /tmp/cwgr.XXXXXX)"
chmod 700 "${CONTROL_ROOT}"
LOCAL_BUNDLE="${TEMP_ROOT}/bundle"
REMOTE_ROOT="/tmp/clawd-wg-relay-smoke"
CONTROL_PATH="${CONTROL_ROOT}/s"
ASKPASS_PATH="${TEMP_ROOT}/askpass.sh"
FIRST_STDOUT="${TEMP_ROOT}/deploy-1.stdout"
FIRST_STDERR="${TEMP_ROOT}/deploy-1.stderr"
SECOND_STDOUT="${TEMP_ROOT}/deploy-2.stdout"
SECOND_STDERR="${TEMP_ROOT}/deploy-2.stderr"
PHASE="initialization"
CONTROL_READY=0
FAILURE_REPORTED=0
VPS_PASSWORD="${CLAWD_TEST_VPS_PASSWORD-}"

set_phase() {
  PHASE="$1"
  printf '[smoke] %s\n' "${PHASE}" >&2
}

report_error() {
  local status=$?
  trap - ERR
  FAILURE_REPORTED=1
  printf '[FAIL] phase=%s exit=%s (diagnostics suppressed; secrets redacted)\n' \
    "${PHASE}" "${status}" >&2
  return "${status}"
}

cleanup() {
  local status=$?
  set +e
  if [ "${CONTROL_READY}" -eq 1 ]; then
    ssh "${SSH_ARGS[@]}" -o BatchMode=yes -- "${VPS_HOST}" "rm -rf '${REMOTE_ROOT}'" >/dev/null 2>&1
    ssh "${SSH_ARGS[@]}" -o BatchMode=yes -O exit -- "${VPS_HOST}" >/dev/null 2>&1
  fi
  VPS_PASSWORD=""
  unset CLAWD_SMOKE_ASKPASS_SECRET CLAWD_TEST_VPS_PASSWORD
  rm -rf "${TEMP_ROOT}"
  rm -rf "${CONTROL_ROOT}"
  if [ "${status}" -ne 0 ] && [ "${FAILURE_REPORTED}" -ne 1 ]; then
    printf '[FAIL] phase=%s exit=%s (diagnostics suppressed; secrets redacted)\n' \
      "${PHASE}" "${status}" >&2
  fi
  exit "${status}"
}
trap cleanup EXIT
trap report_error ERR
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${VPS_PASSWORD}" ] && [ -t 0 ]; then
  printf 'VPS SSH/sudo password (leave blank for key + passwordless sudo): ' >&2
  IFS= read -r -s VPS_PASSWORD
  printf '\n' >&2
fi
if [[ "${VPS_PASSWORD}" == *$'\n'* || "${VPS_PASSWORD}" == *$'\r'* ]]; then
  printf 'The VPS password cannot contain CR or LF.\n' >&2
  exit 64
fi

SSH_ARGS=(
  -p "${VPS_PORT}"
  -l "${VPS_USER}"
  -o LogLevel=ERROR
  -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto
  -o ControlPersist=120
  -o "ControlPath=${CONTROL_PATH}"
)

if [ -n "${VPS_PASSWORD}" ]; then
  export CLAWD_SMOKE_ASKPASS_SECRET="${VPS_PASSWORD}"
  install -m 700 /dev/null "${ASKPASS_PATH}"
  printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$CLAWD_SMOKE_ASKPASS_SECRET"' > "${ASKPASS_PATH}"
  SSH_ARGS+=(
    -o BatchMode=no
    -o NumberOfPasswordPrompts=1
  )
fi

run_ssh() {
  if [ -n "${VPS_PASSWORD}" ]; then
    DISPLAY="${DISPLAY:-clawd-smoke:0}" \
      SSH_ASKPASS="${ASKPASS_PATH}" \
      SSH_ASKPASS_REQUIRE=force \
      ssh "${SSH_ARGS[@]}" -- "${VPS_HOST}" "$@"
  else
    ssh "${SSH_ARGS[@]}" -- "${VPS_HOST}" "$@"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

run_privileged() {
  local remote_command="$1"
  local quoted_command
  quoted_command="$(shell_quote "${remote_command}")"
  if [ "${VPS_USER}" = root ]; then
    run_ssh "bash -c ${quoted_command}"
  elif [ -n "${VPS_PASSWORD}" ]; then
    printf '%s\n' "${VPS_PASSWORD}" | run_ssh "sudo -S -p '' bash -c ${quoted_command}"
  else
    run_ssh "sudo -n bash -c ${quoted_command}"
  fi
}

set_phase "SSH connection"
run_ssh true </dev/null >/dev/null
CONTROL_READY=1

set_phase "secure bundle staging"
install -d -m 700 "${LOCAL_BUNDLE}/app/node_modules"
install -m 755 "${PROJECT_ROOT}/relay/install-wg-relay.sh" "${LOCAL_BUNDLE}/install-wg-relay.sh"
for file in relay-server.js pair-registry.js relay-token-store.js wg-management.js; do
  install -m 644 "${PROJECT_ROOT}/relay/${file}" "${LOCAL_BUNDLE}/app/${file}"
done
cp -R "${PROJECT_ROOT}/node_modules/ws" "${LOCAL_BUNDLE}/app/node_modules/ws"
find "${LOCAL_BUNDLE}/app/node_modules/ws" -type d -exec chmod 700 {} +
find "${LOCAL_BUNDLE}/app/node_modules/ws" -type f -exec chmod 600 {} +

tar --no-xattrs -C "${LOCAL_BUNDLE}" -cf - . |
  run_ssh "umask 077; rm -rf '${REMOTE_ROOT}'; mkdir -m 700 '${REMOTE_ROOT}'; tar -xf - -C '${REMOTE_ROOT}'"

ENDPOINT_ASSIGNMENT="ENDPOINT_HOST=${VPS_HOST}"
INSTALL_COMMAND="env ${ENDPOINT_ASSIGNMENT} bash ${REMOTE_ROOT}/install-wg-relay.sh"

for deployment in 1 2; do
  set_phase "idempotent deployment ${deployment}/2"
  if [ "${deployment}" -eq 1 ]; then
    run_privileged "${INSTALL_COMMAND}" >"${FIRST_STDOUT}" 2>"${FIRST_STDERR}"
  else
    run_privileged "${INSTALL_COMMAND}" >"${SECOND_STDOUT}" 2>"${SECOND_STDERR}"
  fi
done

set_phase "systemd enable/active and private listener checks"
IFS= read -r -d '' REMOTE_CHECK_COMMAND <<'REMOTE_CHECKS' || true
set -euo pipefail
systemctl is-enabled --quiet wg-quick@clawd
systemctl is-active --quiet wg-quick@clawd
systemctl is-enabled --quiet clawd-relay.service
systemctl is-active --quiet clawd-relay.service

relay_env=/etc/clawd-relay/relay.env
firewall_env=/etc/clawd-relay/firewall.env
test -r "${relay_env}"
test -r "${firewall_env}"
bind_addr="$(sed -n 's/^BIND_ADDR=//p' "${relay_env}")"
relay_port="$(sed -n 's/^PORT=//p' "${relay_env}")"
wg_port="$(sed -n 's/^PORT=//p' "${firewall_env}")"
test -n "${bind_addr}" && test -n "${relay_port}" && test -n "${wg_port}"
case "${bind_addr}" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  *) exit 1 ;;
esac
test "$(wg show clawd listen-port)" = "${wg_port}"
ss -H -lnt | awk -v expected="${bind_addr}:${relay_port}" -v suffix=":${relay_port}" '
  $4 == expected { found = 1; next }
  index($4, suffix) == length($4) - length(suffix) + 1 { unexpected = 1 }
  END { exit !(found && !unexpected) }
'
REMOTE_CHECKS
run_privileged "${REMOTE_CHECK_COMMAND}" >/dev/null

set_phase "current sidecar build and verification"
CURRENT_TARGET="$(node -p '`${process.platform}-${process.arch}`')"
case "${CURRENT_TARGET}" in
  win32-x64|win32-arm64|darwin-x64|darwin-arm64|linux-x64|linux-arm64) ;;
  *) printf 'Unsupported local smoke target: %s\n' "${CURRENT_TARGET}" >&2; exit 69 ;;
esac
node "${PROJECT_ROOT}/scripts/build-wg-relay-sidecar.js" --target "${CURRENT_TARGET}" >/dev/null
node "${PROJECT_ROOT}/scripts/verify-wg-relay-sidecars.js" --target "${CURRENT_TARGET}" >/dev/null
SIDECAR_NAME=clawd-wg-tunnel
case "${CURRENT_TARGET}" in win32-*) SIDECAR_NAME=clawd-wg-tunnel.exe ;; esac
SIDECAR_BINARY="${PROJECT_ROOT}/wg-relay-sidecars/${CURRENT_TARGET}/${SIDECAR_NAME}"

# Authentication is complete. Drop the password before protocol probes so the
# sidecar and Node probe cannot inherit it. The SSH control socket remains live.
VPS_PASSWORD=""
unset CLAWD_SMOKE_ASKPASS_SECRET CLAWD_TEST_VPS_PASSWORD
rm -f "${ASKPASS_PATH}"

set_phase "public Relay TCP exposure, sidecar health, and rotation rejection probes"
CLAWD_SMOKE_PROJECT_ROOT="${PROJECT_ROOT}" \
CLAWD_SMOKE_SIDECAR_BINARY="${SIDECAR_BINARY}" \
CLAWD_SMOKE_FIRST_READBACK="${FIRST_STDOUT}" \
CLAWD_SMOKE_SECOND_READBACK="${SECOND_STDOUT}" \
CLAWD_SMOKE_PUBLIC_HOST="${VPS_HOST}" \
node <<'NODE'
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const root = process.env.CLAWD_SMOKE_PROJECT_ROOT;
const binary = process.env.CLAWD_SMOKE_SIDECAR_BINARY;
const publicHost = process.env.CLAWD_SMOKE_PUBLIC_HOST;
const { WgRelaySidecar } = require(path.join(root, "src", "wg-relay-sidecar"));
const WebSocket = require(path.join(root, "node_modules", "ws"));

function parseReadback(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const match = /<<<CLAWD_JSON>>>([\s\S]*?)<<<END_CLAWD_JSON>>>/.exec(text);
  assert.ok(match, "readback_missing");
  const value = JSON.parse(match[1]);
  assert.equal(value.schemaVersion, 1, "readback_version");
  for (const field of ["endpoint", "subnet", "relayUrl", "pcConfig", "phoneConfig", "relayToken", "managementToken"]) {
    assert.equal(typeof value[field], "string", `readback_${field}`);
    assert.ok(value[field].length > 0, `readback_${field}`);
  }
  assert.match(value.relayToken, /^[0-9a-f]{64}$/);
  assert.match(value.managementToken, /^[0-9a-f]{64}$/);
  return value;
}

function parseWgConfig(configText, relayUrl) {
  const sections = { Interface: Object.create(null), Peer: Object.create(null) };
  let section = null;
  for (const sourceLine of configText.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = /^\[([^\]]+)]$/.exec(line);
    if (heading) {
      assert.ok(Object.hasOwn(sections, heading[1]), "config_section");
      section = heading[1];
      continue;
    }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    assert.ok(section && assignment, "config_assignment");
    const key = assignment[1].trim();
    assert.ok(!Object.hasOwn(sections[section], key), "config_duplicate");
    sections[section][key] = assignment[2].trim();
  }
  const relay = new URL(relayUrl);
  const forwardHost = relay.hostname.includes(":") ? `[${relay.hostname}]` : relay.hostname;
  return {
    PrivateKey: sections.Interface.PrivateKey,
    Address: sections.Interface.Address,
    ServerPublicKey: sections.Peer.PublicKey,
    Endpoint: sections.Peer.Endpoint,
    AllowedIP: sections.Peer.AllowedIPs,
    ForwardAddress: `${forwardHost}:${relay.port}`,
    KeepaliveSeconds: Number(sections.Peer.PersistentKeepalive),
  };
}

function createSidecar(config) {
  const sidecar = new WgRelaySidecar({
    platform: process.platform,
    arch: process.arch,
    appRoot: root,
    startupTimeoutMs: 10_000,
    stopTimeoutMs: 2_000,
    forceKillTimeoutMs: 1_000,
    spawn(_file, args, options) {
      return spawn(binary, args, { ...options, cwd: root });
    },
  });
  return sidecar.start(config).then((ready) => ({ sidecar, listen: ready.listen }), async (error) => {
    await sidecar.dispose();
    throw error;
  });
}

function request(listen, { method = "GET", pathname = "/health", token, body, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { "Cache-Control": "no-store" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const req = http.request(`http://${listen}${pathname}`, { method, headers }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) req.destroy(new Error("response_limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (_) {
          reject(new Error("invalid_response"));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request_timeout")));
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function assertHealth(listen) {
  const response = await request(listen);
  assert.equal(response.statusCode, 200, "health_status");
  assert.equal(response.body.version, 1, "health_version");
  assert.equal(response.body.status, "ok", "health_body");
}

async function assertHealthRejected(listen) {
  let rejected = false;
  try { await request(listen, { timeoutMs: 3_000 }); }
  catch (_) { rejected = true; }
  assert.equal(rejected, true, "old_key_still_reaches_relay");
}

function websocketProbe(listen, token, expectAuthorized) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(`ws://${listen}/mobile/ws?role=phone`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => finish(new Error("websocket_timeout")), 5_000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.terminate(); } catch (_) {}
      if (error) reject(error); else resolve();
    }
    socket.once("open", () => finish(expectAuthorized ? null : new Error("old_token_accepted")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(!expectAuthorized && response.statusCode === 401 ? null : new Error("unexpected_auth_status"));
    });
    socket.once("error", (error) => {
      if (expectAuthorized) finish(error);
    });
  });
}

function assertPublicRelayTcpClosed(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(3_000, () => finish());
    socket.once("error", () => finish());
    socket.once("connect", () => finish(new Error("public_relay_tcp_exposure")));
  });
}

(async () => {
  const first = parseReadback(process.env.CLAWD_SMOKE_FIRST_READBACK);
  const second = parseReadback(process.env.CLAWD_SMOKE_SECOND_READBACK);
  assert.deepEqual(second, first, "deployment_not_idempotent");

  const relayPort = Number(new URL(first.relayUrl).port);
  await assertPublicRelayTcpClosed(publicHost, relayPort);

  const pcConfig = parseWgConfig(first.pcConfig, first.relayUrl);
  const oldPhoneConfig = parseWgConfig(first.phoneConfig, first.relayUrl);
  const active = [];
  try {
    const pc = await createSidecar(pcConfig);
    active.push(pc.sidecar);
    await assertHealth(pc.listen);

    const oldPhoneBefore = await createSidecar(oldPhoneConfig);
    active.push(oldPhoneBefore.sidecar);
    await assertHealth(oldPhoneBefore.listen);
    await websocketProbe(oldPhoneBefore.listen, first.relayToken, true);
    await oldPhoneBefore.sidecar.dispose();
    active.splice(active.indexOf(oldPhoneBefore.sidecar), 1);

    const status = await request(pc.listen, {
      pathname: "/api/manage/status",
      token: first.managementToken,
    });
    assert.deepEqual(status, { statusCode: 200, body: { version: 1, status: "ok" } });

    const rotated = await request(pc.listen, {
      method: "POST",
      pathname: "/api/manage/phone/rotate",
      token: first.managementToken,
      body: { version: 1 },
      timeoutMs: 15_000,
    });
    assert.equal(rotated.statusCode, 200, "rotation_status");
    assert.equal(rotated.body.version, 1, "rotation_version");
    assert.equal(typeof rotated.body.phoneConfig, "string", "rotation_phone_config");
    assert.match(rotated.body.relayToken, /^[0-9a-f]{64}$/);
    assert.notEqual(rotated.body.relayToken, first.relayToken, "rotation_token_unchanged");

    await websocketProbe(pc.listen, first.relayToken, false);

    const oldPhoneAfter = await createSidecar(oldPhoneConfig);
    active.push(oldPhoneAfter.sidecar);
    await assertHealthRejected(oldPhoneAfter.listen);
    await oldPhoneAfter.sidecar.dispose();
    active.splice(active.indexOf(oldPhoneAfter.sidecar), 1);

    const newPhoneConfig = parseWgConfig(rotated.body.phoneConfig, first.relayUrl);
    const newPhone = await createSidecar(newPhoneConfig);
    active.push(newPhone.sidecar);
    await assertHealth(newPhone.listen);
    await websocketProbe(newPhone.listen, rotated.body.relayToken, true);
  } finally {
    await Promise.allSettled(active.map((sidecar) => sidecar.dispose()));
  }
})().catch(() => {
  process.exitCode = 1;
});
NODE

set_phase "complete"
printf '%s\n' \
  'WireGuard Relay VPS smoke checklist (secrets redacted)' \
  '[PASS] idempotent deployment 1/2 and 2/2' \
  '[PASS] systemd enable/active: WireGuard + Relay' \
  '[PASS] only WireGuard UDP is public; public Relay TCP exposure rejected' \
  '[PASS] built sidecar health through the WireGuard tunnel' \
  '[PASS] old WireGuard key rejection after rotation' \
  '[PASS] old Relay token rejection after rotation' \
  '[PASS] new phone key/token accepted' \
  '[REDACTED] host, password, configs, keys, and tokens'
