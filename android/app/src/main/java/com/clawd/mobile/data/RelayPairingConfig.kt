package com.clawd.mobile.data

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

enum class RelayPairingErrorCode(val wireCode: String) {
    INVALID_URI("pairing_invalid_uri"),
    DUPLICATE_QUERY("pairing_duplicate_query"),
    UNKNOWN_QUERY("pairing_unknown_query"),
    UNSUPPORTED_VERSION("pairing_unsupported_version"),
    MISSING_FIELD("pairing_missing_field"),
    WRONG_TYPE("pairing_wrong_type"),
    NON_CANONICAL_PAYLOAD("pairing_noncanonical_payload"),
    INVALID_JSON("pairing_invalid_json"),
    DUPLICATE_JSON_KEY("pairing_duplicate_json_key"),
    UNKNOWN_FIELD("pairing_unknown_field"),
    FIELD_TOO_LONG("pairing_field_too_long"),
    INVALID_WIREGUARD_KEY("pairing_invalid_wireguard_key"),
    INVALID_TOPOLOGY("pairing_invalid_topology"),
    INVALID_ENDPOINT("pairing_invalid_endpoint"),
    INVALID_KEEPALIVE("pairing_invalid_keepalive"),
    INVALID_RELAY_URL("pairing_invalid_relay_url"),
    INVALID_RELAY_TOKEN("pairing_invalid_relay_token"),
    INVALID_ISSUED_AT("pairing_invalid_issued_at"),
    STORAGE_FAILED("pairing_storage_failed"),
}

class RelayPairingException(
    val code: RelayPairingErrorCode,
) : IllegalArgumentException(code.wireCode) {
    override fun toString(): String = "RelayPairingException(code=${code.wireCode})"
}

@ConsistentCopyVisibility
data class RelayWireGuardConfig internal constructor(
    val privateKey: String,
    val address: String,
    val serverPublicKey: String,
    val endpoint: String,
    val allowedIps: List<String>,
    val persistentKeepalive: Int,
) {
    override fun toString(): String =
        "RelayWireGuardConfig(privateKey=REDACTED, address=$address, " +
            "serverPublicKey=REDACTED, endpoint=$endpoint, allowedIps=$allowedIps, " +
            "persistentKeepalive=$persistentKeepalive)"
}

@ConsistentCopyVisibility
data class RelayConnectionConfig internal constructor(
    val url: String,
    val token: String,
) {
    override fun toString(): String = "RelayConnectionConfig(url=$url, token=REDACTED)"
}

