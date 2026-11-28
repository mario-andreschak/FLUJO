# Settings

Routes: `/settings`

One page for everything that shapes the whole installation. Sections are grouped into "Data & security" (who can reach FLUJO, users and sign-in, model access, variables, encryption password, backup), "Experience" (look, language, voice input, chat files, the guided tour) and "System" (when tool servers start, updates, privacy, advanced). The user picks a section on the left and changes it on the right. This is also where the few remaining advanced choices live (tool result limits, MCP safety choices, snapshot storage).

## Sub-features

- `settings-network`: "Network access" with "Localhost", "Local Network" and "Public", plus "Allow all MCP app content (relax sandbox)". Changes apply after a restart.
- `settings-users`: "Users and sign-in": turn on sign-in, for the owner alone or for several people ("Your sign-in name", suggested "owner", "Display name", "Password", "Repeat password", "Turn on sign-in"). Once on: "Signed in as …" with "Sign out", "Your API tokens" ("Token label", "Create token", "Revoke"; a new token is shown once), and for admins the "People" table ("Turn off"/"Turn on", "Make admin"/"Make member", "Allow host access"/"Remove host access", "Set new password"), "Add a person", "Workspaces" with each owner ("Team: <name>" for a team) or "Unassigned (admins only)" and "Give to" (a person or a team), and "Turn off sign-in for several people".
- `settings-teams`: under "Users and sign-in", "Teams" for every signed-in person: each team ("Team <name>") with "Your role", its workspaces and the "Members of <name>" table (Owner, Member, Viewer in plain words; "Invited, has not answered yet"). An invitation shows "Accept" / "Decline". Team owners and admins also get "Role of <person> in <team>", "Remove" (then "Yes, remove"), "Person to add to <team>", "Role in <team>", "How to add to <team>" ("Add now" or "Invite (they accept first)"), "Add to team", "New workspace for <team>" → "Make team workspace" (then "Open <workspace>"), and "New name for <team>" → "Rename team". Admins also get "Make a team" ("Team name", "First owner (optional)", "Make team") and "Delete team" (refused while the team still owns workspaces).
- `settings-model-access`: "Model access": whether people can reach a model without a flow.
- `settings-process-env`: "Process environment": launcher and bundled-service environment variables.
- `settings-global-variables`: "Global variables": shared values and secrets used by connected services.
- `settings-encryption`: "Encryption": how saved keys are protected. On a computer with a protected key store the status reads "Protected by Windows" (or "the macOS Keychain", "the system keyring") with a "Recovery key" panel ("Show recovery key", then "Copy", "Save as file", "I keep it somewhere safe"); without one it says the keys have basic protection. Also set or change a private encryption password ("Set a custom encryption password", "Change encryption password").
- `settings-backup`: "Backup & restore": export the setup or restore it.
- `settings-appearance`: "Appearance": themes "Modern Light", "Modern Dark", "Legacy Light", "Legacy Dark", plus "Animated landscape" and "Automatically focus search fields".
- `settings-language`: "Language" for the interface.
- `settings-speech`: "Speech recognition" for voice input.
- `settings-chat-files`: "Chat files": "Largest file (MB)" (default scales with the computer's memory), "Most pages, slides or sheets read from one document" (default 200) and "Most characters of text kept from one file" (default 400,000). Empty fields use the defaults; "Use defaults" clears all three.
- `settings-onboarding`: "Onboarding" with "Replay guided tour".
- `settings-tool-server-startup`: "Tool server startup": when tool servers start and which keep running.
- `settings-updates`: "Updates": installed version and automatic update checks.
- `settings-privacy`: "Privacy & usage": which anonymous usage signals may be shared.
- `settings-diagnostic-report`: under "Privacy & usage", "Diagnostic report" → "Create report" shows a read-only "Report (read it before you share it)" with "Copy" and "Save as file". It holds versions, counts and error counts only and is never sent (`GET /api/diagnostics/report`). Its "Runs" line splits every run into finished, failed, stopped, paused (waiting for an approval or the debugger), ended at a limit and unfinished, so the parts add up to the total. Testers in the user pilot share it by hand (`docs/pilots/product-fit/tester-guide.md`).
- `settings-experimental`: "Advanced" with three groups. "Context management" holds the tool result limits. "MCP and apps" has "Restrict MCP filesystem access to configured roots" and "Require a click to open allowed MCP Apps". "Snapshots and recovery" holds snapshot storage. File snapshots and chat restore are always on, and the modern MCP protocol is always used (it falls back to the classic handshake for a server that needs it), so neither has a switch.
- `settings-tool-result-limit`: under "Advanced" → "Context management", "Move large tool results to a resource" (off by default) with "Size limit": "Automatic (based on the model)" or "Custom size", the fields "Size limit (KB)" and "Line limit", and "Save limits". Stored per workspace through `GET`/`PATCH /api/tool-result-limit`; see `docs/features/tool-result-size-limit.md`.

## How to get to it (user POV)

- Choose "More" in the top navigation, then the "Settings" tab in the row below it (`data-tour="nav-settings"`).
- Choose the "Settings" link in the password notice on the home page.
- Open `http://127.0.0.1:<port>/settings`.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. Nothing else needs to exist.

- **Open the page**: `node scripts/flujo-drive.mjs open /settings` → heading "Settings"; the "Network access" section is shown first.
- **Switch section**: `node scripts/flujo-drive.mjs click /settings --role button --name "Advanced" --then-aria settings-experimental.aria` → the Advanced groups, starting with "Context management".
- **Set the tool result size limit**: `steps`: click button "Advanced", click switch "Move large tool results to a resource", click radio "Custom size", fill "Size limit (KB)" with `32`, click button "Save limits", then `aria` → the switch is on, "Custom size" is chosen and "Saved. The next tool call uses the new setting." shows. Typing `0` instead shows "Enter a whole number of kilobytes from 1 to 102,400." and "Save limits" stays disabled.
- **Tool result size limit end to end** (needs a production build): `npm run check:tool-result-limit` starts its own throwaway FLUJO with a local stand-in AI. It sets the limit here (and sees `0` refused), keeps it after a reload, runs an agent whose tool returns about 43 KB and sees the reply name a `flujo://run/` link, sets the agent's AI step to "Keep results in full" and sees the whole result, then switches the limit off again. Screenshots, ARIA snapshots and `report.json` per stage under `tool-result-limit/desktop/` in the evidence folder; the `First-use journey` job of `verify-full.yml` runs it.
- **Replay the tour**: `steps`: click button "Onboarding", then click button "Replay guided tour" → the guided tour starts.
- **Create a diagnostic report**: `steps`: click button "Privacy & usage", click button "Create report", then `aria` → the "Report (read it before you share it)" text box starting with "FLUJO diagnostic report", plus "Copy" and "Save as file".
- **Proof**: an ARIA snapshot and a screenshot of the chosen section after the change.

## Gotchas

- The chosen section is not in the address; every fresh load starts on "Network access". Each driver command is a fresh session, so use `steps` to pick a section and act on it.
- In narrow windows (under about 900 px wide, including `--viewport 360x800`) the left list is replaced by a "Settings section" drop-down, so the section buttons above are not there.
- The tool result size limit is saved per workspace, not in the browser. A throwaway instance should switch it off again after a run, or be thrown away. The "Size limit (KB)" field stays greyed out until "Custom size" is chosen, and everything below the switch stays greyed out while the switch is off.
- Choosing "Local Network" or "Public" takes effect after a restart. Without a configured owner sign-in, the app's own data requests are then refused ("Owner authentication is unavailable"). Leave a throwaway instance on "Localhost".
- Switching to a "Legacy" theme changes some labels elsewhere, for example "Add server" instead of "Connect App" on Connected Apps.
- The diagnostic report needs FLUJO unlocked; while it waits for the encryption password, "Create report" shows a warning instead. A section that cannot be read in five seconds is listed under "Could not read" and is tried again on the next "Create report".
- Turning on "Users and sign-in" means everyone, including you, must sign in on every page from then on, and all existing workspaces belong to the first admin. A throwaway instance should turn it off again ("Turn off sign-in for several people") or be thrown away after the run.
- A throwaway instance on Windows protects its saved keys with Windows data protection: the protected copy lives in that instance's own data folder (`keys/system-key.json`), so throwing the folder away removes it. Start it with `FLUJO_SYSTEM_KEY_STORE=off` to see the "basic protection" note instead. "Show recovery key" works only on the computer FLUJO runs on and only while unlocked.
- "Teams" appears only while sign-in for several people is on. A viewer sees the team but no buttons; a team workspace made here shows up in the workspace tabs after the next page load ("Open <workspace>" does that).
- Setting an encryption password protects stored credentials; forgetting it locks them. Do not set one in a run unless that is the test.
