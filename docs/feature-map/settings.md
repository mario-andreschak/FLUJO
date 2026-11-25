# Settings

Routes: `/settings`

One page for everything that shapes the whole installation. Sections are grouped into "Data & security" (who can reach FLUJO, model access, variables, encryption password, backup), "Experience" (look, language, voice input, the guided tour) and "System" (when tool servers start, updates, privacy, experimental features). The user picks a section on the left and changes it on the right. This is also where experimental features, including Harness Lab, are switched on.

## Sub-features

- `settings-network`: "Network access" with "Localhost", "Local Network" and "Public", plus "Allow all MCP app content (relax sandbox)". Changes apply after a restart.
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
- **Proof**: an ARIA snapshot and a screenshot of the chosen section after the change.

## Gotchas

- The chosen section is not in the address; every fresh load starts on "Network access". Each driver command is a fresh session, so use `steps` to pick a section and act on it.
- In narrow windows (under about 900 px wide, including `--viewport 360x800`) the left list is replaced by a "Settings section" drop-down, so the section buttons above are not there.
- Experimental pages (under "More" → "Experimental") appear only after "Enable experimental features" is on. Harness Lab also needs "Enable Harness Lab". Turning experimental features off hides them but keeps their data.
- Choosing "Local Network" or "Public" takes effect after a restart. Without a configured owner sign-in, the app's own data requests are then refused ("Owner authentication is unavailable"). Leave a throwaway instance on "Localhost".
- Switching to a "Legacy" theme changes some labels elsewhere, for example "Add server" instead of "Connect App" on Connected Apps.
- Setting an encryption password protects stored credentials; forgetting it locks them. Do not set one in a run unless that is the test.