@ConsistentCopyVisibility
data class RelayPairingConfig internal constructor(
    val version: Int,
    val name: String,
    val wireGuard: RelayWireGuardConfig,
    val relay: RelayConnectionConfig,
    val issuedAt: Long,
) {
    override fun toString(): String =
        "RelayPairingConfig(version=$version, name=$name, wireGuard=REDACTED, " +
            "relay=REDACTED, issuedAt=$issuedAt)"

    @OptIn(ExperimentalSerializationApi::class)
    companion object {
        const val CURRENT_VERSION = 1
        const val MAX_URI_BYTES = 8 * 1024
        private const val MAX_JSON_BYTES = 6 * 1024
        private const val MAX_NAME_LENGTH = 100
        private const val MAX_ENDPOINT_LENGTH = 255
        private const val MAX_SAFE_JS_INTEGER = 9_007_199_254_740_991L

        private val strictJson = Json {
            ignoreUnknownKeys = false
            explicitNulls = false
            isLenient = false
            allowTrailingComma = false
        }

        private val base64UrlPattern = Regex("^[A-Za-z0-9_-]+$")
        private val base64KeyPattern = Regex("^[A-Za-z0-9+/]{43}=$")
        private val relayTokenPattern = Regex("^[0-9A-Fa-f]{64}$")
        private val domainLabelPattern = Regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
        private val controlPattern = Regex("[\\u0000-\\u001f\\u007f]")

        fun parse(rawUri: String): RelayPairingConfig {
            if (rawUri.toByteArray(StandardCharsets.UTF_8).size > MAX_URI_BYTES) {
                invalid(RelayPairingErrorCode.INVALID_URI)
            }

            val uri = try {
                URI(rawUri)
            } catch (_: Exception) {
                invalid(RelayPairingErrorCode.INVALID_URI)
            }
            if (uri.scheme != "clawd" || uri.rawAuthority != "relay-pair" ||
                uri.rawUserInfo != null || uri.port != -1 || uri.rawPath.orEmpty().isNotEmpty() ||
                uri.rawFragment != null
            ) {
                invalid(RelayPairingErrorCode.INVALID_URI)
            }

            val query = parseQuery(uri.rawQuery)
            val queryVersion = query["v"] ?: invalid(RelayPairingErrorCode.MISSING_FIELD)
            val encoded = query["data"] ?: invalid(RelayPairingErrorCode.MISSING_FIELD)
            if (queryVersion != CURRENT_VERSION.toString()) {
                invalid(RelayPairingErrorCode.UNSUPPORTED_VERSION)
            }
            val canonicalUri = "clawd://relay-pair?v=$queryVersion&data=$encoded"
            if (rawUri != canonicalUri) invalid(RelayPairingErrorCode.INVALID_URI)
            if (encoded.isEmpty() || encoded.length > MAX_URI_BYTES || !base64UrlPattern.matches(encoded)) {
                invalid(RelayPairingErrorCode.NON_CANONICAL_PAYLOAD)
            }

            val jsonBytes = try {
                Base64.getUrlDecoder().decode(encoded)
            } catch (_: IllegalArgumentException) {
                invalid(RelayPairingErrorCode.NON_CANONICAL_PAYLOAD)
            }
            if (jsonBytes.size > MAX_JSON_BYTES ||
                Base64.getUrlEncoder().withoutPadding().encodeToString(jsonBytes) != encoded
            ) {
                invalid(RelayPairingErrorCode.NON_CANONICAL_PAYLOAD)
            }
            val jsonText = decodeUtf8(jsonBytes)
            DuplicateJsonKeyScanner(jsonText, strictJson).scan()

            val rootElement = try {
                strictJson.parseToJsonElement(jsonText)
            } catch (_: Exception) {
                invalid(RelayPairingErrorCode.INVALID_JSON)
            }
            val root = rootElement as? JsonObject ?: invalid(RelayPairingErrorCode.WRONG_TYPE)
            validateJsonTypes(root)
            val dto = try {
                strictJson.decodeFromString<RelayPairingDto>(jsonText)
            } catch (_: Exception) {
                invalid(RelayPairingErrorCode.INVALID_JSON)
            }
            if (strictJson.encodeToString(dto) != jsonText) {
                invalid(RelayPairingErrorCode.INVALID_JSON)
            }
            return validateDto(dto)
        }

        internal fun encodeStorage(config: RelayPairingConfig): String = strictJson.encodeToString(
            StoredRelayPairing(
                storageVersion = 1,
                pairing = config.toDto(),
            ),
        )

        /** Stable semantic identity independent of URI text and JSON/storage key order. */
        internal fun semanticFingerprint(config: RelayPairingConfig): String {
            val digest = MessageDigest.getInstance("SHA-256")
            fun addInt(value: Int) {
                digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(value).array())
            }
            fun addLong(value: Long) {
                digest.update(ByteBuffer.allocate(Long.SIZE_BYTES).putLong(value).array())
            }
            fun addString(value: String) {
                val bytes = value.toByteArray(StandardCharsets.UTF_8)
                addInt(bytes.size)
                digest.update(bytes)
            }

            addInt(config.version)
            addString(config.name)
            addString(config.wireGuard.privateKey)
            addString(config.wireGuard.address)
            addString(config.wireGuard.serverPublicKey)
            addString(config.wireGuard.endpoint)
            addInt(config.wireGuard.allowedIps.size)
            config.wireGuard.allowedIps.forEach(::addString)
            addInt(config.wireGuard.persistentKeepalive)
            addString(config.relay.url)
            addString(config.relay.token)
            addLong(config.issuedAt)
            val hex = "0123456789abcdef"
            return buildString(64) {
                for (byte in digest.digest()) {
                    val value = byte.toInt() and 0xff
                    append(hex[value ushr 4])
                    append(hex[value and 0x0f])
                }
            }
        }

        internal fun decodeStorage(blob: String): RelayPairingConfig {
            if (blob.toByteArray(StandardCharsets.UTF_8).size > MAX_JSON_BYTES) {
                invalid(RelayPairingErrorCode.INVALID_JSON)
            }
            DuplicateJsonKeyScanner(blob, strictJson).scan()
            val stored = try {
                strictJson.decodeFromString<StoredRelayPairing>(blob)
            } catch (_: Exception) {
                invalid(RelayPairingErrorCode.INVALID_JSON)
            }
            if (stored.storageVersion != 1) invalid(RelayPairingErrorCode.UNSUPPORTED_VERSION)
            if (strictJson.encodeToString(stored) != blob) invalid(RelayPairingErrorCode.INVALID_JSON)
            return validateDto(stored.pairing)
        }

        private fun parseQuery(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrEmpty()) invalid(RelayPairingErrorCode.MISSING_FIELD)
            val result = linkedMapOf<String, String>()
            for (part in rawQuery.split('&')) {
                val separator = part.indexOf('=')
                if (separator <= 0) {
                    invalid(RelayPairingErrorCode.INVALID_URI)
                }
                val key = part.substring(0, separator)
                val value = part.substring(separator + 1)
                if (key != "v" && key != "data") invalid(RelayPairingErrorCode.UNKNOWN_QUERY)
                if (result.put(key, value) != null) invalid(RelayPairingErrorCode.DUPLICATE_QUERY)
            }
            return result
        }

        private fun decodeUtf8(bytes: ByteArray): String = try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: Exception) {
            invalid(RelayPairingErrorCode.INVALID_JSON)
        }

        private fun validateJsonTypes(root: JsonObject) {
            requireFields(root, setOf("version", "name", "wireGuard", "relay", "issuedAt"))
            requireInteger(root.getValue("version"))
            requireString(root.getValue("name"))
            requireInteger(root.getValue("issuedAt"))

            val wireGuard = requireObject(root.getValue("wireGuard"))
            requireFields(
                wireGuard,
                setOf("privateKey", "address", "serverPublicKey", "endpoint", "allowedIps", "persistentKeepalive"),
            )
            for (field in listOf("privateKey", "address", "serverPublicKey", "endpoint")) {
                requireString(wireGuard.getValue(field))
            }
            val allowedIps = wireGuard.getValue("allowedIps") as? JsonArray
                ?: invalid(RelayPairingErrorCode.WRONG_TYPE)
            allowedIps.forEach(::requireString)
            requireInteger(wireGuard.getValue("persistentKeepalive"))

            val relay = requireObject(root.getValue("relay"))
            requireFields(relay, setOf("url", "token"))
            requireString(relay.getValue("url"))
            requireString(relay.getValue("token"))
        }

        private fun requireFields(value: JsonObject, expected: Set<String>) {
            if (!value.keys.containsAll(expected)) invalid(RelayPairingErrorCode.MISSING_FIELD)
            if (value.keys.any { it !in expected }) invalid(RelayPairingErrorCode.UNKNOWN_FIELD)
        }

        private fun requireObject(value: JsonElement): JsonObject =
            value as? JsonObject ?: invalid(RelayPairingErrorCode.WRONG_TYPE)

        private fun requireString(value: JsonElement) {
            if (value !is JsonPrimitive || !value.isString) invalid(RelayPairingErrorCode.WRONG_TYPE)
        }

        private fun requireInteger(value: JsonElement) {
            if (value !is JsonPrimitive || value.isString || value.longOrNull == null ||
                value.content.contains('.') || value.content.contains('e', ignoreCase = true)
            ) {
                invalid(RelayPairingErrorCode.WRONG_TYPE)
            }
        }

        private fun validateDto(dto: RelayPairingDto): RelayPairingConfig {
            if (dto.version != CURRENT_VERSION) invalid(RelayPairingErrorCode.UNSUPPORTED_VERSION)
            if (dto.name.isEmpty() || dto.name.length > MAX_NAME_LENGTH) {
                invalid(RelayPairingErrorCode.FIELD_TOO_LONG)
            }
            if (controlPattern.containsMatchIn(dto.name)) invalid(RelayPairingErrorCode.INVALID_JSON)
            if (dto.wireGuard.endpoint.length > MAX_ENDPOINT_LENGTH ||
                dto.wireGuard.address.length > 18 || dto.wireGuard.allowedIps.any { it.length > 18 } ||
                dto.relay.url.length > 128 || dto.relay.token.length > 64 ||
                dto.wireGuard.privateKey.length > 44 || dto.wireGuard.serverPublicKey.length > 44
            ) {
                invalid(RelayPairingErrorCode.FIELD_TOO_LONG)
            }
            if (!canonicalKey(dto.wireGuard.privateKey) || !canonicalKey(dto.wireGuard.serverPublicKey) ||
                dto.wireGuard.privateKey == dto.wireGuard.serverPublicKey
            ) {
                invalid(RelayPairingErrorCode.INVALID_WIREGUARD_KEY)
            }
            if (!validEndpoint(dto.wireGuard.endpoint)) invalid(RelayPairingErrorCode.INVALID_ENDPOINT)
            if (dto.wireGuard.persistentKeepalive != 25) {
                invalid(RelayPairingErrorCode.INVALID_KEEPALIVE)
            }
            val prefix = validateTopology(dto.wireGuard.address, dto.wireGuard.allowedIps)
            val expectedRelayUrl = "ws://$prefix.1:7891"
            if (dto.relay.url != expectedRelayUrl) invalid(RelayPairingErrorCode.INVALID_RELAY_URL)
            if (!relayTokenPattern.matches(dto.relay.token)) {
                invalid(RelayPairingErrorCode.INVALID_RELAY_TOKEN)
            }
            if (dto.issuedAt <= 0 || dto.issuedAt > MAX_SAFE_JS_INTEGER) {
                invalid(RelayPairingErrorCode.INVALID_ISSUED_AT)
            }
            return RelayPairingConfig(
                version = dto.version,
                name = dto.name,
                wireGuard = RelayWireGuardConfig(
                    privateKey = dto.wireGuard.privateKey,
                    address = dto.wireGuard.address,
                    serverPublicKey = dto.wireGuard.serverPublicKey,
                    endpoint = dto.wireGuard.endpoint,
                    allowedIps = dto.wireGuard.allowedIps.toList(),
                    persistentKeepalive = dto.wireGuard.persistentKeepalive,
                ),
                relay = RelayConnectionConfig(dto.relay.url, dto.relay.token),
                issuedAt = dto.issuedAt,
            )
        }

        private fun canonicalKey(value: String): Boolean {
            if (!base64KeyPattern.matches(value)) return false
            val decoded = try {
                Base64.getDecoder().decode(value)
            } catch (_: IllegalArgumentException) {
                return false
            }
            return decoded.size == 32 && decoded.any { it.toInt() != 0 } &&
                Base64.getEncoder().encodeToString(decoded) == value
        }

        private fun validateTopology(address: String, allowedIps: List<String>): String {
            if (allowedIps.size != 1) invalid(RelayPairingErrorCode.INVALID_TOPOLOGY)
            val allowed = Regex("^(\\d{1,3}(?:\\.\\d{1,3}){3})/24$")
                .matchEntire(allowedIps.single())
                ?: invalid(RelayPairingErrorCode.INVALID_TOPOLOGY)
            val network = parseIpv4(allowed.groupValues[1])
                ?: invalid(RelayPairingErrorCode.INVALID_TOPOLOGY)
            if (!isPrivateIpv4(network) || network[3] != 0) {
                invalid(RelayPairingErrorCode.INVALID_TOPOLOGY)
            }
            val prefix = network.take(3).joinToString(".")
            if (address != "$prefix.3/32") invalid(RelayPairingErrorCode.INVALID_TOPOLOGY)
            return prefix
        }

        private fun validEndpoint(value: String): Boolean {
            if (value.isEmpty() || value.length > MAX_ENDPOINT_LENGTH || controlPattern.containsMatchIn(value)) {
                return false
            }
            val host: String
            val portText: String
            if (value.startsWith('[')) {
                val close = value.indexOf(']')
                if (close < 2 || close + 1 >= value.length || value[close + 1] != ':' ||
                    value.indexOf('[', 1) >= 0 || value.indexOf(']', close + 1) >= 0
                ) return false
                host = value.substring(1, close)
                portText = value.substring(close + 2)
                if ('%' in host || !isIpv6(host)) return false
            } else {
                val separator = value.lastIndexOf(':')
                if (separator < 1 || value.indexOf(':') != separator) return false
                host = value.substring(0, separator)
                portText = value.substring(separator + 1)
                if (parseIpv4(host) == null) {
                    if (host.length > 253 || host.split('.').any { !domainLabelPattern.matches(it) }) return false
                }
            }
            if (!Regex("^[1-9]\\d{0,4}$").matches(portText)) return false
            return (portText.toIntOrNull() ?: return false) <= 65535
        }

        private fun parseIpv4(value: String): List<Int>? {
            val parts = value.split('.')
            if (parts.size != 4) return null
            return parts.map { part ->
                if (!Regex("^(0|[1-9]\\d{0,2})$").matches(part)) return null
                part.toIntOrNull()?.takeIf { it in 0..255 } ?: return null
            }
        }

        private fun isPrivateIpv4(octets: List<Int>): Boolean =
            octets[0] == 10 ||
                (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168)

        private fun isIpv6(value: String): Boolean {
            if (!value.contains(':') || value.contains('%')) return false
            return try {
                when (InetAddress.getByName(value)) {
                    is Inet6Address -> true
                    // The JDK collapses valid IPv4-mapped IPv6 text to Inet4Address.
                    is Inet4Address -> true
                    else -> false
                }
            } catch (_: Exception) {
                false
            }
        }

        private fun RelayPairingConfig.toDto() = RelayPairingDto(
            version = version,
            name = name,
            wireGuard = WireGuardDto(
                privateKey = wireGuard.privateKey,
                address = wireGuard.address,
                serverPublicKey = wireGuard.serverPublicKey,
                endpoint = wireGuard.endpoint,
                allowedIps = wireGuard.allowedIps,
                persistentKeepalive = wireGuard.persistentKeepalive,
            ),
            relay = RelayDto(relay.url, relay.token),
            issuedAt = issuedAt,
        )

        private fun invalid(code: RelayPairingErrorCode): Nothing = throw RelayPairingException(code)
    }
}

