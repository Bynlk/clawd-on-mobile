const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  MANAGED_AGENT_IDS,
  AGENT_DISPLAY_NAMES,
  CODEX_MARKERS,
  buildCleanupOptionsForHome,
  cleanupIntegrations,
  parseArgs,
} = require("../hooks/cleanup-integrations");
const { resolvePluginDir } = require("../hooks/opencode-install");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listCleanupBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes(".clawd-cleanup-") && name.endsWith(".bak"));
}

describe("cleanupIntegrations", () => {
  it("builds explicit cleanup path overrides for every managed agent", () => {
    const homeDir = path.join(os.tmpdir(), "clawd-target-home");
    const inheritedLocalAppData = path.join(os.tmpdir(), "admin-local-appdata");
    const targetLocalAppData = path.join(homeDir, "AppData", "Local");
    const targetAppData = path.join(homeDir, "AppData", "Roaming");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: {
        HERMES_HOME: path.join(os.tmpdir(), "admin-hermes"),
        LOCALAPPDATA: inheritedLocalAppData,
        APPDATA: path.join(os.tmpdir(), "admin-appdata"),
      },
      hermesCommand: false,
      platform: "win32",
    });
    const missing = MANAGED_AGENT_IDS.filter((agentId) => !plan.byAgent[agentId]);

    assert.deepStrictEqual(missing, []);
    for (const agentId of MANAGED_AGENT_IDS) {
      assert.notStrictEqual(plan.byAgent[agentId], plan.common, `${agentId} must not fall back to common options`);
    }
    assert.strictEqual(plan.byAgent["claude-code"].settingsPath, path.join(homeDir, ".claude", "settings.json"));
    assert.strictEqual(plan.byAgent.codex.hooksPath, path.join(homeDir, ".codex", "hooks.json"));
    assert.strictEqual(plan.byAgent.codewhale.configPath, path.join(homeDir, ".codewhale", "config.toml"));
    assert.strictEqual(plan.byAgent.opencode.configPath, path.join(homeDir, ".config", "opencode", "opencode.json"));
    assert.strictEqual(plan.byAgent.pi.parentDir, path.join(homeDir, ".pi", "agent"));
    assert.strictEqual(plan.env.LOCALAPPDATA, targetLocalAppData);
    assert.strictEqual(plan.env.APPDATA, targetAppData);
    assert.strictEqual(plan.env.HERMES_HOME, undefined);
    assert.strictEqual(plan.byAgent.hermes.env.LOCALAPPDATA, targetLocalAppData);
    assert.notStrictEqual(plan.byAgent.hermes.hermesHome, path.join(inheritedLocalAppData, "hermes"));
  });

  it("removes managed hooks/plugins safely, backs up once, and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cleanup-"));
    const homeDir = path.join(root, "home");
    const pluginDir = resolvePluginDir();
    const codexPath = path.join(homeDir, ".codex", "hooks.json");
    const codewhalePath = path.join(homeDir, ".codewhale", "config.toml");
    const opencodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    const kiroTeamPath = path.join(homeDir, ".kiro", "agents", "team.json");
    const kiroClawdPath = path.join(homeDir, ".kiro", "agents", "clawd.json");

    writeJson(codexPath, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: 'node "C:/clawd/hooks/codex-hook.js"' }] },
          { hooks: [{ type: "command", command: 'node "C:/clawd/hooks/codex-debug-hook.js"' }] },
          { hooks: [{ type: "command", command: 'node "C:/user/hooks/keep.js"' }] },
        ],
      },
    });
    fs.mkdirSync(path.dirname(codewhalePath), { recursive: true });
    fs.writeFileSync(
      codewhalePath,
      [
        "[hooks]",
        "enabled = true",
        "",
        "[[hooks.hooks]]",
        "# managed by clawd-on-desk",
        'event = "session_start"',
        'command = "\\"node\\" \\"C:/clawd/hooks/codewhale-hook.js\\" \\"session_start\\""',
        "",
        "[[hooks.hooks]]",
        'event = "session_start"',
        'command = "echo user-hook"',
        "",
      ].join("\n"),
      "utf8"
    );
    writeJson(opencodePath, {
      plugin: [
        pluginDir,
        "/somewhere/opencode-plugin",
        "opencode-wakatime",
      ],
    });
    writeJson(kiroTeamPath, {
      name: "team",
      hooks: {
        userPromptSubmit: [
          { command: 'node "C:/clawd/hooks/kiro-hook.js"' },
          { command: 'node "C:/user/hooks/keep.js"' },
        ],
      },
    });
    writeJson(kiroClawdPath, {
      name: "clawd",
      description: "customized",
      hooks: {
        stop: [{ command: 'node "C:/clawd/hooks/kiro-hook.js"' }],
      },
    });

    try {
      const result = cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      assert.strictEqual(result.summary.failed, 0);
      assert.ok(result.summary.entriesRemoved >= 5);

      const codex = readJson(codexPath);
      assert.deepStrictEqual(codex.hooks.Stop, [
        { hooks: [{ type: "command", command: 'node "C:/user/hooks/keep.js"' }] },
      ]);
      assert.strictEqual(listCleanupBackups(path.dirname(codexPath)).length, 1);

      const codewhale = fs.readFileSync(codewhalePath, "utf8");
      assert.ok(!codewhale.includes("codewhale-hook.js"));
      assert.ok(codewhale.includes('command = "echo user-hook"'));

      const opencode = readJson(opencodePath);
      assert.deepStrictEqual(opencode.plugin, [
        "/somewhere/opencode-plugin",
        "opencode-wakatime",
      ]);
      assert.strictEqual(listCleanupBackups(path.dirname(opencodePath)).length, 1);

      const kiroTeam = readJson(kiroTeamPath);
      assert.deepStrictEqual(kiroTeam.hooks.userPromptSubmit, [
        { command: 'node "C:/user/hooks/keep.js"' },
      ]);
      assert.ok(fs.existsSync(kiroClawdPath), "cleanup must retain Kiro clawd.json");
      assert.deepStrictEqual(readJson(kiroClawdPath).hooks, {});
      const kiroAgent = result.agents.find((agent) => agent.agentId === "kiro-cli");
      assert.ok(kiroAgent.notes.some((note) => note.includes("clawd.json")));
      assert.deepStrictEqual(kiroAgent.warnings, []);
      assert.strictEqual(listCleanupBackups(path.dirname(kiroTeamPath)).length, 2);

      const backupCounts = {
        codex: listCleanupBackups(path.dirname(codexPath)).length,
        opencode: listCleanupBackups(path.dirname(opencodePath)).length,
        kiro: listCleanupBackups(path.dirname(kiroTeamPath)).length,
      };
      const second = cleanupIntegrations({ homeDir, backup: true, silent: true, hermesCommand: false });
      assert.strictEqual(second.summary.failed, 0);
      assert.strictEqual(second.summary.entriesRemoved, 0);
      assert.deepStrictEqual({
        codex: listCleanupBackups(path.dirname(codexPath)).length,
        opencode: listCleanupBackups(path.dirname(opencodePath)).length,
        kiro: listCleanupBackups(path.dirname(kiroTeamPath)).length,
      }, backupCounts);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── constants ──────────────────────────────────────────────────────

describe("module constants", () => {
  it("MANAGED_AGENT_IDS is a frozen array with at least 15 agents", () => {
    assert.ok(Array.isArray(MANAGED_AGENT_IDS));
    assert.ok(MANAGED_AGENT_IDS.length >= 15);
    assert.throws(() => { MANAGED_AGENT_IDS.push("test"); }, TypeError);
  });

  it("AGENT_DISPLAY_NAMES has a display name for every managed agent", () => {
    for (const agentId of MANAGED_AGENT_IDS) {
      assert.strictEqual(typeof AGENT_DISPLAY_NAMES[agentId], "string", `missing display name for ${agentId}`);
      assert.ok(AGENT_DISPLAY_NAMES[agentId].length > 0, `empty display name for ${agentId}`);
    }
  });

  it("CODEX_MARKERS contains codex-hook.js and codex-debug-hook.js", () => {
    assert.ok(CODEX_MARKERS.includes("codex-hook.js"));
    assert.ok(CODEX_MARKERS.includes("codex-debug-hook.js"));
  });
});

// ── parseArgs ──────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns defaults when no arguments are given", () => {
    const result = parseArgs([]);
    assert.strictEqual(result.backup, true);
    assert.strictEqual(result.silent, false);
  });

  it("parses --apply flag", () => {
    const result = parseArgs(["--apply"]);
    assert.strictEqual(result.backup, true);
  });

  it("parses --no-backup flag", () => {
    const result = parseArgs(["--no-backup"]);
    assert.strictEqual(result.backup, false);
  });

  it("parses --silent flag", () => {
    const result = parseArgs(["--silent"]);
    assert.strictEqual(result.silent, true);
  });

  it("parses --fail-open flag", () => {
    const result = parseArgs(["--fail-open"]);
    assert.strictEqual(result.failOpen, true);
  });

  it("parses --source with value", () => {
    const result = parseArgs(["--source", "uninstall"]);
    assert.strictEqual(result.source, "uninstall");
  });

  it("parses --user-home with value", () => {
    const result = parseArgs(["--user-home", "/home/test"]);
    assert.strictEqual(result.homeDir, "/home/test");
  });

  it("parses --home alias", () => {
    const result = parseArgs(["--home", "/home/test"]);
    assert.strictEqual(result.homeDir, "/home/test");
  });

  it("parses --home-dir alias", () => {
    const result = parseArgs(["--home-dir", "/home/test"]);
    assert.strictEqual(result.homeDir, "/home/test");
  });

  it("parses combined flags", () => {
    const result = parseArgs(["--apply", "--no-backup", "--silent", "--fail-open", "--source", "test", "--home", "/tmp"]);
    assert.strictEqual(result.backup, false);
    assert.strictEqual(result.silent, true);
    assert.strictEqual(result.failOpen, true);
    assert.strictEqual(result.source, "test");
    assert.strictEqual(result.homeDir, "/tmp");
  });

  it("throws on unknown arguments", () => {
    assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
  });

  it("throws on unrecognized positional args", () => {
    assert.throws(() => parseArgs(["something"]), /Unknown argument/);
  });
});

