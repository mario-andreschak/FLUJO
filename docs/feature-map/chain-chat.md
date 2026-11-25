# Chain Chat

Routes: `/chain-chat`

Chain Chat is an experimental, read-only map of a conversation family. One main conversation sits at the top, and every conversation a sub-agent started branches out below it. Each card shows the latest message. The user can expand a card to read that chat in place, open it in Talk, switch between conversation chains, zoom the map, and refresh. Nothing can be sent from here.

## Sub-features

- `chain-chat-map`: the "Top-down conversation flow" map, with cards tagged "Root", "Subflow" or "Parent unavailable", a "{count} conversations" chip and, while something runs, a "{count} active" chip.
- `chain-chat-read`: "Read conversation: <title>" expands a card into a "Conversation preview: <title>" panel, with "Open full chat" and "Close conversation preview".
- `chain-chat-open`: "Open conversation: <title>" jumps to that conversation in Talk.
- `chain-chat-switch`: the "Conversation chain" field picks another chain. It appears only when there is more than one.
- `chain-chat-zoom`: "Map zoom" holds "Zoom in", "Zoom out" and "Reset zoom", plus "Full screen" / "Exit full screen".
- `chain-chat-refresh`: the "Refresh" button. A running chain also updates itself every few seconds.
- `chain-chat-empty`: "No conversation chains yet" / "Start or resume a chat and its chain will appear here."
- `chain-chat-error`: "Could not load the conversation chains" with "Try again".

## How to get to it (user POV)

- Turn on "Enable experimental features" in Settings → "Experimental features" first.
- On a wide screen (1536 px or more), choose `More` in the top navigation, then the `Experimental` tab, then `Chain Chat` (`data-tour="nav-chain-chat"`).
- On narrower screens, choose `Open navigation menu`, then `Chain Chat` under the "Experimental" heading.
- Open `http://127.0.0.1:<port>/chain-chat`.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill, with experimental features turned on. A fresh instance has the switch off and no conversations, so it shows only the empty state. A real chain needs at least one chat (which needs an AI model and an agent; see the Talk entry). A branching chain needs an agent that calls another agent. If that cannot be set up, report the map, read and open steps as unmet.

- **Turn on experimental features**: `node scripts/flujo-drive.mjs steps /settings --file chain-enable.json`. The steps: click button "Experimental features"; click switch "Enable experimental features"; then aria → the switch is checked.
- **Open**: `node scripts/flujo-drive.mjs open /chain-chat` → the heading "Chain Chat" and the "Experimental" chip. On a fresh instance it shows "No conversation chains yet".
- **Read a conversation** (needs a chain): `node scripts/flujo-drive.mjs click /chain-chat --role button --name "Read conversation" --then-shot chain-read.png` → the inline conversation preview.
- **Zoom**: `node scripts/flujo-drive.mjs click /chain-chat --role button --name "Zoom in" --then-shot chain-zoom.png`.
- **Proof**: an ARIA snapshot and a screenshot of the map with at least one card, or of the empty state if no chain could be created.

## Gotchas

- While experimental features are off, `/chain-chat` shows a spinner and then sends you to `/settings`. Seeing the Settings page there means the switch is off, not that the page is broken.
- The experimental switch is stored by the app on the server, so it stays on for later flujo-drive commands until you turn it off again.
- The page never sends messages. Chat in Talk first, then come back.
- The map loads a skeleton first ("Mapping conversation chains…"). Wait for a card or the empty-state text before taking proof.
- Very large chains are cut down to the most recently updated conversations, and a notice says so.
