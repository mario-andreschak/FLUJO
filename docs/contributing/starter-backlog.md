# Starter tasks

Small, real tasks for your first pull request. Each issue explains what is wrong,
the steps, the commands to check your work, and when it is done. None needs an AI
account.

The live list is every open issue labelled
[`good first issue`](https://github.com/mario-andreschak/FLUJO/labels/good%20first%20issue).
These were opened on November 25, 2026:

| Issue | What you will do | Skills |
| --- | --- | --- |
| [#1438](https://github.com/mario-andreschak/FLUJO/issues/1438) Clear the "Copied" and "Saved" messages with the shared timer hook | Swap two raw timers for `useTimeout`, add two small component tests | React, Jest |
| [#1439](https://github.com/mario-andreschak/FLUJO/issues/1439) Share one lazy-loading helper for the three browser services | Replace three copies of the same code with one typed helper and a test | TypeScript |
| [#1440](https://github.com/mario-andreschak/FLUJO/issues/1440) Persona goal card: stop reading the clock while drawing | Make a card switch its label on time, with a fake-timer test | React, Jest |
| [#1441](https://github.com/mario-andreschak/FLUJO/issues/1441) Try the contributor guide on Linux or macOS | Follow the setup guide and fix what is wrong | Documentation |

## How to take one

1. Check that nobody has claimed it in the issue comments or an open pull request.
2. Comment that you are taking it. If you stop, say so, so someone else can.
3. Follow the [contributor guide](README.md). Ask in the issue whenever you are
   stuck; that helps us improve these instructions.

## Rules for this list

- **Kept for people.** AI agents working on this repository leave
  `good first issue` issues alone (see `AGENTS.md`), so they stay available for
  newcomers.
- **Small and checkable.** A good starter changes one or two files, has a test or
  command that proves it, and needs no access, account or payment. Login,
  encryption, release permissions and concurrency changes are never starters.
- **Kept fresh.** When one is done, the maintainer (or anyone who helps maintain
  this list) opens a replacement and updates the table above. Good sources are the
  old lint exceptions in `eslint-suppressions.json` (one rule in one or two files)
  and setup problems newcomers report.
