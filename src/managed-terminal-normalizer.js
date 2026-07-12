"use strict";

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function cleanVisibleText(raw) {
  const withoutAnsi = String(raw || "").replace(ANSI_PATTERN, "");
  return withoutAnsi
    .split("\n")
    .map((line) => line.split("\r").at(-1))
    .join("\n");
}

function parseDiff(text) {
  if (!/(^|\n)(diff --git |@@ )/.test(text)) return null;
  const lines = text.split("\n");
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const fileLine = lines.find((line) => line.startsWith("+++ b/"));
  return {
    kind: "diff",
    text,
    file: fileLine ? fileLine.slice(6) : null,
    additions,
    deletions,
  };
}

class ManagedTerminalNormalizer {
  push(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    const rawText = String(raw);
    const text = cleanVisibleText(rawText);
    const diff = parseDiff(text);
    if (diff) return [{ ...diff, raw: rawText }];

    const fence = text.match(/^```([^\n]*)\n([\s\S]*?)\n```\s*$/);
    if (fence) {
      return [{ kind: "code", language: fence[1].trim() || null, text: fence[2], raw: rawText }];
    }

    const thinking = text.match(/^\s*(?:thinking|thought|reasoning)\s*[:：]\s*([\s\S]*?)\s*$/i);
    if (thinking) {
      return [{ kind: "thinking", text: thinking[1], raw: rawText }];
    }
    return [{ kind: "terminal_delta", text, raw: rawText }];
  }
}

module.exports = { ANSI_PATTERN, ManagedTerminalNormalizer, cleanVisibleText, parseDiff };
