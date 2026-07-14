package com.clawd.mobile.integration

import com.clawd.mobile.RelayPairingCoordinator
import com.clawd.mobile.RelayDeepLinkRouter
import com.clawd.mobile.RelayDeepLinkRoutingResult
import com.clawd.mobile.ui.scan.RelayPairingAcceptance
import com.clawd.mobile.ui.scan.ScanPayloadResult
import com.clawd.mobile.ui.scan.parseScannedPayload
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayPairingErrorCode
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Test

class RelayPairingIntegrationTest {
    private val fixtureUri = "clawd://relay-pair?v=1&data=eyJ2ZXJzaW9uIjoxLCJuYW1lIjoiQW5kcm9pZCBmaXh0dXJlIiwid2lyZUd1YXJkIjp7InByaXZhdGVLZXkiOiJCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjPSIsImFkZHJlc3MiOiIxMC44LjAuMy8zMiIsInNlcnZlclB1YmxpY0tleSI6IkNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWc9IiwiZW5kcG9pbnQiOiIxOTguNTEuMTAwLjc6NTE4MjAiLCJhbGxvd2VkSXBzIjpbIjEwLjguMC4wLzI0Il0sInBlcnNpc3RlbnRLZWVwYWxpdmUiOjI1fSwicmVsYXkiOnsidXJsIjoid3M6Ly8xMC44LjAuMTo3ODkxIiwidG9rZW4iOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIn0sImlzc3VlZEF0IjoxNzgzOTAwODAwMDAwfQ"

    @Test
    fun `Android parses the fixed URI emitted by the PC JavaScript encoder`() {
        val uri = fixtureUri
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(uri.toByteArray())
            .joinToString("") { "%02x".format(it) }
        assertEquals("6176404493ba1fc27408cfa52c0683da476ddf087dbd59556aaab10cdd96000f", digest)

        val config = RelayPairingConfig.parse(uri)
        assertEquals(1, config.version)
        assertEquals("Android fixture", config.name)
        assertEquals("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", config.wireGuard.privateKey)
        assertEquals("10.8.0.3/32", config.wireGuard.address)
        assertEquals("CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=", config.wireGuard.serverPublicKey)
        assertEquals("198.51.100.7:51820", config.wireGuard.endpoint)
        assertEquals(listOf("10.8.0.0/24"), config.wireGuard.allowedIps)
        assertEquals(25, config.wireGuard.persistentKeepalive)
        assertEquals("ws://10.8.0.1:7891", config.relay.url)
        assertEquals("ab".repeat(32), config.relay.token)
        assertEquals(1_783_900_800_000, config.issuedAt)
    }

    @Test
    fun `current PC JavaScript encoder still matches the Android fixture hash`() {
        var repositoryRoot = File(System.getProperty("user.dir") ?: error("user.dir unavailable")).canonicalFile
        while (!File(repositoryRoot, "src/wg-relay-pairing-qr.js").isFile) {
            repositoryRoot = repositoryRoot.parentFile
                ?: error("repository root not found")
        }
        val encoder = File(repositoryRoot, "src/wg-relay-pairing-qr.js")
        val script = """
            const crypto = require('node:crypto');
            const { buildPairingDeepLink } = require(process.argv[1]);
            const privateKey = Buffer.alloc(32, 7).toString('base64');
            const publicKey = Buffer.alloc(32, 8).toString('base64');
            const uri = buildPairingDeepLink({
              profile: { label: 'Android fixture', wgSubnet: '10.8.0.0/24', endpoint: '198.51.100.7:51820' },
              secrets: {
                phoneConfig: `[Interface]\nPrivateKey = ${'$'}{privateKey}\nAddress = 10.8.0.3/32\n\n[Peer]\nPublicKey = ${'$'}{publicKey}\nEndpoint = 198.51.100.7:51820\nAllowedIPs = 10.8.0.0/24\nPersistentKeepalive = 25\n`,
                relayUrl: 'ws://10.8.0.1:7891', relayToken: 'ab'.repeat(32),
              },
              issuedAt: 1783900800000,
            });
            process.stdout.write(crypto.createHash('sha256').update(uri).digest('hex'));
        """.trimIndent()
        val process = ProcessBuilder("node", "-e", script, encoder.absolutePath)
            .redirectErrorStream(true)
            .start()
        assertEquals(true, process.waitFor(10, TimeUnit.SECONDS))
        val output = process.inputStream.bufferedReader().readText().trim()
        assertEquals(0, process.exitValue())
        assertEquals("6176404493ba1fc27408cfa52c0683da476ddf087dbd59556aaab10cdd96000f", output)
    }

