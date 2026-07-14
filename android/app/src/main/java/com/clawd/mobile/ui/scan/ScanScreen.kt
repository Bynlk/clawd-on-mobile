package com.clawd.mobile.ui.scan

import android.Manifest
import android.content.pm.PackageManager

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.clawd.mobile.R
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.RelayPairingConfig
import com.clawd.mobile.data.RelayPairingErrorCode
import com.clawd.mobile.data.RelayPairingException
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.clawd.mobile.util.SafeExecutor

import java.util.concurrent.Executors

sealed interface ScanPayloadResult {
    data class Lan(val config: ConnectionConfig) : ScanPayloadResult
    data class Relay(val config: RelayPairingConfig) : ScanPayloadResult
    data class InvalidRelay(val code: RelayPairingErrorCode) : ScanPayloadResult
}

enum class RelayPairingAcceptance { SAVED, DUPLICATE, STORAGE_FAILED }

interface RelayPairingReceiver {
    fun onRelayPairingScanned(config: RelayPairingConfig): RelayPairingAcceptance
}

internal fun parseScannedPayload(raw: String): ScanPayloadResult? {
    val relayPrefix = "clawd://relay-pair"
    if (raw.regionMatches(0, relayPrefix, 0, relayPrefix.length, ignoreCase = true)) {
        return try {
            ScanPayloadResult.Relay(RelayPairingConfig.parse(raw))
        } catch (error: RelayPairingException) {
            ScanPayloadResult.InvalidRelay(error.code)
        }
    }
    return ConnectionConfig.fromClawdUrl(raw)?.let(ScanPayloadResult::Lan)
}

@androidx.annotation.StringRes
private fun pairingErrorMessage(code: RelayPairingErrorCode): Int = when (code) {
    RelayPairingErrorCode.UNSUPPORTED_VERSION -> R.string.scan_pairing_unsupported
    RelayPairingErrorCode.STORAGE_FAILED -> R.string.scan_pairing_save_failed
    else -> R.string.scan_pairing_invalid
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanScreen(
    onBack: () -> Unit,
    onScanned: (ConnectionConfig) -> Unit
) {
    val context = LocalContext.current
    var hasCameraPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasCameraPermission = granted
    }
    var scanError by remember { mutableStateOf<RelayPairingErrorCode?>(null) }
    var scannerKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            launcher.launch(Manifest.permission.CAMERA)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.scan_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Black,
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White
                )
            )
        }
    ) { padding ->
        if (!hasCameraPermission) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding).background(Color.Black),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.scan_need_camera), color = Color.White, style = MaterialTheme.typography.titleMedium)
                    Spacer(modifier = Modifier.height(16.dp))
                    Button(onClick = { launcher.launch(Manifest.permission.CAMERA) }) {
                        Text(stringResource(R.string.scan_grant_camera))
                    }
                }
            }
        } else {
            Box(modifier = Modifier.fillMaxSize().padding(padding).background(Color.Black)) {
                key(scannerKey) {
                    CameraPreview { result ->
                        when (result) {
                            is ScanPayloadResult.Lan -> onScanned(result.config)
                            is ScanPayloadResult.Relay -> {
                                val receiver = context as? RelayPairingReceiver
                                when (receiver?.onRelayPairingScanned(result.config)) {
                                    RelayPairingAcceptance.SAVED -> Unit
                                    RelayPairingAcceptance.DUPLICATE -> onBack()
                                    RelayPairingAcceptance.STORAGE_FAILED,
                                    null -> scanError = RelayPairingErrorCode.STORAGE_FAILED
                                }
                            }
                            is ScanPayloadResult.InvalidRelay -> scanError = result.code
                        }
                    }
                }

                // Scan frame
                Box(
                    modifier = Modifier
                        .size(250.dp)
                        .align(Alignment.Center)
                        .border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(12.dp))
                )

                // Hint text
                Text(
                    stringResource(R.string.scan_qr_hint),
                    color = Color.White,
                    modifier = Modifier.align(Alignment.Center).offset(y = 160.dp)
                )

                scanError?.let { code ->
                    Card(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(24.dp),
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(stringResource(pairingErrorMessage(code)))
                            Spacer(modifier = Modifier.height(8.dp))
                            TextButton(onClick = {
                                scanError = null
                                scannerKey++
                            }) {
                                Text(stringResource(R.string.scan_retry))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraPreview(onResult: (ScanPayloadResult) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) {
        onDispose { cameraExecutor.shutdown() }
    }
    var scanned by remember { mutableStateOf(false) }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)

            cameraProviderFuture.addListener({
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }

                val imageAnalysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build()
                    .also { analysis ->
                        analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                            if (scanned) {
                                imageProxy.close()
                                return@setAnalyzer
                            }
                            processImage(imageProxy) { result ->
                                if (result != null && !scanned) {
                                    scanned = true
                                    ContextCompat.getMainExecutor(ctx).execute { onResult(result) }
                                }
                            }
                        }
                    }

                cameraProvider.unbindAll()
                    SafeExecutor.tryOrReport("Scan") {
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            imageAnalysis
                        )
                    }
            }, ContextCompat.getMainExecutor(ctx))

            previewView
        },
        modifier = Modifier.fillMaxSize()
    )
}

private fun processImage(imageProxy: ImageProxy, onResult: (ScanPayloadResult?) -> Unit) {
    try {
        val buffer = imageProxy.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)

        val source = PlanarYUVLuminanceSource(
            bytes,
            imageProxy.width,
            imageProxy.height,
            0, 0,
            imageProxy.width,
            imageProxy.height,
            false
        )
        val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
        val reader = QRCodeReader()
        val result = reader.decode(binaryBitmap)
        val raw = result.text

        onResult(parseScannedPayload(raw))
    } catch (e: Exception) {
        // QR decode failures are expected (no QR in frame) — debug level only
        android.util.Log.d("Scan", "QR decode failed: ${e.javaClass.simpleName}")
        onResult(null)
    } finally {
        imageProxy.close()
    }
}
