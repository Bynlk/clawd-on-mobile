# Phase 4 结构优化 — 执行提示词

> 复制下方 ```` ``` ```` 块内容直接粘贴到 Claude Code 执行

---

```
执行 Android 端 Phase 4 结构优化，共 5 个任务。先读取相关文件确认当前状态，再逐个修改。最后运行 `./gradlew assembleDebug` 确认编译通过。

## 背景

评估报告见 android/AUDIT_REPORT.md，执行方案见 android/EXECUTION_PLAN.md Phase 4 部分。
Phase 1-3 已完成（安全加固 + 线程安全 + 代码清理）。

## 任务清单

### T4.1 SettingsScreen 拆文件

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/settings/SettingsScreen.kt` (647 行)

**问题**: 8 个 `@Composable` 函数全部在同一文件，每个 Section 是独立功能。

**方案**: 将 `FloatingPetSection`（最大，~200 行）和 `AboutSection`（~70 行）提取到独立文件。保留 `SettingsScreen` 主骨架 + `AccordionSection` + `ConnectionInfoCard` + 两个小 Section（Scan/Manual 各 ~20 行，Notification ~30 行）在原文件。

**步骤 A**: 新建 `android/app/src/main/java/com/clawd/mobile/ui/settings/FloatingPetSection.kt`

将 `FloatingPetSection` composable 函数（原文件第 355-548 行）和 `NotifyToggle`（如果 FloatingPetSection 使用了的话 — 实际上 NotifyToggle 只被 NotificationSection 使用，所以不需要搬）提取到新文件。

新文件内容：
```kotlin
package com.clawd.mobile.ui.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.overlay.FloatingPetService
import com.clawd.mobile.ui.theme.*

// ─── Floating Pet Section ─────────────────────────────────────────
// 从 SettingsScreen.kt 提取（2026-06-01 Phase 4 拆分）

@Composable
internal fun FloatingPetSection(prefsStore: PrefsStore) {
    // ... 将原文件第 355-548 行的完整 FloatingPetSection 函数体搬到这里 ...
    // 注意：函数签名和内容完全不变，只是换了文件
}
```

**步骤 B**: 新建 `android/app/src/main/java/com/clawd/mobile/ui/settings/AboutSection.kt`

将 `AboutSection` 和 `AboutRow` composable 函数（原文件第 582-647 行）提取到新文件。

新文件内容：
```kotlin
package com.clawd.mobile.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*

// ─── About Section ─────────────────────────────────────────────────
// 从 SettingsScreen.kt 提取（2026-06-01 Phase 4 拆分）

@Composable
internal fun AboutSection() {
    // ... 将原文件第 584-631 行的完整 AboutSection 函数体搬到这里 ...
}

@Composable
private fun AboutRow(label: String, value: String) {
    // ... 将原文件第 633-647 行的完整 AboutRow 函数体搬到这里 ...
}
```

**步骤 C**: 修改原 `SettingsScreen.kt`，删除已搬走的函数。

删除以下内容：
- `FloatingPetSection` 函数（第 355-548 行）
- `AboutSection` 函数（第 582-631 行）
- `AboutRow` 函数（第 633-647 行）

删除不再需要的 import（检查哪些 import 只被搬走的函数使用）：
- `android.content.Intent` — 仍被 FloatingPetSection 使用（已搬走），但 SettingsScreen 本身不用。检查后删除。
- `android.net.Uri` — 同上
- `android.provider.Settings` — 同上
- `com.clawd.mobile.overlay.FloatingPetService` — 同上
- `BasicTextField`, `KeyboardOptions`, `ImeAction`, `KeyboardType` — 只被 FloatingPetSection 使用，删除
- `FontFamily` — 被 FloatingPetSection 和 AboutRow 使用，已搬走，删除

保留在原文件中的函数：
- `SettingsScreen`（主骨架）
- `SettingsTopBar`
- `ConnectionInfoCard`
- `CopyableRow`
- `AccordionSection`
- `ScanSection`
- `ManualSection`
- `NotificationSection`
- `NotifyToggle`

**注意**: `NotifyToggle` 被 `NotificationSection` 使用，保留在原文件中。`ScanSection` 和 `ManualSection` 很短（各 ~20 行），保留在原文件中。

---

### T4.2 硬编码颜色提取

**问题 A**: `PetBubbleView.kt` 中 4 处硬编码颜色字符串（`"#FF1E1E2E"`, `"#FFE0E0E0"`, `"#33FFFFFF"`, `"#FF2A2A3E"`, `"#FF888888"`）。

**方案**: 在 `PetBubbleView` 顶部提取为 companion object 常量。

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/PetBubbleView.kt`

