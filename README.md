<div align="center">

# FLUJO

### Your AI, connected to useful work.

Build a helper, give it the right tools, and talk to it. See what it does, adjust the steps, and use it again.

[**Install FLUJO**](docs/start-here/install.md) · [**Try the workshop guide**](docs/journeys/first-agent.md) · [**Watch the one-minute film**](https://flujo.com.co/film/) · [**Website**](https://flujo.com.co/)

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.46.3-green.svg)](package.json)

</div>

FLUJO is an open-source AI workspace that runs on your computer. Choose an AI, connect useful tools, and build your own helper with simple steps or a visual diagram. See how each answer was made and reuse what you set up for the next job.

## Start with a coffee workshop

A small, real-world task makes the pieces easier to understand:

1. **Connect a useful tool.** Install a web-reading app from its GitHub URL.
2. **Build a workshop helper.** Give it your chosen AI and the tool, then ask it to read a public coffee guide and make a preparation checklist.
3. **Keep planning with Maya.** Try an experimental Persona that carries context across conversations to develop the plan, invitation draft, shopping list and run sheet.

[Follow the first-agent guide →](docs/journeys/first-agent.md) · [Meet Maya →](docs/journeys/persona.md)

The Persona story uses **Day 1 / Day 2 / Day 3 as compressed demonstration sessions**. They are not elapsed days or proof of unattended reliability.

[![A real FLUJO conversation separates source-based coffee advice from workshop planning suggestions](githubpages/assets/journeys/07-verified-checklist.png)](docs/journeys/first-agent.md)

*Real chat in FLUJO 3.46.2 after a follow-up source read. The guide explains the corrections and one remaining detail to review.*

## Why try FLUJO?

- **Choose your AI.** Use an AI service, a supported subscription or a local model. Choose a backup AI for provider limits and outages.
- **Connect once, build on it.** Add a tool from GitHub or the app catalog, then use it in more than one helper. MCP is the shared standard behind these connections.
- **Start simple, add what you need.** Write the steps in plain language, then combine helpers or give the work different paths as it grows.
- **See the work.** Read tool results in chat, review actions before they run, or pause at a step to understand what happened. Compatible tools can show an interactive interface.
- **Keep projects together.** Separate projects, back up your work, run helpers on a schedule, and connect them to other apps.

[Explore capabilities and limits](docs/start-here/capabilities.md) · [Compare Claude, Goose, Dify, n8n, OpenClaw and Hermes](docs/start-here/compare.md)

<a id="-getting-started"></a>
<a id="-quick-install-recommended"></a>

## Install

**Windows:** [Download the latest installer](https://github.com/mario-andreschak/FLUJO/releases/latest/download/flujo-setup.exe). It sets up FLUJO and the runtimes used by connected tools.

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | bash
```

**Already have Node.js 22.17+ (22.x) or 24.2+ (24.x)?**

```bash
npx flujo-ai@latest
```

Open [localhost:4200](http://localhost:4200) and keep the FLUJO server running. The npm command uses the latest published package; shell installers follow the development branch by default. Model access and some tool runtimes require separate setup.

[All installation choices](docs/start-here/install.md) · [Windows PowerShell](docs/start-here/windows.md) · [Docker](docs/start-here/docker.md) · [Source](docs/start-here/source.md) · [Proxy help](docs/start-here/proxy.md)

## What to know before you start

Workspace data is saved on your computer. AI services and connected tools receive the content needed for your requests and may charge separately. Set your own encryption password; the default is public. Anonymous daily usage sharing is on by default; turn it off in Settings. [Privacy and costs](docs/start-here/privacy.md).

Schedules run while the FLUJO server is running and may need attention after errors or approval requests. **Personas, Roles and persistent goals are experimental.** [Current maturity and evidence](docs/project-status.md).

<a id="network-exposure"></a>

The default setup is for you on your own computer, without a sign-in screen or separate user accounts. [Read the limits before sharing access](docs/start-here/network.md).

## Find your next step

[Start here](docs/start-here/README.md) · [Everyday use and recovery](docs/start-here/using-flujo.md) · [Developer / API guide](docs/start-here/developers.md) · [Full docs](docs/README.md) · [Release notes](CHANGELOG.md)

Need help or have an idea? [Open an issue](https://github.com/mario-andreschak/FLUJO/issues) or [join Discord](https://discord.gg/KPyrjTSSat). Contributions are welcome; see the [contributor guide](docs/contributing/README.md).

MIT licensed · Powered by [PocketFlow](https://the-pocket-world.github.io/Pocket-Flow-Framework/) · [Original film and studio](https://flujo.com.co/short/)
