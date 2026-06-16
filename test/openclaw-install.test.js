"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureOpenClawConfigLinked,
  hasIncludeDirective,
  registerOpenClawPlugin,
  resolvePluginDir,
  unregisterOpenClawPlugin,
  resolveOpenClawPaths,
  hasOpenClawCommand,
  PLUGIN_ID,
  PLUGIN_DIR_NAME,
  DEFAULT_STATE_DIR,
  DEFAULT_CONFIG_PATH,
} = require("../hooks/openclaw-install");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-openclaw-install-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("openclaw plugin installer", () => {
  it("skips when OpenClaw is not installed and no config exists", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-not-found");
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("does not create OpenClaw config during startup sync", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      openclawCommandAvailable: true,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-config-missing");
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("links the plugin into an existing strict JSON config", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, { theme: "dark", plugins: { load: { paths: [] }, entries: {} } });

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, true);
    const config = readJson(configPath);
    assert.strictEqual(config.theme, "dark");
    assert.deepStrictEqual(config.plugins.load.paths, [pluginDir]);
    assert.deepStrictEqual(config.plugins.entries["clawd-on-mobile"], {
      enabled: true,
      hooks: { allowConversationAccess: false },
    });
  });

  it("is idempotent when the plugin is already linked", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [pluginDir] },
        entries: {
          "clawd-on-mobile": {
            enabled: true,
            hooks: { allowConversationAccess: false },
          },
        },
      },
    });

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, false);
  });

  it("updates stale absolute plugin paths by basename", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    const stalePath = "D:/old/hooks/openclaw-plugin";
    const pluginDir = "D:/new/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [stalePath] },
        entries: { "clawd-on-mobile": { enabled: false } },
      },
    });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.updated, true);
    const config = readJson(configPath);
    assert.deepStrictEqual(config.plugins.load.paths, [pluginDir]);
    assert.strictEqual(config.plugins.entries["clawd-on-mobile"].enabled, true);
  });

  it("falls back instead of editing configs with include directives", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    writeJson(configPath, {
      plugins: {
        $include: "./plugins.json",
        load: { paths: [] },
      },
    });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "config-has-include");
    assert.deepStrictEqual(readJson(configPath).plugins.load.paths, []);
  });

  it("uses CLI fallback for JSON5 or missing config only when explicitly requested", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");
    const calls = [];

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: "Linked plugin path", stderr: "" };
      },
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.installed, true);
    assert.deepStrictEqual(calls, [[
      "openclaw",
      ["plugins", "install", "--link", "C:/clawd/hooks/openclaw-plugin"],
    ]]);
    assert.strictEqual(fs.existsSync(configPath), false);
  });

  it("unregisters the managed path from strict JSON config", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    const pluginDir = "C:/clawd/hooks/openclaw-plugin";
    writeJson(configPath, {
      plugins: {
        load: { paths: [pluginDir, "C:/other/plugin"] },
        entries: { "clawd-on-mobile": { enabled: true } },
      },
    });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir,
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, true);
    const config = readJson(configPath);
    assert.deepStrictEqual(config.plugins.load.paths, ["C:/other/plugin"]);
    assert.strictEqual(config.plugins.entries["clawd-on-mobile"], undefined);
  });
});

describe("openclaw installer helpers", () => {
  it("detects include directives recursively", () => {
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { $include: "./x.json" } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { entries: { x: { include: ["./x.json"] } } } }), true);
    assert.strictEqual(hasIncludeDirective({ plugins: { load: { paths: [] } } }), false);
  });

  it("can link a minimal config object without clobbering other keys", () => {
    const config = { foo: true };
    const result = ensureOpenClawConfigLinked(config, "C:/clawd/hooks/openclaw-plugin");

    assert.deepStrictEqual(result, { updated: true });
    assert.strictEqual(config.foo, true);
    assert.deepStrictEqual(config.plugins.load.paths, ["C:/clawd/hooks/openclaw-plugin"]);
  });

  it("resolves a forward-slash plugin path and rewrites app.asar", () => {
    const result = resolvePluginDir("/Applications/Clawd.app/Contents/Resources/app.asar/hooks");

    assert.ok(result.endsWith("/openclaw-plugin"), `got: ${result}`);
    assert.ok(result.includes("app.asar.unpacked/hooks/openclaw-plugin"), `got: ${result}`);
    assert.ok(!result.includes("\\"));
  });
});

