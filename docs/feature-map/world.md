# World

Routes: `/world`

The World is a full-screen, playful front door to FLUJO. An animated companion greets the user, helps connect the AI they already use (a saved model, a Codex or Claude subscription on this machine, or other providers), and then takes requests by typing or by voice. "Explore my world" shows a map whose landmarks stand for parts of FLUJO (models, apps, agents, Personas, routines, meetings, packages, past results, settings); choosing one lists what is there and opens the real FLUJO page in a panel inside the World. The user can also talk to a specific agent or Persona from the map, and change the companion's look and the language.

## Sub-features

- `world-welcome`: the companion with the heading "A world waiting to wake." (no AI connected yet) or "What shall we do today?" (ready).
- `world-connect`: "Find my AI" opens the "Connect your AI" dialog: it scans this machine ("Finding connections…"), lists choices plus "More AI options", and tests the chosen one with "Connect and verify"; "Search again" rescans.
- `world-composer`: a text box labelled "Talk to me or write here…", "Send", and a microphone button "Talk" (only when voice is available); "Stop work" while it works; "See details" opens the conversation.
- `world-map`: "Explore my world" toggles the map with the landmarks "Headwater Springs", "Connector Harbor", "Flowwright Workshop", "Homes", "The Lockworks", "Gathering place", "Riverside Market", "Archive" and "Control House".
- `world-place`: a landmark opens a side sheet listing its items, "Talk · <name>" for agents and Personas that can chat, and "View all", which opens the real page in an "Open in Flujo" panel.
- `world-options`: the "Options" button opens settings: the AI in use (change it), "Language / Idioma" (EN, ES, PT), the companion style (Moss, Orbit, Spark), "Hear the companion" when voice is available, and "Open in Flujo" and "New conversation" once a conversation exists.

## How to get to it (user POV)

- There is no menu entry. Open `http://127.0.0.1:<port>/world` directly.
- The flujo mark in the World's top left goes back to the normal home page.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. With no model it shows the welcome and "Find my AI"; real requests need a connected AI that passes the test.

- **Open the page**: `node scripts/flujo-drive.mjs open /world` → heading "A world waiting to wake." (or "What shall we do today?" when an AI is ready).
- **Open the map**: `node scripts/flujo-drive.mjs click /world --role button --name "Explore my world" --then-shot world-map.png` → the landmarks on the map.
- **Open a place**: use `steps /world --file <steps.json>`: click button "Explore my world", click button "Flowwright Workshop", then `aria` → a sheet titled "Flowwright Workshop" listing agents, or "This place starts with you.".
- **Open the connect dialog**: `node scripts/flujo-drive.mjs click /world --role button --name "Find my AI" --then-aria world-connect.aria.txt` → dialog "Connect your AI" with the found connections and "More AI options".
- **Proof**: an ARIA snapshot and a screenshot of the World with the map open.

## Gotchas

- The World hides FLUJO's usual navigation bar, so menu-based steps do not work here.
- The World's language setting also changes the language of the whole app, and the World only offers English, Spanish and Portuguese.
- "Connect and verify" saves a model and runs a real test against the provider. A Claude choice asks for a token; never paste a real one in a test run.
- Sending text before any AI is connected opens the connect dialog instead of sending (or starts voice, when voice is available).
- Choosing "Headwater Springs" on the map opens the connect dialog, not a list.
- The page refreshes its data about every 15 seconds, and a red notice "Some parts of the world are unavailable. Try again." can appear when some data fails to load.
