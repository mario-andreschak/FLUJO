---
name: verify-flujo
description: Check a FLUJO change in the running app the way a user would, and capture proof (screenshots, accessibility snapshots). Use after changing anything a user can see or do in FLUJO, when asked to "verify", "test it in the app", "show it works", or before saying a UI or flow change is done.
---

# Verify FLUJO in a throwaway instance

Run your change in a throwaway FLUJO, use it the way a user would, and keep proof.
`docs/feature-map/` says what each page offers and how to drive it. Never use the
everyday FLUJO on port 4200: it holds real chats and serves the MCP proxy.

Adapted from `create-verification-skill` in Lauren Tan's pstack (MIT,
https://github.com/cursor/plugins/tree/main/pstack).

## Launch

Run every command from the repository root, with Node 22.23+ and this
checkout's own `npm ci`.

```
npm run build:mcp                          # optional: launch builds missing built-in tool servers itself the first time
node scripts/flujo-drive.mjs launch        # free port, new empty data folder
node scripts/flujo-drive.mjs warm          # compile every page once (dev mode); takes several minutes
```

`launch` returns only once `/api/cwd` answers and the home page renders. On
failure it prints the end of the server log. One instance per checkout, so
agents in other worktrees keep theirs; `--port` and `--data-dir` pick them
yourself. Without `warm`, the first visit to a large
page can take minutes while dev mode compiles it. `warm` with routes
(`warm flows chat`) compiles only those.

A fresh instance is not empty: it has the built-in agent "FLUJO" and four
built-in Connected Apps, but no AI model, so anything that needs a reply from a model cannot pass.

## Doctor

```
node scripts/flujo-drive.mjs doctor
```

Read-only. It checks that the process this tool started is alive, the API
answers, a page renders, the data folder exists and the instance was started
from this checkout. Run it first whenever something looks wrong. A failed check
means you fix the instance, not the test.

## Drive

Find the area in `docs/feature-map/README.md`, then follow its "Driving it"
steps. One-off commands:

```
node scripts/flujo-drive.mjs open flows
node scripts/flujo-drive.mjs click flows --role button --name "Start simple" --then-shot agents/start-simple.png
node scripts/flujo-drive.mjs aria models --out ai-setup/first-load.yml
```

Each one-off command is a new browser session. For a journey, write the steps
to a JSON file and run them in one session. This one was run against a fresh
instance:

```json
[
  { "do": "click", "role": "button", "name": "Open navigation menu" },
  { "do": "click", "role": "link", "name": "Agents" },
  { "do": "expect-text", "text": "My agents" },
  { "do": "shot", "out": "agents/agents-list.png" },
  { "do": "aria", "out": "agents/agents-list.yml" }
]
```

```
node scripts/flujo-drive.mjs steps chat --file journey.json
```

For anything on the path a new user takes (Home, AI Setup, Connected Apps,
the simple builder, Talk, `/v1`, the MCP proxy), also run the whole first-use
journey. It brings its own free stub model, so the reply steps can pass. It
drives your `launch` instance while that runs; otherwise it starts its own
FLUJO from the production build (4 GB memory cap) and removes it afterwards:

```
npm run build && npm run journey:first-use      # add --viewport 390x844 for the phone layout
```

For a broad "did anything break" pass over every page, run the release sweep
(`npm run release:sweep`, `docs/release-sweep.md`): it walks every feature map
step it can run on the launched instance and writes one report with proof of
each failure.

Step kinds are `goto`, `click`, `fill`, `press`, `wait-for`, `expect-text`,
`drop-file`, `choose-file`, `shot` and `aria`. `click`, `fill` and `wait-for` find visible elements by
ARIA role and English name (part of the name is enough). `drop-file` drags the
local `file` onto the element named by `role` and `name`; `choose-file` clicks
that element and picks `file` in the file dialog it opens. `expect-text` waits
for text a user can see, so screen-reader-only text does not count. Never use
CSS classes or screen positions. Add `--viewport 360x800` to check the phone
layout.

Every command waits until FLUJO's "Opening your workspace" screen is gone, and
stops with the on-screen message if FLUJO shows an error or sign-in screen
instead. It prints page errors and console errors at the end; treat a new one
as a failure of your change.

Things that trip up a run:

- Below 1536 px wide (including the default 1280 x 720) the top navigation is
  behind "Open navigation menu". Pass `--viewport 1600x900` to see the full bar.
- On a fresh instance the guided tour opens by itself on the home page and its
  popup blocks clicks. Start journeys on another page, or click "Close tour"
  first.
- Git Bash turns an argument that starts with `/` into a Windows path. Write
  routes without the slash (`flows`, `roles/new`) or run from PowerShell; the
  driver stops with a hint if it gets a rewritten path.

## Evidence

Relative `--out`, `--then-shot` and `--then-aria` paths are saved under
`flujo-drive/evidence/` in your own cache folder (`%LOCALAPPDATA%` on Windows,
`~/.cache` elsewhere; `FLUJO_DRIVE_HOME` moves it), outside the repository (see
Repository hygiene in AGENTS.md). Good proof:

- follows the real user path, not internal APIs or test-only routes;
- shows the action and the result: a before and after screenshot, plus an
  ARIA snapshot of the result;
- checks side effects in a second view, for example reopening the page after a
  save;
- names the feature map sub-feature ID it covers.

If a precondition is missing (for example no model is set up), report the
journey as not run and name the precondition. Never weaken the journey until it
passes.

## Cleanup

```
node scripts/flujo-drive.mjs stop
```

Stops only the process tree this tool started from this checkout and deletes
the data folder it created. Evidence stays. Never stop node or FLUJO processes
by name, and never delete other `flujo-drive-data-*` folders in the temp
folder: they belong to other agents' instances. Run `stop` after a failed
attempt too.

## Keep the map honest

When your change adds, renames or removes something a user can see, update the
matching file in `docs/feature-map/` in the same pull request.
`npm run check:feature-map` fails when a page has no entry or an entry points at
a page that no longer exists.
