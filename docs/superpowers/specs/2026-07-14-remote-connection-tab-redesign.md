# Remote Connection Tab Redesign

## Goal

Replace the current WireGuard Relay settings layout with a state-driven page that preserves the existing backend and IPC behavior while making both first-time deployment and daily connection obvious.

The primary workflow is fixed:

1. Enter four SSH values and deploy once.
2. After deployment, connect or disconnect this computer with one primary action.
3. Pair Android from a dedicated phone row.
4. Open maintenance controls only when repairing, rotating, or deleting a configuration.

## Current problems

- VPS deployment, PC tunnel state, and Android pairing are presented as one connection status.
- A failure can render a failed badge, a recovery warning, and an error banner at the same time.
- The ten-row deployment list remains visible after a failed deployment because progress visibility is not reset.
- Recovery and daily actions sit below the long progress list and can fall below the fold.
- QR, rotation, repair, and deletion actions receive similar visual weight even when some cannot succeed.
- The tab owns data selection, async state, progress mapping, DOM construction, focus management, and dialogs in one file of more than 1,200 lines.

## Chosen approach

Use a derived page mode and three explicit connection domains. Keep the existing deployment, connection, QR, rotation, and deletion IPC methods.

Rejected alternatives:

- **Patch the current card:** fastest, but preserves the mixed state model and stale-progress behavior.
- **Full multi-page wizard:** makes first-time setup clear but adds steps and leaves daily connection buried behind installer structure.

## Page modes

### Setup

Shown when no deployed profile exists.

- Four fields only: public IP/domain, SSH username, SSH port, SSH password.
- WireGuard subnet and ports remain smart defaults.
- One primary action: `Deploy remote connection`.
- Password retention guidance sits next to the password field.
- Validation errors appear once, adjacent to the form.

### Deploying

The setup form is replaced by a focused progress surface.

- Show one current-step sentence and an overall progress indicator.
- A `Show details` disclosure contains the existing ten technical stages.
- Disable navigation-sensitive actions while the deployment transaction is active.
- On success, transition to Ready and make phone pairing the next visible task.

### Ready or connected

Show a compact summary with three rows:

1. **VPS Relay:** configured, with the host as supporting text.
2. **This computer:** disconnected, connecting, connected, or failed.
3. **Android:** pairing available, with `Show pairing QR` as the row action.

The computer row owns the only primary page action: `Connect this computer` or `Disconnect`.

`Pair a different phone`, `Repair deployment`, and `Delete local configuration` live under an `Advanced management` disclosure. Delete remains visually destructive.

### Repair required

- Replace duplicate warning/error blocks with one actionable callout.
- Explain the concrete local condition and present one primary action: `Repair deployment`.
- Hide actions that require missing or unreadable secrets, including QR and phone rotation.
- The repair form appears inline after the user chooses repair. It may expose advanced network defaults because this is an exceptional maintenance path.

### Failure during deployment

- Keep only the failed/current stage summary and one localized error.
- Offer `Try deployment again`; retain the non-password draft.
- Hide the ten-stage list by default and never leave all stages marked pending after the operation finishes.

## View architecture

Add a small pure view-model module that derives the page from:

- deployed profile presence;
- runtime connection status;
- active operation kind;
- repair-required error code;
- progress stages and failed stage.

It returns a finite page mode, domain-row states, primary action, allowed secondary actions, and progress summary. The renderer consumes this model and does not infer action availability ad hoc.

Keep secrets out of the view model. The password remains an input-local value and is cleared immediately after invocation or exit.

The tab module remains responsible for IPC calls, listener lifecycle, and rendering. Pure progress mapping and action selection move out of the DOM layer so the complete state matrix can be unit-tested without a fake browser.

## Interaction rules

- Exactly one visually primary action is present.
- Daily connection never shows deployment stages.
- Technical details use native disclosure controls where possible.
- Enter submits the setup or repair form when valid.
- Busy controls expose disabled/loading text without layout shifts.
- Status meaning is conveyed with text and icon shape, not color alone.
- Confirmation remains required for phone rotation and local deletion.

## Error handling

- Preserve existing backend error codes and localization mapping.
- Map each code to one domain: deployment, local secure storage, PC tunnel, Relay health, pairing, or unknown.
- Derive one user-facing callout and one next action from that domain.
- Do not expose QR/rotation when profile secrets are unavailable.
- A failed status refresh must not overwrite a newer pushed status event.

