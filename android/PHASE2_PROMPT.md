# Phase 2 线程安全 — 执行提示词

> 复制下方 ```` ``` ```` 块内容直接粘贴到 Claude Code 执行

---

```
执行 Android 端 Phase 2 线程安全修复，共 5 个任务。先读取相关文件确认当前状态，再逐个修改。最后运行 `./gradlew assembleDebug` 确认编译通过。

## 背景

评估报告见 android/AUDIT_REPORT.md，执行方案见 android/EXECUTION_PLAN.md Phase 2 部分。
Phase 1 安全加固已完成。

## 任务清单

### T2.1 MainActivity 全局状态 → ClawdApp SharedFlow

**问题**: `MainActivity.kt:30-36` 的 companion object 有 3 个可变静态字段（`pendingApprovalRequestId`、`pendingApprovalRequest`、`approvalViewModelRef`），被 UI 线程和通知线程同时读写，且 `approvalViewModelRef` 持有 ViewModel 静态引用可能导致内存泄漏。

**方案**: 用 `ClawdApp` 中的 `SharedFlow` 替代 companion object。通知点击的 Intent 数据通过 Application-scoped 的 Flow 传递，`NavGraph` 收集后转发给 ViewModel。

**步骤 A**: 修改 `android/app/src/main/java/com/clawd/mobile/ClawdApp.kt`

在 companion object 中添加 SharedFlow，import 区添加：
```kotlin
import kotlinx.coroutines.channels.Channel
import com.clawd.mobile.data.PermissionRequestData
```

在 companion object 内（`CHANNEL_SERVICE` 之后）添加：
```kotlin
/** Channel for notification → Activity approval request routing.
 *  Replaces MainActivity companion object statics to avoid thread-safety issues and ViewModel leaks. */
val approvalChannel = Channel<PermissionRequestData>(Channel.BUFFERED)
```

**步骤 B**: 修改 `android/app/src/main/java/com/clawd/mobile/MainActivity.kt`

1. 删除整个 companion object 块（第 30-37 行）：
```kotlin
// 删除以下全部内容
companion object {
    /** Set by notification tap, consumed by NavGraph */
    var pendingApprovalRequestId: String? = null
    /** Full request data from notification intent, survives Activity recreation */
    var pendingApprovalRequest: PermissionRequestData? = null
    /** ViewModel reference for onNewIntent forwarding (set by NavGraph) */
    var approvalViewModelRef: com.clawd.mobile.ui.approval.ApprovalViewModel? = null
}
```

2. 修改 `handleApprovalIntent` 方法（第 119-135 行），从写 companion object 改为发到 Channel：
```kotlin
private fun handleApprovalIntent(intent: Intent?) {
    val requestJson = intent?.getStringExtra("request_json") ?: return
    Log.d("MainActivity", "handleApprovalIntent hasJson=true")
    try {
        val request = Json.decodeFromString<PermissionRequestData>(requestJson)
        Log.d("MainActivity", "Sending approval request to channel: ${request.requestId}")
        (applicationContext as ClawdApp).approvalChannel.trySend(request)
    } catch (e: Exception) {
        Log.w("MainActivity", "Failed to deserialize request_json: ${e.message}")
    }
}
```

3. 简化 `onNewIntent`（第 107-117 行），不再写 companion object：
```kotlin
override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    Log.d("MainActivity", "onNewIntent action=${intent.action}")
    handleApprovalIntent(intent)
}
```

4. 在 `onCreate` 中的 `handleApprovalIntent(intent)` 调用保留不变。

5. 删除不再需要的 import：`import com.clawd.mobile.data.PermissionRequestData`（如果其他地方不再使用）

**步骤 C**: 修改 `android/app/src/main/java/com/clawd/mobile/ui/navigation/NavGraph.kt`