// ── buildCleanupOptionsForHome edge cases ──────────────────────────

describe("buildCleanupOptionsForHome", () => {
  it("uses os.homedir() when no home dir is provided", () => {
    const plan = buildCleanupOptionsForHome(null, { platform: "linux" });
    assert.strictEqual(plan.homeDir, path.resolve(os.homedir()));
  });

  it("trims whitespace from home dir input", () => {
    const plan = buildCleanupOptionsForHome("  /tmp/test-home  ", { platform: "linux" });
    assert.strictEqual(plan.homeDir, path.resolve("/tmp/test-home"));
  });

  it("uses options.homeDir as fallback when first arg is falsy", () => {
    const plan = buildCleanupOptionsForHome(null, { homeDir: "/opt/user", platform: "linux" });
    assert.strictEqual(plan.homeDir, path.resolve("/opt/user"));
  });

  it("uses options.userHome as second fallback", () => {
    const plan = buildCleanupOptionsForHome(null, { userHome: "/var/user", platform: "linux" });
    assert.strictEqual(plan.homeDir, path.resolve("/var/user"));
  });

  it("sets LOCALAPPDATA and APPDATA on win32 platform", () => {
    const homeDir = path.join(os.tmpdir(), "win-home");
    const plan = buildCleanupOptionsForHome(homeDir, { platform: "win32" });
    assert.strictEqual(plan.env.LOCALAPPDATA, path.join(homeDir, "AppData", "Local"));
    assert.strictEqual(plan.env.APPDATA, path.join(homeDir, "AppData", "Roaming"));
  });

  it("does not set LOCALAPPDATA on non-win32 platforms when env is empty", () => {
    const plan = buildCleanupOptionsForHome("/tmp/home", { platform: "linux", env: {} });
    assert.strictEqual(plan.env.LOCALAPPDATA, undefined);
  });

  it("sets HERMES_HOME from options.hermesHome", () => {
    const homeDir = path.join(os.tmpdir(), "hermes-home-test");
    const hermesHome = path.join(os.tmpdir(), "opt-hermes");
    const plan = buildCleanupOptionsForHome(homeDir, { hermesHome, platform: "linux", env: {} });
    assert.strictEqual(plan.env.HERMES_HOME, path.resolve(hermesHome));
  });

  it("deletes inherited HERMES_HOME when explicit home and no hermesHome option", () => {
    const homeDir = path.join(os.tmpdir(), "hermes-del-test");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: { HERMES_HOME: path.join(os.tmpdir(), "inherited") },
      platform: "linux",
    });
    assert.strictEqual(plan.env.HERMES_HOME, undefined);
  });

  it("uses env.OPENCLAW_STATE_DIR when set", () => {
    const homeDir = path.join(os.tmpdir(), "openclaw-env-test");
    const customDir = path.join(os.tmpdir(), "custom-openclaw");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: { OPENCLAW_STATE_DIR: customDir },
      platform: "linux",
    });
    assert.strictEqual(plan.byAgent.openclaw.stateDir, customDir);
  });

  it("uses options.openClawStateDir over env", () => {
    const homeDir = path.join(os.tmpdir(), "openclaw-opt-test");
    const optDir = path.join(os.tmpdir(), "opt-openclaw");
    const envDir = path.join(os.tmpdir(), "env-openclaw");
    const plan = buildCleanupOptionsForHome(homeDir, {
      openClawStateDir: optDir,
      env: { OPENCLAW_STATE_DIR: envDir },
      platform: "linux",
    });
    assert.strictEqual(plan.byAgent.openclaw.stateDir, optDir);
  });

  it("uses options.openClawConfigPath over env", () => {
    const homeDir = path.join(os.tmpdir(), "openclaw-cfg-test");
    const optPath = path.join(os.tmpdir(), "opt-openclaw", "config.json");
    const envPath = path.join(os.tmpdir(), "env-openclaw", "config.json");
    const plan = buildCleanupOptionsForHome(homeDir, {
      openClawConfigPath: optPath,
      env: { OPENCLAW_CONFIG_PATH: envPath },
      platform: "linux",
    });
    assert.strictEqual(plan.byAgent.openclaw.configPath, optPath);
  });

  it("uses options.copilotHome over COPILOT_HOME env", () => {
    const homeDir = path.join(os.tmpdir(), "copilot-opt-test");
    const optHome = path.join(os.tmpdir(), "opt-copilot");
    const envHome = path.join(os.tmpdir(), "env-copilot");
    const plan = buildCleanupOptionsForHome(homeDir, {
      copilotHome: optHome,
      env: { COPILOT_HOME: envHome },
      platform: "linux",
    });
    assert.strictEqual(plan.byAgent["copilot-cli"].copilotHome, optHome);
  });

  it("uses COPILOT_HOME env when options.copilotHome is not set", () => {
    const homeDir = path.join(os.tmpdir(), "copilot-env-test");
    const envHome = path.join(os.tmpdir(), "env-copilot");
    const plan = buildCleanupOptionsForHome(homeDir, {
      env: { COPILOT_HOME: envHome },
      platform: "linux",
    });
    assert.strictEqual(plan.byAgent["copilot-cli"].copilotHome, envHome);
  });

  it("defaults copilotHome to .copilot in homeDir", () => {
    const homeDir = path.join(os.tmpdir(), "copilot-test-home");
    const plan = buildCleanupOptionsForHome(homeDir, { platform: "linux", env: {} });
    assert.strictEqual(plan.byAgent["copilot-cli"].copilotHome, path.join(homeDir, ".copilot"));
  });

  it("sets backup and silent from options", () => {
    const homeDir = path.join(os.tmpdir(), "backup-test-home");
    const plan = buildCleanupOptionsForHome(homeDir, { backup: false, silent: false, platform: "linux", env: {} });
    assert.strictEqual(plan.common.backup, false);
    assert.strictEqual(plan.common.silent, false);
  });

  it("defaults backup to true and silent to true", () => {
    const homeDir = path.join(os.tmpdir(), "defaults-test-home");
    const plan = buildCleanupOptionsForHome(homeDir, { platform: "linux", env: {} });
    assert.strictEqual(plan.common.backup, true);
    assert.strictEqual(plan.common.silent, true);
  });

  it("builds correct paths for each agent", () => {
    const homeDir = path.join(os.tmpdir(), "path-test-home");
    const plan = buildCleanupOptionsForHome(homeDir, { platform: "linux", env: {} });
    assert.strictEqual(plan.byAgent["claude-code"].settingsPath, path.join(homeDir, ".claude", "settings.json"));
    assert.strictEqual(plan.byAgent["gemini-cli"].settingsPath, path.join(homeDir, ".gemini", "settings.json"));
    assert.strictEqual(plan.byAgent["antigravity-cli"].configPath, path.join(homeDir, ".gemini", "config", "hooks.json"));
    assert.strictEqual(plan.byAgent["cursor-agent"].hooksPath, path.join(homeDir, ".cursor", "hooks.json"));
    assert.strictEqual(plan.byAgent.codebuddy.settingsPath, path.join(homeDir, ".codebuddy", "settings.json"));
    assert.strictEqual(plan.byAgent["kiro-cli"].agentsDir, path.join(homeDir, ".kiro", "agents"));
    assert.strictEqual(plan.byAgent["kimi-cli"].settingsPath, path.join(homeDir, ".kimi", "config.toml"));
    assert.strictEqual(plan.byAgent["qwen-code"].settingsPath, path.join(homeDir, ".qwen", "settings.json"));
    assert.strictEqual(plan.byAgent.codex.hooksPath, path.join(homeDir, ".codex", "hooks.json"));
    assert.strictEqual(plan.byAgent.pi.parentDir, path.join(homeDir, ".pi", "agent"));
    assert.strictEqual(plan.byAgent.qoder.settingsPath, path.join(homeDir, ".qoder", "settings.json"));
  });
});

