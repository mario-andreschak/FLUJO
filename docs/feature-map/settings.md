# Settings

Routes: `/settings`

One page for everything that shapes the whole installation. Sections are grouped into "Data & security" (who can reach FLUJO, users and sign-in, model access, variables, encryption password, backup), "Experience" (look, language, voice input, the guided tour) and "System" (when tool servers start, updates, privacy, experimental features). The user picks a section on the left and changes it on the right. This is also where experimental features, including Harness Lab, are switched on.

## Sub-features

- `settings-network`: "Network access" with "Localhost", "Local Network" and "Public", plus "Allow all MCP app content (relax sandbox)". Changes apply after a restart.
- `settings-users`: "Users and sign-in": turn on sign-in for several people ("Your sign-in name", "Display name", "Password", "Repeat password", "Turn on sign-in for several people"). Once on: "Signed in as …" with "Sign out", "Your API tokens" ("Token label", "Create token", "Revoke"; a new token is shown once), and for admins the "People" table ("Turn off"/"Turn on", "Make admin"/"Make member", "Allow host access"/"Remove host access", "Set new password"), "Add a person", "Workspaces" with each owner or "Unassigned (admins only)" and "Give to", and "Turn off sign-in for several people".
- `settings-model-access`: "Model access": whether people can reach a model without a flow.
- `settings-process-env`: "Process environment": launcher and bundled-service environment variables.
- `settings-global-variables`: "Global variables": shared values and secrets used by connected services.
- `settings-encryption`: "Encryption": set or change a private encryption password ("Set a custom encryption password", "Change encryption password").
- `settings-backup`: "Backup & restore": export the setup or restore it.
- `settings-appearance`: "Appearance": themes "Modern Light", "Modern Dark", "Legacy Light", "Legacy Dark", plus "Animated landscape" and "Automatically focus search fields".
- `settings-language`: "Language" for the interface.
- `settings-speech`: "Speech recognition" for voice input.
- `settings-onboarding`: "Onboarding" with "Replay guided tour".
- `settings-tool-server-startup`: "Tool server startup": when tool servers start and which keep running.
- `settings-updates`: "Updates": installed version and automatic update checks.
- `settings-privacy`: "Privacy & usage": which anonymous usage signals may be shared.
- `settings-diagnostic-report`: under "Privacy & usage", "Diagnostic report" → "Create report" shows a read-only "Report (read it before you share it)" with "Copy" and "Save as file". It holds versions, counts and error counts only and is never sent (`GET /api/diagnostics/report`). Testers in the user pilot share it by hand (`docs/pilots/product-fit/tester-guide.md`).
- `settings-experimental`: "Experimental features" with "Enable experimental features", "Enable Harness Lab", "Show models without tool capabilities" and more switches grouped by topic.

## How to get to it (user POV)

- Choose "More" in the top navigation, then the "Settings" tab in the row below it (`data-tour="nav-settings"`).
- Choose the "Settings" link in the password notice on the home page.
- Open `http://127.0.0.1:<port>/settings`.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. Nothing else needs to exist.

- **Open the page**: `node scripts/flujo-drive.mjs open /settings` → heading "Settings"; the "Network access" section is shown first.
- **Switch section**: `node scripts/flujo-drive.mjs click /settings --role button --name "Experimental features" --then-aria settings-experimental.aria` → the experimental switches, starting with "Enable experimental features".
- **Turn on experimental features**: use `steps /settings --file <steps.json>`: click button "Experimental features", click switch "Enable experimental features", then `shot` → the switch is on and "Experimental" appears under "More" in the navigation.
- **Replay the tour**: `steps`: click button "Onboarding", then click button "Replay guided tour" → the guided tour starts.
- **Create a diagnostic report**: `steps`: click button "Privacy & usage", click button "Create report", then `aria` → the "Report (read it before you share it)" text box starting with "FLUJO diagnostic report", plus "Copy" and "Save as file".
- **Proof**: an ARIA snapshot and a screenshot of the chosen section after the change.

## Gotchas

- The chosen section is not in the address; every fresh load starts on "Network access". Each driver command is a fresh session, so use `steps` to pick a section and act on it.
- In narrow windows (under about 900 px wide, including `--viewport 360x800`) the left list is replaced by a "Settings section" drop-down, so the section buttons above are not there.
- Experimental pages (under "More" → "Experimental") appear only after "Enable experimental features" is on. Harness Lab also needs "Enable Harness Lab". Turning experimental features off hides them but keeps their data.
- Choosing "Local Network" or "Public" takes effect after a restart. Without a configured owner sign-in, the app's own data requests are then refused ("Owner authentication is unavailable"). Leave a throwaway instance on "Localhost".
- Switching to a "Legacy" theme changes some labels elsewhere, for example "Add server" instead of "Connect App" on Connected Apps.
- The diagnostic report needs FLUJO unlocked; while it waits for the encryption password, "Create report" shows a warning instead. A section that cannot be read in five seconds is listed under "Could not read" and is tried again on the next "Create report".
- Turning on "Users and sign-in" means everyone, including you, must sign in on every page from then on, and all existing workspaces belong to the first admin. A throwaway instance should turn it off again ("Turn off sign-in for several people") or be thrown away after the run.
- Setting an encryption password protects stored credentials; forgetting it locks them. Do not set one in a run unless that is the test.
