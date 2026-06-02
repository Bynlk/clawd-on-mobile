package com.clawd.mobile.util

import io.mockk.every
import io.mockk.mockk
import okhttp3.Handshake
import okhttp3.Response
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.X509Certificate

/**
 * Unit tests for [CertificateVerifier.extractFingerprint].
 */
class CertificateVerifierTest {

    private fun mockCert(encoded: ByteArray = byteArrayOf(1, 2, 3)): X509Certificate {
        val cert = mockk<X509Certificate>()
        every { cert.encoded } returns encoded
        return cert
    }

    private fun mockResponse(handshake: Handshake?): Response {
        val response = mockk<Response>()
        every { response.handshake } returns handshake
        return response
    }

    private fun mockHandshake(vararg certs: X509Certificate): Handshake {
        val handshake = mockk<Handshake>()
        every { handshake.peerCertificates } returns certs.toList()
        return handshake
    }

    /** Compute expected colon-separated hex fingerprint for given bytes. */
    private fun expectedFingerprint(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(bytes)
        return hash.joinToString(":") { "%02X".format(it) }
    }

    // ── 1. Valid certificate → returns SHA-256 fingerprint ─────────────

    @Test
    fun `valid certificate returns SHA-256 fingerprint`() {
        val certBytes = byteArrayOf(0x30, 0x82.toByte(), 0x01, 0x22) // sample DER bytes
        val cert = mockCert(certBytes)
        val handshake = mockHandshake(cert)
        val response = mockResponse(handshake)

        val result = CertificateVerifier.extractFingerprint(response)

        assertNotNull(result)
        assertEquals(expectedFingerprint(certBytes), result)
    }

    @Test
    fun `fingerprint is uppercase colon-separated hex`() {
        val certBytes = "test-certificate-data".toByteArray()
        val cert = mockCert(certBytes)
        val handshake = mockHandshake(cert)
        val response = mockResponse(handshake)

        val result = CertificateVerifier.extractFingerprint(response)!!

        // Format: XX:XX:XX:... (uppercase hex, colon-separated)
        val parts = result.split(":")
        assertTrue("Should have 32 parts (256/8)", parts.size == 32)
        parts.forEach { part ->
            assertEquals("Each part should be 2 chars", 2, part.length)
            assertTrue("Should be uppercase hex", part.all { it in '0'..'9' || it in 'A'..'F' })
        }
    }

    // ── 2. No certificate → returns null ───────────────────────────────

    @Test
    fun `null handshake returns null`() {
        val response = mockResponse(null)
        assertNull(CertificateVerifier.extractFingerprint(response))
    }

    @Test
    fun `empty peer certificates returns null`() {
        val handshake = mockHandshake() // no certs
        val response = mockResponse(handshake)
        assertNull(CertificateVerifier.extractFingerprint(response))
    }

    @Test
    fun `non-X509 certificate returns null`() {
        val handshake = mockk<Handshake>()
        every { handshake.peerCertificates } returns listOf(mockk<java.security.cert.Certificate>())
        val response = mockResponse(handshake)
        assertNull(CertificateVerifier.extractFingerprint(response))
    }

    // ── 3. Multiple certificates → only leaf (first) is used ───────────

    @Test
    fun `multiple certificates uses only the first (leaf)`() {
        val leafBytes = byteArrayOf(0x01, 0x02, 0x03)
        val intermediateBytes = byteArrayOf(0x04, 0x05, 0x06)

        val leafCert = mockCert(leafBytes)
        val intermediateCert = mockCert(intermediateBytes)

        val handshake = mockHandshake(leafCert, intermediateCert)
        val response = mockResponse(handshake)

        val result = CertificateVerifier.extractFingerprint(response)

        assertNotNull(result)
        assertEquals(expectedFingerprint(leafBytes), result)
        assertNotEquals(expectedFingerprint(intermediateBytes), result)
    }

    // ── 4. Fingerprint format is valid ─────────────────────────────────

    @Test
    fun `fingerprint is consistent for same input`() {
        val certBytes = "consistent-data".toByteArray()
        val cert = mockCert(certBytes)
        val handshake = mockHandshake(cert)
        val response = mockResponse(handshake)

        val result1 = CertificateVerifier.extractFingerprint(response)
        val result2 = CertificateVerifier.extractFingerprint(response)

        assertEquals(result1, result2)
    }

    @Test
    fun `fingerprint differs for different certificates`() {
        val cert1 = mockCert("cert-a".toByteArray())
        val cert2 = mockCert("cert-b".toByteArray())

        val result1 = CertificateVerifier.extractFingerprint(mockResponse(mockHandshake(cert1)))
        val result2 = CertificateVerifier.extractFingerprint(mockResponse(mockHandshake(cert2)))

        assertNotEquals(result1, result2)
    }
}
