package com.clawd.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.data.Session
import com.clawd.mobile.data.parseHexColor
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*

@Composable
internal fun SessionCard(session: Session, prefsStore: PrefsStore, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val data = session.data
    var expanded by remember { mutableStateOf(false) }
    val hasEvents = data.recentEvents.isNotEmpty()

    // Rename state
    var showRenameDialog by remember { mutableStateOf(false) }
    var customName by remember { mutableStateOf(prefsStore.getSessionName(session.id) ?: "") }

    // Display name: custom > desktop-provided displayTitle > agentId
    val displayName = customName.ifBlank { null }
        ?: data.displayTitle
        ?: data.agentId
        ?: ""

    // All visual state from desktop — mobile overrides for better labels
    val chipText = data.chipText
    val chipColor = parseHexColor(data.chipColor) ?: ClawdMutedDark
    val dotColor = parseHexColor(data.dotColor) ?: ClawdSubtleDark

    // Mobile override: dotColor
    val mappedDotColor = when {
        data.dotColor == "#52525b" -> parseHexColor("#71717a") ?: dotColor  // idle 深灰 → done 灰色
        data.event == "Notification" -> parseHexColor("#71717a") ?: dotColor  // Notification → 灰色
        else -> dotColor
    }

    // Mobile override: chip text (more descriptive labels)
    val mappedChipText = when (data.chipText) {
        context.getString(R.string.sessions_waiting) -> when (data.event) {
            "PermissionRequest" -> context.getString(R.string.sessions_waiting_auth)
            "Elicitation" -> context.getString(R.string.sessions_waiting_choice)
            else -> chipText
        }
        else -> chipText
    }

    // Mobile override: chip color (keep original)
    val mappedChipColor = chipColor

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = ClawdSurfaceDark),
        border = BorderStroke(0.5.dp, ClawdBorderDark)
    ) {
        Column(modifier = Modifier.padding(14.dp, 12.dp, 14.dp, 10.dp)) {
            // Header row: [status-dot] [title] [chip] [elapsed] — matches PC HUD
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Status dot (badge-colored, matches PC HUD)
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(mappedDotColor)
                )
                // Title
                Text(
                    text = displayName,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = ClawdTextDark,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .padding(start = 8.dp)
                        .weight(1f, fill = false)
                )
                // State chip — from desktop, direct mapping
                if (mappedChipText != null) {
                    Text(
                        text = mappedChipText,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        color = mappedChipColor,
                        modifier = Modifier
                            .padding(start = 6.dp)
                            .border(0.5.dp, mappedChipColor.copy(alpha = 0.3f), RoundedCornerShape(4.dp))
                            .background(mappedChipColor.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
                // Elapsed time (matches PC HUD)
                Text(
                    text = formatAgo(data.updatedAt, LocalContext.current),
                    fontSize = 11.sp,
                    color = ClawdFaintDark,
                    modifier = Modifier.padding(start = 6.dp)
                )
                // Rename icon
                Icon(
                    ClawdIcons.Pencil,
                    stringResource(R.string.sessions_rename),
                    tint = ClawdFaintDark,
                    modifier = Modifier
                        .padding(start = 4.dp)
                        .size(13.dp)
                        .clickable { showRenameDialog = true }
                )
            }

            // Rename dialog
            if (showRenameDialog) {
                var editName by remember { mutableStateOf(customName) }
                AlertDialog(
                    onDismissRequest = { showRenameDialog = false },
                    containerColor = ClawdSurfaceDark,
                    title = { Text(stringResource(R.string.sessions_rename_title), color = ClawdTextDark) },
                    text = {
                        OutlinedTextField(
                            value = editName,
                            onValueChange = { editName = it },
                            placeholder = { Text(data.displayTitle ?: data.agentId ?: "", color = ClawdFaintDark) },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = ClawdTextDark,
                                unfocusedTextColor = ClawdTextDark,
                                focusedBorderColor = ClawdAccent,
                                unfocusedBorderColor = ClawdBorderDark,
                                cursorColor = ClawdAccent,
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            customName = editName.trim()
                            if (customName.isBlank()) {
                                prefsStore.clearSessionName(session.id)
                            } else {
                                prefsStore.saveSessionName(session.id, customName)
                            }
                            showRenameDialog = false
                        }) {
                            Text(stringResource(R.string.sessions_save), color = ClawdAccent)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showRenameDialog = false }) {
                            Text(stringResource(R.string.sessions_cancel), color = ClawdMutedDark)
                        }
                    }
                )
            }

            // Meta row: agent icon + agentId divider folder + cwd
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (data.agentId != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        Icon(ClawdIcons.Robot, null, tint = ClawdFaintDark, modifier = Modifier.size(11.dp))
                        Text(
                            "Agent",
                            fontSize = 11.sp,
                            color = ClawdFaintDark
                        )
                    }
                }
                if (!data.cwd.isNullOrBlank()) {
                    // Divider
                    Box(modifier = Modifier.size(1.dp, 10.dp).background(ClawdDividerDark))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        Icon(ClawdIcons.Folder, null, tint = ClawdFaintDark, modifier = Modifier.size(11.dp))
                        Text(
                            shortPath(data.cwd),
                            fontSize = 11.sp,
                            color = ClawdFaintDark,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }

            // Last output preview
            val lastOut = data.lastOutput
            if (lastOut != null && lastOut.output.isNotBlank()) {
                Text(
                    text = lastOut.output,
                    fontSize = 12.sp,
                    color = ClawdMutedDark,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    lineHeight = 16.sp,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }

            // Divider
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp)
                    .height(0.5.dp)
                    .background(ClawdBorderDark)
            )

            // Footer: events label + count + chevron
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = hasEvents) { expanded = !expanded }
                    .padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(ClawdIcons.Activity, null, tint = ClawdFaintDark, modifier = Modifier.size(12.dp))
                    Text(stringResource(R.string.sessions_recent_events), fontSize = 11.sp, color = ClawdFaintDark)
                    if (hasEvents) {
                        Text(
                            text = "${data.recentEvents.size}",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = ClawdMutedDark,
                            modifier = Modifier
                                .border(0.5.dp, ClawdBorderDark, RoundedCornerShape(5.dp))
                                .background(Color(0xFF232330), RoundedCornerShape(5.dp))
                                .padding(horizontal = 7.dp, vertical = 2.dp)
                        )
                    }
                }
                if (hasEvents) {
                    Icon(
                        ClawdIcons.ChevronRight,
                        null,
                        tint = Color(0xFF3E3E46),
                        modifier = Modifier.size(14.dp)
                    )
                }
            }

            // Expandable event timeline
            AnimatedVisibility(
                visible = expanded && hasEvents,
                enter = expandVertically(),
                exit = shrinkVertically()
            ) {
                EventTimeline(events = data.recentEvents)
            }
        }
    }
}
