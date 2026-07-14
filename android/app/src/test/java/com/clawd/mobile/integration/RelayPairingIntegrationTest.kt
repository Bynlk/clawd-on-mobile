package com.clawd.mobile.integration

import com.clawd.mobile.RelayPairingCoordinator
import com.clawd.mobile.RelayDeepLinkRouter
import com.clawd.mobile.RelayDeepLinkRoutingResult
import com.clawd.mobile.RelayPairingPreparation
import com.clawd.mobile.RelayPairingConfirmationViewModel
import com.clawd.mobile.RelayPairingConfirmationPhase
import com.clawd.mobile.RelayPairingResumeAction
import com.clawd.mobile.relayPairingResumeAction
import com.clawd.mobile.RelayPairingStoredState
import com.clawd.mobile.consumeActionViewUri
import com.clawd.mobile.toConfirmationMetadata
import com.clawd.mobile.ui.scan.RelayPairingAcceptance
import com.clawd.mobile.ui.scan.ScanPayloadResult
import com.clawd.mobile.ui.scan.parseScannedPayload
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayPairingErrorCode
import java.io.File
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayPairingIntegrationTest {
    private val fixtureUri = "clawd://relay-pair?v=1&data=eyJ2ZXJzaW9uIjoxLCJuYW1lIjoiQW5kcm9pZCBmaXh0dXJlIiwid2lyZUd1YXJkIjp7InByaXZhdGVLZXkiOiJCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjPSIsImFkZHJlc3MiOiIxMC44LjAuMy8zMiIsInNlcnZlclB1YmxpY0tleSI6IkNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWc9IiwiZW5kcG9pbnQiOiIxOTguNTEuMTAwLjc6NTE4MjAiLCJhbGxvd2VkSXBzIjpbIjEwLjguMC4wLzI0Il0sInBlcnNpc3RlbnRLZWVwYWxpdmUiOjI1fSwicmVsYXkiOnsidXJsIjoid3M6Ly8xMC44LjAuMTo3ODkxIiwidG9rZW4iOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIn0sImlzc3VlZEF0IjoxNzgzOTAwODAwMDAwfQ"

    private fun currentPcSemanticVectors(): List<RelayPairingConfig> {
        var repositoryRoot = File(System.getProperty("user.dir") ?: error("user.dir unavailable")).canonicalFile
        while (!File(repositoryRoot, "src/wg-relay-pairing-qr.js").isFile) {
            repositoryRoot = repositoryRoot.parentFile
                ?: error("repository root not found")
        }
        val encoder = File(repositoryRoot, "src/wg-relay-pairing-qr.js")
        val script = """
            const { buildPairingDeepLink } = require(process.argv[1]);
            function make(overrides = {}) {
              const subnet = overrides.subnet || '10.8.0.0/24';
              const prefix = subnet.replace(/\.0\/24${'$'}/, '');
              const endpoint = overrides.endpoint || '198.51.100.7:51820';
              const privateKey = Buffer.alloc(32, overrides.privateByte || 7).toString('base64');
              const publicKey = Buffer.alloc(32, 8).toString('base64');
              return buildPairingDeepLink({
                profile: { label: overrides.label || 'Semantic fixture', wgSubnet: subnet, endpoint },
                secrets: {
                  phoneConfig: `[Interface]\nPrivateKey = ${'$'}{privateKey}\nAddress = ${'$'}{prefix}.3/32\n\n[Peer]\nPublicKey = ${'$'}{publicKey}\nEndpoint = ${'$'}{endpoint}\nAllowedIPs = ${'$'}{subnet}\nPersistentKeepalive = 25\n`,
                  relayUrl: `ws://${'$'}{prefix}.1:7891`,
                  relayToken: (overrides.tokenByte || 'ab').repeat(32),
                },
                issuedAt: overrides.issuedAt,
              });
            }
            process.stdout.write(JSON.stringify([
              make({ issuedAt: 1783900800100 }),
              make({ issuedAt: 1783900800200 }),
              make({ issuedAt: 1783900800300, label: 'Renamed fixture' }),
              make({ issuedAt: 1783900800300, tokenByte: 'cd' }),
              make({ issuedAt: 1783900800300, privateByte: 9 }),
              make({ issuedAt: 1783900800300, endpoint: '198.51.100.8:51820' }),
              make({ issuedAt: 1783900800300, subnet: '10.9.0.0/24' }),
            ]));
        """.trimIndent()
        val process = ProcessBuilder("node", "-e", script, encoder.absolutePath)
            .redirectErrorStream(true)
            .start()
        assertEquals(true, process.waitFor(10, TimeUnit.SECONDS))
        val output = process.inputStream.bufferedReader().readText().trim()
        assertEquals(0, process.exitValue())
        val links = kotlinx.serialization.json.Json.decodeFromString<List<String>>(output)
        return links.map(RelayPairingConfig::parse)
    }

    private fun renamedFixture(name: String): RelayPairingConfig {
        val payload = String(
            java.util.Base64.getUrlDecoder().decode(fixtureUri.substringAfter("&data=")),
            Charsets.UTF_8,
        ).replace("Android fixture", name)
        val encoded = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payload.toByteArray())
        return RelayPairingConfig.parse("clawd://relay-pair?v=1&data=$encoded")
    }

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
    fun `Android parses IPv4 mapped IPv6 endpoint emitted by current PC encoder`() {
        var repositoryRoot = File(System.getProperty("user.dir") ?: error("user.dir unavailable")).canonicalFile
        while (!File(repositoryRoot, "src/wg-relay-pairing-qr.js").isFile) {
            repositoryRoot = repositoryRoot.parentFile
                ?: error("repository root not found")
        }
        val encoder = File(repositoryRoot, "src/wg-relay-pairing-qr.js")
        val script = """
            const { buildPairingDeepLink } = require(process.argv[1]);
            const privateKey = Buffer.alloc(32, 7).toString('base64');
            const publicKey = Buffer.alloc(32, 8).toString('base64');
            const endpoint = '[::ffff:192.0.2.1]:51820';
            process.stdout.write(buildPairingDeepLink({
              profile: { label: 'Mapped IPv6 fixture', wgSubnet: '10.8.0.0/24', endpoint },
              secrets: {
                phoneConfig: `[Interface]\nPrivateKey = ${'$'}{privateKey}\nAddress = 10.8.0.3/32\n\n[Peer]\nPublicKey = ${'$'}{publicKey}\nEndpoint = ${'$'}{endpoint}\nAllowedIPs = 10.8.0.0/24\nPersistentKeepalive = 25\n`,
                relayUrl: 'ws://10.8.0.1:7891', relayToken: 'ab'.repeat(32),
              },
              issuedAt: 1783900800001,
            }));
        """.trimIndent()
        val process = ProcessBuilder("node", "-e", script, encoder.absolutePath)
            .redirectErrorStream(true)
            .start()
        assertEquals(true, process.waitFor(10, TimeUnit.SECONDS))
        val deepLink = process.inputStream.bufferedReader().readText().trim()
        assertEquals(0, process.exitValue())

        val parsed = RelayPairingConfig.parse(deepLink)
        assertEquals("[::ffff:192.0.2.1]:51820", parsed.wireGuard.endpoint)
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
    fun `coordinator saves and navigates once for duplicate pairing input`() = runBlocking {
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
            initialPairing = config,
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )
        assertEquals(RelayPairingAcceptance.DUPLICATE, restored.accept(config))
        assertEquals(1, saves)
        assertEquals(1, navigations)
    }

    @Test
    fun `pending external confirmation survives activity recreation in retained memory`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        val retained = RelayPairingConfirmationViewModel()
        assertTrue(retained.retainForPreparation(config))

        // A recreated Activity receives the same ViewModel instance from its ViewModelStore,
        // while no secret is written into the Activity saved-state Bundle.
        val recreatedCoordinator = RelayPairingCoordinator(
            load = { RelayPairingStoredState() },
            save = { true },
        )
        assertEquals(config, retained.pendingExternalPairing)
        assertEquals(config.toConfirmationMetadata(), retained.metadata)
        assertEquals(RelayPairingConfirmationPhase.PREPARING, retained.phase)
        assertEquals(
            RelayPairingPreparation.CONFIRMATION_REQUIRED,
            recreatedCoordinator.prepareExternal(requireNotNull(retained.pendingExternalPairing)),
        )
    }

    @Test
    fun `duplicate external event cannot overwrite retained pending confirmation`() {
        val config = RelayPairingConfig.parse(fixtureUri)
        val retained = RelayPairingConfirmationViewModel()
        assertTrue(retained.retainForPreparation(config))
        retained.show(config)

        assertFalse(retained.retainForPreparation(config))
        assertEquals(config, retained.pendingExternalPairing)
        assertEquals(RelayPairingConfirmationPhase.AWAITING_CONFIRMATION, retained.phase)
    }

    @Test
    fun `late preparation result cannot overwrite a newer external pairing`() {
        val first = RelayPairingConfig.parse(fixtureUri)
        val replacement = renamedFixture("Newer pairing")
        val retained = RelayPairingConfirmationViewModel()
        assertTrue(retained.retainForPreparation(first))
        val firstPhase = requireNotNull(retained.phase)
        assertTrue(retained.retainForPreparation(replacement))

        assertFalse(retained.isCurrent(first, firstPhase))
        assertTrue(
            retained.isCurrent(
                replacement,
                RelayPairingConfirmationPhase.PREPARING,
            ),
        )
    }

    @Test
    fun `new activity restore invalidates old same config attempt`() {
        val config = RelayPairingConfig.parse(fixtureUri)
        val retained = RelayPairingConfirmationViewModel()
        assertTrue(retained.retainForPreparation(config))
        val phase = requireNotNull(retained.phase)
        val oldAttempt = retained.beginRestore()
        val newAttempt = retained.beginRestore()

        assertFalse(retained.isCurrent(config, phase, oldAttempt))
        assertTrue(retained.isCurrent(config, phase, newAttempt))
    }

    @Test
    fun `recreated activity resumes confirmed save or补发 settings navigation`() {
        assertEquals(
            RelayPairingResumeAction.RESUME_CONFIRMED_SAVE,
            relayPairingResumeAction(
                RelayPairingConfirmationPhase.CONFIRMING,
                RelayPairingPreparation.CONFIRMATION_REQUIRED,
            ),
        )
        assertEquals(
            RelayPairingResumeAction.NAVIGATE_TO_SETTINGS,
            relayPairingResumeAction(
                RelayPairingConfirmationPhase.CONFIRMING,
                RelayPairingPreparation.DUPLICATE,
            ),
        )
        assertEquals(
            RelayPairingResumeAction.SHOW_CONFIRMATION,
            relayPairingResumeAction(
                RelayPairingConfirmationPhase.PREPARING,
                RelayPairingPreparation.CONFIRMATION_REQUIRED,
            ),
        )
    }

    @Test
    fun `coordinator failure does not replace prior fingerprint or navigate`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        var shouldSave = false
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            save = { shouldSave },
            navigateToSettings = { navigations++ },
        )

        assertEquals(RelayPairingAcceptance.STORAGE_FAILED, coordinator.accept(config))
        assertEquals(null, coordinator.lastFingerprint)
        assertEquals(0, navigations)

        shouldSave = true
        assertEquals(RelayPairingAcceptance.SAVED, coordinator.accept(config))
        assertEquals(1, navigations)
    }

    @Test
    fun `new coordinator process deduplicates pairing loaded from encrypted storage`() = runBlocking {
        val scanned = RelayPairingConfig.parse(fixtureUri)
        val loaded = RelayPairingConfig.decodeStorage(RelayPairingConfig.encodeStorage(scanned))
        var saves = 0
        var navigations = 0
        var lanStarts = 0
        val coordinator = RelayPairingCoordinator(
            initialPairing = loaded,
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )
        val router = RelayDeepLinkRouter(
            saveLan = {},
            startLan = { lanStarts++ },
        )

        val routed = router.route(fixtureUri) as RelayDeepLinkRoutingResult.RelayConfirmationRequired
        assertEquals(RelayPairingPreparation.DUPLICATE, coordinator.prepareExternal(routed.config))
        assertEquals(0, saves)
        assertEquals(0, navigations)
        assertEquals(0, lanStarts)
    }

    @Test
    fun `PC reissue with only issuedAt changed is duplicate across cold start`() = runBlocking {
        val (stored, reissued) = currentPcSemanticVectors()
        assertNotEquals(stored.issuedAt, reissued.issuedAt)
        assertEquals(
            RelayPairingConfig.semanticFingerprint(stored),
            RelayPairingConfig.semanticFingerprint(reissued),
        )
        var saves = 0
        var navigations = 0
        val restarted = RelayPairingCoordinator(
            initialPairing = stored,
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )

        assertEquals(RelayPairingAcceptance.DUPLICATE, restarted.accept(reissued))
        assertEquals(0, saves)
        assertEquals(0, navigations)
    }

    @Test
    fun `label and every WG Relay security or topology change replaces pairing`() = runBlocking {
        val vectors = currentPcSemanticVectors()
        val stored = vectors[0]
        val changes = vectors.drop(2)
        assertNotEquals(stored.name, changes[0].name)
        assertNotEquals(stored.relay.token, changes[1].relay.token)
        assertNotEquals(stored.wireGuard.privateKey, changes[2].wireGuard.privateKey)
        assertNotEquals(stored.wireGuard.endpoint, changes[3].wireGuard.endpoint)
        assertNotEquals(stored.wireGuard.address, changes[4].wireGuard.address)

        for (changed in changes) {
            var saved: RelayPairingConfig? = null
            var navigations = 0
            val restarted = RelayPairingCoordinator(
                initialPairing = stored,
                save = { saved = it; true },
                navigateToSettings = { navigations++ },
            )
            assertNotEquals(
                RelayPairingConfig.semanticFingerprint(stored),
                RelayPairingConfig.semanticFingerprint(changed),
            )
            assertEquals(RelayPairingAcceptance.SAVED, restarted.accept(changed))
            assertEquals(changed, saved)
            assertEquals(1, navigations)
        }
    }

    @Test
    fun `new coordinator process atomically saves a semantically different pairing`() = runBlocking {
        val loaded = RelayPairingConfig.parse(fixtureUri)
        val payload = String(
            java.util.Base64.getUrlDecoder().decode(fixtureUri.substringAfter("&data=")),
            Charsets.UTF_8,
        )
            .replace("Android fixture", "Replacement fixture")
        val replacementUri = "clawd://relay-pair?v=1&data=" +
            java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray())
        var saved: RelayPairingConfig? = null
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            initialPairing = loaded,
            save = { saved = it; true },
            navigateToSettings = { navigations++ },
        )

        val replacement = RelayPairingConfig.parse(replacementUri)
        assertEquals(RelayPairingAcceptance.SAVED, coordinator.accept(replacement))
        assertEquals(replacement, saved)
        assertEquals(1, navigations)
    }

    @Test
    fun `corrupt persisted pairing fails closed without save or navigation`() = runBlocking {
        val scanned = RelayPairingConfig.parse(fixtureUri)
        var saves = 0
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            initialPairing = null,
            initialStorageUnavailable = true,
            save = { saves++; true },
            navigateToSettings = { navigations++ },
        )

        assertEquals(RelayPairingAcceptance.STORAGE_FAILED, coordinator.accept(scanned))
        assertEquals(0, saves)
        assertEquals(0, navigations)
    }

    @Test
    fun `deep link router never starts LAN connection for relay or invalid pairing`() {
        var lanSaves = 0
        var lanStarts = 0
        val router = RelayDeepLinkRouter(
            saveLan = { lanSaves++ },
            startLan = { lanStarts++ },
        )

        assertTrue(router.route(fixtureUri) is RelayDeepLinkRoutingResult.RelayConfirmationRequired)
        assertEquals(
            RelayDeepLinkRoutingResult.RelayRejected,
            router.route(fixtureUri.replace("?v=1", "?v=2")),
        )
        assertEquals(0, lanSaves)
        assertEquals(0, lanStarts)

        assertEquals(
            RelayDeepLinkRoutingResult.LanStarted,
            router.route("clawd://192.168.1.7:23334/abcdef1234567890"),
        )
        assertEquals(1, lanSaves)
        assertEquals(1, lanStarts)
    }

    @Test
    fun `external relay link only returns safe confirmation metadata before user confirmation`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        var saves = 0
        val coordinator = RelayPairingCoordinator(
            load = { RelayPairingStoredState() },
            save = { saves++; true },
        )
        val router = RelayDeepLinkRouter(
            saveLan = {},
            startLan = {},
        )

        val routed = router.route(fixtureUri) as RelayDeepLinkRoutingResult.RelayConfirmationRequired
        assertEquals(config, routed.config)
        assertEquals(RelayPairingPreparation.CONFIRMATION_REQUIRED, coordinator.prepareExternal(routed.config))
        assertEquals(0, saves)

        val metadata = routed.config.toConfirmationMetadata()
        val rendered = metadata.toString()
        assertEquals("Android fixture", metadata.name)
        assertEquals("198.51.100.7:51820", metadata.endpoint)
        assertFalse(rendered.contains(config.wireGuard.privateKey))
        assertFalse(rendered.contains(config.wireGuard.serverPublicKey))
        assertFalse(rendered.contains(config.relay.token))

        assertEquals(RelayPairingAcceptance.SAVED, coordinator.confirmExternal(routed.config))
        assertEquals(1, saves)
    }

    @Test
    fun `semantic duplicate external links neither confirm save nor navigate`() = runBlocking {
        val (stored, reissued) = currentPcSemanticVectors()
        var saves = 0
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            load = { RelayPairingStoredState(pairing = stored) },
            save = { saves++; true },
        )

        val preparation = coordinator.prepareExternal(reissued)
        if (preparation == RelayPairingPreparation.CONFIRMATION_REQUIRED) navigations++

        assertEquals(RelayPairingPreparation.DUPLICATE, preparation)
        assertEquals(0, saves)
        assertEquals(0, navigations)
    }

    @Test
    fun `repeated pending external link is a semantic duplicate and is not confirmed twice`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        var saves = 0
        val coordinator = RelayPairingCoordinator(
            load = { RelayPairingStoredState() },
            save = { saves++; true },
        )

        assertEquals(RelayPairingPreparation.CONFIRMATION_REQUIRED, coordinator.prepareExternal(config))
        assertEquals(RelayPairingPreparation.DUPLICATE, coordinator.prepareExternal(config))
        assertEquals(0, saves)
    }

    @Test
    fun `external confirmation can retry but leaves navigation to validated activity attempt`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        var saves = 0
        var navigations = 0
        val coordinator = RelayPairingCoordinator(
            load = { RelayPairingStoredState() },
            save = { ++saves > 1 },
            navigateToSettings = { navigations++ },
        )
        assertEquals(RelayPairingPreparation.CONFIRMATION_REQUIRED, coordinator.prepareExternal(config))

        assertEquals(RelayPairingAcceptance.STORAGE_FAILED, coordinator.confirmExternal(config))
        assertEquals(0, navigations)
        assertEquals(RelayPairingAcceptance.SAVED, coordinator.confirmExternal(config))
        assertEquals(2, saves)
        assertEquals(0, navigations)
    }

    @Test
    fun `coordinator propagates lifecycle cancellation during load and save`() = runBlocking {
        val config = RelayPairingConfig.parse(fixtureUri)
        val loadCancelled = RelayPairingCoordinator(
            load = { throw CancellationException("activity recreated during load") },
            save = { true },
        )
        var loadPropagated = false
        try {
            loadCancelled.prepareExternal(config)
        } catch (_: CancellationException) {
            loadPropagated = true
        }
        assertTrue(loadPropagated)

        val saveCancelled = RelayPairingCoordinator(
            load = { RelayPairingStoredState() },
            save = { throw CancellationException("activity recreated during save") },
        )
        assertEquals(
            RelayPairingPreparation.CONFIRMATION_REQUIRED,
            saveCancelled.prepareExternal(config),
        )
        var savePropagated = false
        try {
            saveCancelled.confirmExternal(config)
        } catch (_: CancellationException) {
            savePropagated = true
        }
        assertTrue(savePropagated)
    }

    @Test
    fun `camera and deep link writes share one IO writer and serialize duplicate events`() = runBlocking {
        val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "relay-pairing-writer")
        }
        val ioDispatcher = ioExecutor.asCoroutineDispatcher()
        try {
            val first = RelayPairingConfig.parse(fixtureUri)
            val second = renamedFixture("Second fixture")
            val enteredFirstSave = CountDownLatch(1)
            val releaseFirstSave = CountDownLatch(1)
            val activeWrites = AtomicInteger(0)
            val maximumActiveWrites = AtomicInteger(0)
            val savedNames = Collections.synchronizedList(mutableListOf<String>())
            val storageThreads = Collections.synchronizedList(mutableListOf<String>())
            val coordinator = RelayPairingCoordinator(
                load = {
                    storageThreads += Thread.currentThread().name
                    RelayPairingStoredState()
                },
                save = { config ->
                    storageThreads += Thread.currentThread().name
                    val active = activeWrites.incrementAndGet()
                    maximumActiveWrites.updateAndGet { current -> maxOf(current, active) }
                    if (config.name == first.name) {
                        enteredFirstSave.countDown()
                        assertTrue(releaseFirstSave.await(10, TimeUnit.SECONDS))
                    }
                    savedNames += config.name
                    activeWrites.decrementAndGet()
                    true
                },
                storageDispatcher = ioDispatcher,
            )

            val camera = async(Dispatchers.Default) { coordinator.accept(first) }
            assertTrue(enteredFirstSave.await(10, TimeUnit.SECONDS))
            val deepLink = async(Dispatchers.Default) {
                assertEquals(
                    RelayPairingPreparation.CONFIRMATION_REQUIRED,
                    coordinator.prepareExternal(second),
                )
                coordinator.confirmExternal(second)
            }
            releaseFirstSave.countDown()

            assertEquals(RelayPairingAcceptance.SAVED, camera.await())
            assertEquals(RelayPairingAcceptance.SAVED, deepLink.await())
            assertEquals(listOf(first.name, second.name), savedNames)
            assertEquals(1, maximumActiveWrites.get())
            assertTrue(storageThreads.isNotEmpty())
            assertTrue(storageThreads.all { it.startsWith("relay-pairing-writer") })
        } finally {
            ioDispatcher.close()
            ioExecutor.shutdownNow()
        }
    }

    @Test
    fun `ACTION_VIEW URI data is cleared immediately after read and before parsing`() {
        val events = mutableListOf<String>()
        var currentData: String? = fixtureUri

        val raw = consumeActionViewUri(
            action = "android.intent.action.VIEW",
            readUri = { events += "read"; currentData },
            clearData = { events += "clear"; currentData = null },
        )
        events += "parse"
        val parsed = parseScannedPayload(requireNotNull(raw))

        assertEquals(listOf("read", "clear", "parse"), events)
        assertEquals(null, currentData)
        assertTrue(parsed is ScanPayloadResult.Relay)
        assertEquals(
            null,
            consumeActionViewUri("android.intent.action.MAIN", { fixtureUri }, { error("must not clear") }),
        )
    }
}
