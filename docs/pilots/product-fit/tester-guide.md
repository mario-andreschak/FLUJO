# FLUJO pilot: tester guide

Thank you for testing FLUJO. This guide has one hour of tasks for the first day
and a short routine for each week after that. Please read the
[consent note](consent-note.md) first.

**Getting stuck is a useful result.** If a task does not work after about ten
minutes, write down where you stopped and what you saw, then move on or ask the
pilot owner. Please do not ask a friend to fix it for you without telling us;
we need to know when help was needed.

## Before you start

You need:

- a Windows, macOS or Linux computer you can install programs on;
- access to an AI model: an API key you already have (for example OpenAI,
  Anthropic, Google Gemini or OpenRouter), a supported subscription login, or a
  free local model with [Ollama](https://ollama.com);
- about an hour for day one;
- a clock or a note app, to write down two times in task 1.

Cloud AI calls may cost a little on your own account. A local Ollama model costs
nothing but needs a reasonably fast computer.

## Day one

### Task 1: install FLUJO and connect your AI

**Write down the time now.** This is the start of your first run.

1. Install the FLUJO version named in your invitation. The
   [install guide](../../start-here/install.md) has the Windows installer, a
   one-line script for macOS and Linux, and `npx flujo-ai` for people who
   already have Node.js.
2. Open [localhost:4200](http://localhost:4200) in your browser. Keep FLUJO
   running while you use it.
3. Choose **AI Setup → Connect AI** and follow the questions.
4. On the new card, choose **Test model**.

**It worked when** the test shows an answer from the model. A saved card alone
does not mean the connection works.

If you need to create an account or get approved by an AI provider, note how
long that took. That time is not counted against FLUJO.

### Task 2: connect an app and test one tool

Apps (also called MCP servers) give the AI extra abilities, such as reading
files or opening web pages.

1. Choose **Connected Apps**. FLUJO comes with a few built-in apps, for example
   **filesystem** (read and write files in allowed folders) and **browser**.
   You can also choose **Connect App** to add another one.
2. Open the app's card and go to the **Tools** tab.
3. Pick a tool that only reads, fill in its fields and choose **Test**.

**It worked when** a result from the tool appears. Opening the form without
pressing Test does not count.

Practice idea, if you don't have your own yet: make a folder called
`flujo-practice` with a text file `practice-note.txt` that contains the line
`Receipt phrase: pocket-garden-042`. For the built-in filesystem app, the
folders it may use are set on its **Environment Variables** tab
(`FLUJO_FS_ROOTS`). Allow only the practice folder, never your whole home folder.

The [connected apps guide](../../features/mcp/overview.md) explains the screens.

### Task 3: build an agent that uses the app

1. Choose **Agents → Start simple**.
2. Write a goal, for example: *"Use the connected app to read
   practice-note.txt and tell me its receipt phrase. Don't guess."*
3. Make sure the step uses the AI you tested and the app from task 2.
4. Give the agent a name and choose **Try my agent**.
5. In **Talk**, ask it the question.

**It worked when** the executed steps (the **Show executed steps** button)
show a call to the app's tool, and the answer uses what the tool returned (for
the practice note: `pocket-garden-042`).

**Write down the time now.** This is the end of your first run. Note whether
anyone helped you.

The [first helper guide](../../journeys/first-agent.md) walks through a similar
agent with screenshots.

### Task 4: approve before the agent acts

1. In **Talk**, open **Run options** and turn on **Require tool approvals**.
2. Ask the same question again. FLUJO now stops before the tool runs and shows
   what the agent wants to do. Choose **Approve**.
3. Ask once more and choose **Reject** this time.

**It worked when** the tool ran only after you approved it, and nothing ran
when you rejected it.

### Task 5: watch the agent step by step

1. In **Talk**, open **Run options** and turn on **Debugger**.
2. Ask the question again. Stop at the step that calls the app, look at the
   tool's result, then continue to the end.

**It worked when** you could see which step was running, what the tool returned,
and the run finished after you continued.

### Task 6 (optional): use the same app from another program

If you already use Claude Desktop, Cursor, Cline or another program that
supports MCP, you can use the app you set up in FLUJO from there, without
setting it up twice. On the app's card, choose **Expose to external apps** and
follow the [API guide](../../api-reference/README.md). Keep it on
`localhost`.

**It worked when** the other program lists the app's tools and one tool call
returns a result.

## Every week (weeks 1 to 8)

1. **Use FLUJO for one real task you already do.** Pick something you would do
   anyway, for example sorting new issues or emails, checking documents, or
   watching a web page. It is fine to change the task during the pilot.
2. **At the end of the week, fill in the [weekly form](feedback-form.md).** It
   takes about five minutes. If you did not use FLUJO, say so; that is a useful
   answer.
3. **Optional: add a diagnostic report** (see below).

## Share a diagnostic report (optional)

FLUJO can create a short report about your setup on your own computer. It is
never sent anywhere by FLUJO.

1. Open **Settings → Privacy & usage**.
2. Under **Diagnostic report**, choose **Create report**.
3. Read the report. It lists versions, your operating system, how many AI
   connections, apps, agents and automations you have, their states, and how
   many runs, tool calls and errors happened in the last seven days.
4. If you are happy to share it, choose **Copy** and paste it into your weekly
   form, or **Save as file** and attach it.

The report never contains keys, passwords, prompts, conversations, file names,
folder paths, web addresses, or the names of your apps, models or agents. If you
see anything private in it, please don't send it and tell the pilot owner; that
would be a bug we need to fix.

## When something goes wrong

- Write down what you were doing, what you expected and what happened instead.
- Put that into the weekly form, or send it to the pilot owner straight away if
  it stops you from working.
- Do not send screenshots of private work, logs, API keys or exported
  workspaces.
- FLUJO has a **Report a bug** button that opens a public GitHub issue. Only use
  it for things you are happy to show publicly, and read the text before you
  send it.

## Stopping

You can stop at any time. Reply "stop" to the pilot owner. If you can, add one
line about why. Uninstalling is described in the
[uninstall guide](../../start-here/uninstall.md); back up anything you want to
keep first.
