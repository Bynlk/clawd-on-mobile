package com.clawd.mobile.ws

/** Info about a server certificate pending user confirmation (TOFU). */
data class CertFingerprintInfo(val host: String, val fingerprint: String)
