# Packages (Extensions)

Routes: `/packages`

Packages bundle a FLUJO setup (agents, models, tool servers by reference, and planned runs) into one shareable file with secrets kept out. On this page the user builds a package with a step-by-step wizard, browses and installs packages published to the online FLUJO package registry, sees and removes installed packages, and signs in to a registry account, which is only needed for publishing. The menu calls this page "Extensions"; the page itself is titled "Packages" and marked "Experimental".

## Sub-features

- `packages-create`: "Create package" opens the "Create package" wizard with the steps "Select contents", "Resolve & validate", "Secret review", "Metadata" and "Export"; buttons "Next", "Back", "Build" (on "Metadata") and "Cancel" (or "Close" once built).
- `packages-account`: "Package registry account" with the tabs "Log in" and "Sign up", "Email" and "Password" fields, "Continue with GitHub" and a "Registry URL" setting.
- `packages-browse`: "Browse registry" searches published packages; choosing one opens the install wizard. Packages published under the signed-in account show a "Delete <package name>" button. The wizard installs exactly the version and contents it showed: if the package changed on the registry after the preview, the install stops with "This package changed after you reviewed it" and nothing is installed.
- `packages-installed`: "Installed packages" lists what is installed, with a search box, "Refresh" and "Uninstall".
- `packages-uninstall-in-use`: "Uninstall" on a package whose agents or Connected Apps are still used outside it opens "Uninstall “<name>”?" with "Some of this package’s agents or Connected Apps are still used outside it. …". Each agent ("Agent “<name>”") and app ("Connected App “<name>”") gets its own section with the same "Switch to" choices as deleting one agent or app; agents and apps that leave with the package are not offered. "Uninstall" stays off until every place has a choice; "Cancel" removes nothing. Places inside the package (its own automations, its agents calling each other, its agents using its apps) need no choice.

## How to get to it (user POV)

- On a wide window, choose "More" in the top navigation, then the "Experimental" tab in the row below, then "Extensions" (`data-tour="nav-packages"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Extensions" under the "Experimental" heading.
- On the World page (`/world`): "Explore my world", then "Riverside Market", then "View all" opens this page in a panel inside the World.
- Open `http://127.0.0.1:<port>/packages`.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill, and at least one agent so the wizard has something to select.

- **Open the page**: `node scripts/flujo-drive.mjs open /packages` → heading "Packages" with the "Experimental" badge, "Package registry account", "Browse registry" and "Installed packages".
- **Start the wizard**: `node scripts/flujo-drive.mjs click /packages --role button --name "Create package" --then-shot packages-wizard.png` → the "Create package" dialog on "Select contents".
- **Check installed packages**: `node scripts/flujo-drive.mjs text /packages` → "No packages installed yet." on a fresh instance.
- **Uninstall a package something else uses** (needs an installed package with an agent, and a Persona or another agent that uses it): click "Uninstall" on the package, then "Uninstall" in "Uninstall “<name>”?" → a second dialog with the same title and "Some of this package’s agents or Connected Apps are still used outside it. …", listing the place under "Agent “<agent>”". Choose another agent under "Switch to", then "Uninstall" → the result banner and the package is gone; the Persona or agent now uses the chosen agent. Shot and aria named `packages-uninstall-in-use`.
- **Proof**: an ARIA snapshot and a screenshot of the Packages page, or of the wizard on its first step.

## Gotchas

- There are two "Create package" buttons (page header and the middle panel); both open the same wizard. The header one has `data-tour="packages-create"`.
- "Next" on "Select contents" stays disabled until something is chosen.
- "Browse registry" talks to the online registry; without internet it shows no results or an error. Do not sign in, sign up or publish during a test run.
- The search boxes have placeholder text but no field label, so `fill --label` cannot find them.
- Uninstall changes the places outside the package first and removes its agents and apps last. If something starts using one of them while the dialog is open, the dialog comes back with "Something changed while this was open. …", and anything already removed says so; nothing is left pointing at a removed agent or app.
