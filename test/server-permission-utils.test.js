"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  PREVIEW_MAX,
  MAX_PERMISSION_SUGGESTIONS,
  MAX_ELICITATION_QUESTIONS,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_HEADER,
  MAX_ELICITATION_PROMPT,
  MAX_ELICITATION_OPTION_LABEL,
  MAX_ELICITATION_OPTION_DESCRIPTION,
  TOOL_MATCH_STRING_MAX,
  TOOL_MATCH_ARRAY_MAX,
  TOOL_MATCH_OBJECT_KEYS_MAX,
  TOOL_MATCH_DEPTH_MAX,
  truncateDeep,
  clampPreviewText,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeHookToolUseId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  normalizeCodexPermissionToolInput,
  findPendingPermissionForStateEvent,
} = require("../src/server-permission-utils");

// ── Constants ───────────────────────────────────────────────────────

describe("server-permission-utils constants", () => {
  it("PREVIEW_MAX is 500", () => { assert.strictEqual(PREVIEW_MAX, 500); });
  it("MAX_PERMISSION_SUGGESTIONS is 20", () => { assert.strictEqual(MAX_PERMISSION_SUGGESTIONS, 20); });
  it("MAX_ELICITATION_QUESTIONS is 5", () => { assert.strictEqual(MAX_ELICITATION_QUESTIONS, 5); });
  it("MAX_ELICITATION_OPTIONS is 5", () => { assert.strictEqual(MAX_ELICITATION_OPTIONS, 5); });
  it("MAX_ELICITATION_HEADER is 48", () => { assert.strictEqual(MAX_ELICITATION_HEADER, 48); });
  it("MAX_ELICITATION_PROMPT is 240", () => { assert.strictEqual(MAX_ELICITATION_PROMPT, 240); });
  it("MAX_ELICITATION_OPTION_LABEL is 80", () => { assert.strictEqual(MAX_ELICITATION_OPTION_LABEL, 80); });
  it("MAX_ELICITATION_OPTION_DESCRIPTION is 160", () => { assert.strictEqual(MAX_ELICITATION_OPTION_DESCRIPTION, 160); });
  it("TOOL_MATCH_STRING_MAX is 240", () => { assert.strictEqual(TOOL_MATCH_STRING_MAX, 240); });
  it("TOOL_MATCH_ARRAY_MAX is 16", () => { assert.strictEqual(TOOL_MATCH_ARRAY_MAX, 16); });
  it("TOOL_MATCH_OBJECT_KEYS_MAX is 32", () => { assert.strictEqual(TOOL_MATCH_OBJECT_KEYS_MAX, 32); });
  it("TOOL_MATCH_DEPTH_MAX is 6", () => { assert.strictEqual(TOOL_MATCH_DEPTH_MAX, 6); });
});

// ── truncateDeep ────────────────────────────────────────────────────

describe("truncateDeep", () => {
  it("returns short strings unchanged", () => { assert.strictEqual(truncateDeep("hello"), "hello"); });
  it("truncates strings longer than PREVIEW_MAX", () => {
    const long = "x".repeat(600);
    const result = truncateDeep(long);
    assert.strictEqual(result.length, PREVIEW_MAX + 1); // +1 for ellipsis
    assert.ok(result.endsWith("…"));
  });
  it("handles null", () => { assert.strictEqual(truncateDeep(null), null); });
  it("handles numbers", () => { assert.strictEqual(truncateDeep(42), 42); });
  it("handles booleans", () => { assert.strictEqual(truncateDeep(true), true); });
  it("recursively truncates object values", () => {
    const obj = { a: "x".repeat(600) };
    const result = truncateDeep(obj);
    assert.strictEqual(result.a.length, PREVIEW_MAX + 1);
  });
  it("recursively truncates array elements", () => {
    const arr = ["x".repeat(600)];
    const result = truncateDeep(arr);
    assert.strictEqual(result[0].length, PREVIEW_MAX + 1);
  });
  it("handles nested objects", () => {
    const obj = { a: { b: { c: "x".repeat(600) } } };
    const result = truncateDeep(obj);
    assert.strictEqual(result.a.b.c.length, PREVIEW_MAX + 1);
  });
  it("preserves short values in mixed objects", () => {
    const obj = { a: "ok", b: "x".repeat(600) };
    const result = truncateDeep(obj);
    assert.strictEqual(result.a, "ok");
    assert.ok(result.b.endsWith("…"));
  });
  it("handles depth limit", () => {
    // At depth > 10, returns obj as-is
    let obj = "deep";
    for (let i = 0; i < 15; i++) obj = { nested: obj };
    const result = truncateDeep(obj, 0);
    assert.ok(typeof result === "object");
  });
});

