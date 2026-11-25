# Help (API documentation)

Routes: `/docs`

Help gathers FLUJO's built-in help. The "Help" entry opens a small menu: "API reference" goes to the API documentation page, "Tutorials" starts the guided tour, and "FLUJO help" links to online guides for AI Setup, Connected Apps, Agents, Talk, Automations and Harness Lab. The API documentation page is a searchable reference for developers who connect other tools to FLUJO: it shows the base address of this installation, groups of endpoints with their method, path, parameters and an example answer, and offers the whole reference as a downloadable OpenAPI file.

## Sub-features

- `help-menu`: the "Help" menu with "API reference", "Tutorials" and the "FLUJO help" list of online guides (they open in a new browser tab).
- `help-tour`: "Tutorials" starts the guided tour of the app.
- `help-api-reference`: heading "API documentation" with "Base URL" and the address of this FLUJO.
- `help-api-search`: a search box ("Search endpoints by path, method, or description…") that filters the endpoint list; no match shows "No endpoints match …".
- `help-api-groups`: endpoint groups such as "Chat — OpenAI compatible", "Conversations and execution", "Models", "Agents", "Automation — triggers", "MCP servers", "Environment and secrets", "Storage and backup" and "System and updates".
- `help-openapi-download`: "Download OpenAPI 3.1 (JSON)" saves `flujo-openapi.json`.
- `help-workspace-header`: when a workspace other than the default is selected, "Current workspace: …" shows the header to send with requests.

## How to get to it (user POV)

- On a wide window, choose "More" in the top navigation, then the "Help" tab in the row below it (`data-tour="nav-docs"`); the tab opens the menu, then choose "API reference".
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Help" under "More" (goes straight to the page), or "Tutorials" just below it.
- Open `http://127.0.0.1:<port>/docs` directly.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. Nothing else needs to exist; the page is not experimental.

- **Open the page**: `node scripts/flujo-drive.mjs open /docs` → heading "API documentation" and group headings such as "Models" and "Agents".
- **Read the reference**: `node scripts/flujo-drive.mjs text /docs` → the base address and every endpoint card.
- **Open the Help menu**: use `steps /automation/triggers --file <steps.json>`: click tab "Help", then `aria` → a menu named "Help" with "API reference", "Tutorials" and "FLUJO help".
- **Start the tour**: in the same kind of run, click tab "Help", then click menu item "Tutorials" → the guided tour appears.
- **Proof**: an ARIA snapshot and a screenshot of the API documentation page.

## Gotchas

- The row with the "Help" tab only appears while a page from the "More" group is open (for example `/automation/triggers`) and the window is at least 900 px wide. Below 1536 px the top bar itself collapses into "Open navigation menu", but that row stays.
- In the navigation drawer "Help" is a plain link to `/docs`, not a menu.
- The search box has placeholder text but no field label, so `fill --label` cannot find it.
- "Download OpenAPI 3.1 (JSON)" starts a browser download; a screenshot will not show it.
- "FLUJO help" entries are links to the project on GitHub and need internet.
