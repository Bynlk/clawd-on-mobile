package com.clawd.mobile.util

import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.CopyOnWriteArrayList

/**
 * In-memory ring buffer for connection-related log entries.
 * Thread-safe — written from IO threads, read from UI thread.
 */
object ConnectionLog {
    private const val MAX_ENTRIES = 200
    private val entries = CopyOnWriteArrayList<String>()
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun d(tag: String, msg: String) {
        val line = "${timeFmt.format(Date())} D/$tag: $msg"
        entries.add(line)
        if (entries.size > MAX_ENTRIES) entries.removeAt(0)
    }

    fun e(tag: String, msg: String) {
        val line = "${timeFmt.format(Date())} E/$tag: $msg"
        entries.add(line)
        if (entries.size > MAX_ENTRIES) entries.removeAt(0)
    }

    fun w(tag: String, msg: String) {
        val line = "${timeFmt.format(Date())} W/$tag: $msg"
        entries.add(line)
        if (entries.size > MAX_ENTRIES) entries.removeAt(0)
    }

    /** Dump all entries as a single string for copying. */
    fun dump(): String = entries.joinToString("\n")

    fun clear() = entries.clear()
}