    @Test
    fun `scan parser distinguishes LAN relay and typed relay errors`() {
        val lan = parseScannedPayload("clawd://192.168.1.7:23334/abcdef1234567890")
        val relay = parseScannedPayload(fixtureUri)
        val invalidRelay = parseScannedPayload(fixtureUri.replace("?v=1", "?v=2"))

        assertEquals("192.168.1.7", (lan as ScanPayloadResult.Lan).config.host)
        assertEquals("Android fixture", (relay as ScanPayloadResult.Relay).config.name)
        assertEquals(
            RelayPairingErrorCode.UNSUPPORTED_VERSION,
            (invalidRelay as ScanPayloadResult.InvalidRelay).code,
        )
        assertEquals(null, parseScannedPayload("https://example.test/not-clawd"))
    }

    @Test
    fun `coordinator saves and navigates once for duplicate pairing input`() {
        val config = RelayPairingConfig.parse(fixtureUri)
        var saves = 0
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )

        assertEquals(RelayPairingAcceptance.SAVED, coordinator.accept(config))
        assertEquals(RelayPairingAcceptance.DUPLICATE, coordinator.accept(config))
        assertEquals(1, saves)
        assertEquals(1, navigations)
        assertEquals(coordinator.lastFingerprint, coordinator.lastFingerprint?.takeIf { it.length == 64 })

        val restored = RelayPairingCoordinator(
            initialFingerprint = coordinator.lastFingerprint,
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )
        assertEquals(RelayPairingAcceptance.DUPLICATE, restored.accept(config))
        assertEquals(1, saves)
        assertEquals(1, navigations)
    }

    @Test
    fun `coordinator failure does not replace prior fingerprint or navigate`() {
        val config = RelayPairingConfig.parse(fixtureUri)
        var shouldSave = false
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            initialFingerprint = "old-fingerprint",
            save = { shouldSave },
            navigateToSettings = { navigations++ },
        )

        assertEquals(RelayPairingAcceptance.STORAGE_FAILED, coordinator.accept(config))
        assertEquals("old-fingerprint", coordinator.lastFingerprint)
        assertEquals(0, navigations)

        shouldSave = true
        assertEquals(RelayPairingAcceptance.SAVED, coordinator.accept(config))
        assertEquals(1, navigations)
    }

    @Test
    fun `deep link router never starts LAN connection for relay or invalid pairing`() {
        var relaySaves = 0
        var lanSaves = 0
        var lanStarts = 0
        val coordinator = RelayPairingCoordinator(
            save = { relaySaves++; true },
            navigateToSettings = {},
        )
        val router = RelayDeepLinkRouter(
            relayCoordinator = coordinator,
            saveLan = { lanSaves++ },
            startLan = { lanStarts++ },
        )

        assertEquals(RelayDeepLinkRoutingResult.RELAY_SAVED, router.route(fixtureUri))
        assertEquals(
            RelayDeepLinkRoutingResult.RELAY_REJECTED,
            router.route(fixtureUri.replace("?v=1", "?v=2")),
        )
        assertEquals(1, relaySaves)
        assertEquals(0, lanSaves)
        assertEquals(0, lanStarts)

        assertEquals(
            RelayDeepLinkRoutingResult.LAN_STARTED,
            router.route("clawd://192.168.1.7:23334/abcdef1234567890"),
        )
        assertEquals(1, lanSaves)
        assertEquals(1, lanStarts)
    }
}
