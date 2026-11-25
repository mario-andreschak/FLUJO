# Who to invite, and what to send them

Part of the [pilot kit](start-here.md). Nothing here is sent automatically.

## Who to invite

Look for people who already have a task that an AI helper with tools could do,
and who are willing to try FLUJO on their own computer for eight weeks. A good
mix has testers from at least three of these groups, so the pilot shows
different kinds of real use.

| Group | What they do today | What they would try in FLUJO | Connected apps they likely use |
| --- | --- | --- | --- |
| MCP users in coding tools | Use tool servers (MCP) in Claude Desktop, Cursor, Cline or VS Code | Set up each tool server once in FLUJO, test it, then use the same servers from their coding tool through FLUJO | GitHub, file system, browser, database |
| People who sort incoming work | Go through issues, tickets, emails or feeds by hand every week | An agent that reads the new items through a connected app and drafts a short list of what needs attention | GitHub, Gmail or IMAP, RSS, Linear or Jira |
| People who check documents | Compare project files, specs or release notes for mistakes | An agent that reads a folder and checks one rule (for example "all versions match"), with approval before any change | File system, Git |
| People who watch web pages | Check websites for changes, prices or broken pages | An agent that opens the pages, compares them with what they expect, and asks before it does anything | Browser (Playwright), fetch |
| Privacy-minded users | Want AI help but keep keys and data on their own machine | The same tasks with a local model (Ollama) or their own API key, all on localhost | Any of the above |
| Agent builders | Build and debug AI agents in code | Build the agent visually, stop it at a step with the debugger, and see each tool call | Any |

Where to find them (only after you decide to start outreach):

- people who opened issues or discussions on the FLUJO repository and are not
  the author or an automated account;
- the FLUJO Discord;
- MCP communities (for example the MCP subreddit and MCP Discord servers);
- local-AI communities (for example people who run Ollama);
- colleagues and friends of friends who match a group above. Mark people who
  work with you, so they are not counted as independent.

Who does **not** count toward the ten independent testers: the author, accounts
run by AI agents, people you pay or who promote FLUJO for you, and people who
work for you. They can still test; keep them in a separate list.

Aim for 12 to 15 people. Some will stop, and everyone who agreed still counts
in the results.

## Invitation

Fill in the parts in square brackets. Keep the message short; attach or
link the [consent note](consent-note.md) and the [tester guide](tester-guide.md).

> Subject: Try FLUJO for eight weeks and tell us what works
>
> Hi [name],
>
> I'm looking for a few people to try FLUJO for eight weeks, starting
> [start date]. FLUJO is a free, open-source app that runs on your own
> computer. It lets you connect an AI model and tool servers (MCP), build small
> AI helpers with them, watch each step, and approve tool use before it
> happens.
>
> What I'm asking:
>
> - install FLUJO [version] and follow a short guide (about an hour the first
>   time);
> - pick one task you already do every week and try it with FLUJO;
> - answer a five-minute form once a week.
>
> Failures are just as useful to me as successes. You can stop at any time,
> and you don't have to recommend FLUJO or write a review.
>
> I never ask for your API keys, prompts, files or conversations. FLUJO can
> create a short diagnostic report on your computer if you want to share
> versions and error counts with me; it is never sent automatically. The
> details are in the consent note.
>
> You'll need your own AI access: an API key you already have, a supported
> subscription login, or a free local model with Ollama. Calls to a paid AI
> provider may cost you a little; I'll never ask you to spend money.
>
> Interested? Reply with "yes" and I'll send the guide. Questions go to
> [contact].
>
> Thanks,
> Mario

## After someone says yes

> Thanks for joining! Three things:
>
> 1. Read the consent note: [link]. Reply "I agree" if you are happy with it.
> 2. Your tester number is [p0xx]. Use it in the weekly form instead of your name.
> 3. Start with the tester guide: [link]. Day one is [start date].

## Weekly reminder

> Hi! Week [n] of the FLUJO pilot ends today. The weekly form takes about five
> minutes: [link or form text]. If you didn't use FLUJO this week, that's a
> useful answer too: just say so. If you want to stop, reply "stop" and I'll
> remove you from the reminders.

## If someone stops

> Thanks for trying FLUJO. Could you tell me in one line why you stopped? For
> example: no time, setup didn't work, not useful for me, I use another tool,
> privacy, or cost. Any answer helps, and you don't have to give one.
