package com.clawd.mobile.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.data.RecentEvent
import com.clawd.mobile.data.Session
import com.clawd.mobile.ui.theme.ClawdFaintDark

internal val EVENT_STATE_COLORS = mapOf(
    "error" to Color(0xFFEF4444),
    "attention" to Color(0xFFB45309),
    "working" to Color(0xFF16A34A),
    "juggling" to Color(0xFFB45309),
    "thinking" to Color(0xFF6366F1),
    "notification" to Color(0xFFB45309),
    "sweeping" to Color(0xFF71717A),
    "carrying" to Color(0xFF71717A),
    "idle" to Color(0xFF71717A),
    "sleeping" to Color(0xFFA1A1AA),
)

@Composable
internal fun EventTimeline(events: List<RecentEvent>) {
    Column(
        modifier = Modifier.padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        events.forEach { event ->
            val eventColor = EVENT_STATE_COLORS[event.state] ?: EVENT_STATE_COLORS["idle"]!!
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(vertical = 3.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(eventColor)
                )
                Text(
                    Session.eventLabel(event.event, LocalContext.current),
                    fontSize = 11.sp,
                    color = ClawdFaintDark,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    formatAgo(event.at, LocalContext.current),
                    fontSize = 11.sp,
                    color = ClawdFaintDark
                )
            }
        }
    }
}
