# Automations (Triggers)

Routes: `/automation/triggers`, `/executions` (older address, same screen)

On the Triggers page a user makes a flow run by itself, without opening chat: on a schedule, when a webhook URL is called, when files in a folder change, when an MCP tool server reports an event, when a watched tool's result changes, when a website changes, or when another flow finishes. Each trigger is a card the user can switch on or off, run now, edit, move to a folder, delete, and expand to see its run history. One page-wide switch pauses or resumes every trigger at once.

## Sub-features

- `automations-list`: cards for every trigger, each showing whether it is armed (for example "Next run: …" or "Paused (global)") and its last run.
- `automations-create`: "Add trigger" (or "New trigger" on the empty page) opens the "New trigger" dialog with three tabs: "1 · When should it run?", "2 · What should it run?", "3 · Start restrictions".
- `automations-trigger-types`: seven kinds to pick from: "On a schedule", "When called (webhook)", "When files change", "Watch a tool", "A tool server reports an event", "When a website changes", "When another flow finishes".
- `automations-event-source`: on "A tool server reports an event", "What the server sends" picks "Events (delivery guaranteed)" or "Claude channel messages (no delivery guarantee)". The channel choice hides the event list and shows a yellow note that such messages can be lost.
- `automations-event-steer`: on "A tool server reports an event", the optional "Send to a running conversation (optional)" field takes a conversation id or a pasted chat link. While that conversation runs, each event shows up in it as a message labelled "Event from <server>"; otherwise a run starts as usual.
- `automations-target`: run "A Flow" (picked with the "Select an agent" button) or "A Persona", with a "What should the flow do?" message sent on every run.
- `automations-restrictions`: what happens if a run is already going ("Already running" choice) and exclusive or emergency starts.
- `automations-pause-all`: the "Run schedules" switch, labelled "Active" or "Paused", stops or arms every trigger.
- `automations-card-actions`: per card "Run now", "Edit", "Move to folder", "Delete", "Turn on" / "Turn off", "Show run history".
- `automations-filter`: "Search triggers…", "Status" and "Trigger" filters, "Group cards" (no grouping, folder, trigger, status) and "Sort triggers".

## How to get to it (user POV)

- On a wide window (wider than 1535 px), choose `More` in the top navigation; it opens Automations first. Both the `More` link and the `Automations` section tab carry `data-tour="nav-executions"`.
- On a narrower window, choose "Open navigation menu", then `Automations` under the "More" heading.
- From any other page in the More group (Meetings, Settings), choose the `Automations` tab in the row of section tabs.
- Open `http://127.0.0.1:<port>/automation/triggers` directly.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. A fresh instance has no triggers and one built-in agent, "FLUJO", which a trigger can run. Reading the page needs nothing.

- **See the empty page**: `node scripts/flujo-drive.mjs text /automation/triggers` → "Triggers", "No triggers yet" and a "New trigger" button.
- **Open the new-trigger dialog**: `node scripts/flujo-drive.mjs click /automation/triggers --role button --name "Add trigger" --then-aria new-trigger.aria.txt` → the "New trigger" dialog on the "When should it run?" tab, with "On a schedule" chosen.
- **Create a trigger** (needs a flow): use `steps` with one browser session: click button "Add trigger", fill label "Name", click tab "2 · What should it run?", click button "Select an agent" and pick the flow card, click button "Save trigger", then expect-text the trigger's name.
- **Run it once**: in the same `steps` file, click button "Run now" on the card, then click button "Show run history".
- **Proof**: an ARIA snapshot and a screenshot of the Triggers page showing the new card and its run history.

## Gotchas

- Every command except `steps` opens a fresh page, so dialogs opened by one command are gone in the next. Use `steps` for anything with more than one click.
- Saving with no flow chosen does not show an error: the dialog jumps to the "What should it run?" tab and puts focus on the picker. An empty "Name" sends you back to the first tab the same way.
- The dialog opens with "On a schedule" set to every day at 09:00; that trigger will not fire during a short test. Use "Run now" instead.
- If the "Run schedules" switch is off, the page shows "Paused" and nothing fires on its own; cards say "Paused (global)". FLUJO must keep running for triggers to fire.
- The page refreshes itself every 10 seconds (every 3 seconds while a run is going), so wait for text instead of taking a snapshot straight away.
- Clicks match accessible names loosely and take the first match, so with several cards "Run now", "Edit" and "Delete" hit the first card. Filter with "Search triggers…" first, or keep one trigger per test.
- With no flows, the "What should it run?" tab shows "No agents available. Create an agent first." instead of the "Select an agent" button.
- "A Persona" as the target needs a Persona, and Personas live under the Experimental menu.
