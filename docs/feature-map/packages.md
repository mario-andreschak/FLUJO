# Packages (Extensions)

Routes: `/packages`

Packages bundle a FLUJO setup (agents, models, tool servers by reference, and planned runs) into one shareable file with secrets kept out. On this page the user builds a package with a step-by-step wizard, browses and installs packages published to the online FLUJO package registry, sees and removes installed packages, and signs in to a registry account, which is only needed for publishing. The menu calls this page "Extensions"; the page itself is titled "Packages" and marked "Experimental".

## Sub-features

- `packages-create`: "Create package" opens the "Create package" wizard with the steps "Select contents", "Resolve & validate", "Secret review", "Metadata" and "Export"; buttons "Next", "Back", "Build" (on "Metadata") and "Cancel" (or "Close" once built).
- `packages-account`: "Package registry account" with the tabs "Log in" and "Sign up", "Email" and "Password" fields, "Continue with GitHub" and a "Registry URL" setting.
- `packages-browse`: "Browse registry" searches published packages; choosing one opens the install wizard. Packages published under the signed-in account show a "Delete <package name>" button. The wizard installs exactly the version and contents it showed: if the package changed on the registry after the preview, the install stops with "This package changed after you reviewed it" and nothing is installed.
- `packages-installed`: "Installed packages" lists what is installed, with a search box, "Refresh" and "Uninstall".

## How to get to it (user POV)

- Turn on "Enable experimental features" in Settings → "Experimental features" first. Without it the page cannot be opened.
- On a wide window, choose "More" in the top navigation, then the "Experimental" tab in the row below, then "Extensions" (`data-tour="nav-packages"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Extensions" under the "Experimental" heading.
- On the World page (`/world`): "Explore my world", then "Riverside Market", then "View all" opens this page in a panel inside the World.
- Open `http://127.0.0.1:<port>/packages` (only once experimental features are on).

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill with experimental features on, and at least one agent so the wizard has something to select.

- **Turn on experimental features**: use `steps /settings --file <steps.json>`: click button "Experimental features", click switch "Enable experimental features". It is saved right away.
- **Open the page**: `node scripts/flujo-drive.mjs open /packages` → heading "Packages" with the "Experimental" badge, "Package registry account", "Browse registry" and "Installed packages".
- **Start the wizard**: `node scripts/flujo-drive.mjs click /packages --role button --name "Create package" --then-shot packages-wizard.png` → the "Create package" dialog on "Select contents".
- **Check installed packages**: `node scripts/flujo-drive.mjs text /packages` → "No packages installed yet." on a fresh instance.
- **Proof**: an ARIA snapshot and a screenshot of the Packages page, or of the wizard on its first step.

## Gotchas

- With experimental features off, `/packages` shows a spinner and then sends the user to `/settings`. Landing on Settings means the switch is off, not that the page broke.
- There are two "Create package" buttons (page header and the middle panel); both open the same wizard. The header one has `data-tour="packages-create"`.
- "Next" on "Select contents" stays disabled until something is chosen.
- "Browse registry" talks to the online registry; without internet it shows no results or an error. Do not sign in, sign up or publish during a test run.
- The search boxes have placeholder text but no field label, so `fill --label` cannot find them.
