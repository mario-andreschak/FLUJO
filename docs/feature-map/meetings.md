# Meetings

Routes: `/meetings` (add ?meeting= and a meeting ID to open one meeting directly)

Meetings ("Agent Meetings") put several agents in one room to discuss a question in rounds. The user names the meeting, writes an opening brief, picks at least two agents (Personas or Flows), chooses how the talk is run (open room, a host who opens and closes, or an active moderator), and starts it. While it runs, the user watches the conversation, messages the room, saves private notes or proposes a motion. Afterwards the user can continue the same meeting, start a follow-up, or download a meeting log. The page is marked "Experimental".

## Sub-features

- `meetings-list`: "Recent meetings" with one card per meeting; an empty page shows "Put your best agents in one room".
- `meetings-wizard`: "New meeting" opens "Set up a meeting" with four steps: "Topic", "Participants", "Facilitation", "Review".
- `meetings-participants`: "What are you adding?" choice between "A Persona" (default, "Recommended") and "A Flow"; at least two are needed.
- `meetings-facilitation`: "Open room", "Host opens & closes", "Actively facilitated" (with "Choose the moderator"), plus "Discussion rounds", "Agents at once", "Finish vote" and "If one agent fails".
- `meetings-run`: "Create & start meeting" creates and starts at once; the meeting page shows status, "Live updates", phases and the "Conversation".
- `meetings-controls`: "Message the room" box with "Private note", "Propose motion" (dialog "Propose a motion") and send buttons; "Stop meeting" asks "Stop this meeting?".
- `meetings-after`: "Continue meeting", "Create follow-up" and "Create meeting log" (downloads a Markdown file); "All meetings" goes back to the list.
- `meetings-from-persona`: the "Meet" button on a Persona opens the wizard with that Persona already added.

## How to get to it (user POV)

- From any page in the More group, choose the `Meetings` section tab (`data-tour="nav-meetings"`). It is not behind the experimental switch.
- On a window 1535 px wide or narrower, choose "Open navigation menu", then `Meetings` under the "More" heading.
- Choose "Meet" on a Persona's page (Personas are under the Experimental menu).
- Open `http://127.0.0.1:<port>/meetings` directly, or `/meetings?meeting=<id>` for one meeting.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. A fresh instance has only the built-in "FLUJO" agent, so the wizard cannot get past "Participants", which needs at least two. To run a real meeting you need a working model and at least two flows (or Personas).

- **See the empty page**: `node scripts/flujo-drive.mjs text /meetings` → "Agent Meetings", "Put your best agents in one room" and "New meeting".
- **Open the wizard**: `node scripts/flujo-drive.mjs click /meetings --role button --name "New meeting" --then-aria meeting-wizard.aria.txt` → "Set up a meeting" on the "Topic" step with "Meeting name" and "Opening brief".
- **Fill the topic and reach Participants**: use `steps`: click button "New meeting", fill label "Meeting name" (3+ characters), fill label "Opening brief" (10+ characters), click button "Next", then aria → "Who belongs in the room?".
- **Pick flows and start** (needs two flows and a model): continue the same `steps` file: click radio "A Flow", choose two flow cards, click button "Next" twice, click button "Create & start meeting", expect-text "Conversation".
- **Proof**: an ARIA snapshot and a screenshot of the running or finished meeting page.

## Gotchas

- "Next" stays disabled until the step is valid: name of 3+ characters and a brief of 10+ characters; two or more participants with unique names; a moderator when the format needs one.
- The wizard starts on "A Persona". With no Personas it shows "Create a Persona before adding one to the room."; switch to "A Flow" for a plain test.
- "Create & start meeting" starts the agents right away and spends model tokens. There is no separate save-as-draft step.
- "Create meeting log" downloads a file; it is not needed as proof.
- A running meeting updates live; wait for text such as "The meeting reached a conclusion" before the final screenshot.
