package com.clawd.mobile.util

import okhttp3.Response
import java.security.MessageDigest
import java.security.cert.X509Certificate

/**
 * Extracts server certificate fingerprints for TOFU (Trust-On-First-Use) pinning.
 */
object CertificateVerifier {

    /**
     * Extract the SHA-256 fingerprint of the server's leaf certificate from [response].
     * Returns a colon-separated uppercase hex string (e.g. "AB:CD:EF:..."), or null
     * if the handshake/chain is unavailable.
     */
    fun extractFingerprint(response: Response): String? {
        val handshake = response.handshake ?: return null
        val cert = handshake.peerCertificates.firstOrNull() as? X509Certificate
            ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(cert.encoded)
        return hash.joinToString(":") { "%02X".format(it) }
    }
}
