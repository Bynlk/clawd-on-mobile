# P2-4: SvgLoader 线程安全与初始化改进

> **优先级**: P2 — 潜在竞态  
> **影响范围**: `overlay/SvgLoader.kt`  
> **预估工时**: 1h  
> **启动提示词**: `执行 P2-3: 改进 SvgLoader 的线程安全，将 assetCache/missingCache 改为线程安全集合，消除初始化时序依赖`

---

## 问题描述

```kotlin
// SvgLoader.kt:448-449
private val assetCache = LinkedHashSet<String>(MAX_CACHE_SIZE, 0.75f)
private val missingCache = LinkedHashSet<String>(MAX_CACHE_SIZE, 0.75f)
```

**问题 1: 线程不安全**
`LinkedHashSet` 非线程安全。`assetExists()` 可能从多线程调用（WebView 主线程 + PetStateManager 协程），并发读写会导致 `ConcurrentModificationException`。

**问题 2: 初始化时序依赖**
```kotlin
// SvgLoader.kt:455
val ctx = appContext
if (ctx == null) {
    // Not initialized yet — degrade to always-true (legacy behavior)
    return true
}
```
如果 `SvgLoader.init(context)` 未被调用（如 Application 创建失败），所有 `assetExists` 返回 `true`，导致加载不存在的资源。

**问题 3: LRU 淘汰逻辑不标准**
```kotlin
if (assetCache.size >= MAX_CACHE_SIZE) assetCache.iterator().let { it.next(); it.remove() }
```
移除的是最旧的条目（LinkedHashSet 的插入顺序），但这是 O(1) 的近似 LRU，不是严格 LRU。

## 修复方案

### Step 1: 使用 ConcurrentHashMap 替代 LinkedHashSet

```kotlin
// SvgLoader.kt
private val assetCache = ConcurrentHashMap.newKeySet<String>()
private val missingCache = ConcurrentHashMap.newKeySet<String>()
```

**注意**: `ConcurrentHashMap.newKeySet()` 无大小限制和 LRU 语义。对于 asset 文件数量有限的场景（~100 个 SVG 文件），可接受无淘汰。

### Step 2: 使用 Collections.synchronizedSet 保留 LRU

```kotlin
private val assetCache = Collections.synchronizedSet(
    object : LinkedHashSet<String>(MAX_CACHE_SIZE, 0.75f) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean {
            return size > MAX_CACHE_SIZE
        }
    }.keys
)
```

但 `LinkedHashSet` 的 `keys` 视图不支持 `removeEldestEntry`。更简单的方案：

```kotlin
private val assetCache = object : LinkedHashMap<String, Boolean>(MAX_CACHE_SIZE, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean {
        return size > MAX_CACHE_SIZE
    }
}
private val missingCache = object : LinkedHashMap<String, Boolean>(MAX_CACHE_SIZE, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean {
        return size > MAX_CACHE_SIZE
    }
}

// assetExists 中
synchronized(assetCache) {
    if (path in assetCache) return true
}
synchronized(missingCache) {
    if (path in missingCache) return false
}
```

### Step 3: 消除初始化时序依赖

```kotlin
// SvgLoader.kt
object SvgLoader {
    private var appContext: Context? = null

    /**
     * Initialize with application context.
     * Must be called from ClawdApp.onCreate() before any SVG operations.
     */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Check if SvgLoader is initialized.
     * Throws if called before init().
     */
    private fun requireContext(): Context {
        return appContext ?: throw IllegalStateException(
            "SvgLoader.init(context) must be called from ClawdApp.onCreate()"
        )
    }

    private fun assetExists(path: String): Boolean {
        if (path in assetCache) return true
        if (path in missingCache) return false
        val ctx = requireContext()  // 明确失败，而非静默返回 true
        return try {
            ctx.assets.open(path).use { }
            synchronized(assetCache) { assetCache[path] = true }
            true
        } catch (_: IOException) {
            synchronized(missingCache) { missingCache[path] = true }
            false
        }
    }
}
```

### Step 4: 支持测试重置

```kotlin
/** Reset for testing — clears caches and context. */
fun resetForTesting() {
    synchronized(assetCache) { assetCache.clear() }
    synchronized(missingCache) { missingCache.clear() }
    appContext = null
}
```

## 验收标准

- [ ] `assetCache` 和 `missingCache` 线程安全（`synchronized` 或 `ConcurrentHashMap`）
- [ ] 未初始化时调用 `assetExists` 抛出明确异常
- [ ] `ClawdApp.onCreate()` 中 `SvgLoader.init()` 调用保持不变
- [ ] LRU 淘汰逻辑保留（可选，如改为无淘汰需注释说明）
- [ ] SvgLoaderLookupTest / SvgLoaderTest 通过