1. 删除第 58-76 行的 companion object 引用和手动转发逻辑：
```kotlin
// 删除以下全部内容
// Register ViewModel ref for onNewIntent forwarding
MainActivity.approvalViewModelRef = approvalViewModel

// Wire up pending approval check for StatusNotifier
statusNotifier.hasPendingApprovals = { approvalViewModel.pendingRequests.value.isNotEmpty() }

// Forward notification tap request to ViewModel (consumed by SessionsScreen)
val pendingRequest = MainActivity.pendingApprovalRequest
val pendingId = MainActivity.pendingApprovalRequestId
if (pendingRequest != null) {
    Log.d("NavGraph", "Forwarding full pendingApprovalRequest id=${pendingRequest.requestId} to ViewModel")
    approvalViewModel.restoreRequestFromNotification(pendingRequest)
    MainActivity.pendingApprovalRequest = null
    MainActivity.pendingApprovalRequestId = null
} else if (pendingId != null) {
    Log.d("NavGraph", "Forwarding pendingApprovalRequestId=$pendingId to ViewModel")
    approvalViewModel.setNotificationRequestId(pendingId)
    MainActivity.pendingApprovalRequestId = null
}
```

替换为 Channel 收集：
```kotlin
// Wire up pending approval check for StatusNotifier
statusNotifier.hasPendingApprovals = { approvalViewModel.pendingRequests.value.isNotEmpty() }

// Collect approval requests from notification taps via ClawdApp Channel
val app = context.applicationContext as com.clawd.mobile.ClawdApp
LaunchedEffect(approvalViewModel) {
    for (request in app.approvalChannel) {
        Log.d("NavGraph", "Received approval request from channel: id=${request.requestId}")
        approvalViewModel.restoreRequestFromNotification(request)
    }
}
```

2. 删除不再需要的 import：`import com.clawd.mobile.MainActivity`

---

### T2.2 StatusNotifier 线程安全

**文件**: `android/app/src/main/java/com/clawd/mobile/notification/StatusNotifier.kt`

**问题**: companion object 的 `lastDisplayState` / `firstLoad` 无同步保护；实例字段 `lastBadge` 是普通 `mutableMapOf`。

**修改**: 将 companion object 字段加 `@Volatile`，`lastBadge` 改为 `ConcurrentHashMap`。

1. 添加 import：
```kotlin
import java.util.concurrent.ConcurrentHashMap
```

2. 修改 companion object（第 16-21 行）：
```kotlin
companion object {
    /** Tracks last notified display state to dedup attention/error alerts */
    @Volatile
    private var lastDisplayState: String? = null
    /** Skip notifications on the very first state snapshot */
    @Volatile
    private var firstLoad = true
}
```

3. 修改 `lastBadge` 声明（第 24 行）：
```kotlin
/** Per-session badge tracking for completion notifications */
private val lastBadge = ConcurrentHashMap<String, String>()
```

---

### T2.3 ApprovalViewModel map 线程安全

**文件**: `android/app/src/main/java/com/clawd/mobile/ui/approval/ApprovalViewModel.kt`

**问题**: `recentlyDismissed` / `timeoutJobs` / `countdownJobs` 是普通 `mutableMapOf`，被多个协程并发访问。

**修改**: 改为 `ConcurrentHashMap`。

1. 添加 import：
```kotlin
import java.util.concurrent.ConcurrentHashMap
```

2. 修改第 76-79 行的三个 map 声明：
```kotlin
// Save recently dismissed requests so notification tap can restore them
private val recentlyDismissed = ConcurrentHashMap<String, PermissionRequestData>()

private val timeoutJobs = ConcurrentHashMap<String, Job>()
private val countdownJobs = ConcurrentHashMap<String, Job>()
```

---

### T2.4 PetStateManager gifGeneration 线程安全

**文件**: `android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt`

**问题**: `gifGeneration` 是普通 `Int`，被 `loadReactionAndRestore` 和 `playWakingAndRestore` 从不同协程读写。

**修改**: 改为 `AtomicInteger`。

1. 添加 import：
```kotlin
import java.util.concurrent.atomic.AtomicInteger
```

2. 修改第 106 行声明：
```kotlin
private val gifGeneration = AtomicInteger(0)
```

