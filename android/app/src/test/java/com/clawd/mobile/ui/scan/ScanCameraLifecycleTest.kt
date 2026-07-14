package com.clawd.mobile.ui.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class ScanCameraLifecycleTest {
    @Test
    fun `camera result gate queues at most one callback`() {
        val gate = CameraResultGate()
        val queued = mutableListOf<() -> Unit>()
        val delivered = mutableListOf<String>()

        assertTrue(gate.queue("first", queued::add, delivered::add))
        assertFalse(gate.queue("second", queued::add, delivered::add))
        assertEquals(emptyList<String>(), delivered)
        assertEquals(1, queued.size)

        queued.single().invoke()
        assertEquals(listOf("first"), delivered)
    }

    @Test
    fun `disposed camera result gate drops an already queued callback`() {
        val gate = CameraResultGate()
        val queued = mutableListOf<() -> Unit>()
        val delivered = mutableListOf<String>()
        assertTrue(gate.queue("late", queued::add, delivered::add))

        gate.dispose()
        queued.single().invoke()

        assertEquals(emptyList<String>(), delivered)
        assertFalse(gate.queue("later", queued::add, delivered::add))
    }

    @Test
    fun `camera binding disposal clears analyzer and unbinds exactly once`() {
        val lifecycle = CameraBindingLifecycle()
        val events = mutableListOf<String>()
        assertTrue(lifecycle.attachAnalyzer { events += "clear" })
        assertTrue(lifecycle.markBound { events += "unbind" })

        lifecycle.dispose()
        lifecycle.dispose()

        assertEquals(listOf("clear", "unbind"), events)
        assertTrue(lifecycle.isDisposed)
    }

    @Test
    fun `camera binding arriving after dispose is cleared without binding`() {
        val lifecycle = CameraBindingLifecycle()
        val events = mutableListOf<String>()
        lifecycle.dispose()

        val attached = lifecycle.attachAnalyzer { events += "clear" }

        assertFalse(attached)
        assertEquals(listOf("clear"), events)
    }

    @Test
    fun `binding completed after dispose is precisely unbound`() {
        val lifecycle = CameraBindingLifecycle()
        val events = mutableListOf<String>()
        lifecycle.dispose()

        assertFalse(lifecycle.markBound { events += "unbind-current-use-cases" })
        assertEquals(listOf("unbind-current-use-cases"), events)
    }

    @Test
    fun `dispose racing with bind completion clears and precisely unbinds once`() {
        val lifecycle = CameraBindingLifecycle()
        val events = Collections.synchronizedList(mutableListOf<String>())
        val bindStarted = CountDownLatch(1)
        val finishBind = CountDownLatch(1)
        assertTrue(lifecycle.attachAnalyzer { events += "clear" })

        val binder = thread {
            lifecycle.runIfActive {
                bindStarted.countDown()
                assertTrue(finishBind.await(5, TimeUnit.SECONDS))
                lifecycle.markBound { events += "unbind-current-use-cases" }
            }
        }
        assertTrue(bindStarted.await(5, TimeUnit.SECONDS))
        val disposer = thread { lifecycle.dispose() }
        finishBind.countDown()
        binder.join(5_000)
        disposer.join(5_000)

        assertFalse(binder.isAlive)
        assertFalse(disposer.isAlive)
        assertEquals(2, events.size)
        assertEquals(setOf("clear", "unbind-current-use-cases"), events.toSet())
    }

    @Test
    fun `duplicate relay scan has explicit non-navigation status effect`() {
        assertEquals(
            RelayScanUiEffect.DUPLICATE,
            relayScanUiEffect(RelayPairingAcceptance.DUPLICATE),
        )
    }

    @Test
    fun `camera provider initialization failure is contained`() {
        val provider = cameraProviderOrNull<String> { error("provider unavailable") }

        assertEquals(null, provider)
    }
}