@Serializable
private data class RelayPairingDto(
    val version: Int,
    val name: String,
    val wireGuard: WireGuardDto,
    val relay: RelayDto,
    val issuedAt: Long,
)

@Serializable
private data class WireGuardDto(
    val privateKey: String,
    val address: String,
    val serverPublicKey: String,
    val endpoint: String,
    val allowedIps: List<String>,
    val persistentKeepalive: Int,
)

@Serializable
private data class RelayDto(
    val url: String,
    val token: String,
)

@Serializable
private data class StoredRelayPairing(
    val storageVersion: Int,
    val pairing: RelayPairingDto,
)

private class DuplicateJsonKeyScanner(
    private val source: String,
    private val json: Json,
) {
    private var index = 0

    fun scan() {
        parseValue(0)
        skipWhitespace()
        if (index != source.length) invalid()
    }

    private fun parseValue(depth: Int) {
        if (depth > 8) invalid()
        skipWhitespace()
        if (index >= source.length) invalid()
        when (source[index]) {
            '{' -> parseObject(depth + 1)
            '[' -> parseArray(depth + 1)
            '"' -> parseString()
            else -> parsePrimitive()
        }
    }

    private fun parseObject(depth: Int) {
        index++
        skipWhitespace()
        val keys = mutableSetOf<String>()
        if (consume('}')) return
        while (true) {
            skipWhitespace()
            if (index >= source.length || source[index] != '"') invalid()
            val keyToken = parseString()
            val key = try {
                json.decodeFromString<String>(keyToken)
            } catch (_: Exception) {
                invalid()
            }
            if (!keys.add(key)) throw RelayPairingException(RelayPairingErrorCode.DUPLICATE_JSON_KEY)
            skipWhitespace()
            if (!consume(':')) invalid()
            parseValue(depth)
            skipWhitespace()
            if (consume('}')) return
            if (!consume(',')) invalid()
        }
    }

    private fun parseArray(depth: Int) {
        index++
        skipWhitespace()
        if (consume(']')) return
        while (true) {
            parseValue(depth)
            skipWhitespace()
            if (consume(']')) return
            if (!consume(',')) invalid()
        }
    }

    private fun parseString(): String {
        val start = index
        if (!consume('"')) invalid()
        while (index < source.length) {
            when (val char = source[index++]) {
                '"' -> return source.substring(start, index)
                '\\' -> {
                    if (index >= source.length) invalid()
                    if (source[index] == 'u') {
                        index++
                        if (index + 4 > source.length ||
                            source.substring(index, index + 4).any { it.digitToIntOrNull(16) == null }
                        ) invalid()
                        index += 4
                    } else if (source[index++] !in "\"\\/bfnrt") {
                        invalid()
                    }
                }
                else -> if (char.code < 0x20) invalid()
            }
        }
        invalid()
    }

    private fun parsePrimitive() {
        val start = index
        while (index < source.length && source[index] !in charArrayOf(',', ']', '}', ' ', '\t', '\r', '\n')) {
            index++
        }
        if (index == start) invalid()
    }

    private fun skipWhitespace() {
        while (index < source.length && source[index] in charArrayOf(' ', '\t', '\r', '\n')) index++
    }

    private fun consume(expected: Char): Boolean {
        if (index >= source.length || source[index] != expected) return false
        index++
        return true
    }

    private fun invalid(): Nothing = throw RelayPairingException(RelayPairingErrorCode.INVALID_JSON)
}
