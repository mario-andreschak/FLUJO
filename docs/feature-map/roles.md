# Roles

Routes: `/roles`, `/roles/new`, `/roles/[roleId]`, `/roles/[roleId]/edit`

Roles are reusable job descriptions for Personas: a name, instructions saying what the Role should do, and a list of suggested Apps (tool servers). Every Persona starts from a Role. The user can browse and search Roles, create a new one, open a Role to see its required behaviors, suggested Apps and how many Personas use it, edit it (each save becomes a new version, and existing Personas stay on the version they already use), go back to an older version, duplicate it, archive or restore it, or delete it for good. Roles are an experimental feature and sit under Personas in the menu.

## Sub-features

- `roles-gallery`: heading "Roles" with one card per Role, a "Search Roles" box, "Refresh" and the "Show archived Roles" checkbox.
- `roles-create`: "New Role" opens "Create a Role" with the fields "Role name" and "What should this Role do?", "Choose Apps", "Cancel" and "Save Role".
- `roles-choose-apps`: "Choose Apps" opens a picker of connected tool servers with a "Search Apps" box; chosen Apps show as removable chips.
- `roles-detail`: a Role page shows its instructions, "Required behaviors", "Suggested Apps" and "Used by Personas", with "All Roles" to go back.
- `roles-edit`: "Edit" opens "Edit Role"; a note says saving creates a new version.
- `roles-actions`: the "Role actions" menu offers "Duplicate", "Archive" (or "Restore" when archived) and "Delete permanently" with a confirmation dialog.
- `roles-history`: the "Advanced and history" section lists versions, each with "Use this version" and a confirmation dialog.

## How to get to it (user POV)

- On a wide window, choose "More" in the top navigation, then the "Experimental" tab in the row below, then "Roles" (`data-tour="nav-roles"`, indented under "Personas").
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Roles" under the "Experimental" heading.
- From the "Create a Persona" wizard, step "Role": "Create a simple Role" opens `/roles/new` in a new tab.
- Open `http://127.0.0.1:<port>/roles` or `/roles/new` directly.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. No model is needed to create a Role. Suggested Apps only list tool servers that already exist under Connected Apps.

- **Open the gallery**: `node scripts/flujo-drive.mjs open /roles` → heading "Roles" and the Role cards ("No Roles match this view." when there are none).
- **Open the form**: `node scripts/flujo-drive.mjs click /roles --role link --name "New Role" --then-shot roles-new.png` → "Create a Role".
- **Create a Role**: use `steps /roles/new --file <steps.json>`: fill label "Role name", fill label "What should this Role do?", click button "Save Role" → the new Role's page with its name as the heading.
- **Open the actions menu**: `node scripts/flujo-drive.mjs click /roles/<id> --role button --name "Role actions" --then-aria roles-actions.aria.txt` → menu items "Duplicate", "Archive", "Delete permanently".
- **Proof**: an ARIA snapshot and a screenshot of the saved Role's page.

## Gotchas

- "Save Role" stays disabled until both "Role name" and "What should this Role do?" have text.
- The driver does not print a new Role's id. Reach the Role by clicking its card on `/roles` (role `link`; the name contains the Role's name), or keep going inside the same `steps` run after saving.
- Archived Roles are hidden from the gallery until "Show archived Roles" is ticked, and an archived Role has no "Edit" button.
- "Delete permanently" is greyed out while any Persona uses the Role; archive it instead.
- "Cancel" in the editor goes back in browser history, so in a fresh driver session it may leave FLUJO's pages entirely. The browser also asks before leaving a form with unsaved changes.
