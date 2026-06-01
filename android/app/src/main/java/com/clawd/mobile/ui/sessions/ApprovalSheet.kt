package com.clawd.mobile.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PermissionRequestData
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*

@Composable
internal fun ApprovalSheet(
    request: PermissionRequestData,
    sessionName: String?,
    remainingSeconds: Int,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onSuggestion: (String, Int) -> Unit,
    onElicitation: (String, String) -> Unit
) {
    val isElicitation = request.toolName == "elicitation"
    val requestId = request.requestId ?: return

    // Timeout for progress bar
    val timeoutMs = request.timeout.coerceIn(10_000, 300_000)
    val totalSec = (timeoutMs / 1000).toInt()
    val progress = if (totalSec > 0) remainingSeconds.toFloat() / totalSec else 0f

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .padding(bottom = 24.dp)
    ) {
        // Session name
        if (!sessionName.isNullOrBlank()) {
            Text(
                sessionName,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = ClawdTextDark,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 12.dp)
        ) {
            Icon(
                ClawdIcons.Shield, null,
                modifier = Modifier.size(20.dp),
                tint = ClawdAccent
            )
            Text(
                request.agentId ?: "Agent",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdMutedDark,
                modifier = Modifier
                    .background(ClawdSurfaceAltDark, RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            )
            Spacer(modifier = Modifier.weight(1f))
            Text(
                if (isElicitation) stringResource(R.string.sessions_action_choice) else stringResource(R.string.sessions_action_permission),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClawdAccentLight
            )
        }

        // Countdown progress bar
        if (remainingSeconds > 0) {
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .padding(bottom = 8.dp)
                    .clip(RoundedCornerShape(2.dp)),
                color = if (remainingSeconds <= 10) ClawdError else ClawdAccent,
                trackColor = ClawdSurfaceAltDark,
            )
            Text(
                "${remainingSeconds}s",
                fontSize = 11.sp,
                color = if (remainingSeconds <= 10) ClawdError else ClawdFaintDark,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }

        if (!isElicitation && !request.toolName.isNullOrBlank()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(bottom = 8.dp)
            ) {
                Icon(ClawdIcons.Tool, null, modifier = Modifier.size(14.dp), tint = ClawdSubtleDark)
                Text(request.toolName, fontSize = 14.sp, color = ClawdTextDark)
            }
        }

        if (!request.toolInputSummary.isNullOrBlank()) {
            Text(
                request.toolInputSummary,
                fontSize = 12.sp,
                color = ClawdTextDark,
                fontFamily = FontFamily.Monospace,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        color = ClawdSurfaceAltDark,
                        shape = RoundedCornerShape(8.dp)
                    )
                    .padding(8.dp)
                    .padding(bottom = 8.dp)
            )
        }

        if (isElicitation && request.elicitationOptions.isNotEmpty()) {
            request.elicitationOptions.forEach { option ->
                Button(
                    onClick = { onElicitation(requestId, option.value) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdAccent.copy(alpha = 0.15f),
                        contentColor = ClawdAccentLight
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(option.label, modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        }

        val hasSuggestions = request.suggestions.isNotEmpty() && request.suggestions.all { it.label.isNotBlank() }

        if (hasSuggestions) {
            request.suggestions.forEachIndexed { index, suggestion ->
                val isAutoAccept = suggestion.mode == "acceptEdits" || suggestion.label.contains("accept", ignoreCase = true)
                val isAllow = suggestion.behavior == "allow"
                Button(
                    onClick = { onSuggestion(requestId, index) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = when {
                            isAutoAccept -> Color(0xFF52525B).copy(alpha = 0.15f)
                            isAllow -> ClawdGreenBright.copy(alpha = 0.15f)
                            else -> ClawdError.copy(alpha = 0.15f)
                        },
                        contentColor = when {
                            isAutoAccept -> Color(0xFF71717A)
                            isAllow -> ClawdGreenBright
                            else -> ClawdError
                        }
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(suggestion.label, modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Button(
                    onClick = { onDeny(requestId) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdError.copy(alpha = 0.15f),
                        contentColor = ClawdError
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(stringResource(R.string.action_deny), modifier = Modifier.padding(vertical = 4.dp))
                }
                Button(
                    onClick = { onApprove(requestId) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = ClawdGreenBright.copy(alpha = 0.15f),
                        contentColor = ClawdGreenBright
                    ),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Text(stringResource(R.string.action_allow), modifier = Modifier.padding(vertical = 4.dp))
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
    }
}
