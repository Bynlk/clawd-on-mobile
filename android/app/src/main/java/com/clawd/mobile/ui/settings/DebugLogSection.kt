package com.clawd.mobile.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*
import com.clawd.mobile.util.ConnectionLog

@Composable
internal fun DebugLogSection() {
    val clipboard = LocalClipboardManager.current
    var logText by remember { mutableStateOf(ConnectionLog.dump()) }

    Text(
        stringResource(R.string.settings_debug_log_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    // Refresh button
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        OutlinedButton(
            onClick = { logText = ConnectionLog.dump() },
            border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.weight(1f)
        ) {
            Icon(ClawdIcons.Refresh, null, modifier = Modifier.size(14.dp), tint = ClawdMutedDark)
            Spacer(modifier = Modifier.width(4.dp))
            Text(stringResource(R.string.action_refresh), color = ClawdMutedDark, fontSize = 12.sp)
        }
        OutlinedButton(
            onClick = { clipboard.setText(AnnotatedString(logText)) },
            border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.weight(1f)
        ) {
            Icon(ClawdIcons.Checks, null, modifier = Modifier.size(14.dp), tint = ClawdMutedDark)
            Spacer(modifier = Modifier.width(4.dp))
            Text(stringResource(R.string.action_copy_all), color = ClawdMutedDark, fontSize = 12.sp)
        }
        OutlinedButton(
            onClick = { ConnectionLog.clear(); logText = "" },
            border = androidx.compose.foundation.BorderStroke(0.5.dp, ClawdBorderDark),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.weight(1f)
        ) {
            Text(stringResource(R.string.action_clear), color = ClawdMutedDark, fontSize = 12.sp)
        }
    }

    // Log display
    if (logText.isNotEmpty()) {
        Spacer(modifier = Modifier.height(10.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 300.dp)
                .background(Color(0xFF111111), RoundedCornerShape(8.dp))
                .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(8.dp))
                .padding(8.dp)
        ) {
            Text(
                logText,
                fontSize = 10.sp,
                color = Color(0xFF88CC88),
                fontFamily = FontFamily.Monospace,
                lineHeight = 14.sp,
                modifier = Modifier.verticalScroll(rememberScrollState())
            )
        }
    } else {
        Spacer(modifier = Modifier.height(8.dp))
        Text(stringResource(R.string.settings_no_log), fontSize = 12.sp, color = ClawdFaintDark)
    }
}
