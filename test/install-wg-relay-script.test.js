"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseReadback } = require("../src/wg-relay-deploy");

const INSTALLER_PATH = path.join(__dirname, "..", "relay", "install-wg-relay.sh");
const SOURCE = fs.readFileSync(INSTALLER_PATH, "utf8");

function linesMatching(pattern) {
  return SOURCE.split("\n").filter((line) => pattern.test(line));
}

describe("persistent WireGuard Relay installer source contracts", () => {
  it("is executable as an uploaded installer", () => {
    assert.notEqual(fs.statSync(INSTALLER_PATH).mode & 0o111, 0);
  });

  it("requires a running systemd and has no silent non-systemd fallback", () => {
    assert.match(SOURCE, /command -v systemctl[^\n]*\|\|[^\n]*die/);
    assert.match(SOURCE, /\/run\/systemd\/system/);
    assert.doesNotMatch(SOURCE, /relay unit skipped|tunnel still up|直接 wg-quick/);
  });

  it("gates filesystem-root and failure shims behind explicit test mode", () => {
    assert.match(SOURCE, /TEST_MODE=[^\n]*CLAWD_INSTALL_TEST_MODE/);
    assert.match(SOURCE, /if \[ "\$\{TEST_MODE\}" = "1" \]; then[\s\S]*CLAWD_INSTALL_ROOT/);
    assert.match(SOURCE, /TEST_MODE[^\n]*= "1"[^\n]*CLAWD_INSTALL_FAIL_STAGE/);
    assert.match(SOURCE, /INSTALL_ROOT=""/);
  });

  it("supports apt, dnf and yum and installs wireguard-tools", () => {
    assert.match(SOURCE, /apt-get[\s\S]*install[^\n]*wireguard-tools/);
    assert.match(SOURCE, /dnf[\s\S]*install[^\n]*wireguard-tools/);
    assert.match(SOURCE, /yum[\s\S]*install[^\n]*wireguard-tools/);
  });

  it("installs the cryptographic runtime used to generate 256-bit tokens", () => {
    assert.match(SOURCE, /apt-get install[^\n]*openssl/);
    assert.match(SOURCE, /dnf install[^\n]*openssl/);
    assert.match(SOURCE, /yum install[^\n]*openssl/);
    assert.match(SOURCE, /openssl rand -hex 32/);
  });

  it("always installs a pinned complete official Node runtime and revalidates its checksum", () => {
    assert.match(SOURCE, /NODE_MIN_MAJOR=["']?18/);
    assert.match(SOURCE, /NODE_RELEASE=["']?v22\.17\.0/);
    assert.match(SOURCE, /nodejs\.org\/dist/);
    assert.match(SOURCE, /sha256sum[^\n]*-c/);
    assert.match(SOURCE, /runtime-cache/);
    assert.doesNotMatch(SOURCE, /NODE_SOURCE=system|SYSTEM_NODE|NODE_SOURCE=current|NODE_SOURCE=legacy/);
    assert.doesNotMatch(SOURCE, /command -v (?:docker|npm|git)\b/);
  });

  it("validates all interpolated inputs and acquires the shared lock before mutation", () => {
    assert.match(SOURCE, /validate_inputs/);
    assert.match(SOURCE, /65535/);
    assert.match(SOURCE, /FORCE_RESET_ALL[^\n]*0[^\n]*1/);
    assert.match(SOURCE, /clawd-relay\.lock/);
    assert.match(SOURCE, /command -v flock[^\n]*die/);
    assert.match(SOURCE, /exec 9>[^\n]*LOCK_FILE/);
    assert.match(SOURCE, /flock -x -w[^\n]*9/);
    assert.doesNotMatch(SOURCE, /mkdir[^\n]*LOCK_(?:DIR|FILE)/);
    assert.ok(SOURCE.indexOf("\nacquire_lock\ncheckpoint lock-acquired") < SOURCE.indexOf("mktemp -d \"${VAR_TMP_FS}"));
  });

  it("requires the whole production installer to run as root and validates the lock inode", () => {
    assert.match(SOURCE, /if \[ "\$\{TEST_MODE\}" != "1" \] && \[ "\$\(id -u\)" -ne 0 \]; then\s+die 13/);
    assert.doesNotMatch(SOURCE, /SUDO=|sudo -n true|\$SUDO/);
    assert.match(SOURCE, /-L[^\n]*LOCK_FILE_FS|LOCK_FILE_FS[^\n]*-L/);
    assert.match(SOURCE, /fd_path="\/proc\/self\/fd\/9"[\s\S]*fd_path="\/dev\/fd\/9"/);
    assert.match(SOURCE, /stat -Lc[^\n]*fd_path/);
    assert.doesNotMatch(SOURCE, /stat -Lc[^\n]*%F/);
    assert.match(SOURCE, /-f[^\n]*fd_path|fd_path[^\n]*-f/);
    assert.match(SOURCE, /mode[^\n]*0600|0600[^\n]*mode/i);
  });

  it("stages app and Node together and atomically switches the dedicated current link", () => {
    assert.match(SOURCE, /SCRIPT_DIR=.*dirname/);
    assert.match(SOURCE, /CURRENT=["']?\/opt\/clawd-relay\/current/);
    assert.match(SOURCE, /node_modules\/ws/);
    assert.match(SOURCE, /APP_SOURCE=[^\n]*SCRIPT_DIR[^\n]*app/);
    assert.match(SOURCE, /cp[^\n]*APP_SOURCE[^\n]*RELEASE_APP_FS/);
    assert.match(SOURCE, /atomic_link[^\n]*RELEASE_FS[^\n]*CURRENT_FS/);
    assert.doesNotMatch(SOURCE, /rm[^\n]*CURRENT_FS[^\n]*mv/);
  });

  it("writes Relay environment, WireGuard config and every key file as 0600", () => {
    assert.match(SOURCE, /RELAY_ENV=["']?\/etc\/clawd-relay\/relay\.env/);
    assert.match(SOURCE, /chmod 600[^\n]*RELAY_ENV/);
    assert.match(SOURCE, /chmod 600[^\n]*WG_CONF/);
    assert.match(SOURCE, /find[^\n]*WG_KEY_DIR[^\n]*-exec chmod 600/);
  });

  it("generates a single-port systemd fixture with all private-network management paths", () => {
    assert.match(SOURCE, /EnvironmentFile=\/etc\/clawd-relay\/relay\.env/);
    assert.match(SOURCE, /ExecStart=\/opt\/clawd-relay\/current\/node\/bin\/node \/opt\/clawd-relay\/current\/app\/relay-server\.js/);
    for (const key of [
      "BIND_ADDR", "PC_IP", "PHONE_IP", "WG_SUBNET", "WG_ENDPOINT",
      "WG_INTERFACE", "WG_CONFIG_PATH", "WG_KEY_DIR", "PHONE_PRIVATE_KEY_PATH",
      "PHONE_PUBLIC_KEY_PATH", "SERVER_PUBLIC_KEY_PATH", "PHONE_ROTATION_JOURNAL_PATH",
      "RELAY_ENV_PATH",
    ]) {
      assert.match(SOURCE, new RegExp(`^${key}=`, "m"));
    }
    assert.match(SOURCE, /BIND_ADDR=\$\{SERVER_IP\}/);
  });

  it("enables and verifies both services without best-effort success", () => {
    assert.match(SOURCE, /systemctl enable[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl is-enabled[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl is-active[^\n]*wg-quick@\$\{IFACE\}/);
    assert.match(SOURCE, /systemctl enable[^\n]*clawd-relay/);
    assert.match(SOURCE, /systemctl is-enabled[^\n]*clawd-relay/);
    assert.match(SOURCE, /systemctl is-active[^\n]*clawd-relay/);
    assert.deepEqual(linesMatching(/systemctl.*\|\|\s*true/), []);
  });

  it("runs production health and strict-Bearer probes before a stable service window", () => {
    assert.match(SOURCE, /probe_relay_service/);
    assert.match(SOURCE, /\/health/);
    assert.match(SOURCE, /unexpected-response/);
    assert.match(SOURCE, /Authorization[^\n]*Bearer/);
    assert.match(SOURCE, /verify_relay_stability/);
    assert.ok(SOURCE.indexOf("probe_relay_service") < SOURCE.indexOf("COMMITTED=1"));
  });

  it("sandboxes the Relay while retaining only its required writable paths and capability", () => {
    for (const setting of [
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "ProtectHome=true",
      "ProtectSystem=strict",
      "ReadWritePaths=/etc/clawd-relay /etc/wireguard /run/lock",
      "CapabilityBoundingSet=CAP_NET_ADMIN",
    ]) assert.match(SOURCE, new RegExp(`^${setting}$`, "m"));
  });

  it("opens only WireGuard UDP and never Relay TCP", () => {
    assert.match(SOURCE, /ufw allow[^\n]*WG_PORT[^\n]*udp/);
    assert.match(SOURCE, /firewall-cmd[^\n]*WG_PORT[^\n]*udp/);
    assert.match(SOURCE, /ip6tables/);
    assert.match(SOURCE, /clawd-relay-firewall\.service/);
    assert.match(SOURCE, /die 14 ["']no supported firewall backend/);
    assert.doesNotMatch(SOURCE, /(?:ufw|firewall-cmd|iptables)[^\n]*(?:RELAY_PORT|7891)[^\n]*(?:tcp|TCP)/);
  });

  it("persists 0600 ownership metadata and migrates only installer-owned firewall state", () => {
    assert.match(SOURCE, /FIREWALL_METADATA/);
    assert.match(SOURCE, /chmod 600[^\n]*FIREWALL_METADATA/);
    assert.match(SOURCE, /OLD_FIREWALL_BACKEND/);
    assert.match(SOURCE, /remove_obsolete_firewall/);
  });

  it("uses same-directory temp-file renames and emits strict schemaVersion 1 readback", () => {
    assert.match(SOURCE, /mktemp[^\n]*RELAY_ETC_FS/);
    assert.match(SOURCE, /mv[^\n]*RELAY_ENV_TMP[^\n]*RELAY_ENV_FS/);
    assert.match(SOURCE, /mktemp[^\n]*WG_DIR_FS/);
    assert.match(SOURCE, /mv[^\n]*WG_CONF_TMP[^\n]*WG_CONF_FS/);
    assert.match(SOURCE, /<<<CLAWD_JSON>>>/);
    assert.match(SOURCE, /"schemaVersion":1/);
    for (const field of [
      "endpoint", "subnet", "relayUrl", "pcConfig", "phoneConfig", "relayToken", "managementToken",
    ]) {
      assert.match(SOURCE, new RegExp(`"${field}"`));
    }
  });

  it("marks the install committed only after the complete readback JSON is constructed", () => {
    const readbackIndex = SOURCE.indexOf("READBACK_JSON=");
    const committedIndex = SOURCE.indexOf("COMMITTED=1");
    assert.ok(readbackIndex > 0);
    assert.ok(committedIndex > readbackIndex);
    assert.match(SOURCE, /printf '%s' "\$\{READBACK_JSON\}"/);
  });

});

const MUTATION_STAGES = [
  "release-staged",
  "current-switch",
  "wireguard-keys",
  "wireguard-config",
  "relay-environment",
  "systemd-unit",
  "firewall-rule",
  "firewall-migration",
  "wireguard-service",
  "relay-service",
  "readback",
];

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function createCommandShims(binDir) {
  const prelude = `#!/usr/bin/env bash\nset -euo pipefail\nSTATE_DIR=\"\${CLAWD_INSTALL_TEST_STATE:?}\"\n`;
  writeExecutable(path.join(binDir, "id"), `#!/usr/bin/env bash\n[ \"\${1:-}\" = -u ] && printf '501\\n'\n`);
  writeExecutable(path.join(binDir, "sudo"), `${prelude}printf 'called\\n' >> "$STATE_DIR/sudo-operations"\nexit 1\n`);
  writeExecutable(path.join(binDir, "stat"), `${prelude}
if [ "\${1:-}" = -Lc ]; then
  target="\${3}"
  if [ -n "\${CLAWD_TEST_LOCK_STAT:-}" ] && { [ "$target" = "$CLAWD_INSTALL_ROOT/run/lock/clawd-relay.lock" ] || [ "$target" = /dev/fd/9 ]; }; then
    "$CLAWD_INSTALL_TEST_NODE_SOURCE" -e 'const fs=require("fs");const target=process.argv[1];const s=target==="/dev/fd/9"?fs.fstatSync(9):fs.statSync(target);const forced=process.argv[2].split(":");const type=s.size===0?"regular empty file":"regular file";const suffix=process.argv[3].includes("%F")?":"+type:"";process.stdout.write(String(s.dev)+":"+String(s.ino)+":"+forced[0]+":"+forced[1]+suffix+"\\n")' "$target" "$CLAWD_TEST_LOCK_STAT" "${2}"
    exit 0
  fi
  "$CLAWD_INSTALL_TEST_NODE_SOURCE" -e 'const fs=require("fs");const target=process.argv[1];const s=target==="/dev/fd/9"?fs.fstatSync(9):fs.statSync(target);const type=s.isFile()?(s.size===0?"regular empty file":"regular file"):"other";const suffix=process.argv[2].includes("%F")?":"+type:"";process.stdout.write(String(s.dev)+":"+String(s.ino)+":"+String(s.uid)+":"+((s.mode&0o777).toString(8))+suffix+"\\n")' "$target" "${2}"
  exit 0
fi
if [ "\${1:-}" = -c ] && [ "\${2:-}" = %u:%a ]; then
  "$CLAWD_INSTALL_TEST_NODE_SOURCE" -e 'const fs=require("fs");const s=fs.lstatSync(process.argv[1]);process.stdout.write(String(s.uid)+":"+((s.mode&0o777).toString(8))+"\\n")' "\${3}"
  exit 0
fi
exec /usr/bin/stat "$@"
`);
  writeExecutable(path.join(binDir, "flock"), `#!/usr/bin/env python3
import errno, fcntl, sys, time
args = sys.argv[1:]
timeout = 0.0
if args[:1] == ["-x"]: args = args[1:]
if args[:1] == ["-w"]:
    timeout = float(args[1]); args = args[2:]
fd = int(args[0])
deadline = time.monotonic() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sys.exit(0)
    except OSError as error:
        if error.errno not in (errno.EACCES, errno.EAGAIN) or time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.005)
`);
  writeExecutable(path.join(binDir, "mkdir"), `${prelude}
set +e
/bin/mkdir "$@"
status=$?
set -e
if [ "$status" -eq 0 ]; then
  for candidate in "$@"; do
    case "$candidate" in "$CLAWD_INSTALL_ROOT"/*) printf '%s\n' "$candidate" >> "$STATE_DIR/installer-mutations" ;; esac
  done
fi
exit "$status"
`);
  writeExecutable(path.join(binDir, "rm"), `${prelude}
for candidate in "$@"; do
  case "$candidate" in
    "$CLAWD_INSTALL_ROOT/opt/clawd-relay/app"|"$CLAWD_INSTALL_ROOT/opt/clawd-relay/node")
      if [ -d "$candidate" ] && [ ! -L "$candidate" ]; then
        printf '%s\\n' "$candidate" >> "$STATE_DIR/legacy-remove-attempts"
        exit 99
      fi
      ;;
  esac
done
exec /bin/rm "$@"
`);
  writeExecutable(path.join(binDir, "apt-get"), `${prelude}exit 0\n`);
  writeExecutable(path.join(binDir, "modprobe"), `${prelude}exit 0\n`);
  writeExecutable(path.join(binDir, "uname"), `${prelude}
[ "\${1:-}" = -m ] || exit 2
printf '%s\n' "\${CLAWD_TEST_UNAME_M:-x86_64}"
`);
  writeExecutable(path.join(binDir, "curl"), `${prelude}
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-Lo|-SLo|-fsSLo) output="\${2:-}"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> "$STATE_DIR/curl-urls"
case "$url" in
  https://nodejs.org/dist/*/SHASUMS256.txt)
    cp "$CLAWD_INSTALL_TEST_NODE_MANIFEST" "$output"
    exit 0
    ;;
  https://nodejs.org/dist/*/node-*-linux-*.tar.gz)
    cp "$CLAWD_INSTALL_TEST_NODE_ARCHIVE" "$output"
    exit 0
    ;;
esac
if [ "$url" = https://api.ipify.org ] && [ -n "\${CLAWD_TEST_DISCOVERED_ENDPOINT:-}" ]; then
  printf '%s' "$CLAWD_TEST_DISCOVERED_ENDPOINT"
  exit 0
fi
exit 1
`);
  writeExecutable(path.join(binDir, "wg-quick"), `${prelude}[ \"\${1:-}\" = strip ]\ncat \"\${2}\" >/dev/null\n`);
  writeExecutable(path.join(binDir, "wg-quick"), `${prelude}
[ "\${1:-}" = strip ] || exit 2
"$CLAWD_INSTALL_TEST_NODE_SOURCE" - "\${2}" <<'NODE'
const fs = require("fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const lines = source.split(/\\r?\\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
let section = null;
const sections = [];
for (const line of lines) {
  if (/^\\[(Interface|Peer)\\]$/.test(line)) {
    section = { name: line.slice(1, -1), fields: new Map() };
    sections.push(section);
    continue;
  }
  if (!section) process.exit(3);
  const match = line.match(/^([A-Za-z]+)\\s*=\\s*(\\S+)$/);
  if (!match || section.fields.has(match[1])) process.exit(4);
  section.fields.set(match[1], match[2]);
}
const exact = (value, names) => value.fields.size === names.length && names.every((name) => value.fields.has(name));
if (sections.length !== 3 || sections[0].name !== "Interface" || sections[1].name !== "Peer" || sections[2].name !== "Peer") process.exit(5);
if (!exact(sections[0], ["Address", "ListenPort", "PrivateKey"]) || !exact(sections[1], ["PublicKey", "AllowedIPs"]) || !exact(sections[2], ["PublicKey", "AllowedIPs"])) process.exit(6);
const base = process.env.WG_SUBNET.slice(0, -5);
if (sections[0].fields.get("Address") !== base + ".1/24" || !/^\\d{1,5}$/.test(sections[0].fields.get("ListenPort"))) process.exit(7);
if (sections[1].fields.get("AllowedIPs") !== base + ".2/32" || sections[2].fields.get("AllowedIPs") !== base + ".3/32") process.exit(8);
for (const value of sections) for (const [name, field] of value.fields) if (name.includes("Key") && !/^[A-Za-z0-9+/]{43}=$/.test(field)) process.exit(9);
NODE
cat "\${2}"
`);
  writeExecutable(path.join(binDir, "wg"), `${prelude}
case \"\${1:-}\" in
  genkey)
    counter_file=\"$STATE_DIR/key-counter\"
    counter=0; [ ! -f \"$counter_file\" ] || counter=$(cat \"$counter_file\")
    counter=$((counter + 1)); printf '%s' \"$counter\" > \"$counter_file\"
    \"$CLAWD_INSTALL_TEST_NODE_SOURCE\" -e 'process.stdout.write(Buffer.alloc(32, Number(process.argv[1]) % 256).toString(\"base64\") + \"\\n\")' \"$counter\"
    ;;
  pubkey)
    IFS= read -r private
    printf '%s' \"$private\" | \"$CLAWD_INSTALL_TEST_NODE_SOURCE\" -e 'const crypto=require(\"crypto\");let value=\"\";process.stdin.on(\"data\",c=>value+=c);process.stdin.on(\"end\",()=>process.stdout.write(crypto.createHash(\"sha256\").update(value).digest(\"base64\") + \"\\n\"));'
    ;;
  show) exit 0 ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(binDir, "systemctl"), `${prelude}
command=\"\${1:-}\"; shift || true
if [ \"$command\" = daemon-reload ]; then exit 0; fi
service=\"\${*: -1}\"; service=\"\${service%.service}\"
file=\"$STATE_DIR/service-$service\"
[ -f \"$file\" ] || printf 'disabled inactive\\n' > \"$file\"
read -r enabled active < \"$file\"
case \"$command\" in
  is-enabled) [ \"$enabled\" = enabled ] ;;
  is-active)
    if [ \"$service\" = clawd-relay ] && [ \"$active\" = active ] && [ \"\${CLAWD_TEST_CRASH_DURING_STABILITY:-0}\" = 1 ]; then
      count_file=\"$STATE_DIR/relay-active-check-count\"
      count=0; [ ! -f \"$count_file\" ] || count=$(cat \"$count_file\")
      count=$((count + 1)); printf '%s' \"$count\" > \"$count_file\"
      if [ \"$count\" -ge 2 ]; then
        printf '1\\n' > \"$STATE_DIR/relay-restarts\"
      fi
    fi
    [ \"$active\" = active ]
    ;;
  show)
    if [ \"$service\" = clawd-relay ]; then
      printf '%s\\n' \"$(cat \"$STATE_DIR/relay-pid\")\"
      if [ -f \"$STATE_DIR/relay-restarts\" ]; then cat \"$STATE_DIR/relay-restarts\"; else printf '0\\n'; fi
    else
      printf '0\\n0\\n'
    fi
    exit 0
    ;;
  enable) enabled=enabled ;;
  disable) enabled=disabled ;;
  start|restart)
    if [ "$service" = clawd-relay ]; then
      unit="$CLAWD_INSTALL_ROOT/etc/systemd/system/clawd-relay.service"
      environment_file="$(sed -n 's/^EnvironmentFile=//p' "$unit")"
      exec_start="$(sed -n 's/^ExecStart=//p' "$unit")"
      [ -n "$environment_file" ] && [ -n "$exec_start" ]
      CLAWD_INSTALL_TEST_UNIT_ENVIRONMENT="$environment_file" CLAWD_INSTALL_TEST_UNIT_EXEC_START="$exec_start" "$CLAWD_INSTALL_TEST_SMOKE_START" start
    fi
    if [ "$service" = clawd-relay-firewall ]; then
      unit="$CLAWD_INSTALL_ROOT/etc/systemd/system/clawd-relay-firewall.service"
      grep -q '^ExecStart=.*iptables.*ip6tables' "$unit"
      firewall_port="$(sed -n 's/.*--dport \\([0-9][0-9]*\\).*/\\1/p' "$unit" | head -1)"
      [ -n "$firewall_port" ]
      iptables -C INPUT -p udp --dport "$firewall_port" -j ACCEPT 2>/dev/null || iptables -A INPUT -p udp --dport "$firewall_port" -j ACCEPT
      ip6tables -C INPUT -p udp --dport "$firewall_port" -j ACCEPT 2>/dev/null || ip6tables -A INPUT -p udp --dport "$firewall_port" -j ACCEPT
    fi
    active=active
    ;;
  stop)
    if [ "$service" = clawd-relay ]; then "$CLAWD_INSTALL_TEST_SMOKE_START" stop; fi
    active=inactive
    ;;
  *) exit 2 ;;
esac
printf '%s %s\\n' \"$enabled\" \"$active\" > \"$file\"
`);
  writeExecutable(path.join(binDir, "ufw"), `${prelude}
rule=\"$STATE_DIR/firewall-udp\"
case \"\${1:-}\" in
  status)
    if [ \"\${CLAWD_TEST_UFW_INACTIVE:-0}\" = 1 ]; then printf 'Status: inactive\\n'; exit 0; fi
    [ \"\${CLAWD_TEST_FIREWALL:-ufw}\" = ufw ] || exit 1
    printf 'Status: active\\n'
    if [ -f \"$rule\" ]; then
      while IFS= read -r port; do
        [ -z \"$port\" ] || printf '%s/udp ALLOW Anywhere\\n%s/udp (v6) ALLOW Anywhere (v6)\\n' \"$port\" \"$port\"
      done < \"$rule\"
    else
      case \"\${CLAWD_TEST_UFW_STATUS:-empty}\" in
        allow) printf '51820/udp ALLOW Anywhere\\n51820/udp (v6) ALLOW Anywhere (v6)\\n' ;;
        deny) printf '51820/udp DENY Anywhere\\n51820/udp (v6) DENY Anywhere (v6)\\n' ;;
        near) printf '151820/udp ALLOW Anywhere\\n151820/udp (v6) ALLOW Anywhere (v6)\\n' ;;
        v4only) printf '51820/udp ALLOW Anywhere\\n' ;;
      esac
    fi
    ;;
  allow)
    port=\"\${2%/udp}\"
    { [ ! -f \"$rule\" ] || ! grep -qx \"$port\" \"$rule\"; } && printf '%s\\n' \"$port\" >> \"$rule\"
    printf 'add\\n' >> \"$STATE_DIR/ufw-operations\"
    ;;
  --force)
    if [ \"\${2:-}\" = delete ] && [ \"\${3:-}\" = allow ]; then
      port=\"\${4%/udp}\"
      if [ -f \"$rule\" ]; then
        grep -vx \"$port\" \"$rule\" > \"$rule.next\" || true
        if [ -s \"$rule.next\" ]; then mv \"$rule.next\" \"$rule\"; else rm -f \"$rule\" \"$rule.next\"; fi
      fi
      printf 'remove\\n' >> \"$STATE_DIR/ufw-operations\"
    fi
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(binDir, "firewall-cmd"), `${prelude}
rule=\"$STATE_DIR/firewalld-permanent-udp\"
runtime=\"$STATE_DIR/firewalld-runtime-udp\"
known=\"$STATE_DIR/firewalld-known\"
if [ \"\${CLAWD_TEST_FIREWALL:-ufw}\" = firewalld ]; then touch \"$known\"; else [ -f \"$known\" ] || exit 1; fi
case \"\${1:-}\" in
  --state) printf 'running\\n' ;;
  --permanent)
    case \"\${2:-}\" in
      --query-port=*) [ -f \"$rule\" ] ;;
      --add-port=*)
        printf '%s' \"\${2#--add-port=}\" > \"$rule\"
        printf 'add\\n' >> \"$STATE_DIR/firewalld-operations\"
        ;;
      --remove-port=*)
        rm -f \"$rule\"
        printf 'remove\\n' >> \"$STATE_DIR/firewalld-operations\"
        ;;
      *) exit 2 ;;
    esac
    ;;
  --reload)
    count_file=\"$STATE_DIR/firewalld-reload-count\"
    count=0; [ ! -f \"$count_file\" ] || count=$(cat \"$count_file\")
    count=$((count + 1)); printf '%s' \"$count\" > \"$count_file\"
    if [ \"\${CLAWD_TEST_FIREWALLD_FAIL_FIRST_RELOAD:-0}\" = 1 ] && [ \"$count\" = 1 ]; then exit 1; fi
    if [ -f \"$rule\" ]; then cp \"$rule\" \"$runtime\"; else rm -f \"$runtime\"; fi
    ;;
  --query-port=*) [ -f \"$runtime\" ] ;;
  *) exit 2 ;;
esac
`);
  const iptablesShim = `${prelude}
family="$(basename "$0")"
rule="$STATE_DIR/$family-udp"
[ "\${CLAWD_TEST_FIREWALL:-ufw}" = iptables ] || [ -f "$rule" ] || exit 2
case "\${1:-}" in
  -C) [ -f "$rule" ] && grep -qx "\${6:-}" "$rule" ;;
  -A)
    { [ ! -f "$rule" ] || ! grep -qx "\${6:-}" "$rule"; } && printf '%s\\n' "\${6:-}" >> "$rule"
    printf 'add\\n' >> "$STATE_DIR/$family-operations"
    ;;
  -D)
    if [ -f "$rule" ]; then
      grep -vx "\${6:-}" "$rule" > "$rule.next" || true
      if [ -s "$rule.next" ]; then mv "$rule.next" "$rule"; else rm -f "$rule" "$rule.next"; fi
    fi
    printf 'remove\\n' >> "$STATE_DIR/$family-operations"
    ;;
  *) exit 2 ;;
esac
`;
  writeExecutable(path.join(binDir, "iptables"), iptablesShim);
  writeExecutable(path.join(binDir, "ip6tables"), iptablesShim);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: false });
}

function createVerifiedNodeFixture(root) {
  const staging = path.join(root, "node-archive-source", "node-v22.17.0-linux-x64");
  fs.mkdirSync(path.join(staging, "bin"), { recursive: true });
  fs.mkdirSync(path.join(staging, "lib", "node_modules", "corepack"), { recursive: true });
  writeExecutable(
    path.join(staging, "bin", "node"),
    "#!/usr/bin/env bash\nexec \"$CLAWD_INSTALL_TEST_NODE_SOURCE\" \"$@\"\n",
  );
  fs.writeFileSync(path.join(staging, "lib", "node_modules", "corepack", "package.json"), "{\"name\":\"corepack\"}\n");
  fs.writeFileSync(path.join(staging, "LICENSE"), "fixture complete runtime\n");
  const archive = path.join(root, "verified-node.tar.gz");
  const packed = childProcess.spawnSync("tar", ["-czf", archive, "-C", path.dirname(staging), path.basename(staging)], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const manifest = path.join(root, "SHASUMS256.txt");
  fs.writeFileSync(
    manifest,
    `${digest}  node-v22.17.0-linux-x64.tar.gz\n${digest}  node-v22.17.0-linux-arm64.tar.gz\n`,
  );
  return { archive, manifest };
}

function writeRelaySmokeFixture(root) {
  const smokeJs = path.join(root, "relay-smoke.js");
  fs.writeFileSync(smokeJs, `
"use strict";
const http = require("node:http");
const WebSocket = require(process.argv[4]);
const port = Number(process.argv[2]);
const token = process.argv[3];
function health() {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health" }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => response.statusCode === 200 && !body.includes(token) ? resolve() : reject(new Error("health smoke failed")));
    });
    request.once("error", reject);
  });
}
function rejected() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(\`ws://127.0.0.1:\${port}/mobile/ws?role=phone\`);
    ws.once("unexpected-response", (_request, response) => response.statusCode === 401 ? resolve() : reject(new Error("strict auth smoke failed")));
    ws.once("open", () => reject(new Error("missing Bearer upgraded")));
    ws.once("error", () => {});
  });
}
function accepted() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(\`ws://127.0.0.1:\${port}/mobile/ws?role=phone\`, { headers: { Authorization: \`Bearer \${token}\` } });
    ws.once("open", () => { ws.close(); resolve(); });
    ws.once("error", reject);
  });
}
(async () => {
  let last;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await health(); last = null; break; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  if (last) throw last;
  await rejected();
  await accepted();
})().catch((error) => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; });
`);
  const control = path.join(root, "relay-smoke-control");
  writeExecutable(control, `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="\${CLAWD_INSTALL_TEST_STATE:?}"
pid_file="$STATE_DIR/relay-pid"
if [ "\${1:-}" = stop ]; then
  if [ -f "$pid_file" ]; then kill -KILL "$(cat "$pid_file")" >/dev/null 2>&1 || true; rm -f "$pid_file"; fi
  exit 0
fi
if [ -f "$pid_file" ]; then kill -KILL "$(cat "$pid_file")" >/dev/null 2>&1 || true; rm -f "$pid_file"; fi
env_file="$CLAWD_INSTALL_ROOT\${CLAWD_INSTALL_TEST_UNIT_ENVIRONMENT:?}"
set -a
. "$env_file"
set +a
port="$("$CLAWD_INSTALL_TEST_NODE_SOURCE" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
printf '127.0.0.1\n' > "$STATE_DIR/relay-probe-host"
printf '%s\n' "$port" > "$STATE_DIR/relay-probe-port"
read -r unit_node unit_app extra <<< "\${CLAWD_INSTALL_TEST_UNIT_EXEC_START:?}"
[ -z "\${extra:-}" ]
unit_node="$CLAWD_INSTALL_ROOT$unit_node"
unit_app="$CLAWD_INSTALL_ROOT$unit_app"
current="$(dirname "$(dirname "$unit_app")")"
export BIND_ADDR=127.0.0.1 PORT="$port" CLAWD_INSTALL_TEST_MODE=1
export RELAY_ENV_PATH="$env_file" RELAY_LOCK_PATH="$CLAWD_INSTALL_ROOT/run/lock/clawd-relay.lock"
export WG_CONFIG_PATH="$CLAWD_INSTALL_ROOT/etc/wireguard/clawd.conf"
export WG_KEY_DIR="$CLAWD_INSTALL_ROOT/etc/wireguard/clawd"
export PHONE_PRIVATE_KEY_PATH="$WG_KEY_DIR/phone.key" PHONE_PUBLIC_KEY_PATH="$WG_KEY_DIR/phone.pub" SERVER_PUBLIC_KEY_PATH="$WG_KEY_DIR/server.pub"
if [ "\${CLAWD_TEST_RELAY_PORT_CONFLICT:-0}" = 1 ]; then
  "$CLAWD_INSTALL_TEST_NODE_SOURCE" -e 'require("http").createServer((_q,r)=>r.end("conflict")).listen(Number(process.argv[1]),"127.0.0.1")' "$port" 9>&- >"$STATE_DIR/relay.log" 2>&1 &
else
  "$unit_node" "$unit_app" 9>&- >"$STATE_DIR/relay.log" 2>&1 &
fi
printf '%s' "$!" > "$pid_file"
if [ "\${CLAWD_TEST_PROBE_FAILURE:-0}" = 1 ]; then
  for _ in $(seq 1 100); do grep -q server_started "$STATE_DIR/relay.log" && break; sleep 0.01; done
  sed 's/^RELAY_TOKEN=.*/RELAY_TOKEN=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/' "$env_file" > "$env_file.next"
  mv "$env_file.next" "$env_file"
  chmod 600 "$env_file"
fi
`);
  return control;
}

function createExecutableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-installer-test-"));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "command-state");
  const appSource = path.join(root, "uploaded-app");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, "run", "systemd", "system"), { recursive: true });
  fs.mkdirSync(path.join(root, "run", "lock"), { recursive: true });
  fs.mkdirSync(path.join(appSource, "node_modules"), { recursive: true });
  for (const name of ["relay-server.js", "pair-registry.js", "relay-token-store.js", "wg-management.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", "relay", name), path.join(appSource, name));
  }
  copyDirectory(path.join(__dirname, "..", "node_modules", "ws"), path.join(appSource, "node_modules", "ws"));
  const nodeFixture = createVerifiedNodeFixture(root);
  const smokeControl = writeRelaySmokeFixture(root);
  createCommandShims(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CLAWD_INSTALL_TEST_MODE: "1",
    CLAWD_INSTALL_ROOT: root,
    CLAWD_INSTALL_TEST_STATE: stateDir,
    CLAWD_INSTALL_APP_SOURCE: appSource,
    CLAWD_INSTALL_TEST_NODE_SOURCE: process.execPath,
    CLAWD_INSTALL_TEST_NODE_ARCHIVE: nodeFixture.archive,
    CLAWD_INSTALL_TEST_NODE_MANIFEST: nodeFixture.manifest,
    CLAWD_INSTALL_TEST_SMOKE_START: smokeControl,
    CLAWD_INSTALL_FORCE_BUNDLED_NODE: "1",
    ENDPOINT_HOST: "8.8.4.4",
    WG_SUBNET: "10.8.0.0/24",
  };

  t.after(() => {
    const pidFile = path.join(stateDir, "relay-pid");
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    binDir,
    stateDir,
    environment: env,
    nodeArchive: nodeFixture.archive,
    nodeManifest: nodeFixture.manifest,
    run(extraEnv = {}) {
      return childProcess.spawnSync(INSTALLER_PATH, [], {
        cwd: path.dirname(INSTALLER_PATH),
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 60_000,
      });
    },
  };
}

function installedSecrets(root) {
  const keys = path.join(root, "etc", "wireguard", "clawd");
  const env = fs.readFileSync(path.join(root, "etc", "clawd-relay", "relay.env"), "utf8");
  const value = (name) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  return {
    server: fs.readFileSync(path.join(keys, "server.key"), "utf8"),
    pc: fs.readFileSync(path.join(keys, "pc.key"), "utf8"),
    phone: fs.readFileSync(path.join(keys, "phone.key"), "utf8"),
    relayToken: value("RELAY_TOKEN"),
    managementToken: value("MANAGEMENT_TOKEN"),
  };
}

function installedFirewallMetadata(root) {
  const file = path.join(root, "etc", "clawd-relay", "firewall.env");
  const values = Object.fromEntries(fs.readFileSync(file, "utf8").trim().split("\n").map((line) => line.split("=", 2)));
  return { file, values };
}

function validatePrivilegedIntegration({
  env,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  markerPath = "/root/.clawd-relay-disposable-vps",
  expectedMarkerUid = 0,
} = {}) {
  if (!env || env.CLAWD_RUN_PRIVILEGED_INSTALL_INTEGRATION !== "1") return { enabled: false };
  if (platform !== "linux") throw new Error("privileged integration requires Linux");
  if (uid !== 0) throw new Error("privileged integration requires root");
  const nonce = env.CLAWD_PRIVILEGED_VPS_NONCE;
  if (typeof nonce !== "string" || !/^[a-f0-9]{32,128}$/.test(nonce)) {
    throw new Error("CLAWD_PRIVILEGED_VPS_NONCE is required");
  }
  let stat;
  try { stat = fs.lstatSync(markerPath); } catch { throw new Error("disposable VPS marker is required"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedMarkerUid) {
    throw new Error("disposable VPS marker must be a root-owned regular file");
  }
  if ((stat.mode & 0o777) !== 0o600) throw new Error("disposable VPS marker must be mode 0600");
  const markerNonce = fs.readFileSync(markerPath, "utf8").trim();
  if (markerNonce !== nonce) throw new Error("disposable VPS marker nonce does not match");
  return { enabled: true, markerPath };
}

const PRIVILEGED_INSTALL_PATHS = [
  "/opt/clawd-relay",
  "/etc/clawd-relay",
  "/etc/wireguard/clawd",
  "/etc/wireguard/clawd.conf",
  "/etc/systemd/system/clawd-relay.service",
  "/etc/systemd/system/clawd-relay-firewall.service",
  "/run/lock/clawd-relay.lock",
];

function runPrivilegedCommand(file, args, { allowFailure = false } = {}) {
  const result = childProcess.spawnSync(file, args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(file)} cleanup command failed`);
  }
  return result;
}

function cleanupPrivilegedInstall(metadata) {
  runPrivilegedCommand("systemctl", ["stop", "clawd-relay.service"], { allowFailure: true });
  runPrivilegedCommand("systemctl", ["disable", "clawd-relay.service"], { allowFailure: true });
  runPrivilegedCommand("systemctl", ["stop", "wg-quick@clawd.service"], { allowFailure: true });
  runPrivilegedCommand("systemctl", ["disable", "wg-quick@clawd.service"], { allowFailure: true });
  runPrivilegedCommand("systemctl", ["stop", "clawd-relay-firewall.service"], { allowFailure: true });
  runPrivilegedCommand("systemctl", ["disable", "clawd-relay-firewall.service"], { allowFailure: true });

  if (metadata) {
    const port = metadata.PORT;
    if (metadata.BACKEND === "ufw" && (metadata.IPV4 === "1" || metadata.IPV6 === "1")) {
      runPrivilegedCommand("ufw", ["--force", "delete", "allow", `${port}/udp`]);
    } else if (metadata.BACKEND === "firewalld" && (metadata.IPV4 === "1" || metadata.IPV6 === "1")) {
      runPrivilegedCommand("firewall-cmd", ["--permanent", `--remove-port=${port}/udp`]);
      runPrivilegedCommand("firewall-cmd", ["--reload"]);
    } else if (metadata.BACKEND === "iptables") {
      if (metadata.IPV4 === "1") {
        runPrivilegedCommand("iptables", ["-D", "INPUT", "-p", "udp", "--dport", port, "-j", "ACCEPT"]);
      }
      if (metadata.IPV6 === "1") {
        runPrivilegedCommand("ip6tables", ["-D", "INPUT", "-p", "udp", "--dport", port, "-j", "ACCEPT"]);
      }
    }
  }
  for (const target of PRIVILEGED_INSTALL_PATHS) fs.rmSync(target, { recursive: true, force: true });
  runPrivilegedCommand("systemctl", ["daemon-reload"]);
}

function verifyPrivilegedCleanup(metadata) {
  for (const target of PRIVILEGED_INSTALL_PATHS) assert.equal(fs.existsSync(target), false, target);
  assert.deepEqual(
    fs.readdirSync("/var/tmp").filter((name) => name.startsWith("clawd-relay-backup.")),
    [],
  );
  for (const service of ["clawd-relay.service", "wg-quick@clawd.service", "clawd-relay-firewall.service"]) {
    assert.notEqual(runPrivilegedCommand("systemctl", ["is-active", "--quiet", service], { allowFailure: true }).status, 0);
    assert.notEqual(runPrivilegedCommand("systemctl", ["is-enabled", "--quiet", service], { allowFailure: true }).status, 0);
  }
  if (!metadata) return;
  const port = metadata.PORT;
  if (metadata.BACKEND === "ufw" && (metadata.IPV4 === "1" || metadata.IPV6 === "1")) {
    const status = runPrivilegedCommand("ufw", ["status"]).stdout.split(/\r?\n/);
    assert.equal(status.some((line) => line.trim().startsWith(`${port}/udp`) && /\bALLOW\b/.test(line)), false);
  } else if (metadata.BACKEND === "firewalld" && (metadata.IPV4 === "1" || metadata.IPV6 === "1")) {
    assert.notEqual(runPrivilegedCommand("firewall-cmd", ["--permanent", `--query-port=${port}/udp`], { allowFailure: true }).status, 0);
  } else if (metadata.BACKEND === "iptables") {
    if (metadata.IPV4 === "1") {
      assert.notEqual(runPrivilegedCommand("iptables", ["-C", "INPUT", "-p", "udp", "--dport", port, "-j", "ACCEPT"], { allowFailure: true }).status, 0);
    }
    if (metadata.IPV6 === "1") {
      assert.notEqual(runPrivilegedCommand("ip6tables", ["-C", "INPUT", "-p", "udp", "--dport", port, "-j", "ACCEPT"], { allowFailure: true }).status, 0);
    }
  }
}

function snapshotTree(root) {
  const ignored = new Set(["bin", "command-state", "uploaded-app"]);
  const result = {};
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && ignored.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const stat = fs.lstatSync(child);
      if (entry.isSymbolicLink()) result[childRelative] = `link:${fs.readlinkSync(child)}`;
      else if (entry.isDirectory()) {
        result[childRelative] = `dir:${stat.mode & 0o777}`;
        visit(child, childRelative);
      } else result[childRelative] = `file:${stat.mode & 0o777}:${fs.readFileSync(child).toString("base64")}`;
    }
  }
  visit(root);
  return result;
}

describe("persistent WireGuard Relay installer executable fixture", () => {
  it("rejects direct non-root production execution before mutation without invoking sudo", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run({ CLAWD_INSTALL_TEST_MODE: "0" });
    assert.equal(result.status, 13, result.stderr);
    assert.match(result.stderr, /must run as root/i);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "sudo-operations")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt")), false);
  });

  it("rejects unsafe shared lock paths and metadata before installation mutation", async (t) => {
    await t.test("symlink", (t) => {
      const fixture = createExecutableFixture(t);
      const victim = path.join(fixture.root, "lock-victim");
      const lockPath = path.join(fixture.root, "run", "lock", "clawd-relay.lock");
      fs.writeFileSync(victim, "sentinel", { mode: 0o644 });
      fs.symlinkSync(victim, lockPath);
      const result = fixture.run();
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(victim, "utf8"), "sentinel");
      assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    });
    await t.test("mode", (t) => {
      const fixture = createExecutableFixture(t);
      const lockPath = path.join(fixture.root, "run", "lock", "clawd-relay.lock");
      fs.writeFileSync(lockPath, "", { mode: 0o644 });
      const result = fixture.run();
      assert.notEqual(result.status, 0);
      assert.equal(fs.statSync(lockPath).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    });
    await t.test("owner", (t) => {
      const fixture = createExecutableFixture(t);
      const lockPath = path.join(fixture.root, "run", "lock", "clawd-relay.lock");
      fs.writeFileSync(lockPath, "", { mode: 0o600 });
      const result = fixture.run({ CLAWD_TEST_LOCK_STAT: "999:600" });
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    });
    await t.test("non-regular", (t) => {
      const fixture = createExecutableFixture(t);
      fs.mkdirSync(path.join(fixture.root, "run", "lock", "clawd-relay.lock"));
      const result = fixture.run();
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    });
  });

  for (const [name, env] of [
    ["port conflict", { CLAWD_TEST_RELAY_PORT_CONFLICT: "1" }],
    ["strict auth probe failure", { CLAWD_TEST_PROBE_FAILURE: "1" }],
    ["crash during stability window", { CLAWD_TEST_CRASH_DURING_STABILITY: "1" }],
  ]) {
    it(`rolls back when the production Relay probe detects ${name}`, (t) => {
      const fixture = createExecutableFixture(t);
      const result = fixture.run(env);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, name.includes("stability") ? /stability verification/i : /Relay probe failed/i);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc", "clawd-relay", "relay.env")), false);
      assert.equal(fs.existsSync(path.join(fixture.root, "opt", "clawd-relay", "current")), false);
    });
  }

  it("performs a first install, reuses all credentials, and atomically exposes one complete release", (t) => {
    const fixture = createExecutableFixture(t);
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      fs.existsSync(path.join(fixture.root, "etc", "clawd-relay", "relay.env")),
      true,
      `${first.stdout}\n${first.stderr}\nfixture=${fixture.root}`,
    );
    const initial = installedSecrets(fixture.root);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    const app = path.join(fixture.root, "opt", "clawd-relay", "app");
    const node = path.join(fixture.root, "opt", "clawd-relay", "node");
    assert.equal(fs.lstatSync(current).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(app).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(node).isSymbolicLink(), true);
    const release = fs.readlinkSync(current);
    assert.equal(fs.readlinkSync(app), path.join(current, "app"));
    assert.equal(fs.readlinkSync(node), path.join(current, "node"));
    assert.equal(fs.existsSync(path.join(release, "app", "relay-server.js")), true);
    assert.equal(fs.existsSync(path.join(release, "node", "bin", "node")), true);
    assert.equal(fs.statSync(path.join(fixture.root, "opt", "clawd-relay")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(release, "node")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(fixture.root, "etc", "clawd-relay", "relay.env")).mode & 0o777, 0o600);

    const rerun = fixture.run();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(installedSecrets(fixture.root), initial);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-wg-quick@clawd"), "utf8"), "enabled active\n");
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-clawd-relay"), "utf8"), "enabled active\n");
  });

  it("regenerates every key and both tokens only on a full reset, with legacy force as an alias", (t) => {
    const fixture = createExecutableFixture(t);
    assert.equal(fixture.run().status, 0);
    const initial = installedSecrets(fixture.root);
    const reset = fixture.run({ FORCE_RESET_ALL: "1" });
    assert.equal(reset.status, 0, reset.stderr);
    const resetSecrets = installedSecrets(fixture.root);
    for (const key of Object.keys(initial)) assert.notEqual(resetSecrets[key], initial[key], key);

    const legacy = fixture.run({ FORCE_PHONE_KEY: "1" });
    assert.equal(legacy.status, 0, legacy.stderr);
    const legacySecrets = installedSecrets(fixture.root);
    for (const key of Object.keys(resetSecrets)) assert.notEqual(legacySecrets[key], resetSecrets[key], key);
  });

  it("upgrades through current without touching existing legacy app or node directories", (t) => {
    const fixture = createExecutableFixture(t);
    const legacyApp = path.join(fixture.root, "opt", "clawd-relay", "app");
    const legacyNode = path.join(fixture.root, "opt", "clawd-relay", "node");
    fs.mkdirSync(legacyApp, { recursive: true });
    fs.mkdirSync(path.join(legacyNode, "bin"), { recursive: true });
    fs.writeFileSync(path.join(legacyApp, "legacy-app.sentinel"), "keep-app");
    fs.writeFileSync(path.join(legacyNode, "legacy-node.sentinel"), "keep-node");

    const installed = fixture.run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.lstatSync(legacyApp).isDirectory(), true);
    assert.equal(fs.lstatSync(legacyNode).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(legacyApp, "legacy-app.sentinel"), "utf8"), "keep-app");
    assert.equal(fs.readFileSync(path.join(legacyNode, "legacy-node.sentinel"), "utf8"), "keep-node");
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "legacy-remove-attempts")), false);

    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    assert.equal(fs.lstatSync(current).isSymbolicLink(), true);
    const release = fs.readlinkSync(current);
    assert.equal(fs.existsSync(path.join(release, "app", "relay-server.js")), true);
    assert.equal(fs.existsSync(path.join(release, "app", "node_modules", "ws", "package.json")), true);
    assert.equal(fs.existsSync(path.join(release, "node", "bin", "node")), true);
    const unit = fs.readFileSync(path.join(fixture.root, "etc", "systemd", "system", "clawd-relay.service"), "utf8");
    assert.match(unit, /^ExecStart=\/opt\/clawd-relay\/current\/node\/bin\/node \/opt\/clawd-relay\/current\/app\/relay-server\.js$/m);
  });

  it("ignores a relative system Node symlink and still installs the complete verified release runtime", (t) => {
    const fixture = createExecutableFixture(t);
    writeExecutable(
      path.join(fixture.binDir, "node-real"),
      "#!/usr/bin/env bash\nexec \"$CLAWD_INSTALL_TEST_NODE_SOURCE\" \"$@\"\n",
    );
    fs.symlinkSync("node-real", path.join(fixture.binDir, "node"));
    const installed = fixture.run({ CLAWD_INSTALL_FORCE_BUNDLED_NODE: "0" });
    assert.equal(installed.status, 0, installed.stderr);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    const releaseNode = path.join(fs.readlinkSync(current), "node", "bin", "node");
    assert.equal(fs.lstatSync(releaseNode).isSymbolicLink(), false);
    assert.ok((fs.statSync(releaseNode).mode & 0o111) !== 0);
    assert.equal(fs.existsSync(path.join(fs.readlinkSync(current), "node", "lib", "node_modules", "corepack", "package.json")), true);
  });

  it("atomically restores the old current link when a post-switch install fails", (t) => {
    const fixture = createExecutableFixture(t);
    const installed = fixture.run();
    assert.equal(installed.status, 0, installed.stderr);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    const previous = fs.readlinkSync(current);

    const failed = fixture.run({ CLAWD_INSTALL_FAIL_STAGE: "current-switch" });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readlinkSync(current), previous);
    assert.equal(fs.existsSync(previous), true);
    assert.equal(fs.existsSync(`${current}.new`), false);
  });

  it("fails closed without replacing an unexpected real current directory", (t) => {
    const fixture = createExecutableFixture(t);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, "unexpected.sentinel"), "keep-current");

    const failed = fixture.run();
    assert.notEqual(failed.status, 0);
    assert.equal(fs.lstatSync(current).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(current, "unexpected.sentinel"), "utf8"), "keep-current");
  });

  it("brackets a discovered global IPv6 endpoint and produces Task 2-accepted readback", (t) => {
    const fixture = createExecutableFixture(t);
    const ipv6 = "2606:4700:4700::1111";
    const installed = fixture.run({
      ENDPOINT_HOST: "",
      CLAWD_TEST_DISCOVERED_ENDPOINT: ipv6,
    });
    assert.equal(installed.status, 0, installed.stderr);
    const parsed = parseReadback(installed.stdout, {
      profile: {
        host: "relay.example.com",
        sshUsername: "deploy",
        wgPort: 51820,
        wgSubnet: "10.8.0.0/24",
      },
      runtime: { relayPort: 7891 },
    });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.readback.endpoint, `[${ipv6}]:51820`);
    assert.match(parsed.readback.pcConfig, new RegExp(`^Endpoint = \\[${ipv6.replaceAll(":", "\\:")}\\]:51820$`, "m"));
    assert.match(parsed.readback.phoneConfig, new RegExp(`^Endpoint = \\[${ipv6.replaceAll(":", "\\:")}\\]:51820$`, "m"));
  });

  it("restores files, releases, firewall and prior service states after every mutation-stage failure", (t) => {
    const fixture = createExecutableFixture(t);
    const installed = fixture.run();
    assert.equal(installed.status, 0, installed.stderr);
    const baselineTree = snapshotTree(fixture.root);
    const baselineServices = fs.readdirSync(fixture.stateDir)
      .filter((name) => name.startsWith("service-") || name.startsWith("firewall-"))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(fixture.stateDir, name), "utf8")]);

    for (const stage of MUTATION_STAGES) {
      const failed = fixture.run({ CLAWD_INSTALL_FAIL_STAGE: stage, FORCE_RESET_ALL: "1" });
      assert.notEqual(failed.status, 0, `${stage} unexpectedly succeeded`);
      assert.deepEqual(snapshotTree(fixture.root), baselineTree, `${stage} changed installed files`);
      const services = fs.readdirSync(fixture.stateDir)
        .filter((name) => name.startsWith("service-") || name.startsWith("firewall-"))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(fixture.stateDir, name), "utf8")]);
      assert.deepEqual(services, baselineServices, `${stage} changed service/firewall state`);
    }
  });

  it("undoes only newly-added firewall and service state on a failed first install", (t) => {
    const fixture = createExecutableFixture(t);
    fs.writeFileSync(path.join(fixture.stateDir, "service-wg-quick@clawd"), "enabled inactive\n");
    fs.writeFileSync(path.join(fixture.stateDir, "service-clawd-relay"), "disabled active\n");
    const failed = fixture.run({ CLAWD_INSTALL_FAIL_STAGE: "relay-service" });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "firewall-udp")), false);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-wg-quick@clawd"), "utf8"), "enabled inactive\n");
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-clawd-relay"), "utf8"), "disabled active\n");
    for (const relative of [
      "etc/clawd-relay/relay.env",
      "etc/wireguard/clawd.conf",
      "etc/wireguard/clawd",
      "etc/systemd/system/clawd-relay.service",
      "opt/clawd-relay/app",
      "opt/clawd-relay/node",
    ]) assert.equal(fs.existsSync(path.join(fixture.root, relative)), false, relative);
    const releases = path.join(fixture.root, "opt", "clawd-relay", "releases");
    assert.equal(fs.existsSync(releases), false);
    const leftovers = Object.keys(snapshotTree(fixture.root)).filter((name) =>
      /(?:\.tmp\.|clawd-relay-backup)/.test(name));
    assert.deepEqual(leftovers, []);
  });

  it("rolls back a newly-added firewalld permanent rule when the first reload fails", (t) => {
    const fixture = createExecutableFixture(t);
    const failed = fixture.run({
      CLAWD_TEST_FIREWALL: "firewalld",
      CLAWD_TEST_FIREWALLD_FAIL_FIRST_RELOAD: "1",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "firewalld-permanent-udp")), false);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "firewalld-reload-count"), "utf8"), "2");
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.stateDir, "firewalld-operations"), "utf8").trim().split("\n"),
      ["add", "remove"],
    );
  });

  it("preserves a pre-existing firewalld permanent rule during rollback", (t) => {
    const fixture = createExecutableFixture(t);
    fs.writeFileSync(path.join(fixture.stateDir, "firewalld-permanent-udp"), "51820/udp");
    const failed = fixture.run({
      CLAWD_TEST_FIREWALL: "firewalld",
      CLAWD_INSTALL_FAIL_STAGE: "relay-service",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "firewalld-permanent-udp"), "utf8"), "51820/udp");
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "firewalld-operations")), false);
  });

  it("rejects invalid and control-bearing inputs before any installation mutation", (t) => {
    const cases = [
      ["WG_PORT", "0"],
      ["WG_PORT", "65536"],
      ["WG_PORT", "51820\nPostUp = touch /tmp/pwned"],
      ["RELAY_PORT", "abc"],
      ["WG_SUBNET", "8.8.8.0/24"],
      ["WG_SUBNET", "10.8.0.1/24"],
      ["WG_SUBNET", "10.08.0.0/24"],
      ["WG_SUBNET", "10.8.0.0/24\nPostUp = touch /tmp/pwned"],
      ["FORCE_PHONE_KEY", "2"],
      ["FORCE_RESET_ALL", "yes"],
      ["ENDPOINT_HOST", "relay.example.com\nPostUp = touch /tmp/pwned"],
    ];
    for (const [name, value] of cases) {
      const fixture = createExecutableFixture(t);
      const result = fixture.run({ [name]: value });
      assert.notEqual(result.status, 0, `${name}=${JSON.stringify(value)} unexpectedly succeeded`);
      assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false, `${name} mutated /etc`);
      assert.equal(fs.existsSync(path.join(fixture.root, "opt")), false, `${name} mutated /opt`);
      assert.equal(fs.existsSync(path.join(fixture.root, "run", "lock", "clawd-relay.lock")), false);
      assert.equal(fs.existsSync(path.join(fixture.stateDir, "installer-mutations")), false, `${name} mutated the test filesystem`);
    }
  });

  it("accepts canonical private 172.16/12 and 192.168/16 /24 networks", (t) => {
    for (const subnet of ["172.31.44.0/24", "192.168.77.0/24"]) {
      const fixture = createExecutableFixture(t);
      const result = fixture.run({ WG_SUBNET: subnet });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(path.join(fixture.root, "etc", "wireguard", "clawd.conf"), "utf8"), new RegExp(`^Address = ${subnet.slice(0, -5)}\\.1/24$`, "m"));
    }
  });

  it("executes the apt, dnf and yum package-manager paths in isolated fixtures", (t) => {
    for (const manager of ["apt-get", "dnf", "yum"]) {
      const fixture = createExecutableFixture(t);
      fs.rmSync(path.join(fixture.binDir, "apt-get"), { force: true });
      writeExecutable(path.join(fixture.binDir, manager), `#!/usr/bin/env bash
printf '%s\n' "${manager} $*" >> "$CLAWD_INSTALL_TEST_STATE/package-operations"
exit 0
`);
      const result = fixture.run();
      assert.equal(result.status, 0, `${manager}: ${result.stderr}`);
      assert.match(fs.readFileSync(path.join(fixture.stateDir, "package-operations"), "utf8"), new RegExp(`^${manager} `, "m"));
    }
  });

  it("fails on flock contention, then succeeds immediately after the holder is killed", async (t) => {
    const fixture = createExecutableFixture(t);
    const lock = path.join(fixture.root, "run", "lock", "clawd-relay.lock");
    const holder = childProcess.spawn("/bin/bash", ["-c", `umask 077; exec 9>"$1"; flock -x -w 5 9; printf 'HELD\\n'; while :; do sleep 1; done`, "_", lock], {
      env: fixture.environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("holder did not acquire flock")), 7000);
      holder.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const result = fixture.run({ CLAWD_INSTALL_LOCK_TIMEOUT_MS: "50" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.statSync(lock).isFile(), true);
    assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt")), false);
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("close", resolve));
    const retried = fixture.run({ CLAWD_INSTALL_LOCK_TIMEOUT_MS: "500" });
    assert.equal(retried.status, 0, retried.stderr);
  });

  it("cleans its shared lock and temporary state after an early injected failure", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run({ CLAWD_INSTALL_FAIL_STAGE: "lock-acquired" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.statSync(path.join(fixture.root, "run", "lock", "clawd-relay.lock")).isFile(), true);
    assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt")), false);
  });

  it("cleans its shared lock and early filesystem state on SIGTERM", async (t) => {
    const fixture = createExecutableFixture(t);
    const child = childProcess.spawn(INSTALLER_PATH, [], {
      cwd: path.dirname(INSTALLER_PATH),
      env: { ...fixture.environment, CLAWD_INSTALL_PAUSE_STAGE: "lock-acquired" },
      stdio: "ignore",
    });
    const marker = path.join(fixture.stateDir, "pause-lock-acquired");
    for (let attempt = 0; attempt < 500 && !fs.existsSync(marker); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(marker), true, "installer did not reach lock-acquired pause");
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 143);
    assert.equal(fs.statSync(path.join(fixture.root, "run", "lock", "clawd-relay.lock")).isFile(), true);
    assert.equal(fs.existsSync(path.join(fixture.root, "etc")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt")), false);
  });

  for (const status of ["deny", "near"]) {
    it(`does not mistake a UFW ${status} line for the exact ALLOW rule`, (t) => {
      const fixture = createExecutableFixture(t);
      const result = fixture.run({ CLAWD_TEST_UFW_STATUS: status });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(fixture.stateDir, "ufw-operations"), "utf8"), "add\n");
    });
  }

  it("preserves an exact pre-existing UFW ALLOW rule and requires IPv6 coverage for an IPv6 endpoint", (t) => {
    const existing = createExecutableFixture(t);
    const preserved = existing.run({ CLAWD_TEST_UFW_STATUS: "allow" });
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(fs.existsSync(path.join(existing.stateDir, "ufw-operations")), false);

    const ipv6 = createExecutableFixture(t);
    const rejected = ipv6.run({
      ENDPOINT_HOST: "2606:4700:4700::1111",
      CLAWD_TEST_UFW_STATUS: "v4only",
    });
    assert.equal(rejected.status, 14, rejected.stderr);
    assert.equal(fs.existsSync(path.join(ipv6.stateDir, "ufw-operations")), false);
  });

  it("falls through an inactive UFW installation to active firewalld", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run({
      CLAWD_TEST_FIREWALL: "firewalld",
      CLAWD_TEST_UFW_INACTIVE: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "firewalld-permanent-udp")), true);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "ufw-operations")), false);
    assert.equal(installedFirewallMetadata(fixture.root).values.BACKEND, "firewalld");
  });

  it("repairs firewalld permanent/runtime drift before declaring success", (t) => {
    const fixture = createExecutableFixture(t);
    fs.writeFileSync(path.join(fixture.stateDir, "firewalld-permanent-udp"), "51820/udp");
    const result = fixture.run({ CLAWD_TEST_FIREWALL: "firewalld" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "firewalld-runtime-udp"), "utf8"), "51820/udp");
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "firewalld-reload-count"), "utf8"), "1");
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "firewalld-operations")), false);
  });

  it("removes only obsolete owned UFW rules after a verified WG port transition", (t) => {
    const fixture = createExecutableFixture(t);
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr);
    const firstMetadata = installedFirewallMetadata(fixture.root);
    assert.equal(fs.statSync(firstMetadata.file).mode & 0o777, 0o600);
    assert.deepEqual(firstMetadata.values, {
      BACKEND: "ufw", PORT: "51820", IPV4: "1", IPV6: "1", UNIT: "0",
    });

    const changed = fixture.run({ WG_PORT: "51821" });
    assert.equal(changed.status, 0, changed.stderr);
    assert.deepEqual(fs.readFileSync(path.join(fixture.stateDir, "firewall-udp"), "utf8").trim().split("\n"), ["51821"]);
    assert.equal(installedFirewallMetadata(fixture.root).values.PORT, "51821");
  });

  it("disables and removes old iptables persistence when switching to UFW", (t) => {
    const fixture = createExecutableFixture(t);
    const first = fixture.run({ CLAWD_TEST_FIREWALL: "iptables" });
    assert.equal(first.status, 0, first.stderr);
    const switched = fixture.run({ CLAWD_TEST_FIREWALL: "ufw" });
    assert.equal(switched.status, 0, switched.stderr);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "iptables-udp")), false);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "ip6tables-udp")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "etc", "systemd", "system", "clawd-relay-firewall.service")), false);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-clawd-relay-firewall"), "utf8"), "disabled inactive\n");
    assert.equal(installedFirewallMetadata(fixture.root).values.BACKEND, "ufw");
  });

  it("keeps old owned firewall metadata and rules when a transition rolls back", (t) => {
    const fixture = createExecutableFixture(t);
    const first = fixture.run();
    assert.equal(first.status, 0, first.stderr);
    const before = fs.readFileSync(installedFirewallMetadata(fixture.root).file, "utf8");
    const failed = fixture.run({ WG_PORT: "51821", CLAWD_INSTALL_FAIL_STAGE: "firewall-migration" });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "firewall-udp"), "utf8"), "51820\n");
    assert.equal(fs.readFileSync(installedFirewallMetadata(fixture.root).file, "utf8"), before);
  });

  it("rejects malformed, noncanonical, or non-global ENDPOINT_HOST values", (t) => {
    for (const endpoint of [
      "999.1.1.1",
      "-bad.example",
      "bad..example",
      "2001:db8::1",
      "2606:4700:4700:0:0:0:0:1111",
    ]) {
      const fixture = createExecutableFixture(t);
      const result = fixture.run({ ENDPOINT_HOST: endpoint });
      assert.equal(result.status, 17, `${endpoint}: ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(fixture.root, "opt", "clawd-relay", "current")), false);
    }
  });

  it("persists iptables and ip6tables rules through a generated oneshot unit and reboot simulation", (t) => {
    const fixture = createExecutableFixture(t);
    const installed = fixture.run({ CLAWD_TEST_FIREWALL: "iptables" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "iptables-udp")), true);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "ip6tables-udp")), true);
    const unit = path.join(fixture.root, "etc", "systemd", "system", "clawd-relay-firewall.service");
    assert.match(fs.readFileSync(unit, "utf8"), /iptables[\s\S]*ip6tables/);
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "service-clawd-relay-firewall"), "utf8"), "enabled active\n");

    fs.rmSync(path.join(fixture.stateDir, "iptables-udp"));
    fs.rmSync(path.join(fixture.stateDir, "ip6tables-udp"));
    const reboot = childProcess.spawnSync(path.join(fixture.binDir, "systemctl"), ["restart", "clawd-relay-firewall.service"], {
      env: { ...process.env, PATH: `${fixture.binDir}:/usr/bin:/bin`, CLAWD_INSTALL_TEST_STATE: fixture.stateDir, CLAWD_INSTALL_ROOT: fixture.root, CLAWD_TEST_FIREWALL: "iptables", CLAWD_INSTALL_TEST_SMOKE_START: path.join(fixture.root, "relay-smoke-control") },
      encoding: "utf8",
    });
    assert.equal(reboot.status, 0, reboot.stderr);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "iptables-udp")), true);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "ip6tables-udp")), true);
  });

  it("rolls back only firewall rules owned by this run for UFW and iptables families", (t) => {
    const ufwAdded = createExecutableFixture(t);
    const failedUfw = ufwAdded.run({ CLAWD_TEST_UFW_STATUS: "deny", CLAWD_INSTALL_FAIL_STAGE: "relay-service" });
    assert.notEqual(failedUfw.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(ufwAdded.stateDir, "ufw-operations"), "utf8").trim().split("\n"), ["add", "remove"]);
    assert.equal(fs.existsSync(path.join(ufwAdded.stateDir, "firewall-udp")), false);

    const ufwExisting = createExecutableFixture(t);
    const preservedUfw = ufwExisting.run({ CLAWD_TEST_UFW_STATUS: "allow", CLAWD_INSTALL_FAIL_STAGE: "relay-service" });
    assert.notEqual(preservedUfw.status, 0);
    assert.equal(fs.existsSync(path.join(ufwExisting.stateDir, "ufw-operations")), false);

    const iptables = createExecutableFixture(t);
    fs.writeFileSync(path.join(iptables.stateDir, "iptables-udp"), "51820");
    const failedIptables = iptables.run({ CLAWD_TEST_FIREWALL: "iptables", CLAWD_INSTALL_FAIL_STAGE: "relay-service" });
    assert.notEqual(failedIptables.status, 0);
    assert.equal(fs.existsSync(path.join(iptables.stateDir, "iptables-udp")), true);
    assert.equal(fs.existsSync(path.join(iptables.stateDir, "ip6tables-udp")), false);
    assert.equal(fs.existsSync(path.join(iptables.root, "etc", "systemd", "system", "clawd-relay-firewall.service")), false);
    assert.deepEqual(fs.readFileSync(path.join(iptables.stateDir, "ip6tables-operations"), "utf8").trim().split("\n"), ["add", "remove"]);
  });

  it("fails with exit 14 when no firewall backend is usable", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run({ CLAWD_TEST_FIREWALL: "none" });
    assert.equal(result.status, 14, result.stderr);
  });

  it("uses the pinned verified complete Node runtime even when a system node exists", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run({ CLAWD_INSTALL_FORCE_BUNDLED_NODE: "0" });
    assert.equal(result.status, 0, result.stderr);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    assert.equal(fs.existsSync(path.join(fs.readlinkSync(current), "node", "lib", "node_modules", "corepack", "package.json")), true);
    const urls = fs.readFileSync(path.join(fixture.stateDir, "curl-urls"), "utf8");
    assert.match(urls, /node-v22\.17\.0-linux-x64\.tar\.gz/);
    assert.match(urls, /SHASUMS256\.txt/);
    assert.equal(
      fs.statSync(path.join(fixture.root, "opt", "clawd-relay", "runtime-cache", "node-v22.17.0-linux-x64.tar.gz")).mode & 0o777,
      0o444,
    );
  });

  it("maps x86_64 and arm64 to official archive names and fails closed on checksum mismatch", (t) => {
    for (const [machine, archiveName] of [["x86_64", "x64"], ["arm64", "arm64"]]) {
      const fixture = createExecutableFixture(t);
      const result = fixture.run({ CLAWD_INSTALL_FORCE_BUNDLED_NODE: "0", CLAWD_TEST_UNAME_M: machine });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(path.join(fixture.stateDir, "curl-urls"), "utf8"), new RegExp(`linux-${archiveName}\\.tar\\.gz`));
    }
    const mismatch = createExecutableFixture(t);
    fs.writeFileSync(mismatch.nodeManifest, `${"0".repeat(64)}  node-v22.17.0-linux-x64.tar.gz\n`);
    const failed = mismatch.run({ CLAWD_INSTALL_FORCE_BUNDLED_NODE: "0" });
    assert.equal(failed.status, 10);
    assert.equal(fs.existsSync(path.join(mismatch.root, "opt", "clawd-relay", "current")), false);
  });

  it("rejects a symlinked verified-runtime cache archive instead of following it", (t) => {
    const fixture = createExecutableFixture(t);
    const cache = path.join(fixture.root, "opt", "clawd-relay", "runtime-cache");
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(fixture.nodeArchive, path.join(cache, "node-v22.17.0-linux-x64.tar.gz"));
    const result = fixture.run();
    assert.equal(result.status, 10, result.stderr);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt", "clawd-relay", "current")), false);
  });

  it("rejects a writable verified-runtime cache archive even when its checksum matches", (t) => {
    const fixture = createExecutableFixture(t);
    const cache = path.join(fixture.root, "opt", "clawd-relay", "runtime-cache");
    fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, "node-v22.17.0-linux-x64.tar.gz");
    fs.copyFileSync(fixture.nodeArchive, archive);
    fs.chmodSync(archive, 0o666);
    const result = fixture.run();
    assert.equal(result.status, 10, result.stderr);
    assert.equal(fs.statSync(archive).mode & 0o777, 0o666);
    assert.equal(fs.existsSync(path.join(fixture.root, "opt", "clawd-relay", "current")), false);
  });

  it("stages the actual Relay modules and passes real health plus strict-Bearer smoke", (t) => {
    const fixture = createExecutableFixture(t);
    const result = fixture.run();
    const relayLog = path.join(fixture.stateDir, "relay.log");
    assert.equal(result.status, 0, `${result.stderr}\nrelay log:\n${fs.existsSync(relayLog) ? fs.readFileSync(relayLog, "utf8") : "missing"}`);
    const current = path.join(fixture.root, "opt", "clawd-relay", "current");
    const release = fs.readlinkSync(current);
    for (const name of ["relay-server.js", "pair-registry.js", "relay-token-store.js", "wg-management.js"]) {
      assert.deepEqual(fs.readFileSync(path.join(release, "app", name)), fs.readFileSync(path.join(__dirname, "..", "relay", name)));
    }
    assert.equal(fs.readFileSync(path.join(fixture.stateDir, "relay-smoke-ok"), "utf8"), "health+strict-bearer\n");
  });

  it("rejects malformed WireGuard configuration in the executable wg-quick shim", (t) => {
    const fixture = createExecutableFixture(t);
    const invalid = path.join(fixture.root, "invalid.conf");
    fs.writeFileSync(invalid, "[Interface]\nAddress = 10.8.0.1/24\nPostUp = injected\n");
    const result = childProcess.spawnSync(path.join(fixture.binDir, "wg-quick"), ["strip", invalid], {
      env: { ...process.env, CLAWD_INSTALL_TEST_STATE: fixture.stateDir, CLAWD_INSTALL_TEST_NODE_SOURCE: process.execPath },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
  });
});

