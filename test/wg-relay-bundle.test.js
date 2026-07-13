"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildRelayBundleManifest,
  uploadRelayBundle,
} = require("../src/wg-relay-bundle");

function makeFixture({ omit = [] } = {}) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-relay-bundle-"));
  const files = {
    "relay/install-wg-relay.sh": "#!/bin/sh\necho install\n",
    "relay/relay-server.js": "module.exports = 'relay';\n",
    "relay/pair-registry.js": "module.exports = 'pairs';\n",
    "relay/relay-token-store.js": "module.exports = 'tokens';\n",
    "relay/wg-management.js": "module.exports = 'management';\n",
    "node_modules/ws/LICENSE": "license\n",
    "node_modules/ws/index.js": "module.exports = require('./lib/websocket');\n",
    "node_modules/ws/package.json": "{\"name\":\"ws\"}\n",
    "node_modules/ws/lib/websocket.js": "module.exports = class WebSocket {};\n",
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    if (omit.includes(relativePath)) continue;
    const filePath = path.join(appRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return appRoot;
}

function removeFixture(appRoot) {
  fs.rmSync(appRoot, { recursive: true, force: true });
}

function makeSftpRecorder() {
  const operations = [];
  return {
    operations,
    mkdir(remotePath, options, callback) {
      operations.push({ type: "mkdir", remotePath, options });
      callback(null);
    },
    writeFile(remotePath, contents, options, callback) {
      operations.push({ type: "writeFile", remotePath, contents, options });
      callback(null);
    },
  };
}

test("buildRelayBundleManifest declares every required Relay and ws runtime file deterministically", (t) => {
  const appRoot = makeFixture();
  t.after(() => removeFixture(appRoot));

  const manifest = buildRelayBundleManifest({ appRoot });

  assert.deepEqual(manifest.map((entry) => entry.remotePath), [
    "install-wg-relay.sh",
    "app/relay-server.js",
    "app/pair-registry.js",
    "app/relay-token-store.js",
    "app/wg-management.js",
    "app/node_modules/ws/LICENSE",
    "app/node_modules/ws/index.js",
    "app/node_modules/ws/lib/websocket.js",
    "app/node_modules/ws/package.json",
  ]);
  assert.equal(manifest[0].mode, 0o755);
  assert.ok(manifest.slice(1).every((entry) => entry.mode === 0o644));
  assert.ok(manifest.every((entry) => path.isAbsolute(entry.localPath)));
  assert.ok(manifest.every((entry) => Buffer.isBuffer(entry.contents)));
});

test("buildRelayBundleManifest fails clearly when a future Task 3 module is absent", (t) => {
  const appRoot = makeFixture({ omit: ["relay/relay-token-store.js"] });
  t.after(() => removeFixture(appRoot));

  assert.throws(
    () => buildRelayBundleManifest({ appRoot }),
    /required relay bundle file.*relay-token-store\.js/i
  );
});

test("buildRelayBundleManifest rejects symlinks anywhere in the ws runtime tree", (t) => {
  const appRoot = makeFixture();
  t.after(() => removeFixture(appRoot));
  const linkPath = path.join(appRoot, "node_modules/ws/lib/linked.js");
  fs.symlinkSync(path.join(appRoot, "node_modules/ws/index.js"), linkPath);

  assert.throws(
    () => buildRelayBundleManifest({ appRoot }),
    /symlink.*node_modules[/\\]ws[/\\]lib[/\\]linked\.js/i
  );
});

test("buildRelayBundleManifest rejects a symlinked ws runtime root", (t) => {
  const appRoot = makeFixture();
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-external-ws-"));
  t.after(() => removeFixture(appRoot));
  t.after(() => removeFixture(externalRoot));
  fs.writeFileSync(path.join(externalRoot, "index.js"), "module.exports = {};\n");
  const wsRoot = path.join(appRoot, "node_modules/ws");
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.symlinkSync(externalRoot, wsRoot, "dir");

  assert.throws(
    () => buildRelayBundleManifest({ appRoot }),
    /symlink.*node_modules[/\\]ws/i
  );
});

test("buildRelayBundleManifest rejects symlinked parents of required Relay files", (t) => {
  const appRoot = makeFixture();
  const externalRoot = makeFixture();
  t.after(() => removeFixture(appRoot));
  t.after(() => removeFixture(externalRoot));
  fs.rmSync(path.join(appRoot, "relay"), { recursive: true, force: true });
  fs.symlinkSync(path.join(externalRoot, "relay"), path.join(appRoot, "relay"), "dir");

  assert.throws(
    () => buildRelayBundleManifest({ appRoot }),
    /symlink.*relay/i
  );
});

test("uploadRelayBundle creates 0755 directories and uploads Buffer contents with file modes", async (t) => {
  const appRoot = makeFixture();
  t.after(() => removeFixture(appRoot));
  const manifest = buildRelayBundleManifest({ appRoot });
  const sftp = makeSftpRecorder();
  const progress = [];

  await uploadRelayBundle({
    sftp,
    manifest,
    remoteRoot: "/tmp/clawd-relay-test",
    onProgress: (event) => progress.push(event),
  });

  const mkdirOps = sftp.operations.filter((op) => op.type === "mkdir");
  assert.deepEqual(mkdirOps.map((op) => op.remotePath), [
    "/tmp/clawd-relay-test",
    "/tmp/clawd-relay-test/app",
    "/tmp/clawd-relay-test/app/node_modules",
    "/tmp/clawd-relay-test/app/node_modules/ws",
    "/tmp/clawd-relay-test/app/node_modules/ws/lib",
  ]);
  assert.ok(mkdirOps.every((op) => op.options.mode === 0o755));

  const writes = sftp.operations.filter((op) => op.type === "writeFile");
  assert.equal(writes.length, manifest.length);
  assert.ok(writes.every((op) => Buffer.isBuffer(op.contents)));
  assert.equal(writes[0].options.mode, 0o755);
  assert.ok(writes.slice(1).every((op) => op.options.mode === 0o644));
  assert.equal(writes[0].contents.toString("utf8"), "#!/bin/sh\necho install\n");
  assert.equal(progress.at(-1).completed, manifest.length);
  assert.equal(progress.at(-1).total, manifest.length);
});

test("uploadRelayBundle rejects traversal and absolute manifest paths before SFTP writes", async () => {
  for (const remotePath of ["../escape", "app/../../escape", "/absolute/escape"]) {
    const sftp = makeSftpRecorder();
    await assert.rejects(
      uploadRelayBundle({
        sftp,
        manifest: [{ contents: Buffer.from("safe"), remotePath, mode: 0o644 }],
        remoteRoot: "/tmp/clawd-relay-test",
      }),
      /unsafe relay bundle path/i
    );
    assert.deepEqual(sftp.operations, []);
  }
});

test("uploadRelayBundle uses captured bytes after source mutation or replacement", async (t) => {
  const appRoot = makeFixture();
  t.after(() => removeFixture(appRoot));
  const installer = path.join(appRoot, "relay/install-wg-relay.sh");
  const original = fs.readFileSync(installer);
  const manifest = buildRelayBundleManifest({ appRoot });
  manifest[0].contents.fill(0);
  fs.renameSync(installer, `${installer}.captured`);
  fs.writeFileSync(installer, "replacement after manifest\n");
  const sftp = makeSftpRecorder();

  await uploadRelayBundle({ sftp, manifest, remoteRoot: "/tmp/clawd-relay-test" });

  const installerWrite = sftp.operations.find((op) => (
    op.type === "writeFile" && op.remotePath.endsWith("/install-wg-relay.sh")
  ));
  assert.deepEqual(installerWrite.contents, original);
  assert.notEqual(installerWrite.contents.toString("utf8"), "replacement after manifest\n");
});

test("desktop packaging includes the Relay sources required by the production manifest", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(packageJson.build.files.includes("relay/**/*"));
});
