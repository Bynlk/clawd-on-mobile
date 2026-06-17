# Spec：Android 浮窗内审批

> 状态：已修正（三轮验证通过，置信度 93%）
> 修正项：双 client 审批路由、FIFO 自动推进逻辑、双 client 来源标记
> 分支：`feat/floating-approval`
> 预估工时：~8h
> 修正项：新增通知同步共享流、窗口标志动态切换、去重竞态保护

## 目标

Android 浮窗宠物收到权限审批请求时，直接在浮窗上显示审批气泡，用户无需拉通知栏或打开 App 即可完成审批。

## 用户体验流程

```
1. Agent 发出权限请求 (WS permission_request)
2. 浮窗宠物旁出现小气泡「审批（点击展开）」
3. 用户点击小气泡 → 展开审批面板
4. 面板显示：工具名 + 操作摘要 + Allow/Deny 滑动条 + suggestion 快捷选项
5. 用户滑动 Allow 或 Deny → 发送响应 → 面板自动收起
6. 超时自动收起，通知栏同步更新
```

对于 elicitation (AskUserQuestion) 请求：小气泡显示「问题（打开App）」，点击跳转 App 内审批页面。

## 改动规模总览

| 类别 | 新增文件 | 修改文件 | 预估行数 |
|------|----------|----------|----------|
| Android overlay | 2 | 2 | ~300 行新增 + ~30 行修改 |
| Android 通知同步 | 0 | 2 | ~15 行修改 |
| **合计** | **2** | **4** | **~345 行** |

零上游耦合：所有改动均在 `android/` 目录，不涉及任何 PC 端 `src/` 文件。

## 技术方案

### 新增文件

| 文件 | 职责 |
|------|------|
| `overlay/PetApprovalBubbleManager.kt` | 审批气泡生命周期管理（显示/展开/收起/消失） |
| `overlay/ApprovalBubbleView.kt` | 审批气泡纯代码布局（摘要 + 滑动操作 + suggestion） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `overlay/FloatingPetService.kt` | 监听 `StreamingClient.permissionRequests`，驱动 `PetApprovalBubbleManager` |
| `overlay/PetGestureHandler.kt` | 单击宠物时，如有审批气泡则展开，否则走原有会话气泡逻辑 |

### 修改文件（通知同步）

| 文件 | 改动 |
|------|------|
| `notification/ApprovalWorker.kt` | 审批完成后 emit 到共享的 `approvalCompletedFlow` |
| `service/WsConnectionService.kt` | 在 Companion 中新增 `approvalCompletedFlow: MutableSharedFlow<String>` |

### 不改动

| 文件 | 原因 |
|------|------|
| `ApprovalSender.kt` | JSON 格式和发送逻辑直接复用 |
| `WsClient.kt` / `StreamingClient.kt` | `sendPermissionResponse()` 已可从任何上下文调用 |
| `ApprovalViewModel.kt` | App 内审批路径保留不变 |
| `NotificationHelper.kt` / `ApprovalReceiver.kt` | 通知路径保留为浮窗未运行时的 fallback |

### 详细设计

#### PetApprovalBubbleManager

```
职责：
- 收集 LAN client 的 permissionRequests flow
- 收集 Relay client 的 permissionRequests flow（如果 relay 已连接）
- 收集 WsConnectionService.approvalCompletedFlow（通知审批完成时同步消失）
- 维护 pendingRequests 列表 + respondedRequestIds 去重集合
- 有 pending 请求时显示小气泡（提示态）
- 用户点击小气泡时展开为审批面板（展开态）
- 用户完成审批或超时后自动推进到下一个排队请求（或全部处理完后消失）
- 同一时间最多显示一个审批请求，其余排队（FIFO 自动推进）

双 client 审批路由：
- 每个 PermissionRequestData 携带来源标记：sourceClient: StreamingClient
- 收集时记录 requestId -> sourceClient 映射
- 审批响应时通过 sourceClient.sendPermissionResponse() 路由回正确 client
- 同一 requestId 通过 respondedRequestIds 去重，不会重复显示

位置：相对于宠物内容区域的上方或下方（复用 PetBubbleManager 的定位逻辑）
窗口类型：TYPE_APPLICATION_OVERLAY（与 PetBubbleManager 一致）

窗口标志动态切换：
- 提示态：FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL | FLAG_WATCH_OUTSIDE_TOUCH
- 展开态：FLAG_NOT_TOUCH_MODAL | FLAG_WATCH_OUTSIDE_TOUCH（去掉 NOT_FOCUSABLE，允许按钮交互）
- 收起时：恢复为提示态标志

去重机制：
- 维护 respondedRequestIds: MutableSet<String>
- 收到 permissionRequests 时检查是否已响应，已响应则跳过
- 浮窗审批完成 → add(requestId) + 取消通知
- 通知审批完成（via approvalCompletedFlow）→ add(requestId) + 隐藏气泡
```

