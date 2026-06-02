# P0-3: 重命名 ClawdWebSocket → SseClient

> **优先级**: P0 — 命名误导  
> **影响范围**: 全项目引用  
> **预估工时**: 30min  
> **启动提示词**: `执行 P0-3: 将 ClawdWebSocket 重命名为 SseClient，同步更新所有引用、日志 TAG、文件名`

---

## 问题描述

`ClawdWebSocket` 类名暗示使用 WebSocket 协议，但实际使用的是 OkHttp SSE（`EventSource`）：

```kotlin
// ClawdWebSocket.kt — 实际是 SSE client
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
```

这对新开发者造成严重误导，阅读代码时会期望 WebSocket 双向通信，实际是 SSE 单向流 + HTTP POST。

## 涉及文件

| 文件 | 需要修改的内容 |
|------|---------------|
| `ws/ClawdWebSocket.kt` | 文件重命名为 `SseClient.kt`，类名 `ClawdWebSocket` → `SseClient` |
| `ws/ConnectionState.kt` | 无变更（已独立） |
| `service/WebSocketService.kt` | 所有 `ClawdWebSocket` 引用 → `SseClient` |
| `ui/navigation/NavGraph.kt` | `ClawdWebSocket` 类型声明 |
| `ui/approval/ApprovalViewModel.kt` | 构造函数参数类型 |
| `overlay/PetStateManager.kt` | `waitForWebSocket()` 返回类型 |
| `overlay/PetBubbleManager.kt` | 若有引用 |
| `overlay/FloatingPetService.kt` | 若有引用 |
| `test/ws/ClawdWebSocketParsingTest.kt` | 文件重命名 + 类名 |

## 修复方案

### Step 1: 重命名文件

```
ws/ClawdWebSocket.kt     → ws/SseClient.kt
ws/ClawdWebSocketTest.kt → ws/SseClientParsingTest.kt
```

### Step 2: 全局替换

```
ClawdWebSocket       → SseClient
TAG = "ClawdWebSocket" → TAG = "SseClient"
"ClawdWebSocket"     → "SseClient"  (日志字符串)
```

### Step 3: 更新注释中的协议描述

```kotlin
// Before
/** Core SSE client using OkHttp EventSource. */

// After — 保持，已经是正确的
/** Core SSE client using OkHttp EventSource. */
```

### Step 4: 考虑 Service 命名

`WebSocketService` 是否也需要重命名？

**建议暂不改**。`WebSocketService` 是 Android Service 组件名，重命名会影响：
- `AndroidManifest.xml` 中的 `<service>` 声明
- 所有 `Intent` 显式引用
- 已安装用户的 Service 恢复（START_STICKY 场景）

**替代方案**: 在类的 KDoc 中明确说明实际协议：

```kotlin
/**
 * Foreground service managing the SSE connection to Clawd server.
 * Named WebSocketService for historical reasons; actual transport is SSE (Server-Sent Events).
 */
```

## 验收标准

- [ ] 文件名 `SseClient.kt`，类名 `SseClient`
- [ ] 全项目无 `ClawdWebSocket` 字符串残留
- [ ] 日志 TAG 更新为 `SseClient`
- [ ] 测试文件同步重命名
- [ ] 编译通过，功能不变
- [ ] `WebSocketService` 的 KDoc 注释说明实际协议
