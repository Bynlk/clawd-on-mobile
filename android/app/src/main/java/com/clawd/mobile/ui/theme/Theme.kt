package com.clawd.mobile.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private fun findActivity(context: android.content.Context): Activity? {
    var ctx = context
    while (ctx is android.content.ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

private val DarkColorScheme = darkColorScheme(
    primary = ClawdAccent,
    onPrimary = Color.White,
    primaryContainer = ClawdAccentDark,
    onPrimaryContainer = Color.White,
    secondary = ClawdAccentLight,
    onSecondary = Color.White,
    background = ClawdBackgroundDark,
    onBackground = ClawdTextDark,
    surface = ClawdSurfaceDark,
    onSurface = ClawdTextDark,
    surfaceVariant = ClawdSurfaceAltDark,
    onSurfaceVariant = ClawdMutedDark,
    error = ClawdError,
    onError = Color.White,
    outline = ClawdBorderDark,
    outlineVariant = Color(0xFF333340),
)

private val LightColorScheme = lightColorScheme(
    primary = ClawdAccent,
    onPrimary = Color.White,
    primaryContainer = ClawdAccentLight,
    onPrimaryContainer = ClawdText,
    secondary = ClawdAccentDark,
    onSecondary = Color.White,
    background = ClawdBackground,
    onBackground = ClawdText,
    surface = ClawdSurface,
    onSurface = ClawdText,
    surfaceVariant = ClawdSurfaceAlt,
    onSurfaceVariant = ClawdMuted,
    error = ClawdError,
    onError = Color.White,
    outline = ClawdBorder,
    outlineVariant = Color(0xFFE0E0E0),
)

@Composable
fun ClawdMobileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    val view = LocalView.current

    if (!view.isInEditMode) {
        SideEffect {
            val window = findActivity(view.context)?.window ?: return@SideEffect
            window.statusBarColor = (if (darkTheme) ClawdBackgroundDark else ClawdBackground).toArgb()
            window.navigationBarColor = (if (darkTheme) ClawdBackgroundDark else ClawdBackground).toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = ClawdTypography,
        content = content
    )
}