在 `companion object` 中（如果没有，新建一个）添加颜色常量：
```kotlin
companion object {
    private const val COLOR_BACKGROUND = 0xFF1E1E2E.toInt()
    private const val COLOR_TEXT_PRIMARY = 0xFFE0E0E0.toInt()
    private const val COLOR_TEXT_SECONDARY = 0xFF888888.toInt()
    private const val COLOR_DIVIDER = 0x33FFFFFF.toInt()
    private const val COLOR_BUTTON_BG = 0xFF2A2A3E.toInt()
}
```

然后替换所有 `Color.parseColor("...")` 调用：
- `Color.parseColor("#FF1E1E2E")` → `COLOR_BACKGROUND`
- `Color.parseColor("#FFE0E0E0")` → `COLOR_TEXT_PRIMARY`
- `Color.parseColor("#FF888888")` → `COLOR_TEXT_SECONDARY`
- `Color.parseColor("#33FFFFFF")` → `COLOR_DIVIDER`
- `Color.parseColor("#FF2A2A3E")` → `COLOR_BUTTON_BG`

**问题 B**: `EventTimeline.kt` 的 `EVENT_STATE_COLORS` 与 `NotificationIcons.colorForState` 重复定义相同颜色值（但类型不同：Compose Color vs Android Int）。

**方案**: 统一颜色值定义，消除 DRY 违反。

在 `NotificationIcons.kt` 中提取颜色值为常量，`EventTimeline.kt` 引用这些常量转换为 Compose Color。

**文件 A**: `android/app/src/main/java/com/clawd/mobile/notification/NotificationIcons.kt`

在 `colorForState` 方法之前添加颜色常量：
```kotlin
/** State color constants — shared across NotificationIcons (Android Int) and EventTimeline (Compose Color). */
const val STATE_COLOR_ERROR = 0xFFEF4444.toInt()
const val STATE_COLOR_ATTENTION = 0xFFB45309.toInt()
const val STATE_COLOR_WORKING = 0xFF16A34A.toInt()
const val STATE_COLOR_THINKING = 0xFF6366F1.toInt()
const val STATE_COLOR_NOTIFICATION = 0xFFB45309.toInt()
const val STATE_COLOR_SWEEPING = 0xFF71717A.toInt()
const val STATE_COLOR_IDLE = 0xFF71717A.toInt()
const val STATE_COLOR_SLEEPING = 0xFFA1A1AA.toInt()
```

修改 `colorForState` 使用常量：
```kotlin
fun colorForState(state: String): Int = when (state) {
    "working" -> STATE_COLOR_WORKING
    "juggling" -> STATE_COLOR_ATTENTION
    "thinking" -> STATE_COLOR_THINKING
    "attention" -> STATE_COLOR_ATTENTION
    "error" -> STATE_COLOR_ERROR
    "notification" -> STATE_COLOR_NOTIFICATION
    "idle" -> STATE_COLOR_IDLE
    "sleeping" -> STATE_COLOR_SLEEPING
    else -> STATE_COLOR_IDLE
}
```

**文件 B**: `android/app/src/main/java/com/clawd/mobile/ui/sessions/EventTimeline.kt`

修改 `EVENT_STATE_COLORS` 引用 `NotificationIcons` 的常量：
```kotlin
import com.clawd.mobile.notification.NotificationIcons

internal val EVENT_STATE_COLORS = mapOf(
    "error" to Color(NotificationIcons.STATE_COLOR_ERROR),
    "attention" to Color(NotificationIcons.STATE_COLOR_ATTENTION),
    "working" to Color(NotificationIcons.STATE_COLOR_WORKING),
    "juggling" to Color(NotificationIcons.STATE_COLOR_ATTENTION),
    "thinking" to Color(NotificationIcons.STATE_COLOR_THINKING),
    "notification" to Color(NotificationIcons.STATE_COLOR_NOTIFICATION),
    "sweeping" to Color(NotificationIcons.STATE_COLOR_SWEEPING),
    "carrying" to Color(NotificationIcons.STATE_COLOR_IDLE),
    "idle" to Color(NotificationIcons.STATE_COLOR_IDLE),
    "sleeping" to Color(NotificationIcons.STATE_COLOR_SLEEPING),
)
```

