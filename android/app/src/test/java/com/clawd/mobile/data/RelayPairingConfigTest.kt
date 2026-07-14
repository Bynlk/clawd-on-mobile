package com.clawd.mobile.data

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RelayPairingConfigTest {
    private val privateKey = Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    private val publicKey = Base64.getEncoder().encodeToString(ByteArray(32) { 8 })
    private val token = "ab".repeat(32)

    private fun json(
        version: String = "1",
        name: String = "Android fixture",
        privateKey: String = this.privateKey,
        address: String = "10.8.0.3/32",
        publicKey: String = this.publicKey,
        endpoint: String = "198.51.100.7:51820",
        allowedIps: String = "[\"10.8.0.0/24\"]",
        keepalive: String = "25",
        relayUrl: String = "ws://10.8.0.1:7891",
        token: String = this.token,
        issuedAt: String = "1783900800000",
    ): String = """{"version":$version,"name":"$name","wireGuard":{"privateKey":"$privateKey","address":"$address","serverPublicKey":"$publicKey","endpoint":"$endpoint","allowedIps":$allowedIps,"persistentKeepalive":$keepalive},"relay":{"url":"$relayUrl","token":"$token"},"issuedAt":$issuedAt}"""

    private fun uri(payload: String = json(), queryVersion: String = "1"): String {
        val data = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray(Charsets.UTF_8))
        return "clawd://relay-pair?v=$queryVersion&data=$data"
    }

    private fun assertError(code: RelayPairingErrorCode, value: String) {
        try {
            RelayPairingConfig.parse(value)
            fail("expected $code")
        } catch (error: RelayPairingException) {
            assertEquals(code, error.code)
            assertEquals(code.wireCode, error.message)
            assertFalse(error.toString().contains(value))
            assertFalse(error.toString().contains(privateKey))
            assertFalse(error.toString().contains(token))
        }
    }

    @Test
    fun `parses approved version one model field by field`() {
        val config = RelayPairingConfig.parse(uri())

        assertEquals(1, config.version)
        assertEquals("Android fixture", config.name)
        assertEquals(privateKey, config.wireGuard.privateKey)
        assertEquals("10.8.0.3/32", config.wireGuard.address)
        assertEquals(publicKey, config.wireGuard.serverPublicKey)
        assertEquals("198.51.100.7:51820", config.wireGuard.endpoint)
        assertEquals(listOf("10.8.0.0/24"), config.wireGuard.allowedIps)
        assertEquals(25, config.wireGuard.persistentKeepalive)
        assertEquals("ws://10.8.0.1:7891", config.relay.url)
        assertEquals(token, config.relay.token)
        assertEquals(1_783_900_800_000, config.issuedAt)
    }

    @Test
    fun `rejects noncanonical URI components and query fields`() {
        val valid = uri()
        val data = valid.substringAfter("&data=")
        assertError(RelayPairingErrorCode.INVALID_URI, valid.replaceFirst("clawd", "CLAWD"))
        assertError(RelayPairingErrorCode.INVALID_URI, valid.replace("relay-pair", "Relay-Pair"))
        assertError(RelayPairingErrorCode.INVALID_URI, "clawd://user@relay-pair?v=1&data=$data")
        assertError(RelayPairingErrorCode.INVALID_URI, "$valid#fragment")
        assertError(RelayPairingErrorCode.DUPLICATE_QUERY, "clawd://relay-pair?v=1&v=1&data=$data")
        assertError(RelayPairingErrorCode.DUPLICATE_QUERY, "clawd://relay-pair?v=1&data=$data&data=$data")
        assertError(RelayPairingErrorCode.UNKNOWN_QUERY, "$valid&extra=1")
        assertError(RelayPairingErrorCode.MISSING_FIELD, "clawd://relay-pair?v=1")
        assertError(RelayPairingErrorCode.MISSING_FIELD, "clawd://relay-pair?data=$data")
    }

    @Test
    fun `rejects unknown query and payload versions with one stable code`() {
        assertError(RelayPairingErrorCode.UNSUPPORTED_VERSION, uri(queryVersion = "2"))
        assertError(RelayPairingErrorCode.UNSUPPORTED_VERSION, uri(json(version = "2")))
        assertError(RelayPairingErrorCode.WRONG_TYPE, uri(json(version = "\"1\"")))
    }

    @Test
    fun `rejects noncanonical base64url and oversize inputs`() {
        val valid = uri()
        assertError(RelayPairingErrorCode.NON_CANONICAL_PAYLOAD, "$valid=")
        assertError(RelayPairingErrorCode.INVALID_URI, valid + "x".repeat(8192))
        assertError(
            RelayPairingErrorCode.FIELD_TOO_LONG,
            uri(json(name = "x".repeat(101))),
        )
    }

    @Test
    fun `rejects trailing unknown and duplicate JSON fields`() {
        assertError(RelayPairingErrorCode.INVALID_JSON, uri(json() + " "))
        assertError(
            RelayPairingErrorCode.UNKNOWN_FIELD,
            uri(json().replaceFirst("{", "{\"unknown\":true,")),
        )
        assertError(
            RelayPairingErrorCode.DUPLICATE_JSON_KEY,
            uri(json().replaceFirst("{", "{\"name\":\"duplicate\",")),
        )
        assertError(
            RelayPairingErrorCode.DUPLICATE_JSON_KEY,
            uri(json().replace("\"address\":", "\"\\u0061ddress\":\"10.8.0.3/32\",\"address\":")),
        )
    }

    @Test
    fun `missing field and wrong type have stable typed errors`() {
        assertError(RelayPairingErrorCode.WRONG_TYPE, uri("[]"))
        assertError(
            RelayPairingErrorCode.MISSING_FIELD,
            uri(json().replace("\"issuedAt\":1783900800000", "\"notIssuedAt\":1783900800000")),
        )
        assertError(RelayPairingErrorCode.WRONG_TYPE, uri(json(issuedAt = "\"1783900800000\"")))
        assertError(RelayPairingErrorCode.WRONG_TYPE, uri(json(allowedIps = "\"10.8.0.0/24\"")))
        assertError(RelayPairingErrorCode.WRONG_TYPE, uri(json(keepalive = "25.0")))
    }

    @Test
    fun `validates canonical nonzero distinct WireGuard keys`() {
        val zero = Base64.getEncoder().encodeToString(ByteArray(32))
        assertError(RelayPairingErrorCode.INVALID_WIREGUARD_KEY, uri(json(privateKey = zero)))
        assertError(RelayPairingErrorCode.INVALID_WIREGUARD_KEY, uri(json(privateKey = privateKey.dropLast(1) + "A")))
        assertError(RelayPairingErrorCode.INVALID_WIREGUARD_KEY, uri(json(publicKey = privateKey)))
    }

    @Test
    fun `requires exact private subnet topology and relay server address`() {
        for (value in listOf("10.8.0.4/32", "8.8.8.3/32", "10.8.0.3/24")) {
            assertError(RelayPairingErrorCode.INVALID_TOPOLOGY, uri(json(address = value)))
        }
        for (value in listOf("[\"10.8.1.0/24\"]", "[\"0.0.0.0/0\"]", "[\"8.8.8.0/24\"]", "[\"10.8.0.0/24\",\"10.9.0.0/24\"]")) {
            assertError(RelayPairingErrorCode.INVALID_TOPOLOGY, uri(json(allowedIps = value)))
        }
        for (value in listOf("ws://10.8.0.2:7891", "ws://10.8.0.1:7892", "wss://10.8.0.1:7891", "ws://10.8.0.1:7891/extra")) {
            assertError(RelayPairingErrorCode.INVALID_RELAY_URL, uri(json(relayUrl = value)))
        }
    }

    @Test
    fun `accepts legal endpoint forms and rejects ambiguous hosts or ports`() {
        for (endpoint in listOf("relay.example.test:1", "192.0.2.4:65535", "[2001:db8::1]:51820")) {
            assertEquals(endpoint, RelayPairingConfig.parse(uri(json(endpoint = endpoint))).wireGuard.endpoint)
        }
        for (endpoint in listOf("bad_host:51820", "2001:db8::1:51820", "[not::ip]:51820", "example.test:0", "example.test:65536", "user@example.test:22")) {
            assertError(RelayPairingErrorCode.INVALID_ENDPOINT, uri(json(endpoint = endpoint)))
        }
    }

    @Test
    fun `keepalive is bounded and relay token is exactly 64 hexadecimal characters`() {
        assertEquals(1, RelayPairingConfig.parse(uri(json(keepalive = "1"))).wireGuard.persistentKeepalive)
        assertEquals(120, RelayPairingConfig.parse(uri(json(keepalive = "120"))).wireGuard.persistentKeepalive)
        assertEquals("AB".repeat(32), RelayPairingConfig.parse(uri(json(token = "AB".repeat(32)))).relay.token)
        assertError(RelayPairingErrorCode.INVALID_KEEPALIVE, uri(json(keepalive = "0")))
        assertError(RelayPairingErrorCode.INVALID_KEEPALIVE, uri(json(keepalive = "121")))
        assertError(RelayPairingErrorCode.INVALID_RELAY_TOKEN, uri(json(token = "zz".repeat(32))))
        assertError(RelayPairingErrorCode.INVALID_RELAY_TOKEN, uri(json(token = "ab".repeat(31))))
    }

    @Test
    fun `all model toString values redact pairing secrets`() {
        val config = RelayPairingConfig.parse(uri())
        for (text in listOf(config.toString(), config.wireGuard.toString(), config.relay.toString())) {
            assertFalse(text.contains(privateKey))
            assertFalse(text.contains(publicKey))
            assertFalse(text.contains(token))
            assertTrue(text.contains("REDACTED"))
        }
    }
}