3. 修改所有读写处（搜索 `gifGeneration`）：
   - `gifGeneration++` 或 `++gifGeneration` → `gifGeneration.incrementAndGet()`
   - `gifGeneration` 读取（如 `if (gifGeneration != gen)`）→ `gifGeneration.get()`
   - `reset()` 中的隐式重置 → `gifGeneration.set(0)`

具体位置：
- 第 106 行声明处
- `reset()` 方法中：添加 `gifGeneration.set(0)`
- `loadReactionAndRestore` 方法中：`val gen = ++gifGeneration` → `val gen = gifGeneration.incrementAndGet()`
- `playWakingAndRestore` 方法中：`val gen = ++gifGeneration` → `val gen = gifGeneration.incrementAndGet()`
- 所有 `if (gifGeneration != gen)` → `if (gifGeneration.get() != gen)`

4. 在类顶部添加线程安全注释（在类声明之前）：
```kotlin
/**
 * Thread safety contract:
 * - [updateSessions] runs under [sessionMutex], protecting all state reads/writes within.
 * - [gifGeneration] is AtomicInteger, safe for cross-coroutine increment/check.
 * - [reset] is called only from Service lifecycle (onDestroy/onStartCommand), which is serialized by Android.
 * - [emitState] and [commandFlowEmit] write to [MutableStateFlow] which is thread-safe by design.
 */
```

---

### T2.5 NotificationHelper notificationId 稳定化

**文件**: `android/app/src/main/java/com/clawd/mobile/notification/NotificationHelper.kt`

**问题**: 静态计数器 `notificationId = 1000` 进程重启后重置，可能造成 PendingIntent 冲突。

**修改**: 改为基于 `requestId` 的确定性 hashCode。

1. 删除第 21 行的计数器：
```kotlin
// 删除: private var notificationId = 1000
```

2. 修改 `showApprovalNotification`（第 23-24 行）：
```kotlin
fun showApprovalNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
    val requestId = request.requestId ?: return
    val id = requestId.hashCode() and 0x7FFFFFFF  // 确保非负，确定性 ID
```

3. 修改 `showElicitationNotification`（第 83-85 行）：
```kotlin
fun showElicitationNotification(context: Context, request: PermissionRequestData, sessionName: String? = null) {
    val requestId = request.requestId ?: return
    val id = (requestId.hashCode() and 0x7FFFFFFF) + 1  // 偏移 1 避免与 approval 冲突
```

---

## 验证

完成所有修改后，执行以下验证：

1. **编译检查**: `./gradlew assembleDebug` 确认无编译错误
2. **Grep 验证**: 确认 MainActivity 不再有 companion object 可变静态字段：
   - `grep -n "companion object" android/app/src/main/java/com/clawd/mobile/MainActivity.kt` 应返回空
3. **Grep 验证**: 确认 ApprovalViewModel 使用 ConcurrentHashMap：
   - `grep -n "ConcurrentHashMap" android/app/src/main/java/com/clawd/mobile/ui/approval/ApprovalViewModel.kt` 应有结果
4. **Grep 验证**: 确认 StatusNotifier 使用 ConcurrentHashMap：
   - `grep -n "ConcurrentHashMap" android/app/src/main/java/com/clawd/mobile/notification/StatusNotifier.kt` 应有结果
5. **Grep 验证**: 确认 PetStateManager 使用 AtomicInteger：
   - `grep -n "AtomicInteger" android/app/src/main/java/com/clawd/mobile/overlay/PetStateManager.kt` 应有结果
6. **Grep 验证**: 确认 NotificationHelper 不再有递增计数器：
   - `grep -n "notificationId++" android/app/src/main/java/com/clawd/mobile/notification/NotificationHelper.kt` 应返回空
7. **Grep 验证**: 确认 NavGraph 不再引用 MainActivity companion：
   - `grep -n "MainActivity\." android/app/src/main/java/com/clawd/mobile/ui/navigation/NavGraph.kt` 应返回空

最后输出修改文件清单和每个文件的改动摘要。
```