---

### T4.3 硬编码字符串提取

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/settings/SettingsScreen.kt`（或拆分后的 `FloatingPetSection.kt`）

**问题**: 第 506 行中文字符串 `"💡 调整大小后需关闭再开启悬浮窗生效"` 未使用 string resource。

**修改**:

1. 在 `android/app/src/main/res/values/strings.xml` 的 settings 相关区域添加：
```xml
<string name="settings_pet_resize_hint">💡 调整大小后需关闭再开启悬浮窗生效</string>
```

2. 将代码中的硬编码字符串替换为：
```kotlin
Text(
    text = stringResource(R.string.settings_pet_resize_hint),
    style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(top = 4.dp)
)
```

---

### T4.4 ClawdWebSocket 提取 MessageParser

**文件**: `android/app/src/main/java/com/clawd/mobile/ws/ClawdWebSocket.kt`

**问题**: `handleMessage` 方法约 170 行，同时负责路由和解析。提取解析逻辑到独立类可降低 `ClawdWebSocket` 行数并提高可测试性。

**方案**: 新建 `WsMessageParser.kt`，将 JSON → 数据对象的转换逻辑提取过去。

**步骤 A**: 新建 `android/app/src/main/java/com/clawd/mobile/ws/WsMessageParser.kt`

```kotlin
package com.clawd.mobile.ws

import com.clawd.mobile.data.*
import com.clawd.mobile.util.SafeExecutor
import kotlinx.serialization.json.*

/**
 * Parses raw SSE JSON messages into typed data objects.
 * Extracted from [ClawdWebSocket.handleMessage] for testability.
 */
internal object WsMessageParser {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Parse the message type field. Returns null if unparseable. */
    fun parseType(rawText: String): String? {
        val obj = try { json.decodeFromString<JsonObject>(rawText) } catch (_: Exception) { return null }
        return obj["type"]?.jsonPrimitive?.contentOrNull
    }

    /** Parse a snapshot message's sessions map. Returns null if sessions field missing. */
    fun parseSnapshotSessions(obj: JsonObject): Map<String, SessionData>? {
        val sessionsObj = obj["sessions"]?.jsonObject ?: return null
        val map = mutableMapOf<String, SessionData>()
        for ((sid, el) in sessionsObj) {
            SafeExecutor.tryOrNull("WsMessageParser") {
                val sd = json.decodeFromJsonElement<SessionData>(el)
                if (sd.isReal && sd.isVisible) map[sid] = sd
            }
        }
        return map
    }

    /** Parse displayState from any message that carries it. */
    fun parseDisplayState(obj: JsonObject): String? {
        return obj["displayState"]?.jsonPrimitive?.contentOrNull
    }

