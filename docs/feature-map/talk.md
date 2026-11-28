# Talk

Routes: `/chat`

Here a user chats. They can talk to one of their saved agents, or start a Quick Chat straight with an AI model, which finds connected apps and saved agents on its own. A "Conversations" sidebar lists past chats; they can be searched, filtered, pinned, renamed, stopped or deleted. While a chat runs, the user can watch the steps the agent carried out, approve tool use, attach files of almost any kind, and open a debugger.

## Sub-features

- `talk-history`: the "Conversations" sidebar with search and filters, or "No conversations yet" / "Start a new conversation" when empty.
- `talk-new-conversation`: the "New" button starts a chat with the last picked, favorite or first agent.
- `talk-choose-agent`: the "Select an agent or Persona" button opens a picker with "Agents" and "Personas" tabs. With no agents it says "No agents available. Create an agent first."
- `talk-quick-chat`: the "Quick" button opens the "Quick Chat" dialog with an "AI" choice, "Instructions (optional)", "Apps (optional)" and "Start chat".
- `talk-send`: the "Message" box ("Type a message…") and the "Send message" button.
- `talk-attach-files`: "Attach files", dropping files on the message box, or pasting them adds one chip per file. Under each name the chip says what is sent: "Sent as text", "Text extracted" (Word, Excel, PowerPoint, OpenDocument), "PDF, N pages", "N files listed, text read" (ZIP, TAR, TAR.GZ), "Sent as image", "Converted to a common image format" (HEIC, AVIF, TIFF, BMP, SVG), "Not converted: only Gemini models can see it" (iPhone HEIC photos this computer cannot decode), sound and video, or a warning such as "Can’t be read: only the name is sent", "Old format: save it as .docx, .xlsx or .pptx" or "Too large (limit … MB): not sent". "Reading…" shows while a file is converted; "Send message" waits for it. Limits are in Settings → "Chat files".
- `talk-slash-commands`: typing `/` in the "Message" box opens the "Commands" list (one line of help per command). Arrow keys pick, Enter runs, Tab fills in, Esc closes. `/goal <text>` gives a Persona an ongoing goal and `/goal` lists its open goals (Persona chats only). `/compact` makes the AI's next reply use a summary of older messages and says what stays word for word (agent chats only). `/new` starts a chat with the same agent or Persona, `/fork` copies the chat into a new one, `/context` shows the AI memory meter, `/status` shows what the chat is doing, `/help` lists the commands. The answer shows in a box above the message field ("Close" hides it). Commands that do not fit the chat are left out of the list; typed anyway, they explain why. Unknown `/words` are sent as normal messages, and `//goal` sends the text `/goal`.
- `talk-run-options`: "Run options" holds "Require tool approvals" and "Debugger". "Debugger" arms the debugger for the next message: beside the chat it shows "Debugger armed"; on a phone (or with the full-screen debugger) nothing covers the message box until the run pauses, and "Run options" then offers "Close the debugger…". While the debugger is open, the "Executed steps" panel steps aside (the debugger draws the same flow) and comes back when it closes. After Approve or Reject the prompt goes away for good; the message box is free again once the run ends.
- `talk-executed-steps`: the "Toggle executed steps panel" button (tooltip "Show executed steps" / "Hide executed steps") shows the steps the agent ran.
- `talk-rename`: "Rename conversation" changes the chat title.
- `talk-copy-link`: "Copy link to this chat" in the top bar, shown only while a conversation is open.
- `talk-delete`: "Delete conversation" on a sidebar row, with a confirmation.
- `talk-project-folder`: the folder chip under the message box shows the folder this chat's agents work in (project, branch, uncommitted changes), or "No project". Its menu changes the project, moves the chat into a worktree, switches or creates a branch, and copies the path. Each chat keeps its own folder. When the agents cannot use the folder, the chip turns orange with a warning sign and the menu says why: the folder "cannot be found" (deleted, renamed or its drive is not connected), or "Restrict MCP filesystem access to configured roots" is on and the folder is outside your projects. The menu then also offers "Add project".
- `talk-cut-off-notice`: when a reply stops early because it reached the model's length limit, the reply stays and a grey note under it says "The answer was cut off because it hit the length limit. Ask it to continue." It is not an error banner. A tool call the limit cut in half is dropped, never run.
- `talk-token-counts`: the header chip shows input and output tokens. When the AI server sends no token counts (some self-hosted servers), it says "Tokens not reported" instead of 0, and the running indicator says the same.
- `talk-server-input`: while an app (MCP server) runs a tool it may ask for input in the chat. A form card ("Server needs more information", "Asked by <server>") shows every field the server asks for, marks required ones and checks answers before "Submit"; "Decline" and "Cancel" are always there. A link card ("Server asks you to open a link") shows the website and the full address, warns about look-alike addresses, and opens the page in a new tab only on "Open link"; then "I’ve finished" lets the tool go on. Requests from background runs wait in their chat for a few minutes and are listed by `GET /api/approvals` under `elicitations`.
- `talk-mcp-skills`: when a connected app offers skills, the agent can call `load_mcp_skill`; the chat then asks "The agent wants to use the skill “<server>:<skill>” …" with "Allow" and "Do not allow" (once per chat and skill version). Skills loaded from the app's details ("Skills" tab, "Load for this conversation") still show above the message box.

