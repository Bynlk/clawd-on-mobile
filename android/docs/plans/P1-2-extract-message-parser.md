# P1-2: 从 ClawdWebSocket 抽取 MessageParser

> **优先级**: P1 — 职责过重  
> **影响范围**: `ws/ClawdWebSocket.kt`  
> **预估工时**: 1.5h  
> **启动提示词**: `执行 P1-2: 从 ClawdWebSocket.handleMessage 中抽取 MessageParser 类，将 8 种消息类型的解析逻辑独立封装`

---

## 问题描述

`ClawdWebSocket.handleMessage()` 承担了 8 种 SSE 消息类型的解析，共 ~170 行：

```
ping / connected / clear_sessions / snapshot / state / tool_output / session_deleted / permission_request
```

每种类型的解析逻辑（JSON 字段提取、类型转换、异常处理）混杂在一个 `when` 分支中，违反单一职责原则，难以单独测试。

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `ws/ClawdWebSocket.kt` | 移除 `handleMessage` 中的解析逻辑，委托给 `MessageParser` |
| `ws/MessageParser.kt` | **新建** — 消息解析器 |
| `test/ws/ClawdWebSocketParsingTest.kt` | 迁移到 `MessageParserTest.kt` |

## 修复方案

### Step 1: 定义解析结果密封类

```kotlin
// ws/ParsedMessage.kt
sealed class ParsedMessage {
    data class Ping(val timestamp: Long) : ParsedMessage()
    data class Connected(val timestamp: Long) : ParsedMessage()
    data class ClearSessions(val timestamp: Long) : ParsedMessage()
    data class Snapshot(
        val sessions: Map<String, SessionData>,
        val displayState: String?,
        val timestamp: Long
    ) : ParsedMessage()
    data class State(
        val sessionId: String,
        val sessionData: SessionData?,
        val displayState: String?,
        val timestamp: Long
    ) : ParsedMessage()
    data class ToolOutput(
        val sessionId: String,
        val toolName: String,
        val output: String,
        val timestamp: Long
    ) : ParsedMessage()
    data class SessionDeleted(val sessionId: String, val timestamp: Long) : ParsedMessage()
    data class PermissionRequest(
        val data: PermissionRequestData,
        val timestamp: Long
    ) : ParsedMessage()
    data class Unknown(val type: String, val timestamp: Long) : ParsedMessage()
}
```

### Step 2: 创建 MessageParser

```kotlin
// ws/MessageParser.kt
class MessageParser {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(rawText: String): ParsedMessage? {
        val obj = try {
            json.decodeFromString<JsonObject>(rawText)
        } catch (_: Exception) {
            return null
        }

        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return null
        val timestamp = obj["timestamp"]?.jsonPrimitive?.longOrNull ?: 0L

        return when (type) {
            "ping" -> ParsedMessage.Ping(timestamp)
            "connected" -> ParsedMessage.Connected(timestamp)
            "clear_sessions" -> ParsedMessage.ClearSessions(timestamp)
            "snapshot" -> parseSnapshot(obj, timestamp)
            "state" -> parseState(obj, timestamp)
            "tool_output" -> parseToolOutput(obj, timestamp)
            "session_deleted" -> parseSessionDeleted(obj, timestamp)
            "permission_request" -> parsePermissionRequest(obj, timestamp)
            else -> ParsedMessage.Unknown(type, timestamp)
        }
    }

    private fun parseSnapshot(obj: JsonObject, timestamp: Long): ParsedMessage.Snapshot { ... }
    private fun parseState(obj: JsonObject, timestamp: Long): ParsedMessage.State { ... }
    private fun parseToolOutput(obj: JsonObject, timestamp: Long): ParsedMessage.ToolOutput { ... }
    private fun parseSessionDeleted(obj: JsonObject, timestamp: Long): ParsedMessage.SessionDeleted { ... }
    private fun parsePermissionRequest(obj: JsonObject, timestamp: Long): ParsedMessage.PermissionRequest { ... }
}
```

### Step 3: 简化 ClawdWebSocket.handleMessage

```kotlin
// ClawdWebSocket.kt — 简化后
private val messageParser = MessageParser()

private fun handleMessage(rawText: String) {
    val parsed = messageParser.parse(rawText) ?: return
    Log.d(TAG, "SSE message type=${parsed::class.simpleName}")

    when (parsed) {
        is ParsedMessage.Ping -> return
        is ParsedMessage.Connected -> { /* handshake confirmed */ }
        is ParsedMessage.ClearSessions -> {
            _sessions.value = emptyMap()
            _syncing.value = true
        }
        is ParsedMessage.Snapshot -> {
            _sessions.value = parsed.sessions
            _syncing.value = false
            parsed.displayState?.let { _displayState.value = it }
        }
        is ParsedMessage.State -> {
            if (parsed.sessionData == null) return
            _sessions.value = _sessions.value.toMutableMap().apply {
                if (parsed.sessionData.isVisible) put(parsed.sessionId, parsed.sessionData)
                else remove(parsed.sessionId)
            }
            parsed.displayState?.let { _displayState.value = it }
        }
        is ParsedMessage.ToolOutput -> { ... }
        is ParsedMessage.SessionDeleted -> { ... }
        is ParsedMessage.PermissionRequest -> { ... }
        is ParsedMessage.Unknown -> { /* ignore */ }
    }

    scope.launch {
        _messages.emit(WsMessage(type = parsed::class.simpleName ?: "unknown", timestamp = parsed.timestamp))
    }
}
```

### Step 4: 迁移测试

将 `ClawdWebSocketParsingTest` 中的 JSON 解析测试迁移到 `MessageParserTest`，可以直接测试 `MessageParser.parse()` 而不需要 mock WebSocket。

## 验收标准

- [ ] `MessageParser` 可独立实例化和测试
- [ ] `ClawdWebSocket.handleMessage()` 仅负责状态更新，无 JSON 解析
- [ ] 8 种消息类型的解析逻辑都在 `MessageParser` 中
- [ ] `MessageParserTest` 覆盖所有消息类型（含边界条件）
- [ ] 编译通过，功能不变
