"use strict";

const path = require("path");
const { sessionAliasKey } = require("./session-alias");
const { getSessionFocusTarget } = require("./session-focus");
const { readCodexThreadName } = require("../hooks/codex-session-index");

const EVENT_LABEL_KEYS = {
  SessionStart: "eventLabelSessionStart",
  SessionEnd: "eventLabelSessionEnd",
  UserPromptSubmit: "eventLabelUserPromptSubmit",
  PreToolUse: "eventLabelPreToolUse",
  PostToolUse: "eventLabelPostToolUse",
  PostToolUseFailure: "eventLabelPostToolUseFailure",
  AfterAgent: "eventLabelAfterAgent",
  Stop: "eventLabelStop",
  StopFailure: "eventLabelStopFailure",
  ApiError: "eventLabelApiError",
  SubagentStart: "eventLabelSubagentStart",
  SubagentStop: "eventLabelSubagentStop",
  PreCompress: "eventLabelPreCompress",
  PreCompact: "eventLabelPreCompact",
  PostCompact: "eventLabelPostCompact",
  Notification: "eventLabelNotification",
  Elicitation: "eventLabelElicitation",
  WorktreeCreate: "eventLabelWorktreeCreate",
  "event_msg:task_complete": "eventLabelStop",
  "stale-cleanup": "eventLabelStaleCleanup",
};

const DONE_EVENTS = new Set(["Stop", "PostCompact", "event_msg:task_complete"]);
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

function isDoneEvent(event) {
  return DONE_EVENTS.has(event);
}

const BADGE_DOT_COLORS = {
  running: "#16a34a",
  interrupted: "#d97706",
  done: "#71717a",
  idle: "#52525b",
};

const ACTIVE_CHIP_MAP = {
  working: { text: "工作中", color: "#22c55e" },
  juggling: { text: "多任务", color: "#d97706" },
  thinking: { text: "思考中", color: "#6366f1" },
  notification: { text: "通知", color: "#d97706" },
  attention: { text: "需要关注", color: "#b45309" },
  error: { text: "错误", color: "#ef4444" },
  sweeping: { text: "清理中", color: "#a1a1aa" },
  carrying: { text: "搬运中", color: "#a1a1aa" },
};

const EVENT_CHIP_MAP = {
  Stop: { text: "已完成", color: "#71717a" },
  PostCompact: { text: "已完成", color: "#71717a" },
  "event_msg:task_complete": { text: "已完成", color: "#71717a" },
  PreCompact: { text: "压缩中", color: "#71717a" },
  PreCompress: { text: "压缩中", color: "#71717a" },
  PermissionRequest: { text: "等待中", color: "#d97706" },
  Elicitation: { text: "等待中", color: "#d97706" },
  Notification: { text: "等待中", color: "#d97706" },
  WorktreeCreate: { text: "工作树", color: "#60a5fa" },
};

const ERROR_EVENTS = new Set(["StopFailure", "PostToolUseFailure", "ApiError"]);

function deriveMobileChipFields(state, recentEvents) {
  const lastEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  const lastEventName = lastEvent && lastEvent.event ? lastEvent.event : null;
  const isOneshot = ONESHOT_STATES.has(state);
  const effectiveState = isOneshot ? "idle" : state;
  if (effectiveState === "idle") {
    if (ERROR_EVENTS.has(lastEventName)) {
      return { text: "出错", color: "#ef4444" };
    }
    // ONESHOT states: check event-based chip first (e.g. Stop → "已完成"),
    // then fall back to state-based chip (e.g. attention → "需要关注").
    if (isOneshot) {
      if (lastEventName && EVENT_CHIP_MAP[lastEventName]) return EVENT_CHIP_MAP[lastEventName];
      return ACTIVE_CHIP_MAP[state] || null;
    }
    return null;
  }
  if (lastEventName && EVENT_CHIP_MAP[lastEventName]) {
    return EVENT_CHIP_MAP[lastEventName];
  }
  return ACTIVE_CHIP_MAP[effectiveState] || null;
}

