package com.clawd.mobile.util

import io.mockk.every
import io.mockk.mockk
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.security.cert.CertificateException
import java.security.cert.X509Certificate

class TofuTrustManagerTest {

    private lateinit var manager: TofuTrustManager

    @Before
    fun setup() {
        manager = TofuTrustManager()
    }

    /** Creates a mock X509Certificate with deterministic encoded bytes. */
    private fun mockCert(encodedSeed: Byte): X509Certificate {
        return mockk<X509Certificate> {
            every { encoded } returns ByteArray(32) { encodedSeed }
            every { subjectDN } returns javax.security.auth.x500.X500Principal("CN=test")
        }
    }

    @Test
    fun `first connection accepts any cert and stores fingerprint`() {
        val cert = mockCert(0x01)
        manager.checkServerTrusted(arrayOf(cert), "RSA")
        val fp = manager.getAcceptedFingerprint()
        assertNotNull("Should store accepted fingerprint on first connection", fp)
        assertTrue("Fingerprint should be colon-separated hex", fp!!.matches(Regex("[0-9A-F:]+")))
    }

    @Test
    fun `pinned fingerprint accepts matching cert`() {
        val cert = mockCert(0x01)
        // First connection to get the fingerprint
        manager.checkServerTrusted(arrayOf(cert), "RSA")
        val fp = manager.consumeAcceptedFingerprint()!!

        // Pin the fingerprint
        manager.pinFingerprint(fp)

        // Second connection with same cert should succeed
        manager.checkServerTrusted(arrayOf(cert), "RSA")
    }

    @Test(expected = CertificateException::class)
    fun `pinned fingerprint rejects different cert`() {
        val cert1 = mockCert(0x01)
        val cert2 = mockCert(0x02)

        // Pin cert1's fingerprint
        manager.checkServerTrusted(arrayOf(cert1), "RSA")
        val fp = manager.consumeAcceptedFingerprint()!!
        manager.pinFingerprint(fp)

        // Connection with cert2 should throw
        manager.checkServerTrusted(arrayOf(cert2), "RSA")
    }

    @Test
    fun `consumeAcceptedFingerprint returns and clears`() {
        val cert = mockCert(0x01)
        manager.checkServerTrusted(arrayOf(cert), "RSA")

        val fp1 = manager.consumeAcceptedFingerprint()
        assertNotNull(fp1)

        val fp2 = manager.consumeAcceptedFingerprint()
        assertNull("Should be cleared after consume", fp2)
    }

    @Test
    fun `pinFingerprint clears accepted fingerprint`() {
        val cert = mockCert(0x01)
        manager.checkServerTrusted(arrayOf(cert), "RSA")
        assertNotNull(manager.getAcceptedFingerprint())

        manager.pinFingerprint("AB:CD:EF")
        assertNull("pinFingerprint should clear accepted", manager.getAcceptedFingerprint())
    }

    @Test(expected = CertificateException::class)
    fun `empty chain throws CertificateException`() {
        manager.checkServerTrusted(emptyArray(), "RSA")
    }

    @Test
    fun `getAcceptedIssuers returns empty array`() {
        assertEquals(0, manager.acceptedIssuers.size)
    }

    @Test
    fun `checkClientTrusted does not throw`() {
        // Should be a no-op, not throw
        manager.checkClientTrusted(emptyArray(), "RSA")
    }

    @Test
    fun `case insensitive fingerprint comparison`() {
        val cert = mockCert(0x01)
        manager.checkServerTrusted(arrayOf(cert), "RSA")
        val fp = manager.consumeAcceptedFingerprint()!!

        // Pin with lowercase
        manager.pinFingerprint(fp.lowercase())

        // Should still accept (case-insensitive comparison)
        manager.checkServerTrusted(arrayOf(cert), "RSA")
    }

    @Test
    fun `second connection without pin stores accepted fingerprint`() {
        val cert1 = mockCert(0x01)
        val cert2 = mockCert(0x02)

        // First connection
        manager.checkServerTrusted(arrayOf(cert1), "RSA")
        val fp1 = manager.consumeAcceptedFingerprint()
        assertNotNull(fp1)

        // Second connection with different cert (no pin set) — should accept and store new fp
        manager.checkServerTrusted(arrayOf(cert2), "RSA")
        val fp2 = manager.getAcceptedFingerprint()
        assertNotNull(fp2)
        assertNotEquals("Different cert should produce different fingerprint", fp1, fp2)
    }
}
