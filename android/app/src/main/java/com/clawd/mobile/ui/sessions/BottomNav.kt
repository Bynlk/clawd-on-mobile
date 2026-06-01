package com.clawd.mobile.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.ui.components.ClawdIcons
import com.clawd.mobile.ui.theme.*

@Composable
internal fun BottomNav(selectedTab: Int, onTabSelected: (Int) -> Unit, modifier: Modifier = Modifier) {
    val tabs = listOf(
        Triple(ClawdIcons.LayoutList, stringResource(R.string.sessions_tab_sessions), 0),
        Triple(ClawdIcons.DeviceDesktop, stringResource(R.string.sessions_tab_devices), 1),
        Triple(ClawdIcons.Settings, stringResource(R.string.sessions_tab_settings), 2)
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 16.dp)
            .border(0.5.dp, ClawdCardBorderDark, RoundedCornerShape(14.dp))
            .background(ClawdCardDark.copy(alpha = 0.95f), RoundedCornerShape(14.dp))
            .padding(vertical = 10.dp, horizontal = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        tabs.forEachIndexed { _, (icon, label, index) ->
            val isActive = selectedTab == index
            Column(
                modifier = Modifier
                    .weight(1f)
                    .clickable { onTabSelected(index) }
                    .padding(vertical = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(
                    icon,
                    label,
                    tint = if (isActive) ClawdAccent else ClawdFaintDark,
                    modifier = Modifier.size(20.dp)
                )
                Text(
                    label,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (isActive) ClawdAccent else ClawdFaintDark,
                    letterSpacing = 0.2.sp
                )
            }
        }
    }
}