const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

function sessionUpdatedAt(session) {
  const updatedAt = Number(session && session.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function deriveSessionBadge(session) {
  if (!session) return "idle";
  if (session.state !== "idle" && session.state !== "sleeping") return "running";
  if (session.state === "sleeping") return "idle";
  if (session.requiresCompletionAck === true) return "done";
  const events = Array.isArray(session.recentEvents) ? session.recentEvents : [];
  const latest = events.length ? events[events.length - 1] : null;
  const latestEvent = latest && latest.event;
  if (latestEvent === "StopFailure" || latestEvent === "PostToolUseFailure" || latestEvent === "ApiError") return "interrupted";
  if (isDoneEvent(latestEvent)) return "done";
  return "idle";
}

function getDisplayLastEvent(session, recentEvents) {
  const latestEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  if (!(session && session.requiresCompletionAck === true)) return latestEvent;
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const event = recentEvents[i];
    if (event && isDoneEvent(event.event)) return event;
  }
  return latestEvent;
}

function isEndedSessionBadge(badge) {
  return badge === "done" || badge === "interrupted";
}

function shouldAutoClearDetachedSession(session, badge, options = {}) {
  if (options.sessionHudCleanupDetached !== true) return false;
  if (!session || session.headless || session.state !== "idle" || session.agentPid) return false;
  if (!session.pidReachable || !session.sourcePid) return false;
  if (!isEndedSessionBadge(badge)) return false;
  const isProcessAlive = typeof options.isProcessAlive === "function"
    ? options.isProcessAlive
    : () => true;
  return !isProcessAlive(session.sourcePid);
}

function getSessionAliasEntry(id, sessionLike, sessionAliases = {}) {
  const scopedAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    id,
    { cwd: sessionLike && sessionLike.cwd }
  );
  if (scopedAliasKey && sessionAliases[scopedAliasKey]) return sessionAliases[scopedAliasKey];

  const legacyAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    id
  );
  if (legacyAliasKey && legacyAliasKey !== scopedAliasKey) return sessionAliases[legacyAliasKey] || null;
  return legacyAliasKey ? sessionAliases[legacyAliasKey] : null;
}

function getEffectiveSessionTitle(id, sessionLike, options = {}) {
  const readThreadName = typeof options.readCodexThreadName === "function"
    ? options.readCodexThreadName
    : readCodexThreadName;
  if (sessionLike && sessionLike.agentId === "codex" && !sessionLike.host) {
    const threadName = normalizeTitle(readThreadName(id));
    if (threadName) return threadName;
  }
  return normalizeTitle(sessionLike && sessionLike.sessionTitle);
}

function sessionDisplayTitle(id, sessionLike, sessionAliases = {}, options = {}) {
  const alias = getSessionAliasEntry(id, sessionLike, sessionAliases);
  if (alias && typeof alias.title === "string" && alias.title) return alias.title;
  const title = getEffectiveSessionTitle(id, sessionLike, options);
  if (title) return title;
  const cwd = sessionLike && sessionLike.cwd;
  if (cwd) return path.basename(cwd);
  return id && id.length > 6 ? `${id.slice(0, 6)}..` : id;
}

function sessionMenuComparator(a, b, statePriority = {}) {
  const pa = statePriority[a.state] || 0;
  const pb = statePriority[b.state] || 0;
  if (pb !== pa) return pb - pa;
  return sessionUpdatedAt(b) - sessionUpdatedAt(a);
}

function sessionUpdatedAtComparator(a, b) {
  const byTime = sessionUpdatedAt(b) - sessionUpdatedAt(a);
  if (byTime !== 0) return byTime;
  return String(a.id).localeCompare(String(b.id));
}

