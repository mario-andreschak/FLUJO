# Connected Apps

Routes: `/mcp`, `/mcp?server=<name>`

Here the user gives agents extra abilities by connecting apps (MCP tool servers): files, services, web tools and so on. A guided "Connect App" wizard helps pick a ready-made app, search the public marketplace, or connect one from a URL, a GitHub repository or a command on this computer; an AI-assisted option can research and install one for you. Each connected app shows as a card with its status. Opening a card lets the user look at and test its tools, resources, prompts and skills, and edit its environment variables. Apps can be enabled, disabled, restarted, edited, deleted, imported and exported. A basic agent does not need any connected app.

## Sub-features

- `connected-apps-list`: server cards with status (Connected, Disconnected, Error), "Search servers…", "Group cards" and "Sort servers".
- `connected-apps-connect-wizard`: "Connect App" opens "Let’s connect an app" with "AI-assisted" (Recommended), "Help me choose", "I have connection details" and "I’m an expert".
- `connected-apps-setup-dialog`: the full server setup with tabs "Spotlight", "Marketplace", "GitHub", "Configure & Test", "Remote", "Reference servers".
- `connected-apps-details`: clicking a card opens its details with tabs "Tools", "Resources", "Prompts", "Skills", "Environment Variables"; tools can be tested here.
- `connected-apps-card-actions`: "Edit server", "Delete server", "Restart server", "Retry connection", "Expose to external apps", favourite star, move to folder, and sign-in ("Authenticate with <server>") for apps that need it.
- `connected-apps-bulk`: "Select", then "Select all" and enable or disable several servers at once.
- `connected-apps-import-export`: "Import" and "Export" menus, each offering several config formats ("<name> format").
- `connected-apps-apps-dashboard`: "MCP Apps Dashboard" button (accessible name "Open MCP Apps Dashboard").
- `connected-apps-journey`: first-run guide "Your first AI + app agent" with "Inspect and test tools" and "Hide this guide".

## How to get to it (user POV)

- Choose "Connected Apps" in the top navigation (`data-tour="nav-mcp"`).
- Choose the "Connected Apps" link on the home page's "Connected Apps are optional" card.
- Open `http://127.0.0.1:<port>/mcp`; add `?server=<name>` to open one server's details directly.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. Testing a real tool needs a connected, enabled app; looking at the page and the wizard does not.

- **Open the page**: `node scripts/flujo-drive.mjs open /mcp` → heading "MCP servers", the toolbar and, on a fresh instance, the four built-in apps bash, browser, filesystem and flujo ("4 of 4 servers").
- **Open the wizard**: `node scripts/flujo-drive.mjs click /mcp --role button --name "Connect App" --then-shot apps-wizard.png` → "Let’s connect an app" with four choices.
- **Reach a setup path**: use `steps /mcp --file <steps.json>`: click button "Connect App", click "I have connection details", then `aria` → "Where does the app run?" with "At a remote URL", "In a GitHub repository", "On this computer".
- **Inspect a server**: `node scripts/flujo-drive.mjs aria "/mcp?server=<name>"` → the details dialog with its tabs.
- **Proof**: an ARIA snapshot and a screenshot of the server list, the wizard, or a server's details.

## Gotchas

- The navigation says "Connected Apps", but the page heading is "MCP servers" (small label above it: "Connect").
- With the "Legacy" look (Settings → Appearance), the main button reads "Add server" and opens the setup dialog straight away instead of the wizard.
- Each driver command is a fresh browser session; dialogs do not survive between commands. Use `steps` or the `?server=` link.
- While no app is connected, the first-run guide shows a second "Connect App" button; both open the same wizard.
- Clicking a disabled server's card does nothing; enable it first.
- "Connected" only means the server started. A tool works only after a real tool test succeeds.
- Installing apps from GitHub, the marketplace or AI-assisted setup downloads and runs third-party code on the machine. Do not do that in an unattended run.
- The search box has only a placeholder, so `fill --label` will not find it.
- The main button carries `data-tour="add-mcp-server"`; the "Marketplace" tab carries `data-tour="mcp-marketplace-tab"`.