## How to get to it (user POV)

- Choose `Talk` in the top navigation (`data-tour="nav-chat"`). Below 1536 px wide, first choose `Open navigation menu`.
- Open `http://127.0.0.1:<port>/chat`.
- Choose `Use` on an agent card in Agents, or "Try it" / "Try my agent" in the agent editor.
- Follow a chat link (`/chat?conversation=<id>`).

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. A fresh instance has no AI model and only the built-in "FLUJO" agent. You can open the page, the Quick Chat dialog and the agent picker without them. Getting a reply needs a connected model (a provider key or a local model server), plus a saved agent for agent chats. If neither can be set up, report the send-and-reply steps as unmet. Do not count the empty state as a pass for chatting.

- **Open**: `node scripts/flujo-drive.mjs open /chat` → the sidebar "Conversations" and "Create a new conversation to start chatting."
- **Quick Chat without a model**: `node scripts/flujo-drive.mjs click /chat --role button --name "Quick Chat: your AI" --then-shot talk-quick.png` → the "Quick Chat" dialog. It says "Connect an AI to start" and offers a "Connect AI" link to `/models?add=1`.
- **Agent picker**: `node scripts/flujo-drive.mjs click /chat --role button --name "Select an agent or Persona" --then-aria talk-picker.aria` → the "Agents" and "Personas" tabs.
- **Chat with an agent** (needs a model and an agent): `node scripts/flujo-drive.mjs steps /chat --file talk-send.json`. The steps: click button "New"; fill "Message"; click button "Send message"; expect-text for a word from the reply; then shot and aria.
- **Attach files**: `steps /chat`: click button "New", upload `sample.docx`, `sample.xlsx`, `sample.pdf`, `sample.zip`, `sample.heic` and `sample.bin` from `__tests__/fixtures/chat-attachments/` into the "Attach files" file field, wait for "Reading…" to go, then shot and aria → one chip per file: "Text extracted" (twice), "PDF, 2 pages", "5 files listed, text read", "Converted to a common image format" and "Can’t be read: only the name is sent".
- **Slash commands** (needs one agent chat with a few replies): in one `steps` run, open the chat by its link; fill "Message" with `/`; expect the listbox "Commands" with options `/compact`, `/new`, `/fork`, `/context`, `/status`, `/help` and no `/goal`; fill `/sta` and press Enter; expect-text "Chat status". Fill `/compact` and press Enter; expect-text "Summary requested" (or "Nothing to summarize yet" in a short chat), then send a normal message and check that the reply still arrives. In a Persona chat, fill `/goal Keep the notes tidy` and press Enter; expect-text "New goal"; then `/goal` alone lists it. Fill `/deploy now` and press Enter; the text is sent as a normal message.
- **Project folder** (needs one chat): add a folder as a project from the sidebar's Projects panel, open the chat, click the folder chip (`data-chat-project-chip`) → a menu with "Project" and the folder path. Rename that folder on disk and wait about 15 seconds (or refocus the page) → the chip shows a warning, and its menu says the folder "cannot be found" and offers "Add project".
- **Proof**: an ARIA snapshot and a screenshot of the conversation showing the sent message and the reply, or of the Quick Chat dialog when no model exists.
- **Server input** (needs a model, an agent with an app that asks for input, for example the MCP "everything" reference server's elicitation tool): `steps /chat` → send a message that makes the agent call that tool, then `aria` → the card with "Submit", "Decline" and "Cancel" (form) or "Open link", "Decline" and "Cancel" (link). Proof: `talk-server-input.png`.

## Gotchas

- The Quick button's accessible name comes from its tooltip: "Quick Chat: your AI discovers connected apps and saved agents as needed". The text on the button is only "Quick".
- Quick Chat can be switched off in Settings (model access). Then the Quick button is not shown.
- "New" with no saved agent does not create a chat. It shows the agent/Persona picker instead.
- Each flujo-drive command is a fresh browser. Open a chat by its `?conversation=<id>` link, or do the whole thing in one `steps` run.
- File chips need no AI model; only the reply to a message with files does. The hidden file field behind "Attach files" has `data-testid="chat-attach-input"`.
- Replies stream in over time. Wait for text from the reply (expect-text) rather than taking a screenshot right after sending.
- To see the cut-off note, set a very small "Max output tokens" on the model (for example 20) and ask for a long answer. The note appears once the run has finished, under the reply (role `note`).
- The guided tour starts on its own only on the home page `/`, so opening `/chat` directly avoids it.
- `/compact` never changes the saved chat. It only shortens what the next replies send to the AI, so the visible conversation looks the same afterwards. It is turned off when summaries are off in Settings, and a Persona chat does not offer it.
- Choosing a worktree outside your projects is refused while "Restrict MCP filesystem access to configured roots" is on; the menu shows the reason in red. Worktrees FLUJO creates sit in `<repo>.worktrees` and are always allowed.
- The command list only opens while the message is a `/` and one word. Once a space follows, Enter runs the command with that text.