function buildSessionSnapshotEntry(id, session, sessionAliases = {}, options = {}) {
  const alias = getSessionAliasEntry(id, session, sessionAliases);
  const recentEvents = Array.isArray(session && session.recentEvents)
    ? session.recentEvents
    : [];
  const latestEvent = getDisplayLastEvent(session, recentEvents);
  const rawEvent = latestEvent && latestEvent.event ? latestEvent.event : null;
  const eventAt = Number(latestEvent && latestEvent.at);
  const badge = deriveSessionBadge(session);
  const state = (session && session.state) || "idle";
  const isReal = state !== "idle" ||
    recentEvents.some(e => e && e.event && e.event !== "SessionStart");
  const getAgentIconUrl = typeof options.getAgentIconUrl === "function"
    ? options.getAgentIconUrl
    : () => null;
  const hiddenFromHud = shouldAutoClearDetachedSession(session, badge, options);
  const focusTarget = session && !session.headless && state !== "sleeping" && !hiddenFromHud
    ? getSessionFocusTarget({ ...(session || {}), id })
    : { canFocus: false, type: null, url: null };
  const chip = deriveMobileChipFields(state, recentEvents);
  return {
    id,
    agentId: (session && session.agentId) || null,
    iconUrl: getAgentIconUrl(session && session.agentId),
    state,
    badge,
    isReal,
    hiddenFromHud,
    hasAlias: !!(alias && typeof alias.title === "string" && alias.title),
    sessionTitle: getEffectiveSessionTitle(id, session, options),
    displayTitle: sessionDisplayTitle(id, session, sessionAliases, options),
    cwd: (session && session.cwd) || "",
    updatedAt: sessionUpdatedAt(session),
    sourcePid: (session && session.sourcePid) || null,
    wtHwnd: (session && session.wtHwnd) || null,
    canFocus: focusTarget.canFocus === true,
    focusTarget: focusTarget.type ? { type: focusTarget.type, url: focusTarget.url || null } : null,
    host: (session && session.host) || null,
    headless: !!(session && session.headless),
    platform: (session && session.platform) || null,
    model: (session && session.model) || null,
    provider: (session && session.provider) || null,
    codexOriginator: (session && session.codexOriginator) || null,
    codexSource: (session && session.codexSource) || null,
    lastEvent: latestEvent ? {
      labelKey: rawEvent ? (EVENT_LABEL_KEYS[rawEvent] || null) : null,
      rawEvent,
      at: Number.isFinite(eventAt) ? eventAt : 0,
    } : null,
    // Lifecycle flag for the Dashboard "Mark read" button visibility (PR2).
    // ackedAt stays internal — only the boolean reaches renderers.
    requiresCompletionAck: !!(session && session.requiresCompletionAck === true),
    // Mobile view model — all fields pre-computed, Android maps directly
    recentEvents,
    lastOutput: (session && session.lastOutput) || null,
    mobile: {
      chipText: chip ? chip.text : null,
      chipColor: chip ? chip.color : null,
      dotColor: BADGE_DOT_COLORS[badge] || BADGE_DOT_COLORS.idle,
      isVisible: state !== "sleeping" && !(session && session.headless),
    },
  };
}

function normalizeSessionsIterable(sessions) {
  if (!sessions) return [];
  if (sessions instanceof Map) return sessions.entries();
  if (typeof sessions[Symbol.iterator] === "function") return sessions;
  return [];
}