// ── cleanupIntegrations edge cases ─────────────────────────────────

describe("cleanupIntegrations edge cases", () => {
  it("produces a result with the expected summary shape", () => {
    const result = cleanupIntegrations({ homeDir: os.tmpdir(), silent: true, hermesCommand: false });
    assert.strictEqual(result.mode, "apply");
    assert.ok(typeof result.homeDir === "string");
    assert.ok(Array.isArray(result.agents));
    assert.strictEqual(result.agents.length, MANAGED_AGENT_IDS.length);
    assert.strictEqual(typeof result.summary.agentsChecked, "number");
    assert.strictEqual(typeof result.summary.agentsAffected, "number");
    assert.strictEqual(typeof result.summary.entriesRemoved, "number");
    assert.strictEqual(typeof result.summary.skipped, "number");
    assert.strictEqual(typeof result.summary.failed, "number");
  });

  it("every agent has required fields", () => {
    const result = cleanupIntegrations({ homeDir: os.tmpdir(), silent: true, hermesCommand: false });
    for (const agent of result.agents) {
      assert.strictEqual(typeof agent.agentId, "string");
      assert.strictEqual(typeof agent.displayName, "string");
      assert.ok(["pending", "applied", "skipped", "failed"].includes(agent.status));
      assert.strictEqual(typeof agent.removed, "number");
      assert.strictEqual(typeof agent.changed, "boolean");
      assert.ok(Array.isArray(agent.backupPaths));
      assert.ok(Array.isArray(agent.warnings));
      assert.ok(Array.isArray(agent.notes));
    }
  });

  it("default homeDir resolves to os.homedir()", () => {
    const result = cleanupIntegrations({ silent: true, hermesCommand: false });
    assert.strictEqual(result.homeDir, path.resolve(os.homedir()));
  });
});
