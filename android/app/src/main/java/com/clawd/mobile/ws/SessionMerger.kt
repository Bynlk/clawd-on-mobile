package com.clawd.mobile.ws

import com.clawd.mobile.data.SessionData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * 合并多个 StreamingClient 的 sessions StateFlow 为一个统一的 sessions 视图。
 *
 * 每个 session 携带 ConnectionTag 标识来源（LAN / RELAY）。
 * 同一 sessionId 可出现在多个 tag 下（独立条目）。
 * UI 按 tag 分组显示。
 */
data class TaggedSession(
    val session: SessionData,
    val tag: ConnectionTag
)

class SessionMerger(
    private val scope: CoroutineScope
) {
    private val _mergedSessions = MutableStateFlow<Map<String, List<TaggedSession>>>(emptyMap())
    val mergedSessions: StateFlow<Map<String, List<TaggedSession>>> = _mergedSessions.asStateFlow()

    private val sessionSources = ConcurrentHashMap<String, ConcurrentHashMap<ConnectionTag, SessionData>>()
    private val jobs = mutableMapOf<ConnectionTag, kotlinx.coroutines.Job>()

    /**
     * 注册一个 client 的 sessions flow 进行合并。
     * 同一 tag 只能注册一次，重复注册会替换。
     */
    fun register(tag: ConnectionTag, sessions: StateFlow<Map<String, SessionData>>) {
        // 取消旧的 collector（如果有）
        jobs[tag]?.cancel()

        val job = scope.launch {
            sessions.collect { sessionMap ->
                // 更新该 tag 的所有 session
                val currentTags = mutableSetOf<String>()

                for ((sessionId, sessionData) in sessionMap) {
                    currentTags.add(sessionId)
                    val tagMap = sessionSources.getOrPut(sessionId) { ConcurrentHashMap() }
                    tagMap[tag] = sessionData
                }

                // 清除该 tag 中已不存在的 session
                for (sessionId in sessionSources.keys.toList()) {
                    val tagMap = sessionSources[sessionId]
                    if (tagMap != null && sessionId !in currentTags) {
                        tagMap.remove(tag)
                        if (tagMap.isEmpty()) {
                            sessionSources.remove(sessionId)
                        }
                    }
                }

                // 重建 merged sessions
                rebuildMerged()
            }
        }
        jobs[tag] = job
    }

    /**
     * 注销一个 client（断线时调用）。
     * 清除该 tag 的所有 session 数据。
     */
    fun unregister(tag: ConnectionTag) {
        jobs[tag]?.cancel()
        jobs.remove(tag)

        // 清除该 tag 的所有 session
        for (sessionId in sessionSources.keys.toList()) {
            val tagMap = sessionSources[sessionId]
            tagMap?.remove(tag)
            if (tagMap.isNullOrEmpty()) {
                sessionSources.remove(sessionId)
            }
        }
        rebuildMerged()
    }

    /**
     * 获取指定 tag 的所有 session。
     */
    fun getSessionsByTag(tag: ConnectionTag): Map<String, SessionData> {
        val result = mutableMapOf<String, SessionData>()
        for ((sessionId, tagMap) in sessionSources) {
            tagMap[tag]?.let { result[sessionId] = it }
        }
        return result
    }

    /**
     * 清除所有 session 数据。
     */
    fun clear() {
        sessionSources.clear()
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        _mergedSessions.value = emptyMap()
    }

    private fun rebuildMerged() {
        val merged = mutableMapOf<String, List<TaggedSession>>()
        for ((sessionId, tagMap) in sessionSources) {
            val taggedSessions = tagMap.map { (tag, session) ->
                TaggedSession(session, tag)
            }
            merged[sessionId] = taggedSessions
        }
        _mergedSessions.value = merged
    }
}
