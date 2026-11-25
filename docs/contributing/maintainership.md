# Maintainership basics

> **Draft for Mario, written November 25, 2026 for
> [#576](https://github.com/mario-andreschak/FLUJO/issues/576).** It describes how
> FLUJO is maintained today and proposes the rest. Nothing marked
> **Mario decides** is in force until Mario confirms it in #576. Publishing this
> page does not make anyone a maintainer or give anyone access.

## Today in one paragraph

FLUJO has one human maintainer, Mario
([@mario-andreschak](https://github.com/mario-andreschak)). He owns the GitHub
repository and every account FLUJO is published through. AI coding agents do
most of the day-to-day work under the `flujo-app` account, following his
standing instructions. No second person can review a core change, publish a
release or answer a private security report. If Mario is unavailable, those
things stop. This is the "bus factor" gap in the
[scorecard](../quality/scorecard-status.md) (row "Community / bus factor").

## Who decides what

| Kind of decision | Who decides today | Proposal |
| --- | --- | --- |
| Everyday change (bug fix, test, docs, small refactor) | Mario, or an agent under his standing instructions | One reviewer who is not the author approves |
| Change in a `.github/CODEOWNERS` area (security, login, credentials, MCP process launch, install and update, releases, HTTP API) | Mario | Mario, or a trained backup for that area |
| Product direction, breaking changes, licence, removing features | Mario | Mario, written down in the issue |
| Who gets access, and how much | Mario | Mario; see [access](#access-and-rotation) |
| Releases and their timing | Mario (agents release under his instructions) | Unchanged |
| Private security reports | Mario | A named responder plus a backup (shared with [#565](https://github.com/mario-andreschak/FLUJO/issues/565)) |

An AI agent can write and merge code for Mario, but it never counts as a
reviewer, a backup or a maintainer.

**Mario decides:** whether these decision levels are right.

## How to escalate

1. Discuss in the issue or pull request, with examples and the options you see.
2. If it stays stuck, mention `@mario-andreschak` and say what decision you need.
3. Security problems never go in public: use the private report described in
   [SECURITY.md](../../SECURITY.md).

Proposed answer times: a first reply to a contributor's pull request within
7 days; a first reply to a private security report within 3 days.

**Mario decides:** these answer times, and whether they go into SECURITY.md.

## Supported releases

Facts: FLUJO publishes often (eight releases between October 26 and
November 21, 2026). Each release ships as the npm package `flujo-ai` plus four
MCP server packages, a Windows installer on GitHub Releases, and the container
image `ghcr.io/mario-andreschak/flujo`. Running from source is also possible.
Every form needs Node.js 22.23.4+ or 24.22.1+.

Proposal: **only the newest release is supported.** Fixes, security fixes
included, ship in the next release; older versions get no separate fixes. Users
update to stay supported. A version with a known serious problem is named in the
release notes and in a GitHub security advisory.

**Mario decides:** whether to adopt this, and whether to state it in
SECURITY.md (SECURITY.md itself belongs to #565).

## Access and rotation

What exists today, from the repository and its workflows. Account and recovery
details stay private and never go into Git.

| What | Where | Held by | Backup |
| --- | --- | --- | --- |
| GitHub repository (admin) | `mario-andreschak/FLUJO`, owned by Mario's personal account | Mario | None |
| Agent account (write) | GitHub user `flujo-app` | Controlled by Mario | None |
| npm packages | `flujo-ai`, `@mario.andreschak/mcp-flujo`, `-filesystem`, `-bash`, `-browser`; published by GitHub Actions through npm trusted publishing, no npm token stored ([release guide](../npm-release.md)) | Mario as npm owner | None |
| Container image | `ghcr.io/mario-andreschak/flujo`, published by GitHub Actions | Tied to Mario's GitHub account | None |
| Windows installer | GitHub Releases, built by `installer.yml` | Repository | None |
| Website | GitHub Pages from `githubpages/`, domain `flujo.com.co` | Mario (registrar and DNS account are private) | None |
| Community | Discord server | Mario | None |
| Private security reports | GitHub **Security** tab of the repository | Repository admins (Mario) | None |

The workflows use only the built-in `GITHUB_TOKEN`; no long-lived publishing
secret is stored in the repository. That keeps rotation simple.

**Adding a person.** Grant the smallest role that fits, after the steps in
[becoming a maintainer](#becoming-a-maintainer): GitHub **Triage**, then
**Write**, then **Maintain**; **Admin** only as a planned successor. Add npm
ownership only to someone trained to release. Check the access works with a
harmless action (for example labelling an issue) and write down the date.

**Removing a person** (leaving, or account lost): remove their GitHub role, npm
ownership, container package access and Discord admin rights; check open
invitations; rotate anything they could read (today nothing, since no secrets
are stored); write down what was removed and when.

**Review the list** every six months, and after anyone leaves.

**Mario decides:** the review interval, and when to add a second npm owner.

## Emergency steps

If Mario cannot be reached:

- **Today**, with no backup, nobody else can publish a release, change
  repository settings or read private security reports. Installed copies keep
  running; they just stop receiving updates. The MIT licence lets anyone fork
  FLUJO and continue it.
- **Once a backup exists**, the backup:
  1. waits the agreed time (proposal: 14 days without an answer on the private
     contacts) before acting;
  2. handles private security reports first;
  3. uses only access that was granted and tested beforehand, never a guessed
     or borrowed account;
  4. publishes only through the normal [release procedure](../npm-release.md);
  5. writes down who did what, when, and with which access, in a private note
     and a short public issue.

Ways to make this real (all **Mario decides**):

- Name a successor in GitHub (**Settings → Account → Successor settings**) so a
  trusted person can keep the repository going if Mario's account is ever left
  unattended.
- Move the repository into a GitHub organization with two owners, so access does
  not depend on one personal account.
- Add a second owner to the five npm packages once someone is trained.
- Keep recovery codes and a short private contact list somewhere a backup can
  reach in an emergency.

## Becoming a maintainer

1. Get a few pull requests accepted (the [starter tasks](starter-backlog.md) are
   a good start).
2. Review a core change: explain what it changes for users, what could break, and
   which test would catch it.
3. Run the [release and recovery drill](maintainer-drill.md) yourself, without
   the original author doing it for you.
4. Mario decides on a role and grants the smallest access that fits it.

Each step needs the person's consent, and only a human decides a promotion.
Never contact possible contributors on FLUJO's behalf without Mario's approval.

## Security and release tabletop

A practice run with made-up data, so a backup has done it once before it
matters: receive a private report, decide how bad it is and which versions it
affects, reproduce it, review a fix privately, verify a release candidate, decide
on an advisory, follow up. Use the [release procedure](../npm-release.md),
including its rule to rerun only failed jobs after a partial publish. The
practice run publishes nothing. Write down who took part, the decisions, the
times and what was missing.

## Evidence record

The audit target in #576 counts people, not commits: two more maintainers who
can review a core change and run the drill, and three or more people outside the
author who make accepted contributions or reviews over 90 days. Automated
commits, bots and stars do not count.

Keep one line per event, with the person's consent, in the #576 issue or a
private list:

```text
Date | Person (public handle, with consent) | Kind: first PR, review, drill, access check | Link | Help they needed | Notes
```

Count each person once per measure. A gap stays visible until it is closed.

## Mario's checklist

Only Mario can do these. Tick them in
[#576](https://github.com/mario-andreschak/FLUJO/issues/576).

- [ ] Confirm or change this draft: decision levels, answer times, supported
      releases.
- [ ] Decide where to invite contributors (README, Discord, social posts) and
      approve the invitation text below.
- [ ] Find a second maintainer and a security backup; grant access only after
      the steps above (also tracked in #565).
- [ ] Name a GitHub account successor, or move the repository into an
      organization with two owners.
- [ ] Add a second npm owner once someone is trained.
- [ ] Store recovery codes and emergency contacts where a backup can reach them.
- [ ] Decide whether to add a code of conduct; it needs a contact person for
      reports.

Invitation draft (not sent):

> FLUJO is looking for people who want to help. Start with a small task from
> the starter list; you need no AI account. If you enjoy it, we would like to
> train one or two people to review changes and run releases. Nothing is
> granted until you agree to a role.