// ── clampPreviewText ────────────────────────────────────────────────

describe("clampPreviewText", () => {
  it("returns empty string for non-string input", () => { assert.strictEqual(clampPreviewText(42, 10), ""); });
  it("returns empty string for null", () => { assert.strictEqual(clampPreviewText(null, 10), ""); });
  it("returns empty string for whitespace-only", () => { assert.strictEqual(clampPreviewText("   ", 10), ""); });
  it("returns short text unchanged", () => { assert.strictEqual(clampPreviewText("hello", 10), "hello"); });
  it("trims whitespace", () => { assert.strictEqual(clampPreviewText("  hello  ", 10), "hello"); });
  it("truncates long text with ellipsis", () => {
    const result = clampPreviewText("hello world", 5);
    assert.strictEqual(result, "hell…");
  });
  it("handles max of 0", () => { assert.strictEqual(clampPreviewText("hello", 0), "…"); });
  it("handles exact length", () => { assert.strictEqual(clampPreviewText("hello", 5), "hello"); });
});

// ── normalizePermissionSuggestions ──────────────────────────────────

describe("normalizePermissionSuggestions", () => {
  it("returns empty array for null input", () => { assert.deepStrictEqual(normalizePermissionSuggestions(null), []); });
  it("returns empty array for non-array input", () => { assert.deepStrictEqual(normalizePermissionSuggestions("bad"), []); });
  it("filters out non-object entries", () => {
    const result = normalizePermissionSuggestions([null, "bad", 42, { type: "addRules" }]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, "addRules");
  });
  it("passes through non-addRules suggestions", () => {
    const suggestions = [{ type: "allow" }, { type: "deny" }];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result.length, 2);
  });
  it("merges multiple addRules entries", () => {
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "a" }] },
      { type: "addRules", rules: [{ toolName: "b" }] },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, "addRules");
    assert.strictEqual(result[0].rules.length, 2);
  });
  it("preserves destination and behavior from first addRules entry", () => {
    const suggestions = [
      { type: "addRules", destination: "projectSettings", behavior: "deny", rules: [] },
      { type: "addRules", destination: "other", behavior: "allow", rules: [] },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result[0].destination, "projectSettings");
    assert.strictEqual(result[0].behavior, "deny");
  });
  it("defaults destination to localSettings only when merging multiple", () => {
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "a" }] },
      { type: "addRules", rules: [{ toolName: "b" }] },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result[0].destination, "localSettings");
  });
  it("defaults behavior to allow only when merging multiple", () => {
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "a" }] },
      { type: "addRules", rules: [{ toolName: "b" }] },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result[0].behavior, "allow");
  });
  it("respects MAX_PERMISSION_SUGGESTIONS limit", () => {
    const suggestions = Array.from({ length: 25 }, (_, i) => ({ type: "test", id: i }));
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result.length, MAX_PERMISSION_SUGGESTIONS);
  });
  it("keeps merged addRules at the end when over limit", () => {
    const suggestions = [
      ...Array.from({ length: 20 }, (_, i) => ({ type: "test", id: i })),
      { type: "addRules", rules: [{ toolName: "x" }] },
      { type: "addRules", rules: [{ toolName: "y" }] },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result.length, MAX_PERMISSION_SUGGESTIONS);
    assert.strictEqual(result[result.length - 1].type, "addRules");
  });
  it("handles single addRules entry without merging", () => {
    const suggestions = [{ type: "addRules", rules: [{ toolName: "x" }] }];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rules[0].toolName, "x");
  });
  it("handles addRules with toolName/toolContent fallback via merge", () => {
    const suggestions = [
      { type: "addRules", toolName: "bash", ruleContent: "allow" },
      { type: "addRules", toolName: "cat", ruleContent: "deny" },
    ];
    const result = normalizePermissionSuggestions(suggestions);
    assert.strictEqual(result[0].rules[0].toolName, "bash");
    assert.strictEqual(result[0].rules[0].ruleContent, "allow");
    assert.strictEqual(result[0].rules[1].toolName, "cat");
  });
});

