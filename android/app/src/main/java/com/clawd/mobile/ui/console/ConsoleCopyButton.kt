package com.clawd.mobile.ui.console

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import com.clawd.mobile.R

@Composable
fun ConsoleCopyButton(value: String) {
    val clipboard = LocalClipboardManager.current
    TextButton(
        onClick = { clipboard.setText(AnnotatedString(value)) },
        enabled = value.isNotEmpty(),
    ) {
        Text(stringResource(R.string.console_copy))
    }
}
