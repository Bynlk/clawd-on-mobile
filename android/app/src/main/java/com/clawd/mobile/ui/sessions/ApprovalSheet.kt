package com.clawd.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
import com.clawd.mobile.data.ElicitationQuestion
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
    onElicitation: (String, Map<String, String>) -> Unit
) {
    val isElicitation = request.toolName == "AskUserQuestion"
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

        // ── Elicitation UI ────────────────────────────────────────────
        if (isElicitation && request.elicitationQuestions.isNotEmpty()) {
            ElicitationContent(
                questions = request.elicitationQuestions,
                onSubmit = { answers -> onElicitation(requestId, answers) }
            )
        }
        // ── Permission UI ─────────────────────────────────────────────
        else {
            if (!request.toolName.isNullOrBlank()) {
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

            val hasSuggestions = request.suggestions.isNotEmpty() && request.suggestions.all { it.label.isNotBlank() }

            // Suggestion buttons (e.g. "Auto-accept edits")
            if (hasSuggestions) {
                request.suggestions.forEachIndexed { index, suggestion ->
                    val isAutoAccept = suggestion.mode == "acceptEdits" || suggestion.label.contains("accept", ignoreCase = true)
                    val isAllow = suggestion.behavior == "allow"
                    val translatedLabel = translateSuggestionLabel(suggestion.label, suggestion.mode)
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
                        Text(translatedLabel, modifier = Modifier.padding(vertical = 4.dp))
                    }
                }
            }

            // Allow / Deny — always visible
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = if (hasSuggestions) 8.dp else 0.dp),
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

// ── Elicitation internals ─────────────────────────────────────────────

/**
 * Multi-question stepper for AskUserQuestion.
 * State: [activeStep], [selectedAnswers] (questionIndex → set of option indices),
 * [otherTexts] (questionIndex → free text for "Other").
 */
@Composable
private fun ElicitationContent(
    questions: List<ElicitationQuestion>,
    onSubmit: (Map<String, String>) -> Unit
) {
    val totalSteps = questions.size
    var activeStep by remember { mutableIntStateOf(0) }
    // questionIndex → selected option indices (including "Other" at index = options.size)
    var selectedAnswers by remember { mutableStateOf<Map<Int, Set<Int>>>(emptyMap()) }
    // questionIndex → "Other" free text
    var otherTexts by remember { mutableStateOf<Map<Int, String>>(emptyMap()) }

    val question = questions[activeStep]
    val selected = selectedAnswers[activeStep] ?: emptySet()
    val otherText = otherTexts[activeStep] ?: ""

    // Whether current question is answerable
    val canProceed = remember(question, selected, otherText) {
        if (selected.isEmpty()) false
        else if (selected.contains(question.options.size) && otherText.isBlank()) false
        else true
    }

    // Step indicator (multi-question only)
    if (totalSteps > 1) {
        Text(
            stringResource(R.string.elicitation_question_of, activeStep + 1, totalSteps),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = ClawdMutedDark,
            modifier = Modifier.padding(bottom = 8.dp)
        )
    }

    // Question header
    if (question.header != null) {
        Text(
            question.header,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = ClawdMutedDark,
            modifier = Modifier.padding(bottom = 2.dp)
        )
    }
    Text(
        question.question,
        fontSize = 15.sp,
        fontWeight = FontWeight.Bold,
        color = ClawdTextDark,
        modifier = Modifier.padding(bottom = 4.dp)
    )

    // Hint
    Text(
        if (question.multiSelect) stringResource(R.string.elicitation_choose_multiple)
        else stringResource(R.string.elicitation_choose_one),
        fontSize = 12.sp,
        color = ClawdFaintDark,
        modifier = Modifier.padding(bottom = 12.dp)
    )

    // Options list
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(ClawdSurfaceAltDark, RoundedCornerShape(10.dp))
            .padding(4.dp)
    ) {
        question.options.forEachIndexed { index, option ->
            val isSelected = selected.contains(index)
            OptionRow(
                label = option.label,
                description = option.description,
                isMultiSelect = question.multiSelect,
                isSelected = isSelected,
                onClick = {
                    selectedAnswers = if (question.multiSelect) {
                        val next = if (isSelected) selected - index else selected + index
                        selectedAnswers + (activeStep to next)
                    } else {
                        selectedAnswers + (activeStep to setOf(index))
                    }
                }
            )
        }

        // "Other" option — always present (matches PC behavior)
        val otherIndex = question.options.size
        val isOtherSelected = selected.contains(otherIndex)
        OptionRow(
            label = stringResource(R.string.elicitation_other),
            description = null,
            isMultiSelect = question.multiSelect,
            isSelected = isOtherSelected,
            onClick = {
                selectedAnswers = if (question.multiSelect) {
                    val next = if (isOtherSelected) selected - otherIndex else selected + otherIndex
                    selectedAnswers + (activeStep to next)
                } else {
                    selectedAnswers + (activeStep to setOf(otherIndex))
                }
            }
        )

        // Other text field (visible when Other is selected)
        AnimatedVisibility(visible = isOtherSelected) {
            OutlinedTextField(
                value = otherText,
                onValueChange = { newText ->
                    otherTexts = otherTexts + (activeStep to newText)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                placeholder = {
                    Text(stringResource(R.string.elicitation_other), fontSize = 13.sp, color = ClawdFaintDark)
                },
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = ClawdTextDark,
                    unfocusedTextColor = ClawdTextDark,
                    focusedBorderColor = ClawdAccent,
                    unfocusedBorderColor = ClawdSubtleDark,
                    cursorColor = ClawdAccent,
                ),
                shape = RoundedCornerShape(8.dp),
            )
        }
    }

    Spacer(modifier = Modifier.height(12.dp))

    // Navigation buttons
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)
    ) {
        // Previous (multi-question only)
        if (totalSteps > 1 && activeStep > 0) {
            OutlinedButton(
                onClick = { activeStep-- },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = ClawdMutedDark),
                shape = RoundedCornerShape(10.dp),
            ) {
                Text(stringResource(R.string.elicitation_previous), modifier = Modifier.padding(vertical = 4.dp))
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Next / Submit
        val isLastStep = activeStep >= totalSteps - 1
        Button(
            onClick = {
                if (isLastStep) {
                    // Collect all answers
                    val answers = collectElicitationAnswers(questions, selectedAnswers, otherTexts)
                    if (answers != null) onSubmit(answers)
                } else {
                    activeStep++
                }
            },
            enabled = canProceed,
            colors = ButtonDefaults.buttonColors(
                containerColor = ClawdAccent,
                contentColor = Color.White,
                disabledContainerColor = ClawdAccent.copy(alpha = 0.3f),
                disabledContentColor = Color.White.copy(alpha = 0.5f),
            ),
            shape = RoundedCornerShape(10.dp)
        ) {
            Text(
                if (isLastStep) stringResource(R.string.elicitation_submit)
                else stringResource(R.string.elicitation_next),
                modifier = Modifier.padding(vertical = 4.dp)
            )
        }
    }
}

