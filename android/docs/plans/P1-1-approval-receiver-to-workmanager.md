# P1-1: ApprovalReceiver 迁移到 WorkManager

> **优先级**: P1 — ANR 风险 + 协程泄漏  
> **影响范围**: 通知栏审批按钮  
> **预估工时**: 2h  
> **启动提示词**: `执行 P1-1: 将 ApprovalReceiver 中的 goAsync+协程替换为 WorkManager，消除 ANR 风险和协程泄漏`

---

## 问题描述

`ApprovalReceiver` 使用 `goAsync()` + 无主协程处理网络请求：

```kotlin
// ApprovalReceiver.kt:35-37
val pendingResult = goAsync()
CoroutineScope(Dispatchers.IO).launch {
    // 网络请求可能超过 10s
}
```

**风险**:
1. `goAsync()` 的 `PendingResult` 有 **10 秒超时**，网络请求可能超时导致 ANR
2. `CoroutineScope(Dispatchers.IO)` 无人管理，BroadcastReceiver 被回收后协程仍在执行
3. 无重试机制，网络抖动直接失败

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `notification/ApprovalReceiver.kt` | 改为启动 WorkManager 任务 |
| `notification/ApprovalWorker.kt` | **新建** — Worker 实现 |
| `build.gradle.kts` | 添加 `androidx.work:work-runtime-ktx` 依赖 |

## 修复方案

### Step 1: 添加依赖

```kotlin
// build.gradle.kts
dependencies {
    implementation("androidx.work:work-runtime-ktx:2.10.0")
}
```

### Step 2: 创建 `ApprovalWorker`

```kotlin
// notification/ApprovalWorker.kt
class ApprovalWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val requestId = inputData.getString("request_id") ?: return Result.failure()
        val decision = inputData.getString("decision") ?: return Result.failure()
        val notificationId = inputData.getInt("notification_id", -1)

        return try {
            val prefsStore = PrefsStore.getInstance(applicationContext)
            val config = prefsStore.loadConfig() ?: return Result.failure()

            val body = buildJsonObject {
                put("id", requestId)
                put("decision", decision)
            }.toString()

            val client = HttpClientProvider.getClient(config)
            val request = Request.Builder()
                .url(config.approveUrl())
                .addHeader("Authorization", config.authHeader())
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()

            val response = client.newCall(request).execute()
            response.close()

            if (response.isSuccessful) {
                if (notificationId >= 0) {
                    NotificationHelper.cancelNotification(applicationContext, notificationId)
                }
                Result.success()
            } else {
                Log.w(TAG, "Approval failed: HTTP ${response.code}")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Approval error", e)
            Result.retry()
        }
    }

    companion object {
        private const val TAG = "ApprovalWorker"
        const val WORK_NAME_PREFIX = "approval_"
    }
}
```

### Step 3: 简化 `ApprovalReceiver`

```kotlin
// notification/ApprovalReceiver.kt
class ApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra("request_id") ?: return
        val notificationId = intent.getIntExtra("notification_id", -1)
        val decision = when (intent.action) {
            ACTION_APPROVE -> "allow"
            ACTION_DENY -> "deny"
            else -> return
        }

        val inputData = workDataOf(
            "request_id" to requestId,
            "decision" to decision,
            "notification_id" to notificationId
        )

        val workRequest = OneTimeWorkRequestBuilder<ApprovalWorker>()
            .setInputData(inputData)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                "${ApprovalWorker.WORK_NAME_PREFIX}$requestId",
                ExistingWorkPolicy.KEEP,
                workRequest
            )
    }
}
```

### 关键改进

| 原问题 | WorkManager 方案 |
|--------|-----------------|
| `goAsync()` 10s 超时 | Worker 无超时限制，系统调度 |
| 无主协程泄漏 | WorkManager 管理生命周期 |
| 无重试 | `Result.retry()` + 指数退避 |
| 进程杀死丢失 | WorkManager 持久化队列 |

## 验收标准

- [ ] `ApprovalReceiver` 不再使用 `goAsync()` 和裸协程
- [ ] 网络请求在 `ApprovalWorker` 中执行
- [ ] 失败时自动重试（指数退避，最多 3 次）
- [ ] 通知栏审批按钮功能不变
- [ ] 无 ANR 风险
