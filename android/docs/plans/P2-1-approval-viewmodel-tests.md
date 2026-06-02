# P2-1: ApprovalViewModel 单元测试

> **优先级**: P2 — 测试缺失  
> **影响范围**: `ui/approval/ApprovalViewModel.kt`  
> **预估工时**: 2h  
> **启动提示词**: `执行 P2-1: 为 ApprovalViewModel 编写单元测试，覆盖倒计时、去重、自动超时、通知恢复等核心逻辑`

---

## 问题描述

`ApprovalViewModel` 包含复杂的业务逻辑，但没有任何测试覆盖：

- 请求去重（SSE 重连可能重发同一请求）
- 倒计时逻辑（每秒递减，超时自动 dismiss）
- 通知恢复（dismiss 后通过通知重新打开）
- recentlyDismissed 缓存淘汰（max 20）
- elicitation vs approval 区分

## 测试文件

```
test/ui/approval/ApprovalViewModelTest.kt  — 新建
```

## 测试用例设计

### 1. 请求去重

```kotlin
@Test
fun `duplicate requestId is ignored`() = runTest {
    val request = makeRequest(requestId = "req-1")
    vm.handleNewRequest(request)  // 第一次
    vm.handleNewRequest(request)  // 重复
    assertEquals(1, vm.pendingRequests.value.size)
}
```

### 2. 倒计时递减

```kotlin
@Test
fun `countdown decrements every second`() = runTest {
    val request = makeRequest(requestId = "req-1", timeout = 30000)
    vm.handleNewRequest(request)
    advanceTimeBy(1000)
    assertEquals(29, vm.countdowns.value["req-1"])
    advanceTimeBy(1000)
    assertEquals(28, vm.countdowns.value["req-1"])
}
```

### 3. 超时自动 dismiss

```kotlin
@Test
fun `request auto-dismissed on timeout`() = runTest {
    val request = makeRequest(requestId = "req-1", timeout = 10000)
    vm.handleNewRequest(request)
    advanceTimeBy(10001)
    assertTrue(vm.pendingRequests.value.none { it.requestId == "req-1" })
}
```

### 4. 超时后通知恢复

```kotlin
@Test
fun `dismissed request restored on notification tap`() = runTest {
    val request = makeRequest(requestId = "req-1", timeout = 10000)
    vm.handleNewRequest(request)
    advanceTimeBy(10001)  // auto-dismiss
    vm.setNotificationRequestId("req-1")  // 通知恢复
    assertTrue(vm.pendingRequests.value.any { it.requestId == "req-1" })
}
```

### 5. approve/deny 发送

```kotlin
@Test
fun `approve sends allow response`() = runTest {
    val request = makeRequest(requestId = "req-1")
    vm.handleNewRequest(request)
    vm.approve("req-1")
    verify { webSocket.sendPermissionResponse("req-1", "allow", null) }
    assertTrue(vm.pendingRequests.value.none { it.requestId == "req-1" })
}
```

### 6. recentlyDismissed 淘汰

```kotlin
@Test
fun `recentlyDismissed evicts oldest when over limit`() = runTest {
    // 添加 21 个请求并 dismiss
    repeat(21) { i ->
        val request = makeRequest(requestId = "req-$i", timeout = 10000)
        vm.handleNewRequest(request)
        advanceTimeBy(10001)
    }
    // 第一个应被淘汰
    vm.setNotificationRequestId("req-0")
    assertTrue(vm.pendingRequests.value.none { it.requestId == "req-0" })
}
```

### 7. Elicitation 区分

```kotlin
@Test
fun `elicitation request shows elicitation notification`() = runTest {
    val request = makeRequest(requestId = "req-1", toolName = "AskUserQuestion")
    vm.handleNewRequest(request)
    // 验证 NotificationHelper.showElicitationNotification 被调用
}
```

## Mock 策略

```kotlin
// Mock ClawdWebSocket
class MockClawdWebSocket : ClawdWebSocket(mockk(relaxed = true)) {
    val sentResponses = mutableListOf<Triple<String, String, Int?>>()
    override fun sendPermissionResponse(requestId: String, behavior: String, suggestionIndex: Int?) {
        sentResponses.add(Triple(requestId, behavior, suggestionIndex))
    }
}
```

## 验收标准

- [ ] 测试文件 `ApprovalViewModelTest.kt` 创建
- [ ] 覆盖 7 个核心测试用例
- [ ] 所有测试通过
- [ ] 测试可在 CI 环境运行（无 Android 依赖，纯 JVM）
