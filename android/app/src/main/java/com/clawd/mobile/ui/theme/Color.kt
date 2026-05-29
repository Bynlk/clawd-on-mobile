package com.clawd.mobile.ui.theme

import androidx.compose.ui.graphics.Color

// Clawd brand colors — dashboard aligned
val ClawdAccent = Color(0xFFD97757)          // terracotta
val ClawdAccentLight = Color(0xFFE8A08C)
val ClawdAccentDark = Color(0xFFC4684A)

// Light mode
val ClawdBackground = Color(0xFFF5F5F7)
val ClawdSurface = Color(0xFFFFFFFF)
val ClawdSurfaceAlt = Color(0xFFECECEF)
val ClawdText = Color(0xFF18181B)
val ClawdMuted = Color(0xFF6B6B70)
val ClawdSubtle = Color(0xFF9B9BA0)
val ClawdBorder = Color(0x14000000)          // rgba(0,0,0,0.08)

// Dark mode
val ClawdBackgroundDark = Color(0xFF1C1C1F)
val ClawdSurfaceDark = Color(0xFF232327)
val ClawdSurfaceAltDark = Color(0xFF18181B)
val ClawdTextDark = Color(0xFFF4F4F5)
val ClawdMutedDark = Color(0xFFA1A1AA)
val ClawdSubtleDark = Color(0xFF71717A)
val ClawdBorderDark = Color(0x14FFFFFF)      // rgba(255,255,255,0.08)

// Status colors — dashboard aligned
val ClawdSuccess = Color(0xFF16803C)         // running green
val ClawdError = Color(0xFFEF4444)           // red
val ClawdWarning = Color(0xFFB45309)         // amber
val ClawdBlue = Color(0xFF3B82F6)            // thinking blue

// Legacy aliases for compatibility
val ClawdBg = ClawdBackgroundDark
val ClawdTextPrimary = ClawdTextDark
val ClawdTextSecondary = ClawdMutedDark
val ClawdTextTertiary = ClawdSubtleDark

// State card border colors — dashboard aligned
val StateError = Color(0xFFEF4444)
val StateAttention = Color(0xFFB45309)
val StateWorking = Color(0xFF16803C)
val StateJuggling = Color(0xFF16803C)
val StateThinking = Color(0xFF3B82F6)
val StateNotification = Color(0xFFD97757)
val StateSweeping = Color(0xFF71717A)
val StateCarrying = Color(0xFF71717A)
val StateIdle = Color(0xFF71717A)
val StateSleeping = Color(0xFFA1A1AA)
