package com.clawd.mobile.util

import org.junit.Test
import org.junit.Assert.*

class SafeExecutorTest {

    @Test
    fun `tryOrNull returns result on success`() {
        val result = SafeExecutor.tryOrNull { 42 }
        assertEquals(42, result)
    }

    @Test
    fun `tryOrNull returns null on exception`() {
        val result = SafeExecutor.tryOrNull<String> { throw RuntimeException("test") }
        assertNull(result)
    }

    @Test
    fun `tryOrNull returns null on IllegalArgumentException`() {
        val result = SafeExecutor.tryOrNull<Int> { throw IllegalArgumentException("bad arg") }
        assertNull(result)
    }

    @Test
    fun `tryOrNull returns null on NullPointerException`() {
        val result = SafeExecutor.tryOrNull<String> { throw NullPointerException() }
        assertNull(result)
    }

    @Test
    fun `tryOrNull returns string result`() {
        val result = SafeExecutor.tryOrNull { "hello" }
        assertEquals("hello", result)
    }

    @Test
    fun `tryOrNull returns null result when block returns null`() {
        val result = SafeExecutor.tryOrNull { null }
        assertNull(result)
    }

    @Test
    fun `tryOrLog returns result on success`() {
        val result = SafeExecutor.tryOrLog { "ok" }
        assertEquals("ok", result)
    }

    @Test
    fun `tryOrLog returns null on exception`() {
        val result = SafeExecutor.tryOrLog<Int> { throw RuntimeException("network error") }
        assertNull(result)
    }

    @Test
    fun `tryOrReport returns result on success`() {
        val result = SafeExecutor.tryOrReport { 99 }
        assertEquals(99, result)
    }

    @Test
    fun `tryOrReport returns null on exception`() {
        val result = SafeExecutor.tryOrReport<String> { throw RuntimeException("critical") }
        assertNull(result)
    }

    @Test
    fun `tryOrReport invokes callback on exception`() {
        var caught: Exception? = null
        SafeExecutor.tryOrReport(
            onError = { caught = it }
        ) { throw RuntimeException("boom") }
        assertNotNull(caught)
        assertEquals("boom", caught!!.message)
    }

    @Test
    fun `tryOrReport does not invoke callback on success`() {
        var called = false
        val result = SafeExecutor.tryOrReport(
            onError = { called = true }
        ) { "ok" }
        assertEquals("ok", result)
        assertFalse(called)
    }

    @Test
    fun `tryOrReport works without callback`() {
        val result = SafeExecutor.tryOrReport<String> { throw RuntimeException("no callback") }
        assertNull(result)
    }

    @Test
    fun `tryOrNull with custom tag`() {
        val result = SafeExecutor.tryOrNull("CustomTag") { throw RuntimeException("test") }
        assertNull(result)
    }

    @Test
    fun `tryOrLog with custom tag`() {
        val result = SafeExecutor.tryOrLog("NetTag") { throw RuntimeException("test") }
        assertNull(result)
    }

    @Test
    fun `tryOrNull handles nested exceptions`() {
        val result = SafeExecutor.tryOrNull {
            throw IllegalArgumentException("nested", RuntimeException("cause"))
        }
        assertNull(result)
    }
}