describe("openclaw installer constants", () => {
  it("exports expected constants", () => {
    assert.strictEqual(PLUGIN_ID, "clawd-on-mobile");
    assert.strictEqual(PLUGIN_DIR_NAME, "openclaw-plugin");
    assert.ok(DEFAULT_STATE_DIR.includes(".openclaw"));
    assert.ok(DEFAULT_CONFIG_PATH.includes("openclaw.json"));
  });
});

describe("resolveOpenClawPaths", () => {
  it("uses default paths when no overrides provided", () => {
    const { stateDir, configPath } = resolveOpenClawPaths({});
    assert.ok(stateDir.includes(".openclaw"));
    assert.ok(configPath.includes("openclaw.json"));
  });

  it("respects stateDir option", () => {
    const tmpDir = path.join(os.tmpdir(), "clawd-test-state");
    const { stateDir, configPath } = resolveOpenClawPaths({ stateDir: tmpDir });
    assert.strictEqual(stateDir, tmpDir);
    assert.ok(configPath.startsWith(tmpDir));
  });

  it("respects configPath option", () => {
    const { configPath } = resolveOpenClawPaths({ configPath: "/custom/openclaw.json" });
    assert.strictEqual(configPath, "/custom/openclaw.json");
  });

  it("respects env vars for paths", () => {
    const { stateDir, configPath } = resolveOpenClawPaths({
      env: {
        OPENCLAW_STATE_DIR: "/env/state",
        OPENCLAW_CONFIG_PATH: "/env/config.json",
      },
    });
    assert.strictEqual(stateDir, "/env/state");
    assert.strictEqual(configPath, "/env/config.json");
  });
});

describe("hasOpenClawCommand", () => {
  it("returns boolean when openclawCommandAvailable is a boolean", () => {
    assert.strictEqual(hasOpenClawCommand({ openclawCommandAvailable: true }), true);
    assert.strictEqual(hasOpenClawCommand({ openclawCommandAvailable: false }), false);
  });

  it("returns boolean when openclawCommandAvailable is a function", () => {
    assert.strictEqual(hasOpenClawCommand({ openclawCommandAvailable: () => true }), true);
    assert.strictEqual(hasOpenClawCommand({ openclawCommandAvailable: () => false }), false);
  });

  it("uses execFileSync to detect command on win32", () => {
    const calls = [];
    const result = hasOpenClawCommand({
      platform: "win32",
      openclawCommandAvailable: undefined,
      execFileSync: (cmd, args) => {
        calls.push([cmd, args]);
        return "";
      },
    });
    assert.strictEqual(result, true);
    assert.deepStrictEqual(calls[0], ["where", ["openclaw"]]);
  });

  it("returns false when command detection fails on win32", () => {
    const result = hasOpenClawCommand({
      platform: "win32",
      openclawCommandAvailable: undefined,
      execFileSync: () => { throw new Error("not found"); },
    });
    assert.strictEqual(result, false);
  });

  it("tries multiple shells on non-windows platforms", () => {
    let callCount = 0;
    const result = hasOpenClawCommand({
      platform: "linux",
      openclawCommandAvailable: undefined,
      execFileSync: () => { callCount++; throw new Error("not found"); },
    });
    assert.strictEqual(result, false);
    assert.ok(callCount >= 2);
  });
});