// ── normalizeHookToolUseId ──────────────────────────────────────────

describe("normalizeHookToolUseId", () => {
  it("returns null for non-string", () => { assert.strictEqual(normalizeHookToolUseId(42), null); });
  it("returns null for null", () => { assert.strictEqual(normalizeHookToolUseId(null), null); });
  it("returns null for empty string", () => { assert.strictEqual(normalizeHookToolUseId(""), null); });
  it("returns null for whitespace-only", () => { assert.strictEqual(normalizeHookToolUseId("   "), null); });
  it("trims and returns valid string", () => { assert.strictEqual(normalizeHookToolUseId("  abc  "), "abc"); });
  it("returns valid string unchanged", () => { assert.strictEqual(normalizeHookToolUseId("toolu_abc123"), "toolu_abc123"); });
});

// ── normalizeToolMatchValue ─────────────────────────────────────────

describe("normalizeToolMatchValue", () => {
  it("returns primitives unchanged", () => { assert.strictEqual(normalizeToolMatchValue(42), 42); });
  it("returns boolean unchanged", () => { assert.strictEqual(normalizeToolMatchValue(true), true); });
  it("returns null unchanged", () => { assert.strictEqual(normalizeToolMatchValue(null), null); });
  it("truncates long strings", () => {
    const long = "x".repeat(300);
    const result = normalizeToolMatchValue(long);
    assert.ok(result.length <= TOOL_MATCH_STRING_MAX);
    assert.ok(result.endsWith("…"));
  });
  it("preserves short strings", () => { assert.strictEqual(normalizeToolMatchValue("ok"), "ok"); });
  it("truncates arrays to TOOL_MATCH_ARRAY_MAX", () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const result = normalizeToolMatchValue(arr);
    assert.strictEqual(result.length, TOOL_MATCH_ARRAY_MAX);
  });
  it("sorts object keys", () => {
    const obj = { z: 1, a: 2, m: 3 };
    const result = normalizeToolMatchValue(obj);
    assert.deepStrictEqual(Object.keys(result), ["a", "m", "z"]);
  });
  it("truncates object keys to TOOL_MATCH_OBJECT_KEYS_MAX", () => {
    const obj = {};
    for (let i = 0; i < 40; i++) obj[`key${String(i).padStart(2, "0")}`] = i;
    const result = normalizeToolMatchValue(obj);
    assert.ok(Object.keys(result).length <= TOOL_MATCH_OBJECT_KEYS_MAX);
  });
  it("recursively normalizes nested objects", () => {
    const obj = { a: { z: 1, a: 2 } };
    const result = normalizeToolMatchValue(obj);
    assert.deepStrictEqual(Object.keys(result.a), ["a", "z"]);
  });
  it("returns null at max depth", () => {
    let obj = "deep";
    for (let i = 0; i <= TOOL_MATCH_DEPTH_MAX + 2; i++) obj = { nested: obj };
    const result = normalizeToolMatchValue(obj, 0);
    // The deepest nesting should be null
    let cursor = result;
    for (let i = 0; i < TOOL_MATCH_DEPTH_MAX + 1; i++) {
      if (cursor && typeof cursor === "object") cursor = cursor.nested;
    }
    assert.strictEqual(cursor, null);
  });
});

// ── buildToolInputFingerprint ───────────────────────────────────────

describe("buildToolInputFingerprint", () => {
  it("returns null for null input", () => { assert.strictEqual(buildToolInputFingerprint(null), null); });
  it("returns null for non-object", () => { assert.strictEqual(buildToolInputFingerprint("bad"), null); });
  it("returns a sha1 hex string", () => {
    const fp = buildToolInputFingerprint({ command: "ls" });
    assert.ok(typeof fp === "string");
    assert.strictEqual(fp.length, 40); // sha1 hex = 40 chars
    assert.ok(/^[0-9a-f]{40}$/.test(fp));
  });
  it("returns same fingerprint for same input", () => {
    const fp1 = buildToolInputFingerprint({ command: "ls", args: ["-la"] });
    const fp2 = buildToolInputFingerprint({ command: "ls", args: ["-la"] });
    assert.strictEqual(fp1, fp2);
  });
  it("returns different fingerprint for different input", () => {
    const fp1 = buildToolInputFingerprint({ command: "ls" });
    const fp2 = buildToolInputFingerprint({ command: "cat" });
    assert.notStrictEqual(fp1, fp2);
  });
  it("normalizes key order before hashing", () => {
    const fp1 = buildToolInputFingerprint({ a: 1, b: 2 });
    const fp2 = buildToolInputFingerprint({ b: 2, a: 1 });
    assert.strictEqual(fp1, fp2);
  });
});

