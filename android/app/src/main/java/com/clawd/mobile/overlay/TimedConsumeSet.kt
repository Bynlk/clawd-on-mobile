package com.clawd.mobile.overlay

import java.util.concurrent.ConcurrentHashMap

/**
 * A set of consumed keys with automatic TTL-based expiration.
 *
 * Used to track one-shot session events (done, interrupted, notification)
 * so they only trigger once per session, with automatic cleanup after [ttlMs].
 *
 * Thread-safe: backed by [ConcurrentHashMap].
 */
class TimedConsumeSet(private val ttlMs: Long) {

    private val map = ConcurrentHashMap<String, Long>()

    /**
     * Try to consume [key]. Returns `true` if this is the first time (key was added),
     * `false` if already consumed.
     */
    fun tryConsume(key: String): Boolean {
        cleanup()
        return map.putIfAbsent(key, System.currentTimeMillis()) == null
    }

    /** Check if [key] has been consumed (without consuming). */
    fun contains(key: String): Boolean = map.containsKey(key)

    /** Remove [key] from the consumed set (e.g. when a new task starts). */
    fun remove(key: String) = map.remove(key)

    /** Clear all entries. */
    fun clear() = map.clear()

    /** Remove entries older than [ttlMs]. */
    private fun cleanup() {
        val now = System.currentTimeMillis()
        val expired = map.entries
            .filter { now - it.value > ttlMs }
            .map { it.key }
        expired.forEach { map.remove(it) }
    }
}