describe("ensureOpenClawConfigLinked edge cases", () => {
  it("returns config-not-object for non-object input", () => {
    assert.deepStrictEqual(ensureOpenClawConfigLinked(null, "dir"), { reason: "config-not-object" });
    assert.deepStrictEqual(ensureOpenClawConfigLinked("string", "dir"), { reason: "config-not-object" });
    assert.deepStrictEqual(ensureOpenClawConfigLinked(42, "dir"), { reason: "config-not-object" });
    assert.deepStrictEqual(ensureOpenClawConfigLinked(undefined, "dir"), { reason: "config-not-object" });
  });

  it("returns plugins-not-object when plugins is a string", () => {
    const config = { plugins: "invalid" };
    assert.deepStrictEqual(ensureOpenClawConfigLinked(config, "dir"), { reason: "plugins-not-object" });
  });

  it("returns plugins-load-not-object when plugins.load is a string", () => {
    const config = { plugins: { load: "invalid" } };
    assert.deepStrictEqual(ensureOpenClawConfigLinked(config, "dir"), { reason: "plugins-load-not-object" });
  });

  it("returns plugins-load-paths-not-array when paths is a string", () => {
    const config = { plugins: { load: { paths: "invalid" } } };
    assert.deepStrictEqual(ensureOpenClawConfigLinked(config, "dir"), { reason: "plugins-load-paths-not-array" });
  });

  it("returns plugins-entries-not-object when entries is a string", () => {
    const config = { plugins: { load: { paths: [] }, entries: "invalid" } };
    assert.deepStrictEqual(ensureOpenClawConfigLinked(config, "dir"), { reason: "plugins-entries-not-object" });
  });

  it("initializes missing plugins structure", () => {
    const config = {};
    const result = ensureOpenClawConfigLinked(config, "/plugin/dir");
    assert.strictEqual(result.updated, true);
    assert.deepStrictEqual(config.plugins.load.paths, ["/plugin/dir"]);
    assert.deepStrictEqual(config.plugins.entries[PLUGIN_ID], {
      enabled: true,
      hooks: { allowConversationAccess: false },
    });
  });

  it("preserves existing hooks on the plugin entry", () => {
    const config = {
      plugins: {
        load: { paths: ["/plugin/dir"] },
        entries: {
          "clawd-on-mobile": {
            enabled: false,
            hooks: { allowConversationAccess: true, customSetting: 42 },
          },
        },
      },
    };
    const result = ensureOpenClawConfigLinked(config, "/plugin/dir");
    assert.strictEqual(result.updated, true);
    assert.strictEqual(config.plugins.entries["clawd-on-mobile"].enabled, true);
    assert.strictEqual(config.plugins.entries["clawd-on-mobile"].hooks.allowConversationAccess, false);
    assert.strictEqual(config.plugins.entries["clawd-on-mobile"].hooks.customSetting, 42);
  });
});

