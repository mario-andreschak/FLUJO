# Home (setup dashboard)

Routes: `/`

The start page walks a new user through three steps in order: connect an AI, create an agent, and talk to it. Each step is a card that shows its status (for example "Required", "Saved", "After AI setup", "1 created", "Started") and a button for the next action. The page also shows a notice about protecting saved credentials with a private password, tickets that agents left for the user, an optional "Connected Apps are optional" card, a button to replay the setup guide, and a short "Are you happy with FLUJO?" feedback box.

## Sub-features

- `home-setup-steps`: the "Getting started" area with three cards: "Connect your AI", "Create an agent", "Talk to your agent". Later cards stay greyed out until the earlier step is done.
- `home-connect-ai`: step 1 button. "Connect AI" when no model is saved (opens AI Setup with the connection wizard), "Test model" once a model is saved, "Open AI setup" when the saved models could not be checked.
- `home-create-agent`: step 2 button. "Connect AI first" (disabled) until a model exists, then "Open simple builder", then "Create another".
- `home-talk`: step 3 button. "Finish AI setup first" or "Create an agent first" (disabled), then "Start talking" (opens Talk).
- `home-dismiss-card`: close buttons on each card, for example "Dismiss Connect your AI card" and "Dismiss connected apps notice". Dismissals are saved.
- `home-connected-apps-card`: "Connected Apps are optional" card with a "Connected Apps" link to `/mcp`.
- `home-tickets`: "Tickets for you" section with "See all (N)". Hidden when there are no tickets.
- `home-password-notice`: notice that links to "Settings" to add a private password for stored credentials.
- `home-update-banner`: "A FLUJO update is ready …" with "Update now". Only shown when update checks on startup are switched on and an update exists.
- `home-setup-guide`: "Open setup guide" replays the guided tour.
- `home-feedback`: "Are you happy with FLUJO?" with "Yes" / "Not really", an optional text box and "Send".

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/`.
- Choose the FLUJO logo (accessible name "FLUJO home") in the top bar.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill (`launch`); no model or agent configured yet.

- **Close the first-run tour**: on a fresh instance the guided tour opens by itself on `/`. `node scripts/flujo-drive.mjs click / --role button --name "Close tour"` → tour closes and is marked done, so it no longer auto-starts.
- **Read the steps**: `node scripts/flujo-drive.mjs text /` → "Set up once. Then just use it.", the three step cards, step 1 marked "Required".
- **Start AI setup**: `node scripts/flujo-drive.mjs click / --role link --name "Connect AI" --then-shot home-connect-ai.png` → AI Setup opens with the "Let’s connect your AI!" wizard.
- **Replay the guide**: `node scripts/flujo-drive.mjs click / --role button --name "Open setup guide" --then-shot home-tour.png` → the tour's first step appears.
- **Proof**: an ARIA snapshot and a screenshot of `/` showing the three step cards and their status chips.

## Gotchas

- The tour auto-starts on `/` until it is closed or finished once; its overlay sits on top of the page and can catch clicks.
- Step 1 says "Saved", not "tested". Saving a model does not prove it works; use "Test model" on AI Setup.
- Dismissing a card is saved in settings and survives reloads. Replaying the tour can bring the setup cards back.
- Never press "Send" in the feedback box during a run: it forwards the feedback to the hosted FLUJO registry.
- Never press "Update now": it updates and restarts the instance.
- The step 1 link is a link (role `link`), not a button. The "Create an agent" button carries `data-tour="dashboard-create-flow"`; the step 1 button carries `data-tour="manage-ai-setup"`.
