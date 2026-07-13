package com.clawd.mobile.ui.console

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.clawd.mobile.console.ManagedAgent
import com.clawd.mobile.R
import androidx.compose.ui.res.stringResource

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateSessionSheet(
    agents: List<ManagedAgent>,
    directories: List<String>,
    onDismiss: () -> Unit,
    onCreate: (String, String) -> Unit,
) {
    var agent by remember(agents) { mutableStateOf(agents.firstOrNull()) }
    var directory by remember(directories) { mutableStateOf(directories.firstOrNull()) }
    var agentMenu by remember { mutableStateOf(false) }
    var directoryMenu by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.console_new_session), style = MaterialTheme.typography.titleLarge)
            Box {
                OutlinedButton(onClick = { agentMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(agent?.name ?: stringResource(R.string.console_choose_agent))
                }
                DropdownMenu(expanded = agentMenu, onDismissRequest = { agentMenu = false }) {
                    agents.forEach { value -> DropdownMenuItem(
                        text = { Text(value.name) },
                        onClick = { agent = value; agentMenu = false },
                    ) }
                }
            }
            Box {
                OutlinedButton(onClick = { directoryMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(directory ?: stringResource(R.string.console_choose_directory))
                }
                DropdownMenu(expanded = directoryMenu, onDismissRequest = { directoryMenu = false }) {
                    directories.forEach { value -> DropdownMenuItem(
                        text = { Text(value) },
                        onClick = { directory = value; directoryMenu = false },
                    ) }
                }
            }
            Button(
                onClick = { onCreate(agent!!.id, directory!!); onDismiss() },
                enabled = agent != null && directory != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.console_create)) }
            Spacer(Modifier.height(16.dp))
        }
    }
}
