package com.clawd.mobile.ui.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.overlay.FloatingPetService
import com.clawd.mobile.ui.theme.*

@Composable
internal fun FloatingPetSection(prefsStore: PrefsStore, snackbarHostState: SnackbarHostState? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var enabled by remember { mutableStateOf(prefsStore.isFloatingPetEnabled()) }
    var hasOverlayPermission by remember { mutableStateOf(Settings.canDrawOverlays(context)) }

    var sizeDp by remember { mutableIntStateOf(prefsStore.getPetSizeDp()) }
    var character by remember { mutableStateOf(prefsStore.getPetCharacter()) }

    Text(
        stringResource(R.string.settings_pet_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    // Enable toggle
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(stringResource(R.string.settings_pet_enable), fontSize = 13.sp, color = ClawdTextDark)
            Text(
                if (hasOverlayPermission) stringResource(R.string.settings_pet_overlay_granted) else stringResource(R.string.settings_pet_overlay_needed),
                fontSize = 11.sp,
                color = if (hasOverlayPermission) ClawdGreenBright else ClawdFaintDark
            )
        }
        Switch(
            checked = enabled,
            onCheckedChange = { newValue ->
                if (newValue) {
                    if (Settings.canDrawOverlays(context)) {
                        enabled = true
                        prefsStore.setFloatingPetEnabled(true)
                        val intent = Intent(context, FloatingPetService::class.java)
                        context.startForegroundService(intent)
                    } else {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:${context.packageName}")
                        )
                        context.startActivity(intent)
                    }
                } else {
                    enabled = false
                    prefsStore.setFloatingPetEnabled(false)
                    val intent = Intent(context, FloatingPetService::class.java)
                    context.stopService(intent)
                }
            },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = ClawdAccent,
                uncheckedThumbColor = ClawdFaintDark,
                uncheckedTrackColor = ClawdSurfaceAltDark
            )
        )
    }

    // Action buttons
    if (enabled) {
        Spacer(modifier = Modifier.height(10.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedButton(
                onClick = {
                    context.sendBroadcast(
                        Intent(FloatingPetService.ACTION_PET_RECENTER).setPackage(context.packageName)
                    )
                    snackbarHostState?.let { sb ->
                        scope.launch { sb.showSnackbar(context.getString(R.string.toast_recentered), duration = SnackbarDuration.Short) }
                    }
                },
                border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f)
            ) {
                Text(stringResource(R.string.settings_pet_recenter), color = ClawdFaintDark, fontSize = 12.sp)
            }
            OutlinedButton(
                onClick = {
                    enabled = false
                    prefsStore.setFloatingPetEnabled(false)
                    context.startService(
                        Intent(context, FloatingPetService::class.java)
                            .setAction(FloatingPetService.ACTION_DISCONNECT)
                    )
                    snackbarHostState?.let { sb ->
                        scope.launch { sb.showSnackbar(context.getString(R.string.toast_disconnected), duration = SnackbarDuration.Short) }
                    }
                },
                border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.weight(1f)
            ) {
                Text(stringResource(R.string.settings_disconnect), color = ClawdFaintDark, fontSize = 12.sp)
            }
        }
    }

    // Size slider
    if (enabled) {
        Spacer(modifier = Modifier.height(12.dp))
        Text(stringResource(R.string.settings_pet_size), fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(4.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Slider(
                value = sizeDp.toFloat(),
                onValueChange = { sizeDp = it.toInt() },
                onValueChangeFinished = {
                    prefsStore.setPetSizeDp(sizeDp)
                    context.sendBroadcast(
                        Intent(FloatingPetService.ACTION_PET_SIZE)
                            .putExtra(FloatingPetService.EXTRA_SIZE_DP, sizeDp)
                    )
                },
                valueRange = 32f..128f,
                modifier = Modifier.weight(1f),
                colors = SliderDefaults.colors(thumbColor = ClawdAccent, activeTrackColor = ClawdAccent)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text("$sizeDp dp", fontSize = 12.sp, color = ClawdFaintDark, modifier = Modifier.width(48.dp))
        }

        // Character selector
        Spacer(modifier = Modifier.height(8.dp))
        Text(stringResource(R.string.settings_pet_character), fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("clawd" to "Clawd", "calico" to "Calico", "cloudling" to "Cloudling").forEach { (key, label) ->
                FilterChip(
                    selected = character == key,
                    onClick = {
                        character = key
                        prefsStore.setPetCharacter(key)
                        context.sendBroadcast(
                            Intent(FloatingPetService.ACTION_PET_CHARACTER)
                                .putExtra(FloatingPetService.EXTRA_CHARACTER, key)
                                .setPackage(context.packageName)
                        )
                    },
                    label = { Text(label, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = ClawdAccent,
                        selectedLabelColor = Color.White
                    )
                )
            }
        }

        // Click-through toggle
        Spacer(modifier = Modifier.height(14.dp))
        var clickThrough by remember { mutableStateOf(prefsStore.isClickThroughEnabled()) }
        NotifyToggle(
            stringResource(R.string.settings_pet_click_through),
            stringResource(R.string.settings_pet_click_through_desc),
            clickThrough
        ) {
            clickThrough = it
            prefsStore.setClickThroughEnabled(it)
        }

        // Sleep timeout
        Spacer(modifier = Modifier.height(14.dp))
        Text(stringResource(R.string.settings_pet_sleep_timeout), fontSize = 13.sp, color = ClawdTextDark)
        Spacer(modifier = Modifier.height(6.dp))
        var sleepSec by remember { mutableIntStateOf(prefsStore.getSleepTimeoutSec()) }
        val options = listOf(30, 60, 300, 0)
        val labels = listOf(
            stringResource(R.string.settings_pet_sleep_30s),
            stringResource(R.string.settings_pet_sleep_1min),
            stringResource(R.string.settings_pet_sleep_5min),
            stringResource(R.string.settings_pet_sleep_never)
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            options.forEachIndexed { i, sec ->
                FilterChip(
                    selected = sleepSec == sec,
                    onClick = {
                        sleepSec = sec
                        prefsStore.setSleepTimeoutSec(sec)
                        context.sendBroadcast(
                            Intent(FloatingPetService.ACTION_PET_SLEEP_TIMEOUT)
                                .putExtra(FloatingPetService.EXTRA_SLEEP_SEC, sec)
                                .setPackage(context.packageName)
                        )
                    },
                    label = { Text(labels[i], fontSize = 11.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = ClawdAccent,
                        selectedLabelColor = Color.White
                    )
                )
            }
        }
    }

    // Re-check permission and auto-start service if needed
    LaunchedEffect(Unit) {
        hasOverlayPermission = Settings.canDrawOverlays(context)
        // Auto-start service if pref says enabled but service is not running
        // Covers: process death, returning from permission screen
        if (hasOverlayPermission && prefsStore.isFloatingPetEnabled() && !FloatingPetService.isRunning) {
            enabled = true
            val intent = Intent(context, FloatingPetService::class.java)
            context.startForegroundService(intent)
        }
    }
}
