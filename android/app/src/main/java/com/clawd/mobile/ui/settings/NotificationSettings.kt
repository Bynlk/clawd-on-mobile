package com.clawd.mobile.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ui.theme.*

@Composable
internal fun NotificationSection(prefsStore: PrefsStore) {
    var enabled by remember { mutableStateOf(prefsStore.isNotifyEnabled()) }
    var approval by remember { mutableStateOf(prefsStore.isNotifyApproval()) }
    var status by remember { mutableStateOf(prefsStore.isNotifyStatus()) }
    var alert by remember { mutableStateOf(prefsStore.isNotifyAlert()) }
    Text(
        stringResource(R.string.settings_notification_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    NotifyToggle(stringResource(R.string.settings_notify_master), stringResource(R.string.settings_notify_master_desc), enabled) {
        enabled = it; prefsStore.setNotifyEnabled(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_approval), stringResource(R.string.settings_notify_approval_desc), approval && enabled, enabled) {
        approval = it; prefsStore.setNotifyApproval(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_status), stringResource(R.string.settings_notify_status_desc), status && enabled, enabled) {
        status = it; prefsStore.setNotifyStatus(it)
    }
    NotifyToggle(stringResource(R.string.settings_notify_alert), stringResource(R.string.settings_notify_alert_desc), alert && enabled, enabled) {
        alert = it; prefsStore.setNotifyAlert(it)
    }
}

@Composable
internal fun NotifyToggle(
    label: String,
    desc: String,
    checked: Boolean,
    enabled: Boolean = true,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, fontSize = 13.sp, color = if (enabled) ClawdTextDark else ClawdFaintDark)
            Text(desc, fontSize = 11.sp, color = ClawdFaintDark)
        }
        Switch(
            checked = checked,
            onCheckedChange = { onCheckedChange(it) },
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = ClawdAccent,
                uncheckedThumbColor = ClawdFaintDark,
                uncheckedTrackColor = ClawdSurfaceAltDark
            )
        )
    }
}