// ── normalizeCodexPermissionToolInput ───────────────────────────────

describe("normalizeCodexPermissionToolInput", () => {
  it("returns empty object for null rawInput and no description", () => {
    assert.deepStrictEqual(normalizeCodexPermissionToolInput(null, null), {});
  });
  it("returns truncated rawInput when no description", () => {
    const result = normalizeCodexPermissionToolInput({ cmd: "ls" }, null);
    assert.strictEqual(result.cmd, "ls");
  });
  it("adds description when provided", () => {
    const result = normalizeCodexPermissionToolInput({}, "Run ls");
    assert.strictEqual(result.description, "Run ls");
  });
  it("trims description", () => {
    const result = normalizeCodexPermissionToolInput({}, "  Run ls  ");
    assert.strictEqual(result.description, "Run ls");
  });
  it("ignores empty description", () => {
    const result = normalizeCodexPermissionToolInput({ cmd: "ls" }, "   ");
    assert.strictEqual(result.description, undefined);
  });
  it("truncates deep values in rawInput", () => {
    const long = "x".repeat(600);
    const result = normalizeCodexPermissionToolInput({ cmd: long }, null);
    assert.ok(result.cmd.endsWith("…"));
  });
});

// ── findPendingPermissionForStateEvent ──────────────────────────────

describe("findPendingPermissionForStateEvent", () => {
  function perm(sessionId, overrides = {}) {
    return {
      res: {},
      sessionId,
      toolUseId: overrides.toolUseId || null,
      toolName: overrides.toolName || null,
      toolInputFingerprint: overrides.toolInputFingerprint || null,
    };
  }

  it("returns null for empty permissions", () => {
    assert.strictEqual(findPendingPermissionForStateEvent([], { sessionId: "s1" }), null);
  });

  it("returns null when no matching session", () => {
    const permissions = [perm("s1", { toolUseId: "tu1" })];
    assert.strictEqual(findPendingPermissionForStateEvent(permissions, { sessionId: "s2", toolUseId: "tu1" }), null);
  });

  it("matches by toolUseId", () => {
    const p = perm("s1", { toolUseId: "tu1" });
    const result = findPendingPermissionForStateEvent([p], { sessionId: "s1", toolUseId: "tu1" });
    assert.strictEqual(result, p);
  });

  it("matches by toolName + fingerprint when no toolUseId match", () => {
    const p = perm("s1", { toolName: "bash", toolInputFingerprint: "fp1" });
    const result = findPendingPermissionForStateEvent([p], { sessionId: "s1", toolName: "bash", toolInputFingerprint: "fp1" });
    assert.strictEqual(result, p);
  });

  it("does not match by fingerprint when perm has toolUseId and it does not match", () => {
    const p = perm("s1", { toolUseId: "tu1", toolName: "bash", toolInputFingerprint: "fp1" });
    // options toolUseId "tu2" != perm toolUseId "tu1", so no toolUseId match
    // fingerprint match requires !perm.toolUseId, but perm has "tu1", so no match
    const result = findPendingPermissionForStateEvent([p], { sessionId: "s1", toolUseId: "tu2", toolName: "bash", toolInputFingerprint: "fp1" });
    assert.strictEqual(result, null);
  });

  it("matches singleton fallback when allowSingletonFallback is true", () => {
    const p = perm("s1", { toolName: "other" });
    const result = findPendingPermissionForStateEvent([p], { sessionId: "s1", allowSingletonFallback: true });
    assert.strictEqual(result, p);
  });

  it("does not match singleton fallback when allowSingletonFallback is false", () => {
    const p = perm("s1", { toolName: "other" });
    const result = findPendingPermissionForStateEvent([p], { sessionId: "s1", allowSingletonFallback: false });
    assert.strictEqual(result, null);
  });

  it("does not match singleton fallback when multiple pending", () => {
    const p1 = perm("s1", { toolName: "a" });
    const p2 = perm("s1", { toolName: "b" });
    const result = findPendingPermissionForStateEvent([p1, p2], { sessionId: "s1", allowSingletonFallback: true });
    assert.strictEqual(result, null);
  });

  it("defaults sessionId to default", () => {
    const p = perm("default", { toolUseId: "tu1" });
    const result = findPendingPermissionForStateEvent([p], { toolUseId: "tu1" });
    assert.strictEqual(result, p);
  });

  it("prefers toolUseId match over fingerprint match", () => {
    const p1 = perm("s1", { toolUseId: "tu1", toolName: "bash" });
    const p2 = perm("s1", { toolName: "bash", toolInputFingerprint: "fp1" });
    const result = findPendingPermissionForStateEvent([p1, p2], { sessionId: "s1", toolUseId: "tu1", toolName: "bash", toolInputFingerprint: "fp1" });
    assert.strictEqual(result, p1);
  });

  it("ignores entries without res", () => {
    const bad = { sessionId: "s1", toolUseId: "tu1" }; // no res
    const result = findPendingPermissionForStateEvent([bad], { sessionId: "s1", toolUseId: "tu1" });
    assert.strictEqual(result, null);
  });
});

