package com.clawd.mobile.ui.manual

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.clawd.mobile.R
import com.clawd.mobile.data.ConnectionConfig
import com.clawd.mobile.data.PrefsStore

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualScreen(
    prefsStore: PrefsStore,
    onBack: () -> Unit,
    onConnect: (ConnectionConfig) -> Unit
) {
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("23334") }
    var token by remember { mutableStateOf("") }
    var tokenVisible by remember { mutableStateOf(false) }
    var showError by remember { mutableStateOf(false) }
    val history = remember { mutableStateOf(prefsStore.getHistory()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.manual_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back))
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text(stringResource(R.string.manual_host_label)) },
                placeholder = { Text("192.168.1.10") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = port,
                onValueChange = { port = it },
                label = { Text(stringResource(R.string.manual_port_label)) },
                placeholder = { Text("23334") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text(stringResource(R.string.manual_token_label)) },
                placeholder = { Text(stringResource(R.string.manual_token_placeholder)) },
                singleLine = true,
                visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    IconButton(onClick = { tokenVisible = !tokenVisible }) {
                        Icon(
                            imageVector = if (tokenVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                            contentDescription = if (tokenVisible) "Hide token" else "Show token"
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth()
            )

            if (showError) {
                Text(
                    stringResource(R.string.manual_fill_required),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }

            Button(
                onClick = {
                    val p = port.toIntOrNull()
                    if (host.isBlank() || p == null || token.isBlank()) {
                        showError = true
                    } else {
                        showError = false
                        onConnect(ConnectionConfig(host, p, token))
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(R.string.manual_connect))
            }

            if (history.value.isNotEmpty()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(stringResource(R.string.manual_history), style = MaterialTheme.typography.titleSmall)
                history.value.forEachIndexed { index, config ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            "${config.host}:${config.port}",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = { onConnect(config) }) {
                            Text(stringResource(R.string.manual_connect))
                        }
                        TextButton(onClick = {
                            prefsStore.removeFromHistory(index)
                            history.value = prefsStore.getHistory()
                        }) {
                            Text(stringResource(R.string.manual_delete))
                        }
                    }
                }
            }
        }
    }
}
