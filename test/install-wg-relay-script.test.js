"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
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

  it("installs and checksum-verifies Node >=18 when the system runtime is missing or old", () => {
    assert.match(SOURCE, /NODE_MIN_MAJOR=["']?18/);
    assert.match(SOURCE, /node[^\n]*--version/);
    assert.match(SOURCE, /nodejs\.org\/dist/);
    assert.match(SOURCE, /sha256sum[^\n]*-c/);
    assert.doesNotMatch(SOURCE, /command -v (?:docker|npm|git)\b/);
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
      "PHONE_PUBLIC_KEY_PATH", "SERVER_PUBLIC_KEY_PATH", "RELAY_ENV_PATH",
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

  it("opens only WireGuard UDP and never Relay TCP", () => {
    assert.match(SOURCE, /ufw allow[^\n]*WG_PORT[^\n]*udp/);
    assert.match(SOURCE, /firewall-cmd[^\n]*WG_PORT[^\n]*udp/);
    assert.doesNotMatch(SOURCE, /(?:ufw|firewall-cmd|iptables)[^\n]*(?:RELAY_PORT|7891)[^\n]*(?:tcp|TCP)/);
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
  writeExecutable(path.join(binDir, "sudo"), "#!/usr/bin/env bash\nexit 1\n");
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
  writeExecutable(path.join(binDir, "curl"), `${prelude}
for argument in "$@"; do
  if [ "$argument" = https://api.ipify.org ] && [ -n "\${CLAWD_TEST_DISCOVERED_ENDPOINT:-}" ]; then
    printf '%s' "$CLAWD_TEST_DISCOVERED_ENDPOINT"
    exit 0
  fi
done
exit 1
`);
  writeExecutable(path.join(binDir, "wg-quick"), `${prelude}[ \"\${1:-}\" = strip ]\ncat \"\${2}\" >/dev/null\n`);
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
  is-active) [ \"$active\" = active ] ;;
  enable) enabled=enabled ;;
  disable) enabled=disabled ;;
  start|restart) active=active ;;
  stop) active=inactive ;;
  *) exit 2 ;;
esac
printf '%s %s\\n' \"$enabled\" \"$active\" > \"$file\"
`);
  writeExecutable(path.join(binDir, "ufw"), `${prelude}
rule=\"$STATE_DIR/firewall-udp\"
case \"\${1:-}\" in
  status)
    [ \"\${CLAWD_TEST_FIREWALL:-ufw}\" = ufw ] || exit 1
    [ ! -f \"$rule\" ] || printf '%s/udp ALLOW Anywhere\\n' \"$(cat \"$rule\")\"
    ;;
  allow) printf '%s' \"\${2%/udp}\" > \"$rule\" ;;
  --force)
    [ \"\${2:-}\" = delete ] && [ \"\${3:-}\" = allow ] && rm -f \"$rule\"
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(path.join(binDir, "firewall-cmd"), `${prelude}
[ \"\${CLAWD_TEST_FIREWALL:-ufw}\" = firewalld ] || exit 1
rule=\"$STATE_DIR/firewalld-permanent-udp\"
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
    ;;
  *) exit 2 ;;
esac
`);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: false });
}

function createExecutableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-installer-test-"));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "command-state");
  const appSource = path.join(root, "uploaded-app");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, "run", "systemd", "system"), { recursive: true });
  fs.mkdirSync(path.join(appSource, "node_modules"), { recursive: true });
  for (const name of ["pair-registry.js", "relay-token-store.js", "wg-management.js"]) {
    fs.writeFileSync(path.join(appSource, name), `"use strict"; module.exports = {};\n`);
  }
  fs.writeFileSync(path.join(appSource, "relay-server.js"), `"use strict"; require("ws"); module.exports = {};\n`);
  copyDirectory(path.join(__dirname, "..", "node_modules", "ws"), path.join(appSource, "node_modules", "ws"));
  createCommandShims(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CLAWD_INSTALL_TEST_MODE: "1",
    CLAWD_INSTALL_ROOT: root,
    CLAWD_INSTALL_TEST_STATE: stateDir,
    CLAWD_INSTALL_APP_SOURCE: appSource,
    CLAWD_INSTALL_TEST_NODE_SOURCE: process.execPath,
    CLAWD_INSTALL_FORCE_BUNDLED_NODE: "1",
    ENDPOINT_HOST: "198.51.100.40",
  };

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    binDir,
    stateDir,
    run(extraEnv = {}) {
      return childProcess.spawnSync(INSTALLER_PATH, [], {
        cwd: path.dirname(INSTALLER_PATH),
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 20_000,
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

  it("dereferences a relative system Node symlink into the complete release", (t) => {
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
    assert.deepEqual(fs.readdirSync(releases), []);
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
});
