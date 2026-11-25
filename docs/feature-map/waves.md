# Waves

Routes: `/automation/waves`, `/waves` (both show the very same screen; the navigation links to the first and treats the second as the same entry)

Waves is a read-only picture of the user's automations. The "Day" view shows what is planned for a chosen day: triggers that are always listening, scheduled rhythms, and a day timeline. The "Playground" view draws how flows and triggers connect, so a user can follow one chain ("wave") from its starting trigger through every flow it sets off. A third view, "FACTORY", shows a FACTORY swarm when one is set up. Nothing can be edited here; changes are made on the Triggers page.

## Sub-features

- `waves-day`: the "Day" view (the default) with "Today", "Previous day", "Next day", a month calendar, "Always listening", "Scheduled rhythms" and the "Day timeline".
- `waves-day-jump`: choosing an item in the day view switches to the Playground with that wave selected.
- `waves-playground`: the "Playground" map with "Simple" and "Expert" detail, counts of flows and connections, and a warning chip for unlinked event triggers.
- `waves-package-filter`: the "All packages" chip ("Filter packages" tooltip) narrows the map to chosen packages.
- `waves-factory`: the "FACTORY" view, a read-only list of FACTORY swarm cells and tasks with its own "Refresh" button.
- `waves-paused-badge`: a "Scheduler paused" badge when all triggers are paused on the Triggers page.

## How to get to it (user POV)

- Turn on experimental features first: Settings, "Experimental features", switch "Enable experimental features". Waves stays hidden from the navigation until then.
- From any page in the More group (Automations, Meetings, Settings), choose the `Experimental` section tab, then `Waves` in that menu (`data-tour="nav-waves"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then `Waves` under the "Experimental" heading.
- Open `http://127.0.0.1:<port>/automation/waves` or `http://127.0.0.1:<port>/waves` directly. Typing the address works even while experimental features are off.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. A fresh instance has no triggers, so the Day view has nothing scheduled, and the Playground shows only the built-in "FLUJO" agent ("1 flow", "0 connections", started "Used manually"). For a real picture, add a scheduled trigger first (see the Automations entry).

- **Open the page**: `node scripts/flujo-drive.mjs open /automation/waves` → heading "Waves", the Day view.
- **Switch to the map**: `node scripts/flujo-drive.mjs click /automation/waves --role button --name "Playground" --then-shot waves-playground.png` → the Playground with "Simple" and "Expert" buttons and flow and connection counts.
- **Show more detail**: use `steps`: click button "Playground", click button "Expert", then shot.
- **Check the FACTORY view**: `node scripts/flujo-drive.mjs click /automation/waves --role button --name "FACTORY swarm" --then-aria waves-factory.aria.txt` → on a normal instance, "FACTORY is not configured for this FLUJO instance."
- **Proof**: an ARIA snapshot and a screenshot of the Day view and of the Playground.

## Gotchas

- The browser remembers the last view, but each flujo-drive command starts a fresh browser, so the page always opens on "Day". A real user may land on "Playground" instead.
- Clicks match names loosely and take the first match: `--name "Day"` also matches "Previous day" and "Next day". The "Day" view button comes first on the page, so it works, but do not rely on it for the arrows; use their full names.
- The map reloads every 30 seconds; on a slow machine the first load shows "Loading your calendar…" or "Building your automation map…". Wait for text before taking proof.
- "FACTORY" only works when the FLUJO server was started with the FACTORY observatory settings (an address on 127.0.0.1, a token and an ID). Without them the view only shows a warning, which is expected, not a failure.
- On narrow screens the month calendar is behind a "Choose date" button.
