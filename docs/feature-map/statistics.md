# Statistics (Activity)

Routes: `/statistics`

Statistics shows how the user's agents have been behaving: how many runs there were, how many succeeded, tokens used, run time, failed tool calls and cache hits. Numbers come from run records with private content removed; no conversations or keys are shown. The user picks a date range and filters, then looks at rankings per flow, trigger, model, provider, node, tool and subflow, opens a detail list of single runs, or compares two saved versions of a setup side by side. The navigation calls this page "Activity"; the page itself is titled "Statistics" and marked "Experimental".

## Sub-features

- `statistics-summary`: summary cards "Logical runs", "Success rate", "Tokens", "Run wall-clock time", "Failed tool calls" and "Cache hit rate". When model calls ran but their AI server sent no token counts, "Tokens" says "Not reported" instead of 0.
- `statistics-filters`: "Shared filters" with "From (UTC)", "To (UTC)", "Sources", "Statuses", "Subflow mode", "Cache outcome", "Content category", "Sort by" and "Direction"; "Reset" and "Refresh" buttons.
- `statistics-tabs`: views "Overview", "Flows", "Executions", "Models", "Providers & Keys", "Nodes", "Tools", "Subflows", "Compare".
- `statistics-drilldown`: choosing a row in a ranking, or a day in a chart, applies it as a filter for the whole page.
- `statistics-details`: "Open metadata details" buttons open a side panel listing single runs, tool calls or subflow calls, with "Load more" and "Close".
- `statistics-compare`: "Revision comparison" with "Baseline revision", "Candidate revision" and "Compare revisions".

## How to get to it (user POV)

- Turn on experimental features first: Settings, "Experimental features", switch "Enable experimental features".
- From any page in the More group (Automations, Meetings, Settings), choose the `Experimental` section tab, then `Activity` in that menu (`data-tour="nav-statistics"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then `Activity` under the "Experimental" heading.
- Open `http://127.0.0.1:<port>/statistics` directly (only works once experimental features are on).

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill with experimental features turned on. Numbers only appear after some flows have run while experimental features were on; a fresh instance shows "No telemetry for this selection".

- **Turn on experimental features**: use `steps` on `/settings`: click button "Experimental features", click switch "Enable experimental features". The setting is saved right away.
- **Open the page**: `node scripts/flujo-drive.mjs open /statistics` → heading "Statistics" with "Shared filters" (or, with no data, "No telemetry for this selection").
- **Read the numbers**: `node scripts/flujo-drive.mjs text /statistics` → the summary cards and the "Overview" tab when there is data.
- **Look at one view**: `node scripts/flujo-drive.mjs click /statistics --role tab --name "Flows" --then-shot statistics-flows.png` → the flow ranking table.
- **Open run details**: `node scripts/flujo-drive.mjs click /statistics --role button --name "Open metadata details: Runs" --then-aria statistics-runs.aria.txt` → the "Details · Runs" side panel.
- **Proof**: an ARIA snapshot and a screenshot of the Statistics page with the summary cards.

## Gotchas

- With experimental features off, `/statistics` shows a spinner and then sends the user to `/settings`. A run that lands on Settings has not failed to load; the switch is off.
- Runs from before experimental features were turned on are never counted, so make some runs after turning it on.
- The default range is the last 7 days in UTC, not local time. Runs from late in the local evening may fall on the next UTC day.
- The tabs and detail buttons only appear when there is data for the chosen range.
- Clearing either date shows "Choose both UTC dates." and disables "Refresh".
