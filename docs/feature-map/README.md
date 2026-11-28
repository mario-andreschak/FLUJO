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

## Steps the release sweep can run

The release sweep (`npm run release:sweep`, see `docs/release-sweep.md`) runs
every "Driving it" bullet written like this, page by page in the order of the
feature list below, each in a fresh browser session on one throwaway instance.
Other bullets are listed as manual in its report. `npm run check:feature-map`
fails when an entry has no bullet the sweep can run.

- A command: `` `node scripts/flujo-drive.mjs open <route>` `` (also `text`,
  `aria`, `shot`), `click <route> --role ROLE --name "NAME"` or
  `fill <route> --label "LABEL" --value "TEXT"`.
- A steps list: `` `steps /route` `` (or `` `steps` on `/route` ``, or
  `` `steps` `` alone for the entry's first route), then `:` and items split by
  `,` or `;`, ending at the first full stop. Items: `click <role> "Name"` (role
  is button, link, tab, radio, switch, checkbox, menu item, option or
  combobox), `fill "Label"` with an optional `` with `value` `` (without it the
  sweep types "Release sweep check"), `expect-text "Text"`, `press Enter`, and
  `shot` or `aria`, which the sweep skips because it saves its own proof. A
  `steps` command with `--file` puts the list after "The steps:".
- `click switch "X"` and `click checkbox "X"` mean "make sure it is on", so
  walking several entries in a row never turns it off again.
- After `→`, a leading `heading "X"`, `dialog "X"` or `"quoted text"` is
  checked. Put conditional alternatives in parentheses after it.
- `(needs …)` right after the bold label, or a `<placeholder>` in a route or
  value, marks a bullet a fresh instance cannot run.
- The sweep never presses "Send", "Update now", "Delete permanently", the
  sign-in or encryption password switches, or "Public" / "Local Network".

## First-use journey

`npm run journey:first-use` walks the path a new user takes, in one browser
session on a throwaway instance: Home → connect an AI by hand → test it (with
its tool round-trip) → inspect the built-in `filesystem` app and test one tool →
build an agent in the simple builder and try it → run it with tool approval on
and approve the call → open the executed steps → call the agent through `/v1`
→ expose the app and call it through the MCP proxy from an outside MCP client.
It starts a free local stub model (`scripts/first-journey/stub-model.mjs`), so
no account or key is needed; a pass proves the wiring, not the quality of a
real AI. Each stage saves a screenshot and an ARIA snapshot, plus
`report.json` (seconds per stage, where it stopped, errors on the page), under
`first-journey/<viewport>/` in the evidence folder. `--viewport 390x844`
checks the phone layout. A failed stage stops the run and saves
`<stage>-failed.png`.

Without a running `launch` instance it starts its own FLUJO from the production
build (run `npm run build` first) on a fresh data folder with the memory capped
at 4 GB, and stops it and deletes the folder at the end. Then the run also fails
on a crash on the page or when the whole path takes longer than 15 minutes, the
target for a newcomer. The `First-use journey` job of `verify-full.yml` runs it
this way on desktop and phone screens and keeps the evidence. On a `launch`
(dev mode) instance, warm the pages first (`warm models mcp flows chat`); dev
mode needs about 8–10 GB for this many pages, otherwise Next restarts itself
mid-run and the loading stage fails with `ERR_CONNECTION_REFUSED`.

## Scripted pilot

`npm run pilot:scripted` (after `npm run build`) plays three first-time users
(desktop, laptop and phone-sized windows) through the day-one tasks of the
pilot's [tester guide](../pilots/product-fit/tester-guide.md). Each one gets
its own fresh FLUJO with an empty data folder and a local stand-in model
(`scripts/scripted-pilot/pilot-model.mjs`) that lists the allowed folders,
reads the practice note and quotes its receipt phrase. Every task has a fixed
rule: its result shows on screen within its time limit and no red error
message appears. It ends with Settings → Privacy & usage → "Create report" and
checks that the report counts the tester's work and holds nothing private. It
writes `result.md` in plain language, `result.json`, each tester's diagnostic
report and a screenshot and page snapshot per task, and exits with 1 when any
task fails. The anonymous usage pulse goes to a local stand-in
(`scripts/scripted-pilot/pulse-collector.mjs`), never to the real collector.
The broad CI run (`verify-full`) runs it on Linux and Windows.

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
