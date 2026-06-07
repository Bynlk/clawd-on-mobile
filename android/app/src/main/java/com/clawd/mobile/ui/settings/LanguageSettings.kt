package com.clawd.mobile.ui.settings

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clawd.mobile.R
import com.clawd.mobile.data.PrefsStore
import com.clawd.mobile.ui.theme.*

@Composable
internal fun LanguageSection(prefsStore: PrefsStore) {
    val context = LocalContext.current
    var currentLang by remember { mutableStateOf(prefsStore.getLanguage()) }

    Text(
        stringResource(R.string.settings_language_desc),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    val languages = listOf(
        "zh" to stringResource(R.string.settings_language_zh),
        "en" to stringResource(R.string.settings_language_en)
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        languages.forEach { (code, label) ->
            FilterChip(
                selected = currentLang == code,
                onClick = {
                    if (currentLang != code) {
                        currentLang = code
                        prefsStore.setLanguage(code)
                        // Recreate activity to apply new locale
                        (context as? Activity)?.recreate()
                    }
                },
                label = { Text(label, fontSize = 13.sp) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = ClawdAccent,
                    selectedLabelColor = Color.White
                )
            )
        }
    }
}