function buildSessionSnapshot(sessions, options = {}) {
  const entries = [];
  const sessionAliases = options.sessionAliases && typeof options.sessionAliases === "object"
    ? options.sessionAliases
    : {};
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    entries.push(buildSessionSnapshotEntry(id, session, sessionAliases, options));
  }

  const dashboardEntries = entries.slice().sort(sessionUpdatedAtComparator);
  const menuEntries = entries.slice().sort((a, b) => sessionMenuComparator(a, b, options.statePriority));
  const orderedIds = dashboardEntries.map((entry) => entry.id);
  const menuOrderedIds = menuEntries.map((entry) => entry.id);
  const hudEntries = dashboardEntries.filter((entry) =>
    !entry.headless && entry.state !== "sleeping" && !entry.hiddenFromHud
  );

  const groupMap = new Map();
  for (const entry of dashboardEntries) {
    const host = entry.host || "";
    if (!groupMap.has(host)) groupMap.set(host, []);
    groupMap.get(host).push(entry.id);
  }
  const groups = [];
  if (groupMap.has("")) {
    groups.push({ host: "", ids: groupMap.get("") });
  }
  for (const [host, ids] of groupMap) {
    if (!host) continue;
    groups.push({ host, ids });
  }

  const lastSession = dashboardEntries[0] || null;
  return {
    sessions: entries,
    groups,
    orderedIds,
    menuOrderedIds,
    hudTotalNonIdle: hudEntries.length,
    hudLastSessionId: hudEntries.length ? hudEntries[0].id : null,
    hudLastTitle: hudEntries.length ? hudEntries[0].displayTitle : null,
    lastSessionId: lastSession ? lastSession.id : null,
    lastTitle: lastSession ? lastSession.displayTitle : null,
  };
}

function getActiveSessionAliasKeys(sessions) {
  const keys = new Set();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const key = sessionAliasKey(
      session && session.host,
      session && session.agentId,
      id,
      { cwd: session && session.cwd }
    );
    if (key) keys.add(key);
  }
  return keys;
}

function sessionSnapshotSignature(snapshot) {
  return JSON.stringify({
    orderedIds: snapshot.orderedIds,
    menuOrderedIds: snapshot.menuOrderedIds,
    hudTotalNonIdle: snapshot.hudTotalNonIdle,
    hudLastSessionId: snapshot.hudLastSessionId,
    hudLastTitle: snapshot.hudLastTitle,
    lastSessionId: snapshot.lastSessionId,
    lastTitle: snapshot.lastTitle,
    sessions: snapshot.sessions.map((entry) => ({
      id: entry.id,
      state: entry.state,
      badge: entry.badge,
      hasAlias: entry.hasAlias,
      sessionTitle: entry.sessionTitle,
      displayTitle: entry.displayTitle,
      cwd: entry.cwd,
      agentId: entry.agentId,
      sourcePid: entry.sourcePid,
      wtHwnd: entry.wtHwnd,
      canFocus: entry.canFocus,
      focusTarget: entry.focusTarget,
      headless: entry.headless,
      hiddenFromHud: !!entry.hiddenFromHud,
      host: entry.host,
      platform: entry.platform,
      model: entry.model,
      provider: entry.provider,
      codexOriginator: entry.codexOriginator,
      codexSource: entry.codexSource,
      lastEventLabelKey: entry.lastEvent ? entry.lastEvent.labelKey : null,
      lastEventRawEvent: entry.lastEvent ? entry.lastEvent.rawEvent : null,
      lastEventAt: entry.lastEvent ? entry.lastEvent.at : null,
      requiresCompletionAck: !!entry.requiresCompletionAck,
      recentEventsCount: Array.isArray(entry.recentEvents) ? entry.recentEvents.length : 0,
      lastOutputAt: entry.lastOutput && entry.lastOutput.at ? entry.lastOutput.at : null,
    })),
  });
}

module.exports = {
  EVENT_LABEL_KEYS,
  SESSION_TITLE_MAX,
  normalizeTitle,
  sessionUpdatedAt,
  deriveSessionBadge,
  deriveMobileChipFields,
  BADGE_DOT_COLORS,
  shouldAutoClearDetachedSession,
  getSessionAliasEntry,
  getEffectiveSessionTitle,
  sessionDisplayTitle,
  sessionMenuComparator,
  sessionUpdatedAtComparator,
  buildSessionSnapshotEntry,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
};