describe("registerOpenClawPlugin edge cases", () => {
  it("returns openclaw-config-not-strict-json when JSON is malformed and no CLI fallback", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{invalid json!!", "utf8");

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-config-not-strict-json");
  });

  it("returns config-has-include when config has include and no CLI fallback", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    writeJson(configPath, { plugins: { $include: "./ext.json", load: { paths: [] } } });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "config-has-include");
  });

  it("uses CLI fallback when JSON parse fails and useCliFallback is true", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{bad json", "utf8");

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 0, stdout: "OK", stderr: "" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.status, "ok");
  });

  it("uses CLI fallback when config has include and useCliFallback is true", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    writeJson(configPath, { plugins: { $include: "./ext.json" } });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 0, stdout: "OK", stderr: "" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
  });

  it("uses CLI fallback when config is missing and useCliFallback is true", () => {
    const root = makeTempDir();
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");

    const result = registerOpenClawPlugin({
      stateDir,
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 0, stdout: "Linked", stderr: "" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
  });

  it("writes config when linked is updated", () => {
    const root = makeTempDir();
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    writeJson(configPath, { plugins: { load: { paths: [] }, entries: {} } });

    const result = registerOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.updated, true);
    const saved = readJson(configPath);
    assert.deepStrictEqual(saved.plugins.load.paths, ["C:/clawd/hooks/openclaw-plugin"]);
  });

  it("handles CLI already-installed result", () => {
    const result = registerOpenClawPlugin({
      stateDir: "/tmp/.openclaw",
      configPath: "/tmp/.openclaw/openclaw.json",
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 1, stdout: "", stderr: "Plugin already installed" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "already-installed");
  });

  it("handles CLI failure result", () => {
    const result = registerOpenClawPlugin({
      stateDir: "/tmp/.openclaw",
      configPath: "/tmp/.openclaw/openclaw.json",
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 2, stdout: "", stderr: "permission denied" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "cli-failed");
  });
});

describe("unregisterOpenClawPlugin edge cases", () => {
  it("returns openclaw-config-missing when config file does not exist", () => {
    const result = unregisterOpenClawPlugin({
      configPath: "/nonexistent/openclaw.json",
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "openclaw-config-missing");
  });

  it("returns openclaw-config-not-strict-json when JSON is malformed", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, "{bad json", "utf8");

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.reason, "openclaw-config-not-strict-json");
  });

  it("returns config-has-include when config has include directives", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    writeJson(configPath, { plugins: { $include: "./ext.json" } });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.reason, "config-has-include");
  });

  it("returns skipped when plugin is not in config", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    writeJson(configPath, { plugins: { load: { paths: [] }, entries: {} } });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
    });

    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.skipped, true);
  });

  it("uses CLI fallback for uninstall when config is missing and useCliFallback is true", () => {
    const calls = [];
    const result = unregisterOpenClawPlugin({
      configPath: "/nonexistent/openclaw.json",
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: (cmd, args) => {
        calls.push([cmd, args]);
        return { status: 0, stdout: "Removed", stderr: "" };
      },
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.removed, true);
    assert.deepStrictEqual(calls[0][1], ["plugins", "uninstall", "clawd-on-mobile", "--force"]);
  });

  it("uses CLI fallback when JSON parse fails", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, "{bad", "utf8");

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 0, stdout: "Removed", stderr: "" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
  });

  it("uses CLI fallback when config has include directives and useCliFallback is true", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    writeJson(configPath, { plugins: { $include: "./ext.json" } });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 0, stdout: "Removed", stderr: "" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
  });

  it("handles CLI not-found result as success", () => {
    const result = unregisterOpenClawPlugin({
      configPath: "/nonexistent/openclaw.json",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 1, stdout: "", stderr: "Plugin not found" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.removed, false);
  });

  it("handles CLI failure result", () => {
    const result = unregisterOpenClawPlugin({
      configPath: "/nonexistent/openclaw.json",
      useCliFallback: true,
      openclawCommandAvailable: true,
      spawnSync: () => ({ status: 2, stdout: "", stderr: "permission denied" }),
      silent: true,
    });

    assert.strictEqual(result.usedCli, true);
    assert.strictEqual(result.removed, false);
    assert.strictEqual(result.reason, "cli-failed");
  });

  it("creates backup when backup option is true", () => {
    const root = makeTempDir();
    const configPath = path.join(root, "openclaw.json");
    writeJson(configPath, {
      plugins: {
        load: { paths: ["C:/clawd/hooks/openclaw-plugin"] },
        entries: { "clawd-on-mobile": { enabled: true } },
      },
    });

    const result = unregisterOpenClawPlugin({
      configPath,
      pluginDir: "C:/clawd/hooks/openclaw-plugin",
      openclawCommandAvailable: false,
      silent: true,
      backup: true,
    });

    assert.strictEqual(result.removed, true);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    // Cleanup backup
    try { fs.unlinkSync(result.backupPath); } catch {}
  });
});

describe("hasIncludeDirective edge cases", () => {
  it("returns false for non-object non-array input", () => {
    assert.strictEqual(hasIncludeDirective(null), false);
    assert.strictEqual(hasIncludeDirective("string"), false);
    assert.strictEqual(hasIncludeDirective(42), false);
    assert.strictEqual(hasIncludeDirective(undefined), false);
  });

  it("detects $include in arrays", () => {
    assert.strictEqual(hasIncludeDirective([{ $include: "./x.json" }]), true);
    assert.strictEqual(hasIncludeDirective([{ a: 1 }]), false);
  });

  it("detects nested $include deep in object tree", () => {
    assert.strictEqual(hasIncludeDirective({
      level1: { level2: { level3: { $include: "./deep.json" } } },
    }), true);
  });

  it("detects include arrays deep in object tree", () => {
    assert.strictEqual(hasIncludeDirective({
      level1: { include: ["./deep.json"] },
    }), true);
  });
});