    /** Parse a state update message into SessionData. Returns null if sessionId missing or isReal=false. */
    fun parseStateUpdate(obj: JsonObject): SessionData? {
        val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return null
        val isReal = obj["isReal"]?.jsonPrimitive?.booleanOrNull ?: true
        if (!isReal) return null

        val recentEvents = try {
            obj["recentEvents"]?.jsonArray?.map { el ->
                val o = el.jsonObject
                RecentEvent(
                    at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                    event = o["event"]?.jsonPrimitive?.contentOrNull,
                    state = o["state"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList()
        } catch (_: Exception) { emptyList() }

        val lastOutput = try {
            obj["lastOutput"]?.jsonObject?.let { o ->
                LastOutput(
                    toolName = o["toolName"]?.jsonPrimitive?.contentOrNull ?: "",
                    output = o["output"]?.jsonPrimitive?.contentOrNull ?: "",
                    at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                )
            }
        } catch (_: Exception) { null }

        return SessionData(
            sessionId = sid,
            state = obj["state"]?.jsonPrimitive?.contentOrNull ?: "idle",
            event = obj["event"]?.jsonPrimitive?.contentOrNull,
            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
            toolName = obj["toolName"]?.jsonPrimitive?.contentOrNull,
            sessionTitle = obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
            displayTitle = obj["displayTitle"]?.jsonPrimitive?.contentOrNull
                ?: obj["sessionTitle"]?.jsonPrimitive?.contentOrNull,
            cwd = obj["cwd"]?.jsonPrimitive?.contentOrNull,
            updatedAt = obj["timestamp"]?.jsonPrimitive?.longOrNull,
            recentEvents = recentEvents,
            lastOutput = lastOutput,
            displayState = obj["displayState"]?.jsonPrimitive?.contentOrNull,
            badge = obj["badge"]?.jsonPrimitive?.contentOrNull ?: "idle",
            chipText = obj["chipText"]?.jsonPrimitive?.contentOrNull,
            chipColor = obj["chipColor"]?.jsonPrimitive?.contentOrNull,
            dotColor = obj["dotColor"]?.jsonPrimitive?.contentOrNull,
            isVisible = obj["isVisible"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
    }

    /** Parse a permission_request message. Returns null if id missing. */
    fun parsePermissionRequest(obj: JsonObject): PermissionRequestData? {
        val toolNameStr = obj["toolName"]?.jsonPrimitive?.contentOrNull
        val toolInputObj = obj["toolInput"]?.jsonObject
        val suggestions = SafeExecutor.tryOrNull("WsMessageParser") {
            obj["suggestions"]?.jsonArray?.map { s ->
                val so = s.jsonObject
                PermissionSuggestion(
                    label = so["label"]?.jsonPrimitive?.content ?: "",
                    behavior = so["behavior"]?.jsonPrimitive?.content ?: "deny",
                    rule = so["rule"]?.jsonPrimitive?.contentOrNull,
                )
            }
        } ?: emptyList()

        val elicitationQuestions = if (toolNameStr == "AskUserQuestion") {
            SafeExecutor.tryOrNull("WsMessageParser") {
                toolInputObj?.get("questions")?.jsonArray?.map { q ->
                    val qo = q.jsonObject
                    ElicitationQuestion(
                        question = qo["question"]?.jsonPrimitive?.content ?: "",
                        header = qo["header"]?.jsonPrimitive?.contentOrNull,
                        multiSelect = qo["multiSelect"]?.jsonPrimitive?.booleanOrNull ?: false,
                        options = qo["options"]?.jsonArray?.map { o ->
                            val oo = o.jsonObject
                            ElicitationOption(
                                label = oo["label"]?.jsonPrimitive?.content ?: "",
                                description = oo["description"]?.jsonPrimitive?.contentOrNull,
                            )
                        } ?: emptyList(),
                    )
                }
            } ?: emptyList()
        } else emptyList()

        return PermissionRequestData(
            agentId = obj["agentId"]?.jsonPrimitive?.contentOrNull,
            toolName = toolNameStr,
            toolInputSummary = buildToolInputSummary(toolNameStr, toolInputObj),
            sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull,
            requestId = obj["id"]?.jsonPrimitive?.contentOrNull,
            timeout = obj["timeout"]?.jsonPrimitive?.longOrNull ?: 60000,
            suggestions = suggestions,
            elicitationQuestions = elicitationQuestions,
            toolInputRaw = obj["toolInput"],
        )
    }

    /** Build a human-readable summary of tool input for notification display. */
    fun buildToolInputSummary(toolName: String?, toolInput: JsonObject?): String? {
        if (toolInput == null) return null
        val key = toolName ?: ""
        val summary = when (key) {
            "Write", "Edit", "Delete", "Read" ->
                toolInput["file_path"]?.jsonPrimitive?.contentOrNull
            "Bash" ->
                toolInput["command"]?.jsonPrimitive?.contentOrNull
            "NotebookEdit" ->
                toolInput["notebook_path"]?.jsonPrimitive?.contentOrNull
            "WebFetch" ->
                toolInput["url"]?.jsonPrimitive?.contentOrNull
            "WebSearch" ->
                toolInput["query"]?.jsonPrimitive?.contentOrNull
            "AskUserQuestion" ->
                SafeExecutor.tryOrNull("WsMessageParser") {
                    val questions = toolInput["questions"]?.jsonArray
                    val first = questions?.firstOrNull()?.jsonObject
                    first?.get("question")?.jsonPrimitive?.contentOrNull
                }
            else -> {
                toolInput["description"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["summary"]?.jsonPrimitive?.contentOrNull
                    ?: toolInput["reason"]?.jsonPrimitive?.contentOrNull
            }
        }
        val text = summary?.take(60)?.trim()
        if (text.isNullOrBlank()) {
            val fallback = toolInput.toString().take(80)
            return if (fallback.length > 2) "$key → $fallback…" else null
        }
        return "$key → $text" + if (summary.length > 60) "…" else ""
    }
}
```

**步骤 B**: 修改 `ClawdWebSocket.kt` 的 `handleMessage` 方法，委托给 `WsMessageParser`。

将 `handleMessage` 方法简化为路由层。核心变化：
1. JSON 解析改为 `val obj = try { json.decodeFromString<JsonObject>(rawText) } catch (_: Exception) { return }`
2. 类型判断改为 `val type = WsMessageParser.parseType(rawText) ?: return`（注意：需要先 parse obj，因为 parseType 内部会重新解析。或者保留 obj 解析，只把数据提取委托出去）
3. `"snapshot"` 分支：用 `WsMessageParser.parseSnapshotSessions(obj)` 替代内联解析
4. `"state"` 分支：用 `WsMessageParser.parseStateUpdate(obj)` 替代内联解析
5. `"permission_request"` 分支：用 `WsMessageParser.parsePermissionRequest(obj)` 替代内联解析
6. 删除 `buildToolInputSummary` 方法（已移到 WsMessageParser）

`handleMessage` 目标行数：约 60-70 行（纯路由 + 状态更新）。

**注意**: `WsMessageParser` 中的 `json` 实例和 `ClawdWebSocket` 中的 `json` 实例是独立的。如果需要共享，可以将 `json` 作为参数传入 `WsMessageParser` 的方法，或让 `WsMessageParser` 接受一个 `Json` 实例。最简单的做法是让 `WsMessageParser` 自带 `json` 实例（当前方案）。

---

### T4.5 过时 API 更新

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/scan/ScanScreen.kt`

**问题**: 第 27 行使用了已 deprecated 的 `LocalLifecycleOwner`。

**修改**: 检查当前 import：
```kotlin
import androidx.lifecycle.compose.LocalLifecycleOwner
```

如果已经是 `androidx.lifecycle.compose.LocalLifecycleOwner`（非 deprecated 版本），则无需修改。
如果是 `androidx.compose.ui.platform.LocalLifecycleOwner`（deprecated），替换为：
```kotlin
import androidx.lifecycle.compose.LocalLifecycleOwner
```

**注意**: 在 Phase 3 T3.3 中已经添加了 `DefaultLifecycleObserver` 和 `LifecycleOwner` 的 import。确认不冲突。

---

## 验证

完成所有修改后，执行以下验证：

1. **编译检查**: `./gradlew assembleDebug` 确认无编译错误
2. **行数验证**: 确认 SettingsScreen.kt 行数减少：
   - `wc -l android/app/src/main/java/com/clawd/mobile/ui/settings/SettingsScreen.kt` 应 ≤ 400 行
3. **文件存在验证**: 确认新文件已创建：
   - `ls android/app/src/main/java/com/clawd/mobile/ui/settings/FloatingPetSection.kt`
   - `ls android/app/src/main/java/com/clawd/mobile/ui/settings/AboutSection.kt`
   - `ls android/app/src/main/java/com/clawd/mobile/ws/WsMessageParser.kt`
4. **Grep 验证**: 确认 PetBubbleView 不再有 Color.parseColor 硬编码：
   - `grep -n "Color.parseColor" android/app/src/main/java/com/clawd/mobile/overlay/PetBubbleView.kt` 应返回空
5. **Grep 验证**: 确认 EventTimeline 引用 NotificationIcons 常量：
   - `grep -n "NotificationIcons.STATE_COLOR" android/app/src/main/java/com/clawd/mobile/ui/sessions/EventTimeline.kt` 应有结果
6. **Grep 验证**: 确认 SettingsScreen 不再有硬编码中文提示：
   - `grep -n "调整大小" android/app/src/main/java/com/clawd/mobile/ui/settings/` 应返回空
7. **Grep 验证**: 确认 ClawdWebSocket.handleMessage 行数减少：
   - `grep -c "" android/app/src/main/java/com/clawd/mobile/ws/ClawdWebSocket.kt` 应 ≤ 350 行

最后输出修改文件清单和每个文件的改动摘要。
```
