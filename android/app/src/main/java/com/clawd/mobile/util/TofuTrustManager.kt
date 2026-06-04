package com.clawd.mobile.util

import android.annotation.SuppressLint
import android.util.Log
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/**
 * Trust-On-First-Use (TOFU) certificate trust manager for LAN connections.
 *
 * Behavior:
 * - **No pinned fingerprint** (first connection): Accepts any certificate but remembers
 *   the leaf cert's SHA-256 fingerprint as "accepted" (one-time, consumed on first use).
 * - **Pinned fingerprint set**: Only accepts certificates whose SHA-256 fingerprint matches
 *   the pinned value. Rejects all others with [CertificateException].
 *
 * This replaces the previous trust-all X509TrustManager that silently accepted any cert,
 * eliminating MITM risk after the initial TOFU confirmation.
 */
@SuppressLint("CustomX509TrustManager")
class TofuTrustManager : X509TrustManager {

    companion object {
        private const val TAG = "TofuTrustManager"
    }

    @Volatile
    private var pinnedFingerprint: String? = null

    /** Temporarily stores the first-connection cert fingerprint (consumed on first use). */
    @Volatile
    private var acceptedFingerprint: String? = null

    /**
     * Set the pinned SHA-256 fingerprint (colon-separated uppercase hex).
     * Called after TOFU user confirmation or when loading a previously saved fingerprint.
     * Also clears any one-time accepted fingerprint.
     */
    fun pinFingerprint(sha256: String?) {
        pinnedFingerprint = sha256
        acceptedFingerprint = null
    }

    /**
     * Returns the one-time accepted fingerprint from the first TOFU connection,
     * or null if no first connection has occurred yet.
     * The value is NOT consumed — use [consumeAcceptedFingerprint] for that.
     */
    fun getAcceptedFingerprint(): String? = acceptedFingerprint

    /**
     * Returns and clears the one-time accepted fingerprint.
     * Returns null if already consumed or not yet set.
     */
    fun consumeAcceptedFingerprint(): String? {
        val fp = acceptedFingerprint
        acceptedFingerprint = null
        return fp
    }

    @SuppressLint("TrustAllX509TrustManager")
    @Throws(CertificateException::class)
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        if (chain.isEmpty()) throw CertificateException("Empty certificate chain")

        val cert = chain[0]
        val fingerprint = fingerprintOf(cert)

        val pinned = pinnedFingerprint
        if (pinned != null) {
            // Pinned mode: strict match required
            if (!fingerprint.equals(pinned, ignoreCase = true)) {
                Log.w(TAG, "Certificate mismatch! Expected=${pinned.take(11)}..., Got=${fingerprint.take(11)}...")
                throw CertificateException(
                    "Server certificate does not match pinned fingerprint. " +
                    "Possible MITM attack or server certificate changed."
                )
            }
            Log.d(TAG, "Certificate matches pinned fingerprint")
        } else {
            // First connection: accept and remember (one-time TOFU)
            Log.i(TAG, "TOFU first connection: accepting cert ${fingerprint.take(11)}... from ${cert.subjectDN}")
            acceptedFingerprint = fingerprint
        }
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        // Client cert auth not used — no-op
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()

    private fun fingerprintOf(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(cert.encoded)
        return hash.joinToString(":") { "%02X".format(it) }
    }
}
