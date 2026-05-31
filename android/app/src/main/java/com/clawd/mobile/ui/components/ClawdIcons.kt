package com.clawd.mobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Stroke-based line-art icons for Clawd states, matching the PWA SVG icons.
 * All icons: 24dp x 24dp, 2dp stroke, round caps/joins.
 */
object ClawdIcons {

    private val strokeColor = SolidColor(Color.Black) // alpha=1.0 required for Icon tint (BlendMode.SrcIn)

    private fun iconBuilder(name: String, block: ImageVector.Builder.() -> ImageVector.Builder): ImageVector {
        return ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).block().build()
    }

    // Circle with exclamation — error
    val Error: ImageVector = iconBuilder("error") {
        path(
            stroke = strokeColor,
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            fill = SolidColor(Color.Transparent)
        ) {
            // circle
            moveTo(12f, 2f)
            arcTo(10f, 10f, 0f, true, true, 12f, 22f)
            arcTo(10f, 10f, 0f, true, true, 12f, 2f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 8f); lineTo(12f, 12f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 16f); lineTo(12.01f, 16f)
        }
    }

    // Triangle warning — attention
    val Attention: ImageVector = iconBuilder("attention") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(10.29f, 3.86f)
            lineTo(1.82f, 18f)
            arcTo(2f, 2f, 0f, false, false, 3.53f, 21f)
            lineTo(20.47f, 21f)
            arcTo(2f, 2f, 0f, false, false, 22.18f, 18f)
            lineTo(13.71f, 3.86f)
            arcTo(2f, 2f, 0f, false, false, 10.29f, 3.86f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 9f); lineTo(12f, 13f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 17f); lineTo(12.01f, 17f)
        }
    }

    // Gear — working
    val Working: ImageVector = iconBuilder("working") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // center circle
            moveTo(12f, 9f)
            arcTo(3f, 3f, 0f, true, true, 12f, 15f)
            arcTo(3f, 3f, 0f, true, true, 12f, 9f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // outer gear shape (simplified)
            moveTo(19.4f, 15f)
            arcTo(1.65f, 1.65f, 0f, false, false, 19.73f, 16.82f)
            lineTo(19.79f, 16.88f)
            arcTo(2f, 2f, 0f, false, true, 16.96f, 19.71f)
            lineTo(16.9f, 19.65f)
            arcTo(1.65f, 1.65f, 0f, false, false, 15.08f, 19.32f)
            arcTo(1.65f, 1.65f, 0f, false, false, 14.08f, 20.83f)
            lineTo(14.08f, 21f)
            arcTo(2f, 2f, 0f, false, true, 10.08f, 21f)
            lineTo(10.08f, 20.91f)
            arcTo(1.65f, 1.65f, 0f, false, false, 9f, 19.4f)
            arcTo(1.65f, 1.65f, 0f, false, false, 7.18f, 19.73f)
            lineTo(7.12f, 19.79f)
            arcTo(2f, 2f, 0f, false, true, 4.29f, 16.96f)
            lineTo(4.35f, 16.9f)
            arcTo(1.65f, 1.65f, 0f, false, false, 4.68f, 15.08f)
            arcTo(1.65f, 1.65f, 0f, false, false, 3.17f, 14.08f)
            lineTo(3f, 14.08f)
            arcTo(2f, 2f, 0f, false, true, 3f, 10.08f)
            lineTo(3.09f, 10.08f)
            arcTo(1.65f, 1.65f, 0f, false, false, 4.6f, 9f)
            arcTo(1.65f, 1.65f, 0f, false, false, 4.27f, 7.18f)
            lineTo(4.21f, 7.12f)
            arcTo(2f, 2f, 0f, false, true, 7.04f, 4.29f)
            lineTo(7.1f, 4.35f)
            arcTo(1.65f, 1.65f, 0f, false, false, 8.92f, 4.68f)
            arcTo(1.65f, 1.65f, 0f, false, false, 9.92f, 3.17f)
            lineTo(9.92f, 3f)
            arcTo(2f, 2f, 0f, false, true, 13.92f, 3f)
            lineTo(13.92f, 3.09f)
            arcTo(1.65f, 1.65f, 0f, false, false, 15f, 4.6f)
            arcTo(1.65f, 1.65f, 0f, false, false, 16.82f, 4.27f)
            lineTo(16.88f, 4.21f)
            arcTo(2f, 2f, 0f, false, true, 19.71f, 7.04f)
            lineTo(19.65f, 7.1f)
            arcTo(1.65f, 1.65f, 0f, false, false, 19.32f, 8.92f)
            arcTo(1.65f, 1.65f, 0f, false, false, 20.83f, 9.92f)
            lineTo(21f, 9.92f)
            arcTo(2f, 2f, 0f, false, true, 21f, 13.92f)
            lineTo(20.91f, 13.92f)
            arcTo(1.65f, 1.65f, 0f, false, false, 19.4f, 15f)
            close()
        }
    }

    // Layers — juggling
    val Juggling: ImageVector = iconBuilder("juggling") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // three stacked layers
            moveTo(2f, 7f); lineTo(22f, 7f)
            moveTo(2f, 12f); lineTo(22f, 12f)
            moveTo(2f, 17f); lineTo(22f, 17f)
        }
    }

    // Thought bubble — thinking
    val Thinking: ImageVector = iconBuilder("thinking") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // chat bubble
            moveTo(21f, 15f)
            arcTo(2f, 2f, 0f, false, true, 19f, 17f)
            lineTo(7f, 17f)
            lineTo(3f, 21f)
            lineTo(3f, 5f)
            arcTo(2f, 2f, 0f, false, true, 5f, 3f)
            lineTo(19f, 3f)
            arcTo(2f, 2f, 0f, false, true, 21f, 5f)
            close()
        }
        // three dots
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(8f, 10f); lineTo(8.01f, 10f)
            moveTo(12f, 10f); lineTo(12.01f, 10f)
            moveTo(16f, 10f); lineTo(16.01f, 10f)
        }
    }

    // Bell — notification
    val Notification: ImageVector = iconBuilder("notification") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(18f, 8f)
            arcTo(6f, 6f, 0f, false, false, 6f, 8f)
            curveTo(6f, 15f, 3f, 17f, 3f, 17f)
            lineTo(21f, 17f)
            curveTo(21f, 17f, 18f, 15f, 18f, 8f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(13.73f, 21f)
            arcTo(2f, 2f, 0f, false, true, 10.27f, 21f)
        }
    }

    // Broom — sweeping
    val Sweeping: ImageVector = iconBuilder("sweeping") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(5f, 21f)
            curveTo(6.5f, 19.5f, 8f, 19f, 12f, 19f)
            curveTo(16f, 19f, 17.5f, 19.5f, 19f, 21f)
            moveTo(12f, 3f)
            lineTo(12f, 11f)
            lineTo(9f, 8f)
            moveTo(12f, 11f)
            lineTo(15f, 8f)
            moveTo(12f, 5f)
            arcTo(7f, 7f, 0f, false, true, 19f, 12f)
        }
    }

    // Box — carrying
    val Carrying: ImageVector = iconBuilder("carrying") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(21f, 16f)
            lineTo(21f, 8f)
            arcTo(2f, 2f, 0f, false, false, 20f, 6.27f)
            lineTo(13f, 2.27f)
            arcTo(2f, 2f, 0f, false, false, 11f, 2.27f)
            lineTo(4f, 6.27f)
            arcTo(2f, 2f, 0f, false, false, 3f, 8f)
            lineTo(3f, 16f)
            arcTo(2f, 2f, 0f, false, false, 4f, 17.73f)
            lineTo(11f, 21.73f)
            arcTo(2f, 2f, 0f, false, false, 13f, 21.73f)
            lineTo(20f, 17.73f)
            arcTo(2f, 2f, 0f, false, false, 21f, 16f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(3.27f, 6.96f); lineTo(12f, 12.01f); lineTo(20.73f, 6.96f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 22.08f); lineTo(12f, 12f)
        }
    }

    // Moon — idle
    val Idle: ImageVector = iconBuilder("idle") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(21f, 12.79f)
            arcTo(9f, 9f, 0f, true, true, 11.21f, 3f)
            arcTo(7f, 7f, 0f, false, false, 21f, 12.79f)
            close()
        }
    }

    // Zzz — sleeping
    val Sleeping: ImageVector = iconBuilder("sleeping") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(2f, 12f)
            lineTo(6f, 12f)
            lineTo(8f, 8f)
            lineTo(11f, 16f)
            lineTo(14f, 10f)
            lineTo(16f, 14f)
            lineTo(20f, 14f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 20f); lineTo(20f, 20f)
        }
    }

    // Wrench — tool indicator
    val Tool: ImageVector = iconBuilder("tool") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(14.7f, 6.3f)
            arcTo(1f, 1f, 0f, false, false, 16.1f, 7.7f)
            lineTo(17.7f, 6.1f) // simplified wrench
            arcTo(6f, 6f, 0f, false, true, 9.76f, 14.06f)
            lineTo(2.85f, 20.97f)
            arcTo(2.12f, 2.12f, 0f, false, true, -0.14f, 17.98f) // won't render negative, simplified
            lineTo(6.94f, 11.06f) // back
            arcTo(6f, 6f, 0f, false, true, 14.7f, 6.3f)
            close()
        }
    }

    // Folder — cwd indicator
    val Folder: ImageVector = iconBuilder("folder") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(22f, 19f)
            arcTo(2f, 2f, 0f, false, true, 20f, 21f)
            lineTo(4f, 21f)
            arcTo(2f, 2f, 0f, false, true, 2f, 19f)
            lineTo(2f, 5f)
            arcTo(2f, 2f, 0f, false, true, 4f, 3f)
            lineTo(9f, 3f)
            lineTo(11f, 6f)
            lineTo(20f, 6f)
            arcTo(2f, 2f, 0f, false, true, 22f, 8f)
            close()
        }
    }

    // Paw — empty state
    val Paw: ImageVector = iconBuilder("paw") {
        // four toe circles
        path(stroke = strokeColor, strokeLineWidth = 1.5f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top left toe
            moveTo(6f, 6f)
            arcTo(2f, 2f, 0f, true, true, 6f, 10f)
            arcTo(2f, 2f, 0f, true, true, 6f, 6f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 1.5f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top right toe
            moveTo(18f, 6f)
            arcTo(2f, 2f, 0f, true, true, 18f, 10f)
            arcTo(2f, 2f, 0f, true, true, 18f, 6f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 1.5f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom left toe
            moveTo(11f, 4f)
            arcTo(2f, 2f, 0f, true, true, 11f, 8f)
            arcTo(2f, 2f, 0f, true, true, 11f, 4f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 1.5f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // pad
            moveTo(7.5f, 14f)
            arcTo(4.5f, 3.5f, 0f, false, false, 16.5f, 14f)
            arcTo(4.5f, 3.5f, 0f, false, false, 7.5f, 14f)
            close()
        }
    }

    // Chevron down — expand
    val Expand: ImageVector = iconBuilder("expand") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(6f, 9f); lineTo(12f, 15f); lineTo(18f, 9f)
        }
    }

    // Chevron up — collapse
    val Collapse: ImageVector = iconBuilder("collapse") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(18f, 15f); lineTo(12f, 9f); lineTo(6f, 15f)
        }
    }

    // Shield — approval
    val Shield: ImageVector = iconBuilder("shield") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 22f)
            curveTo(12f, 22f, 20f, 18f, 20f, 12f)
            lineTo(20f, 5f)
            lineTo(12f, 2f)
            lineTo(4f, 5f)
            lineTo(4f, 12f)
            curveTo(4f, 18f, 12f, 22f, 12f, 22f)
            close()
        }
    }

    // Clock — time indicator
    val Clock: ImageVector = iconBuilder("clock") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 2f)
            arcTo(10f, 10f, 0f, true, true, 12f, 22f)
            arcTo(10f, 10f, 0f, true, true, 12f, 2f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 6f); lineTo(12f, 12f); lineTo(16f, 14f)
        }
    }

    // Checks — batch approve (double checkmark)
    val Checks: ImageVector = iconBuilder("checks") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(7f, 12f); lineTo(10f, 15f); lineTo(17f, 8f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(3f, 12f); lineTo(6f, 15f)
        }
    }

    // Refresh — circular arrows (simplified)
    val Refresh: ImageVector = iconBuilder("refresh") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top arc arrow
            moveTo(20f, 8f); lineTo(20f, 4f); lineTo(16f, 4f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom arc arrow
            moveTo(4f, 16f); lineTo(4f, 20f); lineTo(8f, 20f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top arc
            moveTo(20f, 4f)
            lineTo(18f, 5f)
            lineTo(14f, 5f)
            lineTo(10f, 6f)
            lineTo(6f, 8f)
            lineTo(4f, 10f)
            lineTo(4f, 16f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom arc
            moveTo(4f, 20f)
            lineTo(6f, 19f)
            lineTo(10f, 19f)
            lineTo(14f, 18f)
            lineTo(18f, 16f)
            lineTo(20f, 14f)
            lineTo(20f, 8f)
        }
    }

    // History — clock with counter-arrow
    val History: ImageVector = iconBuilder("history") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // circle
            moveTo(12f, 2f)
            arcTo(10f, 10f, 0f, true, true, 12f, 22f)
            arcTo(10f, 10f, 0f, true, true, 12f, 2f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // clock hands
            moveTo(12f, 6f); lineTo(12f, 12f); lineTo(16f, 14f)
        }
    }

    // Bell — notification tab (simplified)
    val Bell: ImageVector = iconBuilder("bell") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bell body
            moveTo(4f, 12f)
            lineTo(4f, 10f)
            lineTo(5f, 8f)
            lineTo(6f, 6f)
            lineTo(8f, 5f)
            lineTo(10f, 4f)
            lineTo(12f, 4f)
            lineTo(14f, 4f)
            lineTo(16f, 5f)
            lineTo(18f, 6f)
            lineTo(19f, 8f)
            lineTo(20f, 10f)
            lineTo(20f, 12f)
            lineTo(4f, 12f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom
            moveTo(4f, 12f); lineTo(2f, 16f); lineTo(22f, 16f); lineTo(20f, 12f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // clapper
            moveTo(9f, 16f)
            lineTo(10f, 18f)
            lineTo(12f, 19f)
            lineTo(14f, 18f)
            lineTo(15f, 16f)
        }
    }

    // DeviceDesktop — device tab (simplified)
    val DeviceDesktop: ImageVector = iconBuilder("deviceDesktop") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // screen
            moveTo(2f, 4f); lineTo(22f, 4f); lineTo(22f, 15f); lineTo(2f, 15f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // stand
            moveTo(8f, 19f); lineTo(16f, 19f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // neck
            moveTo(12f, 15f); lineTo(12f, 19f)
        }
    }

    // UserCircle — my tab (simplified)
    val UserCircle: ImageVector = iconBuilder("userCircle") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // circle
            moveTo(12f, 2f)
            arcTo(10f, 10f, 0f, true, true, 12f, 22f)
            arcTo(10f, 10f, 0f, true, true, 12f, 2f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // head
            moveTo(12f, 4f)
            lineTo(14f, 5f)
            lineTo(15f, 7f)
            lineTo(15f, 9f)
            lineTo(14f, 10f)
            lineTo(12f, 11f)
            lineTo(10f, 10f)
            lineTo(9f, 9f)
            lineTo(9f, 7f)
            lineTo(10f, 5f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // body
            moveTo(5f, 19f)
            lineTo(7f, 15f)
            lineTo(9f, 13f)
            lineTo(12f, 13f)
            lineTo(15f, 13f)
            lineTo(17f, 15f)
            lineTo(19f, 19f)
        }
    }

    // LayoutList — sessions tab (simplified)
    val LayoutList: ImageVector = iconBuilder("layoutList") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 4f); lineTo(20f, 4f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 8f); lineTo(20f, 8f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 12f); lineTo(16f, 12f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 16f); lineTo(18f, 16f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(4f, 20f); lineTo(14f, 20f)
        }
    }

    // ChevronRight — card footer arrow
    val ChevronRight: ImageVector = iconBuilder("chevronRight") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(9f, 6f); lineTo(15f, 12f); lineTo(9f, 18f)
        }
    }

    // Activity — event label icon
    val Activity: ImageVector = iconBuilder("activity") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(3f, 12f); lineTo(7f, 12f); lineTo(10f, 4f); lineTo(13f, 20f); lineTo(16f, 8f); lineTo(19f, 12f); lineTo(21f, 12f)
        }
    }

    // Robot — agent icon (simplified, no arcs)
    val Robot: ImageVector = iconBuilder("robot") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // head
            moveTo(4f, 7f); lineTo(20f, 7f); lineTo(20f, 16f); lineTo(4f, 16f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // antenna
            moveTo(12f, 4f); lineTo(12f, 7f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // antenna tip
            moveTo(9f, 4f); lineTo(15f, 4f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // left eye
            moveTo(8f, 10f); lineTo(8.01f, 10f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // right eye
            moveTo(16f, 10f); lineTo(16.01f, 10f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // mouth
            moveTo(9f, 14f); lineTo(15f, 14f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // legs
            moveTo(8f, 16f); lineTo(8f, 21f); lineTo(10f, 21f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(16f, 16f); lineTo(16f, 21f); lineTo(14f, 21f)
        }
    }

    // QR Code — scan button (simplified)
    val QrCode: ImageVector = iconBuilder("qrCode") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top-left block
            moveTo(4f, 4f); lineTo(10f, 4f); lineTo(10f, 10f); lineTo(4f, 10f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // top-right block
            moveTo(14f, 4f); lineTo(20f, 4f); lineTo(20f, 10f); lineTo(14f, 10f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom-left block
            moveTo(4f, 14f); lineTo(10f, 14f); lineTo(10f, 20f); lineTo(4f, 20f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // bottom-right dots
            moveTo(14f, 14f); lineTo(16f, 14f); lineTo(16f, 16f); lineTo(14f, 16f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(18f, 18f); lineTo(20f, 18f); lineTo(20f, 20f); lineTo(18f, 20f); close()
        }
    }

    // Pet — crab icon for floating pet
    val Pet: ImageVector = iconBuilder("pet") {
        // body (round)
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(12f, 8f)
            arcTo(5f, 5f, 0f, true, true, 12f, 18f)
            arcTo(5f, 5f, 0f, true, true, 12f, 8f)
            close()
        }
        // eyes
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(9.5f, 11.5f); lineTo(9.51f, 11.5f)
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(14.5f, 11.5f); lineTo(14.51f, 11.5f)
        }
        // left claw
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(7.8f, 11.2f)
            lineTo(5f, 5f)
            arcTo(3f, 3f, 0f, false, true, 8f, 4.5f)
        }
        // right claw
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(16.2f, 11.2f)
            lineTo(19f, 5f)
            arcTo(3f, 3f, 0f, false, false, 16f, 4.5f)
        }
    }

    // Pencil — edit/rename
    val Pencil: ImageVector = iconBuilder("pencil") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(17f, 3f)
            lineTo(21f, 7f)
            lineTo(8f, 20f)
            lineTo(4f, 20f)
            lineTo(4f, 16f)
            close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            moveTo(15f, 5f); lineTo(19f, 9f)
        }
    }

    // Settings — gear for settings button (simplified, no complex arcs)
    val Settings: ImageVector = iconBuilder("settings") {
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // gear teeth
            moveTo(12f, 3f); lineTo(13f, 3f); lineTo(13.5f, 5.5f)
            lineTo(15f, 6f); lineTo(17f, 4.5f); lineTo(18f, 5.5f)
            lineTo(17f, 7.5f); lineTo(17.5f, 9f); lineTo(20f, 9.5f)
            lineTo(20.5f, 11f); lineTo(18f, 12f); lineTo(18f, 12.5f)
            lineTo(20.5f, 13.5f); lineTo(20f, 15f); lineTo(17.5f, 15f)
            lineTo(17f, 16.5f); lineTo(18f, 18.5f); lineTo(16.5f, 19.5f)
            lineTo(15f, 18f); lineTo(13.5f, 18.5f); lineTo(13f, 21f)
            lineTo(11f, 21f); lineTo(10.5f, 18.5f); lineTo(9f, 18f)
            lineTo(7.5f, 19.5f); lineTo(6f, 18.5f); lineTo(7f, 16.5f)
            lineTo(6.5f, 15f); lineTo(4f, 15f); lineTo(3.5f, 13.5f)
            lineTo(6f, 12.5f); lineTo(6f, 12f); lineTo(3.5f, 11f)
            lineTo(4f, 9.5f); lineTo(6.5f, 9f); lineTo(7f, 7.5f)
            lineTo(6f, 5.5f); lineTo(7.5f, 4.5f); lineTo(9f, 6f)
            lineTo(10.5f, 5.5f); lineTo(11f, 3f); close()
        }
        path(stroke = strokeColor, strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
            // inner circle
            moveTo(16f, 12f)
            lineTo(15.5f, 14f)
            lineTo(14f, 15.5f)
            lineTo(12f, 16f)
            lineTo(10f, 15.5f)
            lineTo(8.5f, 14f)
            lineTo(8f, 12f)
            lineTo(8.5f, 10f)
            lineTo(10f, 8.5f)
            lineTo(12f, 8f)
            lineTo(14f, 8.5f)
            lineTo(15.5f, 10f)
            close()
        }
    }
}