describe("privileged Linux installer guard", () => {
  it("requires opt-in, root, a fixed regular 0600 marker, and matching nonce", (t) => {
    assert.deepEqual(validatePrivilegedIntegration({ env: {} }), { enabled: false });
    assert.throws(() => validatePrivilegedIntegration({
      env: { CLAWD_RUN_PRIVILEGED_INSTALL_INTEGRATION: "1" },
      platform: "linux",
      uid: 0,
    }), /nonce/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-privileged-guard-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const markerPath = path.join(dir, ".clawd-relay-disposable-vps");
    fs.writeFileSync(markerPath, "wrong\n", { mode: 0o600 });
    const options = {
      env: {
        CLAWD_RUN_PRIVILEGED_INSTALL_INTEGRATION: "1",
        CLAWD_PRIVILEGED_VPS_NONCE: "ab".repeat(16),
      },
      platform: "linux",
      uid: 0,
      markerPath,
      expectedMarkerUid: fs.statSync(markerPath).uid,
    };
    assert.throws(() => validatePrivilegedIntegration(options), /marker.*nonce/i);
    fs.writeFileSync(markerPath, `${options.env.CLAWD_PRIVILEGED_VPS_NONCE}\n`, { mode: 0o600 });
    assert.deepEqual(validatePrivilegedIntegration(options), { enabled: true, markerPath });
    fs.chmodSync(markerPath, 0o644);
    assert.throws(() => validatePrivilegedIntegration(options), /0600/);
  });
});

it("runs the privileged Linux installer integration only on an explicitly marked disposable VPS", (t) => {
  const authorization = validatePrivilegedIntegration({ env: process.env });
  if (!authorization.enabled) {
    t.skip("requires explicit disposable-VPS opt-in");
    return;
  }
  assert.equal(process.platform, "linux");
  assert.equal(typeof process.getuid === "function" ? process.getuid() : -1, 0);
  for (const target of PRIVILEGED_INSTALL_PATHS) {
    if (fs.existsSync(target)) throw new Error(`disposable VPS is not clean: ${target}`);
  }
  for (const service of ["clawd-relay.service", "wg-quick@clawd.service", "clawd-relay-firewall.service"]) {
    if (runPrivilegedCommand("systemctl", ["is-active", "--quiet", service], { allowFailure: true }).status === 0 ||
        runPrivilegedCommand("systemctl", ["is-enabled", "--quiet", service], { allowFailure: true }).status === 0) {
      throw new Error(`disposable VPS service is not clean: ${service}`);
    }
  }
  let metadata = null;
  try {
    const result = childProcess.spawnSync(INSTALLER_PATH, [], {
      env: { ...process.env, CLAWD_INSTALL_TEST_MODE: "0" },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    metadata = installedFirewallMetadata("/").values;
  } finally {
    if (!metadata && fs.existsSync("/etc/clawd-relay/firewall.env")) {
      metadata = installedFirewallMetadata("/").values;
    }
    cleanupPrivilegedInstall(metadata);
    verifyPrivilegedCleanup(metadata);
  }
});
