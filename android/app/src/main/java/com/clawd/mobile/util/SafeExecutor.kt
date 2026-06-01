package com.clawd.mobile.util

import android.util.Log

/**
 * Unified exception handling with severity levels.
 *
 * - [tryOrNull] — non-critical path (JSON parse, UI ops): log warning, return null
 * - [tryOrLog] — network operations: log full stack trace, return null
 * - [tryOrReport] — critical business logic: log error + optional callback
 */
object SafeExecutor {
    /** Non-critical path: allow skip, log warning. */
    inline fun <T> tryOrNull(tag: String = "Clawd", block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.w(tag, "Non-critical: ${e.message}")
            null
        }
    }

    /** Network operations: log full stack trace. */
    inline fun <T> tryOrLog(tag: String = "Clawd", block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.e(tag, "Network error", e)
            null
        }
    }

    /** Critical path: log error + optional callback. */
    inline fun <T> tryOrReport(tag: String = "Clawd", noinline onError: ((Exception) -> Unit)? = null, block: () -> T): T? {
        return try { block() } catch (e: Exception) {
            Log.e(tag, "Critical error", e)
            onError?.invoke(e)
            null
        }
    }
}
