# AI Setup

Routes: `/models`, `/models?add=1`, `/models?add=manual`, `/models?edit=<id>`

Here the user connects the AI that every agent and conversation uses, and manages those connections. A guided wizard asks a few plain questions (experience level, how to pay, online or offline) and then creates ready-to-use model connections for services such as OpenRouter, Requesty, Claude, ChatGPT/Codex, Gemini, Azure OpenAI or a local Ollama model. Experts can fill in every model field by hand. Each saved connection appears as a card that can be tested, edited, duplicated, moved into a folder, starred, turned into an agent or deleted. A fallback policy can list several models to try in order.

## Sub-features

- `ai-setup-list`: the cards of saved AI connections, with "Search AI connections…", "Group cards" and "Sort models". Empty state: "Your AI is not connected yet".
- `ai-setup-wizard`: "Connect AI" opens the "Let’s connect your AI!" wizard with "No idea", "I know a bit" and "I’m an expert".
- `ai-setup-manual`: "More AI connection options" → "Manual creation" opens the full "Connect your AI" form (Display name, Provider, API key, Technical name and more), saved with "Save".
- `ai-setup-test`: "Test model" on a card sends a small direct request and shows the answer.
- `ai-setup-edit`: "Edit model" opens the "Edit AI connection" form.
- `ai-setup-card-actions`: "Duplicate model", "Move model to folder", "Delete model" and a star for favourites.
- `ai-setup-convert-to-agent`: "Convert <model> to an agent" opens "Convert model to agent" with "Agent name", optional connected apps and "Save and open".
- `ai-setup-fallback-policy`: "Create fallback policy" opens the "Fallback policy" dialog.
- `ai-setup-allowance`: the "Subscription allowance" panel shows one bar per subscription account (Claude, Codex, Antigravity) with "N% left", coloured green, amber or red, and "Refresh". Without a current number it says "No reading yet", "Outdated", "Partial reading", "Usage not exposed", "Usage check paused", "Check failed" or "FLUJO can't read usage" instead of a bar. The same bar sits on model cards, fallback policies, agents and Personas; clicking an account opens its windows and models.

## How to get to it (user POV)

- Choose "AI Setup" in the top navigation (`data-tour="nav-models"`).
- Choose "Connect AI", "Test model" or "Open AI setup" on step 1 of the home page.
- Open `http://127.0.0.1:<port>/models` directly. Add `?add=1` to open the wizard, or `?edit=<id>` to open one connection's form.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill; a fresh instance has no models configured. A real test needs a working provider key, which a throwaway run usually does not have.

- **Open the page**: `node scripts/flujo-drive.mjs open /models` → heading "AI Setup" and, on a fresh instance, "Your AI is not connected yet".
- **Open the wizard**: `node scripts/flujo-drive.mjs click /models --role button --name "Connect AI" --then-shot ai-setup-wizard.png` → "Let’s connect your AI!" with three experience choices.
- **Open the manual form**: use `steps /models --file <steps.json>`: click button "More AI connection options", click menu item "Manual creation", fill "Display name", then `aria` → the "Connect your AI" form with the name filled in.
- **Proof**: an ARIA snapshot and a screenshot of the model list, or of the wizard or form that was opened.

## Gotchas

- Every driver command is a new browser session, so a dialog opened by one `click` is gone in the next command. Use `steps` for anything that needs more than one click, or deep links such as `/models?add=1`.
- "Saved" does not mean "works". The wizard says so too: run "Test model" before using a connection. A test sends a real request and may use provider credits.
- The search box has only a placeholder, no label, so `fill --label` will not find it.
- "I’m an expert" in the wizard skips the questions and opens the manual form.
- With Provider "Ollama" the manual form needs no API key ("Not needed for Ollama. Leave it empty."); it stores the same placeholder as the wizard. Any local OpenAI-compatible server works this way, including the stub model of `npm run journey:first-use`.
- Offline (Ollama) and subscription routes check or install tools on the machine running FLUJO. Do not let a run install software.
- Provider model lists hide models known not to support tool calls (for example image generators) unless "Show models without tool capabilities" is on under Settings → Experimental features.
- The allowance panel appears only when a subscription connection exists, and a throwaway instance has no real subscription, so it can only show the wording states. Percentages from real accounts need the owner's own logins; `docs/features/models/subscription-allowance.md` lists what each state means.
- The "Connect AI" button carries `data-tour="add-model"`; the page itself carries `data-tour="models-overview"`.
