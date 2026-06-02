# P3-3: 集成测试覆盖

> **优先级**: P3 — 测试缺失  
> **影响范围**: Service ↔ WebSocket ↔ UI 端到端  
> **预估工时**: 4h  
> **启动提示词**: `执行 P3-3: 补充集成测试，覆盖 Service 生命周期、SSE 连接重连、PetStateManager 与 WebSocket 的端到端协作`

---

## 问题描述

现有 10 个测试文件全部是单元测试，无集成测试覆盖以下关键路径：

| 路径 | 风险 |
|------|------|
| WebSocketService 创建 → SSE 连接 → 状态更新 | 连接建立失败静默丢失 |
| SSE 断开 → 重连 → 状态恢复 | 重连后 session 状态不一致 |
| PetStateManager ↔ WebSocket session 同步 | 浮窗状态与实际 session 不同步 |
| 权限请求 → 通知 → 审批 → HTTP POST | 审批丢失或重复发送 |
| Service 被系统杀死 → START_STICKY 恢复 | 恢复后连接状态异常 |

## 测试文件规划

```
test/
├── integration/
│   ├── SseConnectionIntegrationTest.kt    — SSE 连接生命周期
│   ├── PetStateIntegrationTest.kt         — PetStateManager ↔ sessions
│   └── ApprovalFlowIntegrationTest.kt     — 权限请求完整流程
```

## 测试用例设计

### 1. SseConnectionIntegrationTest

```kotlin
class SseConnectionIntegrationTest {

    @Test
    fun `connect then disconnect transitions through CONNECTING CONNECTED DISCONNECTED`() = runTest {
        // Mock OkHttp EventSource，模拟 onOpen → onClosed
        // 验证 connectionState 流经正确状态
    }

    @Test
    fun `reconnect uses exponential backoff on failure`() = runTest {
        // Mock EventSource.onFailure 连续触发
        // 验证重连延迟: 1s → 2s → 4s → ... → 30s max
    }

    @Test
    fun `401 response sets AUTH_FAILED and stops reconnect`() = runTest {
        // Mock Response(code=401)
        // 验证状态为 AUTH_FAILED，无后续重连
    }

    @Test
    fun `watchdog triggers reconnect after 30s silence`() = runTest {
        // 发送一条消息后 30s 无消息
        // 验证触发 scheduleReconnect
    }

    @Test
    fun `snapshot clears syncing flag and populates sessions`() = runTest {
        // 发送 clear_sessions + snapshot
        // 验证 syncing=false, sessions 非空
    }
}
```

### 2. PetStateIntegrationTest

```kotlin
class PetStateIntegrationTest {

    @Test
    fun `session state change triggers pet state update`() = runTest {
        // 注入 sessionsFlow
        // 发射 session(state="working")
        // 验证 stateFlow 收到 StateChanged(Working)
    }

    @Test
    fun `all sessions idle starts sleep timer`() = runTest {
        // 发射 session(state="idle")
        // advanceTimeBy(60000)
        // 验证 stateFlow 收到 Yawning → Sleeping
    }

    @Test
    fun `active session wakes from sleep sequence`() = runTest {
        // 先进入 Sleeping
        // 发射 session(state="working")
        // 验证 Waking → Working
    }

    @Test
    fun `multi-session juggling state resolved correctly`() = runTest {
        // 发射 2 个 session(state="working")
        // 验证 displayState 为 juggling（由服务器设置）
    }

    @Test
    fun `badge transition done triggers happy interlude`() = runTest {
        // session.badge: "running" → "done"
        // 验证 ReactionSvg 被发射
    }
}
```

### 3. ApprovalFlowIntegrationTest

```kotlin
class ApprovalFlowIntegrationTest {

    @Test
    fun `permission request from SSE → notification → approve → HTTP POST`() = runTest {
        // Mock SSE 发送 permission_request
        // 验证 NotificationHelper.showApprovalNotification 被调用
        // 调用 ApprovalViewModel.approve()
        // 验证 HTTP POST 到 approveUrl
    }

    @Test
    fun `timeout auto-dismiss saves for notification restore`() = runTest {
        // 发送 permission_request(timeout=10s)
        // advanceTimeBy(10001)
        // 验证 pendingRequests 为空
        // 调用 setNotificationRequestId
        // 验证 request 恢复
    }

    @Test
    fun `duplicate requestId on SSE reconnect is ignored`() = runTest {
        // 发送同一 requestId 两次
        // 验证 pendingRequests 只有 1 条
    }
}
```

## Mock 基础设施

```kotlin
// test/mock/MockEventSourceFactory.kt
class MockEventSourceFactory : EventSource.Factory {
    private var listener: EventSourceListener? = null
    private val mockEventSource = MockEventSource()

    override fun newEventSource(request: Request, listener: EventSourceListener): EventSource {
        this.listener = listener
        return mockEventSource
    }

    fun simulateOpen() { listener?.onOpen(mockEventSource, mockResponse(200)) }
    fun simulateEvent(data: String) { listener?.onEvent(mockEventSource, null, null, data) }
    fun simulateFailure(code: Int = -1) { listener?.onFailure(mockEventSource, null, mockResponse(code)) }
    fun simulateClose() { listener?.onClosed(mockEventSource) }
}
```

## 验收标准

- [ ] `SseConnectionIntegrationTest` 覆盖连接/断开/重连/401/watchdog
- [ ] `PetStateIntegrationTest` 覆盖状态同步/睡眠/唤醒/多 session
- [ ] `ApprovalFlowIntegrationTest` 覆盖请求→通知→审批→POST 完整流程
- [ ] Mock 基础设施可复用（MockEventSourceFactory）
- [ ] 所有测试在 CI 环境可运行（纯 JVM，无 Android 依赖）