## Scope boundaries

- No backend, WireGuard, VPS installer, IPC contract, Android, or Relay protocol changes.
- One configured VPS and one active Android pairing remain the intended UI scope.
- No multi-profile selector and no continuous VPS health dashboard.
- Existing secure-storage and destructive-action protections remain unchanged.

## Testing

1. Pure view-model tests cover Setup, Deploying, Ready, Connected, Repair required, and deployment failure.
2. DOM tests verify one primary action, advanced disclosure, Enter submission, password clearing, and valid action visibility.
3. Regression coverage proves failed deployment progress does not remain as ten pending rows.
4. Existing IPC, race, focus-trap, localization, contrast, text-scale, and reduced-motion tests remain passing.
5. A rendered desktop smoke check verifies the first viewport contains the current status and primary action.

## Acceptance criteria

1. A new user sees only four required SSH fields and one deployment action.
2. Deployment replaces the form with one current step; technical stages are collapsed by default.
3. A configured user sees VPS, computer, and Android as separate rows.
4. Connecting or disconnecting this computer requires one click from the first viewport.
5. Repair-required state shows one error and one repair action, with invalid phone actions hidden.
6. Maintenance and destructive actions are available under Advanced management.
7. No stale deployment progress appears during normal daily use or after a completed failure.

## Fresh-install follow-up QA

The post-implementation desktop inspection used a separate Electron
`--user-data-dir`, not the developer's normal application data. It established
that the repair screen seen on the development machine came from that machine's
persisted public profile while its encrypted Relay secrets were absent. The
host was not present in source, defaults, or packaged file inputs. A fresh
profile contains `wgRelay.profiles: []` and therefore enters Setup with an empty
host, `root`, port `22`, an empty password, and one deploy action.

The same inspection found two presentation defects that had not been visible
in source-only checks:

- Mobile settings always rendered the obsolete manual Relay URL/token editor,
  even when all legacy Relay preferences were empty. This created a second,
  conflicting VPS setup path for new users.
- WireGuard Relay form inputs inherited Chromium's default controls, including
  white backgrounds and browser fonts in dark mode. Default `h2` margins then
  pushed the primary setup action below the first viewport once the inputs were
  given normal control height.

The follow-up keeps backend compatibility without reintroducing two setup
paths: the legacy editor is rendered only when a user already has a legacy
Relay URL, token, or enabled flag. New users configure their own VPS only in
Remote Connection. Existing legacy controls use the shared themed fields and
buttons. Relay inputs now have explicit light/dark theme styling, form heading
margins are reset, and first-use spacing keeps the primary action fully visible
without empty vertical overflow at the default Settings window size.

Additional regression coverage verifies:

1. Empty legacy preferences do not render the Mobile manual Relay editor.
2. Existing legacy preferences still render manageable, themed controls.
3. Relay form controls never fall back to browser-default field styling.
4. The Setup heading and spacing preserve the first-viewport primary action.
5. Mobile error text uses the existing accessible danger token instead of an
   undefined CSS variable.

The independent follow-up review found and closed the remaining accessibility
and compatibility gaps. The legacy editor now has complete en / zh / zh-TW / ko
/ ja copy, calls its credential a Connection Token, and gives both inputs
programmatic labels. URL-only, token-only, and enabled-only legacy snapshots are
covered independently, while `prefs.getDefaults()` is the source of truth for
the fresh-install test.

The Relay controls now use dedicated light/dark tokens whose input boundaries
and primary-action text/background exceed the applicable 3:1 non-text and 4.5:1
small-text contrast thresholds. Focus rings use the same high-contrast theme
color. The source audit also converted Repair into a native form with Enter
submission and an associated one-time-password hint, corrected invalid SSH-port
validation, and made Connect/Disconnect busy copy update immediately. Returning
to the tab now discards its runtime-only status cache and rechecks secrets before
restoring QR or phone-rotation actions.

Final cold-start Electron inspection at the default 800×528 CSS viewport
confirmed the from-zero Setup, the hidden fresh-install legacy editor, the
three-domain repair state, the seven-field exceptional Repair form, and empty
console error/exception collections. No backend, IPC, VPS installer, Relay
protocol, or Android file changed.