@Composable
private fun OptionRow(
    label: String,
    description: String?,
    isMultiSelect: Boolean,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        if (isMultiSelect) {
            Checkbox(
                checked = isSelected,
                onCheckedChange = { onClick() },
                colors = CheckboxDefaults.colors(
                    checkedColor = ClawdAccent,
                    uncheckedColor = ClawdSubtleDark,
                )
            )
        } else {
            RadioButton(
                selected = isSelected,
                onClick = onClick,
                colors = RadioButtonDefaults.colors(
                    selectedColor = ClawdAccent,
                    unselectedColor = ClawdSubtleDark,
                )
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        Column {
            Text(label, fontSize = 14.sp, color = ClawdTextDark)
            if (!description.isNullOrBlank()) {
                Text(description, fontSize = 12.sp, color = ClawdFaintDark)
            }
        }
    }
}

/**
 * Collect all answers as { questionText: answerText }.
 * Returns null if any question is unanswered.
 */
private fun collectElicitationAnswers(
    questions: List<ElicitationQuestion>,
    selectedAnswers: Map<Int, Set<Int>>,
    otherTexts: Map<Int, String>
): Map<String, String>? {
    val answers = mutableMapOf<String, String>()
    for ((qi, question) in questions.withIndex()) {
        val selected = selectedAnswers[qi] ?: return null
        if (selected.isEmpty()) return null
        val parts = selected.sorted().mapNotNull { oi ->
            if (oi == question.options.size) {
                // "Other" option — use free text
                otherTexts[qi]?.takeIf { it.isNotBlank() }
            } else {
                question.options[oi].label
            }
        }
        if (parts.isEmpty()) return null
        answers[question.question] = parts.joinToString(", ")
    }
    return answers
}

/**
 * Translate well-known English suggestion labels to Chinese.
 * Falls back to the original label for dynamic / unknown strings.
 */
private fun translateSuggestionLabel(label: String, mode: String?): String {
    // mode-based translations
    if (mode == "acceptEdits") return "自动接受编辑"
    if (mode == "plan") return "切换到计划模式"
    // label-based fallback
    val lower = label.lowercase()
    return when {
        lower == "auto-accept edits" -> "自动接受编辑"
        lower == "always allow" -> "始终允许"
        lower == "switch to plan mode" -> "切换到计划模式"
        lower.startsWith("allow ") && lower.contains(" in ") -> {
            // "Allow Bash in /some/path" → "允许 Bash 在 /some/path"
            val parts = label.removePrefix("Allow ").split(" in ", limit = 2)
            if (parts.size == 2) "允许 ${parts[0]} 在 ${parts[1]}" else label
        }
        lower.startsWith("always allow:") -> "始终允许: ${label.removePrefix("Always allow:").trim()}"
        else -> label
    }
}
