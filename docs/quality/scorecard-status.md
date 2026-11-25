# Scorecard status (epic #563)

Checked on **2026-11-25** against the source on `main` at `32890f24` (version
3.48.10, the latest published release) plus the issue-cleanup branch. The goal of
[epic #563](https://github.com/mario-andreschak/FLUJO/issues/563) is an
independent A− or better on all nine rows of the external audit.

This page awards no grade. It lists what exists in the code today, what is still
missing for A−, and which issue owns each missing piece. Only an independent
reviewer can grade ([#578](https://github.com/mario-andreschak/FLUJO/issues/578)).
The measurable targets behind each row are in the
[scorecard foundation contract](scorecard-foundation.md).

## Summary

| Row | Audit grade | Still missing for A− | Owner | Can automation finish it? |
| --- | --- | --- | --- | --- |
| Idea / product fit | A− | Proof that people other than the author use it again and again | [#577](https://github.com/mario-andreschak/FLUJO/issues/577), [#572](https://github.com/mario-andreschak/FLUJO/issues/572) | No: needs real users |
| Feature surface | A− | The main journeys checked on the shipped installers, not only on source | [#572](https://github.com/mario-andreschak/FLUJO/issues/572), [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#578](https://github.com/mario-andreschak/FLUJO/issues/578) | Mostly yes |
| Engineering discipline | B+ | Merge rules that block failing changes; 70 open code-scanning alerts; 6 open dependency alerts; a named security responder | [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#576](https://github.com/mario-andreschak/FLUJO/issues/576) | Partly: merge rules need Mario's decision, the responder needs a person |
| Code health | B− | The four biggest files keep growing; 802 listed lint exceptions; a second person who can change the core | [#571](https://github.com/mario-andreschak/FLUJO/issues/571), [#1423](https://github.com/mario-andreschak/FLUJO/issues/1423), [#661](https://github.com/mario-andreschak/FLUJO/issues/661) | Splitting yes; the second person no |
| Security | C+ | Credentials and login are protected only if the owner opts in; shared use is not isolated; scanner alerts in MCP code; no outside security review | **No owner** for the defaults (see below), [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#573](https://github.com/mario-andreschak/FLUJO/issues/573)–[#575](https://github.com/mario-andreschak/FLUJO/issues/575), [#578](https://github.com/mario-andreschak/FLUJO/issues/578) | Mostly yes, except the outside review |
| Maturity / stability | C | Long real-model runs; installed restart and backup checks; experimental features still experimental; open bug reports | [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#578](https://github.com/mario-andreschak/FLUJO/issues/578), single bug issues | Yes, but long runs need elapsed time and a provider budget |
| Community / bus factor | D | Two more human maintainers; three or more outside contributors over 90 days | [#576](https://github.com/mario-andreschak/FLUJO/issues/576), [#577](https://github.com/mario-andreschak/FLUJO/issues/577), [#661](https://github.com/mario-andreschak/FLUJO/issues/661) | No: needs people |
| Docs honesty | A | Keep README, status, security and changelog in step with the code; publish evidence for one exact release | [#565](https://github.com/mario-andreschak/FLUJO/issues/565), [#578](https://github.com/mario-andreschak/FLUJO/issues/578) | Yes |
| Production readiness | C− | Installed operation checked on each install method; multi-user and team isolation | [#570](https://github.com/mario-andreschak/FLUJO/issues/570), [#573](https://github.com/mario-andreschak/FLUJO/issues/573)–[#575](https://github.com/mario-andreschak/FLUJO/issues/575) under deferred [#212](https://github.com/mario-andreschak/FLUJO/issues/212) | Mostly yes, but #212 is deferred by the owner |

**Honest overall picture:** no row that started below A− can be shown at A−
today. Three rows (community, product fit and the outside reviews) depend on
people, not code. The rows that started at A− or A can drop if their evidence is
not kept current.

## Row by row

### Idea / product fit (A−)

- **Delivered since the audit:** MCP stays the centre of the product. A
  product-fit pilot kit exists: [tasks and consent](../pilots/product-fit/README.md)
  and `scripts/product-fit-pilot/`. The first-use navigation was repaired in
  PR #1128 (part of #572).
- **Missing:** the targets in the contract: ten independent people using FLUJO
  weekly for eight weeks, and eight of ten new users finishing a first
  model-plus-MCP run within 15 minutes. No pilot has started. #577 was deferred on
  2026-10-08 and later reopened.

### Feature surface (A−)

- **Delivered:** every feature the audit listed is still present. Added since:
  owner login, container-isolated MCP servers, MCP security review (#101, #527),
  worker mode, Meetings and Waves (experimental). Tool tester fixes #517 and #526
  are closed.
- **Missing:** a recorded run of the main journeys (model, MCP server, agent,
  debugger, approval, OpenAI and MCP endpoints) on the shipped npm package,
  Windows installer and Docker image. Source tests do not prove the installers.
  The `npm run drive` tool and the [feature map](../feature-map/) can script this.

### Engineering discipline (B+)

- **Delivered:** [SECURITY.md](../../SECURITY.md) with private vulnerability
  reporting switched on; `.github/CODEOWNERS`; verify workflows; release
  provenance guides ([verification](../engineering-verification.md),
  [release distribution](../release-distribution-verification.md)); custom lint
  rules with a shrink-only exception list (#1426); a feature map and a
  verification skill (#1428); an import boundary test. About 1,380 test files.
- **Missing:**
  - Merge rules on `main` require a pull request and resolved review threads,
    but **zero approvals and no required checks**. On 2026-10-04 the rules held 13
    required checks and one approval; they were relaxed later to match the
    owner's "merge without waiting for CI" policy. A reviewer will see that a red
    build does not block a merge.
  - **70 open code-scanning alerts** on `main` (3 critical, 29 high, 38 medium).
    The three critical ones are in `src/backend/services/security/isolatedMcp.ts`
    and `src/backend/services/mcp/githubInstall.ts` (opened 2026-11-20). Three
    high ones in `scripts/flujo-drive.mjs` are fixed on the cleanup branch (see
    below).
  - **6 open dependency alerts**: five for `hono` (used at runtime, fixed in
    4.13.16) and one for `minimatch` (development only).
  - No named security responder, backup or response time (SECURITY.md says so).

### Code health (B−)

- **Delivered:** the import boundary test for `backend`, `frontend` and
  `shared`; lint rules against blocking file calls, raw timers and double casts;
  the lint exception ratchet; module and ordering contracts in
  [execution module boundaries](../architecture/execution-module-boundaries.md).
- **Missing:** the hot spots named in #571 grew instead of shrinking. Line counts
  at planning (2026-10-03) → today:

  | File | Then | Now |
  | --- | --- | --- |
  | `src/backend/execution/flow/runFlow.ts` | ~3,540 | 3,852 |
  | `src/backend/execution/flow/handlers/ModelHandler.ts` | ~4,375 | 5,167 |
  | `src/backend/services/mcp/index.ts` | ~3,577 | 4,144 |
  | `src/frontend/components/Chat/index.tsx` | not measured | 6,440 |

  `eslint-suppressions.json` lists 802 exceptions in 261 files (#1423). GitHub
  reports the repository at about 300 MB (the audit said about 120 MB); the
  checked-out files are 185 MB, of which 80 MB is one website video. The human
  maintenance exercise (#661) has not happened.

### Security (C+)

- **Delivered:** owner login, browser sessions, scoped API access and first-owner
  pairing (#566); Network and Public modes refuse to start without an owner login;
  passphrase and operator-file encryption with checked migration of old records
  (#567); container-isolated MCP servers and owner consent before host launches
  (#568); SECURITY.md and private reporting.
- **Missing:**
  - **Defaults (no owner issue).** A fresh local install still has no login on
    `localhost`, and it still wraps the credential key with the public default
    password unless the owner sets a passphrase
    ([private encryption profiles](../security/private-encryption-profiles-v1.md)).
    Anyone who copies the data folder can read the saved credentials. Turning
    on login takes a command-line tool and four environment variables
    ([first-owner pairing](../security/first-owner-pairing-v1.md)), so few users
    will do it. #566 and #567 are closed, so nobody owns changing these defaults.
  - Multi-user isolation (#573–#575 under #212, deferred by the owner).
  - Triage or fixes for the critical and high code-scanning alerts in MCP code
    (#565).
  - SECURITY.md still says #566–#568 are "being delivered"; they are closed
    (#565).
  - An outside security review of an installed release (#578).

### Maturity / stability (C)

- **Delivered:** the heap out-of-memory crash #520 is closed, with memory bounds
  from #569. #515, #517, #526, worker restart recovery #553 and shutdown receipts
  #547 are closed. Persona acceptance issues #505, #435 and #418 are closed. The
  README no longer opens with "too complicated?".
- **Missing:** Personas, Meetings and Waves are still marked experimental (an
  honest label). No multi-day run with a real model exists; the contract's spend
  limit for such runs is currently zero. Restart, backup and restore are not yet
  checked on installed profiles (#570). Several bug reports are open (for example
  #1419, #1389, #1368, #1350, #757); none is marked critical.

### Community / bus factor (D)

- **Delivered:** [CONTRIBUTING.md](../../CONTRIBUTING.md), a
  [maintainer and succession plan](../contributing/maintainership.md), a starter
  backlog, a task map and a maintainer drill.
- **Today's numbers:** since 2026-08-25 the commits (merges left out) are 1,124
  from `flujo-app`, 128 from the `FLUJO` bot, 73 from Dependabot, 6 from
  `Flujo Agent`, 5 from Mario and 1 from one outside person. Of the 420 pull
  requests merged in that time, 349 came from `flujo-app`, 70 from Dependabot
  and 1 from that outside person. 674 stars,
  92 forks, 6 watchers. No account or duty in the maintainer access table has a
  backup person. On the cleanup branch (#576): the contributor guide was walked through on
  Windows and fixed, five `good first issue` issues are open (#1438–#1442), and
  the [maintainership basics](../contributing/maintainership.md) are a draft
  waiting for Mario's decisions.
- **Missing:** two more human maintainers and three or more outside contributors
  over 90 days. Automation cannot supply these.

### Docs honesty (A)

- **Delivered:** [project status](../project-status.md) names experimental
  features and limits; the foundation contract separates definitions from
  results; this page.
- **Missing:** SECURITY.md is out of date (see Security). Evidence bound to one
  exact release is not published (#578). This row drops if pages go stale, so
  refresh this page whenever a child issue changes state.

### Production readiness (C−)

- **Delivered:** a Docker image with an owner-aware health check (#994, #997),
  worker mode with its own login, a
  [backup, upgrade and restore guide](../operations/production-operations.md),
  and a Windows upgrade and rollback drill on source builds (#1151).
- **Missing:** the same checks on the npm package, the Windows installer, Linux
  and the container (#570). Multi-user and team isolation (#573–#575): without it
  the audit's "not a multi-user system" still holds. #212 is deferred by the
  owner, so this row cannot reach A− for shared use until that changes.

## Gaps no child issue covered

| Gap | Action |
| --- | --- |
| `scripts/flujo-drive.mjs` kept its state file in the shared temp folder, and `stop` deleted whatever folder that file named | Fixed on the cleanup branch: state and evidence now live in the user's own cache folder, and `stop` only deletes a data folder the tool created. Three high scanner alerts go away. |
| Credentials and login are protected only when the owner opts in | Needs a new issue: protect the credential key with the operating system's per-user store by default (Windows DPAPI, macOS Keychain, a private key file outside the data folder on Linux), migrate existing installs with a backup, let the owner turn on login from Settings instead of environment variables, and consider login by default for new installs. |
| The four hot-spot files grow with each feature | Suggested for #571: a size ratchet like the lint ratchet, added once parallel work has landed. |
| Shell installers clone the full history, including an 80 MB website video | Suggested for #570/#571: a partial clone, or moving the video to release assets (the website uses it, so only with Mario's approval). |

## What only people can do

- [ ] Decide whether `main` should require passing checks before a merge. Auto-merge
      lets agents keep working without waiting (#565).
- [ ] Name a security responder and a backup (#565, #576).
- [ ] Find two more human maintainers and outside contributors (#576).
- [ ] Run the product-fit pilot with real users (#577).
- [ ] Run the human maintenance exercise (#661).
- [ ] Ask an independent reviewer to regrade one exact release (#578).
- [ ] Decide whether shared or team use (#212) stays deferred. While it does, the
      production-readiness row can only be graded for single-owner use.

## Refresh this page

```sh
gh api repos/mario-andreschak/FLUJO --jq '{stars:.stargazers_count,forks:.forks_count,watchers:.subscribers_count}'
gh api repos/mario-andreschak/FLUJO/rules/branches/main
gh api "repos/mario-andreschak/FLUJO/code-scanning/alerts?state=open&per_page=100" --jq 'group_by(.rule.security_severity_level)|map({severity:.[0].rule.security_severity_level,count:length})'
gh api "repos/mario-andreschak/FLUJO/dependabot/alerts?state=open" --jq 'length'
git log --since=<date> --no-merges --format=%an | sort | uniq -c | sort -rn
wc -l src/backend/execution/flow/runFlow.ts src/backend/execution/flow/handlers/ModelHandler.ts src/backend/services/mcp/index.ts src/frontend/components/Chat/index.tsx
```
