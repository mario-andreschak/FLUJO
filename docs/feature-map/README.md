# FLUJO feature map

What a user can do on each page, how to get there, and how to drive it. People
and agents use the same names from here, so "the agent list" or "the Talk page"
means one thing. The `verify-flujo` skill (`.claude/skills/verify-flujo/SKILL.md`)
explains how to launch a throwaway FLUJO and drive these steps.

## Baseline

- Start from `node scripts/flujo-drive.mjs launch`: a free port and an empty
  data folder. Never drive the everyday FLUJO on port 4200.
- `node scripts/flujo-drive.mjs doctor` must pass before you trust a result.
- A fresh instance has the built-in agent "FLUJO" and four built-in Connected
  Apps (bash, browser, filesystem, flujo), but no AI model, chats, triggers,
  Roles or Personas. Each entry's Preconditions line says what it needs first.
- Run `node scripts/flujo-drive.mjs warm` once after `launch`, so dev mode has
  compiled every page before you time anything.
- Below 1536 px wide the top navigation sits behind "Open navigation menu", and
  on a fresh instance the guided tour opens on the home page and blocks clicks
  until "Close tour".

## Conventions

- Find elements by ARIA role and visible English name, or by the navigation's
  `data-tour` handles (`nav-models`, `nav-mcp`, `nav-flows`, `nav-chat` and so
  on). Never by CSS class or screen position.
- Proof is a screenshot and an ARIA snapshot of the result, named after the
  sub-feature ID it covers. If a precondition is missing, report the journey as
  not run and say which precondition. Never report it as passed by another route.
- Each entry has exactly four sections: Sub-features, How to get to it (user
  POV), Driving it with flujo-drive, Gotchas. `npm run check:feature-map`
  enforces this, and that every page in `src/app` has exactly one entry.

## Features

The order below doubles as the sweep order for a broad "did we break the app" pass.

- [Home](home.md): the three first steps (connect an AI, create an agent, talk to it).
- [AI Setup](ai-setup.md): connect and manage the AI models every agent uses.
- [Connected Apps](connected-apps.md): connect apps (MCP tool servers) that give agents extra abilities.
- [Agents](agents.md): the agent (flow) list and the visual builder.
- [Talk](talk.md): chat with a saved agent, or Quick Chat straight with a model.
- [Automations](automations.md): triggers that run agents on their own (also at `/executions`).
- [Waves](waves.md): a read-only picture of what automations will run and how they connect.
- [Meetings](meetings.md): several agents discussing a question in rounds.
- [Personas](personas.md): long-lived AI teammates built from a Role.
- [Roles](roles.md): reusable job descriptions that Personas start from.
- [Packages](packages.md): build, install and share bundles of agents, models and servers.
- [Chain Chat](chain-chat.md): a read-only map of a conversation and the chats its sub-agents started.
- [Statistics](statistics.md): how agents have been behaving: runs, success, tokens and time.
- [World](world.md): a full-screen, playful front door with an animated companion.
- [Harness Lab](harness-lab.md): improve an agent's instructions by experiment (experimental).
- [Help](help.md): API reference, tutorials and online guides.
- [Settings](settings.md): access, security, look and feel, and experimental switches.
- [Owner login](owner-login.md): signing in when owner sign-in is set up for remote access.