#### ApprovalBubbleView

```
提示态（小气泡）：
- 8dp 圆角矩形，深色背景
- 文字「审批（点击展开）」或「问题（打开App）」
- 如有多个排队请求，显示角标数量
- 可点击

展开态（审批面板）：
- 工具名（粗体）
- 操作摘要（单行，ellipsize）
- suggestion 快捷按钮（如有）
- 滑动操作条：左滑 Deny（红色），右滑 Allow（绿色）
- 倒计时进度条
- 点击面板外部收起回提示态

FIFO 自动推进：
- 当前请求审批完成或超时 → 从 pendingRequests 移除
- 如果 pendingRequests 非空 → 自动展开下一个请求（提示态 → 展开态）
- 如果 pendingRequests 为空 → 气泡消失
- 用户手动收起（点击外部）→ 回到提示态，不自动推进，等待用户再次点击
```

#### 滑动操作实现

```
- 使用 GestureDetector 检测水平滑动
- 滑动阈值：50dp
- 滑动过程中 Allow 侧变绿、Deny 侧变红（视觉反馈）
- 超过阈值松手 → 发送响应
- 未超过阈值松手 → 回弹
- 发送后面板收起，小气泡消失
```

#### 与通知系统的协调

```
新增共享完成信号：
- WsConnectionService.Companion.approvalCompletedFlow =
    MutableSharedFlow<String>(extraBufferCapacity = 16)
  extraBufferCapacity=16 确保 ApprovalWorker（WorkManager 线程）emit 时不挂起
  PetApprovalBubbleManager 在 Main dispatcher 收集

去重集合（线程安全）：
- respondedRequestIds = ConcurrentHashMap.newKeySet<String>()
  浮窗审批路径在 Main dispatcher 写入
  通知审批路径通过 approvalCompletedFlow collector 在 Main dispatcher 写入
  两端统一用 ConcurrentHashMap.newKeySet() 防御性保证线程安全

协调流程：
- 审批请求到达 → 通知和浮窗气泡同时显示（两个独立 collector，SharedFlow extraBufferCapacity=16 支撑）
- 浮窗审批完成 → respondedRequestIds.add(requestId) → cancelNotification(requestId) → emit(approvalCompletedFlow)
- 通知审批完成 → ApprovalWorker emit(approvalCompletedFlow) → 浮窗 collector 收到 → respondedRequestIds.add(requestId) → 隐藏气泡
- 竞态保护：两端都检查 respondedRequestIds.contains()，已响应则跳过重复 sendPermissionResponse
- 浮窗未运行时 → 通知为唯一审批入口（现有逻辑不变，approvalCompletedFlow 无 collector 不影响）
```

## 验收标准

1. 浮窗运行时，权限请求到达后宠物旁出现小气泡
2. 点击小气泡展开审批面板，显示工具名和操作摘要
3. 右滑 Allow 发送 `permission_response` (decision=allow)，PC 端收到
4. 左滑 Deny 发送 `permission_response` (decision=deny)，PC 端收到
5. suggestion 按钮点击后发送带 `suggestionIndex` 的响应
6. elicitation 请求显示「打开App」提示，点击跳转 App 内审批页
7. 超时后气泡自动消失
8. 浮窗审批和通知审批互相同步状态
9. 浮窗未运行时，通知审批路径不受影响

## 风险点

| 风险 | 缓解 |
|------|------|
| 滑动误触 | 50dp 阈值 + 视觉反馈 + 松手前可取消 |
| 审批请求堆积 | 同一时间只显示一个，其余排队 |
| 与 PetBubbleManager 定位冲突 | 审批气泡优先级高于会话气泡，审批期间隐藏会话气泡 |
| overlay 窗口过多影响性能 | 审批气泡复用同一窗口实例，不重复创建 |
| 浮窗+通知同时审批竞态 | respondedRequestIds 去重，server 忽略重复 response |
| Android 9+ ACTION_OUTSIDE 坐标粗糙化 | 收起逻辑只判断"外部点击"，不依赖精确坐标 |
| 窗口标志切换闪烁 | 提示态/展开态切换时用 updateViewLayout 而非 remove+add |
