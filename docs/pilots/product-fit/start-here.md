# Run the pilot: start here

The pilot for [#577](https://github.com/mario-andreschak/FLUJO/issues/577) asks
one question: can a first-time user get through FLUJO's day-one tasks without
getting stuck? It runs by itself; nobody has to invite, watch or ask anyone.

## The scripted pilot

```sh
npm run build
npm run pilot:scripted
```

Three scripted first-time users (a desktop, a laptop and a phone-sized window)
each get a fresh FLUJO with an empty data folder and work through every day-one
task of the [tester guide](tester-guide.md), the way the guide tells a person to:

1. connect an AI and test it;
2. let the built-in filesystem app read only a practice folder and test its
   `read_file` tool on the practice note;
3. build an agent with **Agents → Start simple** and ask it for the note's
   receipt phrase;
4. turn on **Require tool approvals**, approve once and reject once;
5. turn on the **Debugger**, step through the run and continue to the end;
6. expose the app to external apps and read the note from another MCP program;
7. create the diagnostic report under **Settings → Privacy & usage**.

The AI is a free local stand-in (`scripts/scripted-pilot/pilot-model.mjs`): it
lists the allowed folders, reads the note and quotes what the tool returned, so
no account or key is needed. Everything else is the real FLUJO. FLUJO's anonymous
daily usage pulse goes to a local stand-in too, so pilot runs never count as real
installations, and the pilot checks that it holds only the five fields its notice
names.

Every task has a fixed rule. It passes only when its result shows on screen
within its time limit and no red error message appears. Tasks 1 to 3 together
(the first run) must take less than 15 minutes. The diagnostic report must be
complete, count what the tester just did, and contain none of the tester's
names, paths, addresses or the practice phrase.

The run writes `result.md` (a short result in plain language), `result.json`,
each tester's diagnostic report, and a screenshot and page snapshot of every
task. It exits with 1 when any task fails. Options: `--only p02-laptop` for one
tester, `--out <folder>` for the result folder, `--mode dev` without a build.

The broad CI run (`verify-full`) runs it on Linux and Windows and keeps the
result folder as a download; `scripts/workflow-contract.mjs` fails when that
job is missing or made optional.

## Inviting real people too

The rest of this page and the rest of the kit are for anyone who also wants to
invite real testers later. Nothing in this folder contacts anyone, sends data or
starts that by itself.

## What is in the kit

| File | Who reads it | What it is for |
| --- | --- | --- |
| [Who to invite and the invitation](invite.md) | Pilot owner | Pick testers and send a ready-made message |
| [Consent note](consent-note.md) | Testers | What we collect, what we never collect, how to stop |
| [Tester guide](tester-guide.md) | Testers | Step-by-step tasks for the first hour and the weekly routine |
| [Weekly feedback form](feedback-form.md) | Testers | Five-minute check-in, once a week |
| [Weekly tracking sheet](tracking-sheet.csv) | Pilot owner | One row per tester per week |
| [First-run sheet](first-run-sheet.csv) | Pilot owner | One row per tester for the very first run |

The longer documents in this folder ([README](README.md),
[task protocol](tasks.md), [evidence format](evidence-format.md),
[detailed consent drafts](recruitment-consent.md)) are for the independent
reviewer and for a strict, checkable record. You do not need them to run the
pilot week by week.

## The four steps

### 1. Recruit (week 0)

- Choose a contact address for the pilot (for example a separate mailbox or a
  Discord channel only you can read).
- Fill in the blanks in the [invitation](invite.md): name, start date, the
  FLUJO version to install and your contact.
- Pick 12 to 15 people from the [target groups](invite.md#who-to-invite), so
  that about 10 are still there after eight weeks.
- Give each person a tester number (`p001`, `p002`, …). Keep the list that
  connects names to numbers in a private place, never in this repository.

### 2. Send (week 0)

- Send each person the invitation, the [consent note](consent-note.md) and
  the [tester guide](tester-guide.md).
- Wait for a clear "yes, I agree" to the consent note before you count
  anyone. Write down the date of each yes in your private list.
- Pick one start date for everyone. Week 1 is the first seven days after it.

### 3. Collect (weeks 1 to 8)

- Each tester sends the [weekly form](feedback-form.md) at the end of each
  week. A short reminder message is in the [invitation page](invite.md#weekly-reminder).
- Copy each answer into one row of the [tracking sheet](tracking-sheet.csv).
  If a tester sends nothing, still add the row with `report_received` set to
  `no`. A missing week is a result, not a gap to hide.
- After a tester's first run, fill in one row of the
  [first-run sheet](first-run-sheet.csv).
- When a tester reports a problem, open a GitHub issue in your own words.
  Leave out names, prompts, file names, keys and anything from their
  computer. Put the issue number into the sheet.

### 4. Review (every week, and once at the end)

Every week, look at four numbers in the tracking sheet:

1. How many testers sent a report.
2. How many used FLUJO for real work that week (`used_flujo` = `yes` and at
   least one finished workflow).
3. Which problems came up more than once (`problem_codes`).
4. Who stopped, and why (`stopped`, `stop_reason`).

To get these numbers without a spreadsheet, save both sheets as CSV and run this
from a FLUJO checkout (it only reads the two files and prints a summary):

```sh
node scripts/product-fit-pilot/sheets.mjs --weekly <your tracking-sheet.csv> --first-run <your first-run-sheet.csv>
```

It prints each week's reports, real use, finished and failed tasks, help given and
drop-outs; who used FLUJO in every week so far; who reported a real benefit in two
or more weeks; missing reports; problems that came up more than once; and the
first-run result against the 15-minute target. Rows with a typo are listed so you
can fix them in the sheet.

Fix or file the repeated problems first. When a fix ships, ask the tester who hit
it to try again and note the result in the next week's row.

At the end of week 8, hand the sheets (with tester numbers only) to the
independent reviewer ([#578](https://github.com/mario-andreschak/FLUJO/issues/578)).
The proposed targets from #577 are:

- at least 10 independent testers use FLUJO every week for eight weeks;
- at least three different real workflows that testers repeat and find useful;
- repeated serious problems are fixed and confirmed by the tester on a new release;
- failed tasks and help you had to give are reported, not only successes.

Count everyone who agreed, including people who stopped or never replied. Do not
replace drop-outs with new people to reach ten.

## Rules that keep testers safe

- Never ask for or accept API keys, passwords, workspace exports, prompts or
  screenshots of private work. If someone sends them anyway, delete them and tell
  them you did.
- Testers share a **diagnostic report** only if they want to. FLUJO creates it on
  their computer (Settings → Privacy & usage → Diagnostic report) and never sends
  it. It holds versions, counts and error counts, not names or content. Read it
  before you file anything based on it.
- People you pay, people who work with you, and accounts run by AI agents can
  test, but mark them in your private list. They do not count toward the ten.
- Publishing a quote or a named story needs a separate yes from that tester for
  that exact text.

## Fill in the sheets

Open the `.csv` files in any spreadsheet program. Keep the filled-in copies in
your private folder, not in this repository. Use the codes below so the
numbers can be added up later.

`tracking-sheet.csv` (one row per tester per week):

| Column | What to enter |
| --- | --- |
| `week` | 1 to 8 |
| `tester` | Tester number, for example `p003` |
| `report_received` | `yes` or `no` |
| `used_flujo` | `yes` if they used FLUJO for their own work that week |
| `finished_workflows` | How many real tasks finished as the tester wanted |
| `failed_workflows` | How many real tasks failed or were given up |
| `used_connected_app` | `yes` if a finished task used a connected app (MCP server) |
| `benefit` | `time-saved`, `better-control`, `connection-reuse`, `none` or `unmeasured` |
| `help_given` | How many times you had to step in (answer a question, fix a setting) |
| `problem_codes` | Codes from the list below, separated by `;` |
| `issue_numbers` | GitHub issue numbers, separated by `;` |
| `flujo_version` | The version shown in Settings → Updates |
| `install_method` | `windows-installer`, `npm`, `docker`, `script` or `source` |
| `stopped` | `yes` if the tester left the pilot this week |
| `stop_reason` | `no-time`, `setup-failed`, `not-useful`, `other-tool`, `privacy`, `cost` or `other` |

`first-run-sheet.csv` (one row per tester):

| Column | What to enter |
| --- | --- |
| `tester` | Tester number |
| `date` | Day of the first run, `YYYY-MM-DD` |
| `minutes` | Minutes from starting the install to the first agent answer that used a connected app. Leave out time spent creating an account with an AI provider. |
| `finished` | `yes` or `no` |
| `stopped_at` | If not finished: `install`, `model`, `connect`, `inspect`, `tool-test`, `agent` |
| `help_given` | `yes` if anyone helped live or wrote code for them |
| `new_to_flujo` | `yes` if they had never finished an agent run with a connected app in FLUJO before |
| `problem_codes` | Codes from the list below, separated by `;` |

Problem codes (the same as the [evidence format](evidence-format.md)):
`installation`, `prerequisite`, `authentication`, `quota`, `discovery`,
`tool-form`, `tool-call`, `model-binding`, `runtime`, `approval`, `debugger`,
`proxy`, `accessibility`, `unclear-next-step`, `other`.

If the reviewer asks for a stricter, checkable record, the same codes go into the
[offline reporter](README.md#collect-and-report-offline).