// ── normalizeElicitationToolInput ───────────────────────────────────

describe("normalizeElicitationToolInput", () => {
  it("returns null for null input", () => { assert.strictEqual(normalizeElicitationToolInput(null), null); });
  it("returns non-object as-is", () => { assert.strictEqual(normalizeElicitationToolInput("bad"), "bad"); });
  it("returns object without questions as-is", () => {
    const input = { command: "ls" };
    assert.deepStrictEqual(normalizeElicitationToolInput(input), input);
  });
  it("normalizes questions with options", () => {
    const input = {
      questions: [{
        header: "Choose",
        question: "What do you want?",
        options: [{ label: "A", description: "Option A" }],
      }],
    };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions.length, 1);
    assert.strictEqual(result.questions[0].header, "Choose");
    assert.strictEqual(result.questions[0].options[0].label, "A");
  });
  it("truncates long header", () => {
    const input = { questions: [{ header: "x".repeat(100), question: "Q", options: [] }] };
    const result = normalizeElicitationToolInput(input);
    assert.ok(result.questions[0].header.length <= MAX_ELICITATION_HEADER + 1); // +1 for ellipsis
  });
  it("truncates long question", () => {
    const input = { questions: [{ header: "H", question: "x".repeat(300), options: [] }] };
    const result = normalizeElicitationToolInput(input);
    assert.ok(result.questions[0].question.length <= MAX_ELICITATION_PROMPT + 1);
  });
  it("truncates long option label", () => {
    const input = { questions: [{ header: "H", question: "Q", options: [{ label: "x".repeat(100) }] }] };
    const result = normalizeElicitationToolInput(input);
    assert.ok(result.questions[0].options[0].label.length <= MAX_ELICITATION_OPTION_LABEL + 1);
  });
  it("truncates long option description", () => {
    const input = { questions: [{ header: "H", question: "Q", options: [{ description: "x".repeat(200) }] }] };
    const result = normalizeElicitationToolInput(input);
    assert.ok(result.questions[0].options[0].description.length <= MAX_ELICITATION_OPTION_DESCRIPTION + 1);
  });
  it("limits questions to MAX_ELICITATION_QUESTIONS", () => {
    const input = { questions: Array.from({ length: 10 }, (_, i) => ({ header: "H", question: `Q${i}`, options: [] })) };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions.length, MAX_ELICITATION_QUESTIONS);
  });
  it("limits options to MAX_ELICITATION_OPTIONS", () => {
    const input = { questions: [{ header: "H", question: "Q", options: Array.from({ length: 10 }, (_, i) => ({ label: `L${i}` })) }] };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions[0].options.length, MAX_ELICITATION_OPTIONS);
  });
  it("filters out null questions", () => {
    const input = { questions: [null, { header: "H", question: "Q", options: [] }, null] };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions.length, 1);
  });
  it("filters out questions with empty question text", () => {
    const input = { questions: [{ header: "H", question: "", options: [] }] };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions.length, 0);
  });
  it("filters out null options", () => {
    const input = { questions: [{ header: "H", question: "Q", options: [null, { label: "A" }] }] };
    const result = normalizeElicitationToolInput(input);
    assert.strictEqual(result.questions[0].options.length, 1);
  });
});
