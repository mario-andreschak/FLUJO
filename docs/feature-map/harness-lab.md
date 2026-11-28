# Harness Lab

Routes: `/harness`

Harness Lab improves an agent's instructions by experiment. The user starts from written instructions (typed in, imported from an agent step, or taken from a saved agent or Persona behavior), adds example requests with words the answer must and must not contain, and lets FLUJO propose better instructions over a few rounds. Some examples are used for training and some are held back to check the result fairly. The user then reviews the evidence, downloads it, and can create an improved agent or activate the better version. For saved agents and Personas it can also keep versions and improve them automatically in the background. It is experimental and has its own switch.

## Sub-features

- `harness-lab-new-experiment`: "New experiment" form with "Experiment name", "Domain for reusable lessons", "Fixed model connection", "Original instructions", "Fixed evaluation rubric", "Refinement rounds" and the switch "Reuse lessons from accepted experiments in this domain".
- `harness-lab-import`: "Import instructions from an agent step" fills the instructions from an existing agent (only shown when agents have such steps).
- `harness-lab-examples`: "Examples and checks", each example marked "Training" or "Held out" with required and forbidden words; "Add example".
- `harness-lab-run`: "Create and run" starts it; a run can be paused ("Pause after this step"), resumed ("Continue") or cancelled.
- `harness-lab-evidence`: results with scores and "Download evidence"; "Create evolved agent" or "Activate this version" when the result qualifies, then "Open evolved agent".
- `harness-lab-saved`: "Saved experiments" picks an earlier run to look at again.
- `harness-lab-versions`: "Improvement and versions" with "Agent or Persona behavior", the switch "Automatically improve and activate passing revisions", "Save settings", "Refresh status", and per version "Compare prompts" and "Activate this version".

## How to get to it (user POV)

- On a wide window, choose "More" in the top navigation, then the "Experimental" tab in the row below, then "Harness Lab" (`data-tour="nav-harness"`).
- On a window 1535 px wide or narrower, choose "Open navigation menu", then "Harness Lab" under the "Experimental" heading.
- Under "More" → "Help" → "FLUJO help", "Harness Lab" opens its online guide (not this page).
- Open `http://127.0.0.1:<port>/harness` directly.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. Running an experiment also needs a suitable model under AI Setup (a keyless Codex connection or an approved OpenRouter text model).

- **Open the page**: `node scripts/flujo-drive.mjs open /harness` → heading "Harness Lab" with the "Experimental" badge and the "New experiment" form, filled with a sample support-summary experiment.
- **Read the form**: `node scripts/flujo-drive.mjs aria /harness --out harness-form.aria.txt` → the fields above and the "Create and run" button.
- **Add an example**: `node scripts/flujo-drive.mjs click /harness --role button --name "Add example" --then-shot harness-example.png` → one more example row.
- **Proof**: an ARIA snapshot and a screenshot of the "New experiment" form (or of a finished run's evidence when a model is available).

## Gotchas

- With no suitable model, a warning names what to add in AI Setup, and "Create and run" stays disabled. Ordinary API-key models may not be offered.
- A run makes real model calls (the page shows "Maximum experiment steps") and can use paid allowance. A manual run may pause when the page closes, so a one-shot driver command will not finish one.
