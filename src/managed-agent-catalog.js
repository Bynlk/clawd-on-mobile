"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_LAUNCH_COMMANDS = {
  "claude-code": { command: "claude", args: [] },
  codex: { command: "codex", args: [] },
  "copilot-cli": { command: "copilot", args: [] },
  "gemini-cli": { command: "gemini", args: [] },
  "antigravity-cli": { command: "agy", args: [] },
  "cursor-agent": { command: "cursor-agent", args: [] },
  codebuddy: { command: "codebuddy", args: [] },
  "kiro-cli": { command: "kiro-cli", args: [] },
  "kimi-cli": { command: "kimi", args: [] },
  "qwen-code": { command: "qwen", args: [] },
  codewhale: { command: "codewhale", args: [] },
  opencode: { command: "opencode", args: [] },
  pi: { command: "pi", args: [] },
  openclaw: { command: "openclaw", args: ["tui", "--local"] },
  hermes: { command: "hermes", args: [] },
  qoder: { command: "qodercli", args: [] },
  reasonix: { command: "reasonix", args: [] },
  qoderwork: { command: "qoderwork", args: [] },
};

function executableExists(command, options = {}) {
  if (typeof command !== "string" || !command.trim()) return false;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathEntries = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? `${command}${extension}` : command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

class ManagedAgentCatalog {
  constructor(options = {}) {
    this.agents = Array.isArray(options.agents) ? options.agents : [];
    this.platform = options.platform || process.platform;
    this.isAgentEnabled = typeof options.isAgentEnabled === "function"
      ? options.isAgentEnabled
      : () => true;
    this.commandExists = typeof options.commandExists === "function"
      ? options.commandExists
      : (command) => executableExists(command, { platform: this.platform });
    this.directoryExists = typeof options.directoryExists === "function"
      ? options.directoryExists
      : (directory) => {
          try { return fs.statSync(directory).isDirectory(); } catch { return false; }
        };
    this.homeDir = options.homeDir || os.homedir();
    this.processCwd = options.processCwd || process.cwd();
    this.getSessionDirectories = typeof options.getSessionDirectories === "function"
      ? options.getSessionDirectories
      : () => [];
    this.launchCommands = { ...DEFAULT_LAUNCH_COMMANDS, ...(options.launchCommands || {}) };
  }

  listAgents() {
    const available = [];
    for (const agent of this.agents) {
      if (!agent || !agent.id || !this.isAgentEnabled(agent.id)) continue;
      const launch = this._launchFor(agent);
      if (!launch || !this.commandExists(launch.command)) continue;
      available.push({
        id: agent.id,
        name: agent.name || agent.id,
        command: launch.command,
        args: [...launch.args],
      });
    }
    return available;
  }

  listDirectories() {
    const candidates = [this.homeDir, this.processCwd, ...this.getSessionDirectories()];
    const seen = new Set();
    const result = [];
    for (const value of candidates) {
      if (typeof value !== "string" || !value.trim()) continue;
      const normalized = path.resolve(value);
      if (seen.has(normalized) || !this.directoryExists(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result.sort((a, b) => a.localeCompare(b));
  }

  resolveCreateRequest(request) {
    const value = request && typeof request === "object" ? request : {};
    const agent = this.listAgents().find((entry) => entry.id === value.agentId);
    if (!agent) throw new Error("agent_not_available");
    const cwd = typeof value.cwd === "string" ? path.resolve(value.cwd) : "";
    if (!cwd || !this.listDirectories().includes(cwd)) throw new Error("directory_not_allowed");
    return { agentId: agent.id, cwd, command: agent.command, args: [...agent.args] };
  }

  _launchFor(agent) {
    const configured = this.launchCommands[agent.id];
    if (configured && typeof configured.command === "string") {
      return { command: configured.command, args: Array.isArray(configured.args) ? configured.args : [] };
    }
    const names = agent.processNames && (agent.processNames[this.platform] || agent.processNames.mac);
    const command = Array.isArray(names) ? names[0] : null;
    return command ? { command: command.replace(/\.exe$/i, ""), args: [] } : null;
  }
}

module.exports = { DEFAULT_LAUNCH_COMMANDS, ManagedAgentCatalog, executableExists };
