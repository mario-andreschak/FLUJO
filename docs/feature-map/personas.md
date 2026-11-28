# Personas

Routes: `/personas`, `/personas/[personaId]`

Personas are long-lived AI teammates. Each one is built from a Role, remembers context, keeps saved tasks and can be given an ongoing goal that it keeps working on across restarts while FLUJO is running. The "Persona desks" page lists every Persona with what it is doing now, what needs the user and what is next. Opening a desk shows one Persona in detail: give it a goal, chat or meet with it, manage its tasks, memory, apps and behaviors, review improvement suggestions and its activity, or change its preferences and delete it. Personas are an experimental feature.

## Sub-features

- `personas-gallery`: heading "Persona desks" with one card per Persona and the buttons "Open desk", "Chat" and "Assign"; "Refresh" and "Load more".
- `personas-create`: "Create Persona" opens the "Create a Persona" wizard with the steps "About", "Role", "Apps", "Supplemental behaviors" and "Review"; buttons "Next" (or "Skip"), "Back", "Save draft", "Cancel" and, at the end, "Create Persona".
- `personas-drafts`: "Saved Persona drafts" above the gallery, each with "Resume" and "Discard draft".
- `personas-desk-tabs`: a desk has the tabs "Overview", "Setup", "Behaviors", "Apps", "Memory", "Conversations", "Tasks", "Activity history", "Improvements" and "Settings".
- `personas-goal`: on "Overview", "Give this Persona a goal"; also "Working now", "Up next", "What this Persona can do" with "Change setup".
- `personas-chat`: "Chat" (desk header) or "Start conversation" (Conversations tab) opens a new conversation in Talk; "Meet" starts a meeting.
- `personas-tasks`: "Saved Tasks" with "New Task", then per task "Edit Task", "Pause", "Stop", "Move earlier", "Move later" and "Delete" (shown depending on the task's state).
- `personas-apps`: "Apps" tab lists granted tool servers, with "Manage MCP configs" leading to Connected Apps.
- `personas-settings`: "Settings" tab with preferences, "Preview export" and "Delete Persona".

## How to get to it (user POV)

- On a wide window, choose "More" in the top navigation, then the "Experimental" tab in the row below, then "Personas" (`data-tour="nav-personas"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Personas" under the "Experimental" heading.
- Open `http://127.0.0.1:<port>/personas`, or `/personas/<id>?area=tasks` to land on one desk tab (`area` is one of `overview`, `setup`, `behaviors`, `apps`, `memory`, `conversations`, `tasks`, `history`, `improvements`, `settings`).

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill with a working model under AI Setup, at least one Role (see roles.md).

- **Open the gallery**: `node scripts/flujo-drive.mjs open /personas` → heading "Persona desks"; on a fresh instance "No Personas yet".
- **Start the wizard**: `node scripts/flujo-drive.mjs click /personas --role button --name "Create Persona" --then-shot personas-wizard.png` → the "Create a Persona" dialog on step "About".
- **Create one**: use `steps /personas --file <steps.json>`: click button "Create Persona", fill label "Name", click button "Next", click the Role card (role `radio`, name = the Role's name), `expect-text` "Core and Behavior Flows are configured", click "Next" through "Apps" and "Supplemental behaviors" (they read "Skip"), then click the last "Create Persona" → the new desk opens on "Overview".
- **Look at a desk tab**: `node scripts/flujo-drive.mjs click /personas/<id> --role tab --name "Tasks" --then-aria personas-tasks.aria.txt` → "Saved Tasks" with "New Task".
- **Proof**: an ARIA snapshot and a screenshot of the new Persona's desk on "Overview".

## Gotchas

- On the "Role" step, "Next" stays disabled until the Role's setup check passes. Without a working model it shows "Finish setup before creating this Persona" and a "Configure models" link.
- With no Roles the picker is empty. "Create a simple Role" opens `/roles/new` in a new tab, which the driver does not follow; create the Role first, then use "Refresh Roles".
- The page button and the wizard's final button are both called "Create Persona"; the driver clicks the first match.
- Closing the wizard with unsaved input asks first ("Keep editing" or discard).
- "Chat" leaves the page for Talk. "Delete Persona" removes it for good.
