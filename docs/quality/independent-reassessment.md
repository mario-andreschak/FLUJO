# Independent reassessment package (#578)

The [external audit](https://github.com/mario-andreschak/FLUJO/issues/563)
graded FLUJO on nine rows. [Epic #563](https://github.com/mario-andreschak/FLUJO/issues/563)
asks for A− or better on every row. Only a person outside the project can give
that grade. This page is what we hand that person: what to look at, which
release, the nine rows and the questions to answer.

Nothing on this page is a grade. The project's own view of each row is in the
[scorecard status](scorecard-status.md); treat it as the project's claims, to
be checked.

## Who can review

The reviewer must be independent:

- not Mario, not the `flujo-app` account, and not any AI agent or bot run for
  the project (the automated source review recorded in the
  [foundation contract](scorecard-foundation.md) does not count);
- no paid work for, or ownership in, FLUJO in the last 12 months, unless it is
  written in the report;
- no commits, reviews or issue triage in this repository in the last 90 days;
- comfortable reading a Node.js and TypeScript code base and judging the
  security of a local app that starts programs (MCP servers) on its host.

If the reviewer uses AI tools, the report says which and for what. The grades
and reasons must be the reviewer's own.

## Which release

The review is of **one exact release**: its commit, its npm packages, its
Docker image digest and its Windows installer, as listed on its
[release evidence page](release-evidence/README.md).

| Release | Evidence | Note |
| --- | --- | --- |
| 3.48.10 (2026-11-21) | [v3.48.10.md](release-evidence/v3.48.10.md) | Latest release today. Built before the SBOM was attached to release pages and before the current cleanup work |
| Next release after the cleanup bundle reaches `main` | collect with `npm run evidence:release -- --version <x.y.z> --out docs/quality/release-evidence` | Recommended for the review: it carries the security, release and documentation fixes made for #565, #573 and #576 |

## What the reviewer gets

| Topic | Material |
| --- | --- |
| The assessed release | Its release evidence page; the source at the exact commit; the npm packages, image and installer it names |
| The original audit and the targets | Epic [#563](https://github.com/mario-andreschak/FLUJO/issues/563) (original grades and reasons); [scorecard foundation contract](scorecard-foundation.md) and its [JSON](scorecard-foundation.json) (criteria and numeric targets per row) |
| The project's own account | [Scorecard status](scorecard-status.md); [project status](../project-status.md); [README](../../README.md); [changelog](../../CHANGELOG.md) |
| Security | [SECURITY.md](../../SECURITY.md); [vulnerability response](../security/vulnerability-response.md); [alert triage](../security/alert-triage.json); [owner access](../security/owner-access-v1.md); [private encryption profiles](../security/private-encryption-profiles-v1.md); [MCP execution consent](../security/mcp-execution-consent-v1.md); [MCP execution profiles](../security/mcp-execution-profiles.md); [main merge rules](../security/main-merge-rules.md) |
| Architecture and code health | [Architecture overview](../architecture/README.md); [execution module boundaries](../architecture/execution-module-boundaries.md); [multi-user contracts](../architecture/multi-user-contracts.md) |
| Operations and releases | [Production operations](../operations/production-operations.md); [release distribution verification](../release-distribution-verification.md); [npm release](../npm-release.md); [Windows installer checklist](../windows-installer-release-checklist.md) |
| People | [Contributing](../../CONTRIBUTING.md); [maintainership](../contributing/maintainership.md); [product-fit pilot kit](../pilots/product-fit/README.md) |

The repository is public, so no account is needed to read code, CI runs, the
npm registry or the image. Open security alert details are visible only to
maintainers; the evidence page gives their counts and `alert-triage.json` gives
a written reason for each one.

## Kinds of evidence, kept apart

The reviewer should weigh each kind for what it is. For 3.48.10:

| Kind | Where it is | State for 3.48.10 |
| --- | --- | --- |
| Source tests | Release evidence page: CI and Tests | 13,473 of 13,486 tests passed on the release commit, 0 failed, 13 skipped (each skip needs a written reason in `test-baseline.json`) |
| Shipped-artifact checks | Release evidence page: npm, image, installer | Signed build records name the release commit for all npm packages, the image and the installer. No recorded run of the main user journeys on the installed packages (#572). The clean-Windows first-launch job did not run for this release. On the cleanup branch, #570 adds backup, restart, upgrade and restore checks on each shipped form inside the release workflows, so later evidence pages show them as jobs |
| Offline simulations | `persona-soak.yml`, started by hand with the commit to test | Not run on the 3.48.10 commit. Must be run with `commit_sha` set to the assessed commit |
| Live runs with real models | None | The contract's spend limit for such runs is zero |
| Human use and usability | Product-fit pilot (#577) | Not started |

## The nine rows and the questions

For each row, give a grade, the reasons, the evidence used and what would raise
it. The criteria behind each row are in the foundation contract.

| Row | Audit grade | Look at first |
| --- | --- | --- |
| Idea / product fit | A− | README, product-fit pilot kit, #577 |
| Feature surface | A− | Installed release, feature map, project status |
| Engineering discipline | B+ | Release evidence page, CI workflows, main merge rules, vulnerability response |
| Code health | B− | Architecture docs, the largest files, lint exception list |
| Security | C+ | SECURITY.md, the security docs above, the installed defaults, alert triage |
| Maturity / stability | C | Project status, open bug reports, operations guide |
| Community / bus factor | D | Commit and pull-request authors, maintainership, contributing |
| Docs honesty | A | Whether README, project status, changelog and security docs match what the release does |
| Production readiness | C− | Operations guide, worker mode, Docker image, multi-user contracts |

Questions per row:

1. **Idea / product fit.** Is an MCP-first local hub still a real gap next to
   the alternatives the audit named? Is there any sign of repeated use by people
   other than the author?
2. **Feature surface.** Install the release (npm, Docker or Windows installer).
   Do the main journeys work: connect a model, add an MCP server, build and run
   an agent, use the debugger and an approval, call the OpenAI-compatible API and
   the MCP proxy? Which fail, and on which install method?
3. **Engineering discipline.** Does the evidence page tie the shipped bytes to
   one commit that passed CI? Can a failing change still reach `main`? Is the
   vulnerability response real (targets, triage, private reporting)?
4. **Code health.** Can a newcomer find and change the execution and MCP code?
   Do the module boundaries hold? Are the largest files a risk?
5. **Security.** With the installed defaults, who can reach the app and read
   saved credentials? Do owner login, encryption passphrase, MCP consent and
   container isolation work as described? Are the 3 critical and 28 high open
   code-scanning alerts at release real problems? Report any finding privately
   first, through [SECURITY.md](../../SECURITY.md).
6. **Maturity / stability.** Does the release stay up under normal use, recover
   after a restart and restore from a backup? Are experimental features clearly
   marked?
7. **Community / bus factor.** Who besides Mario and the project's bots can
   maintain, review and release? What happens if Mario is away for a month?
8. **Docs honesty.** Does every claim in the README, project status and security
   docs hold for this release? Name any claim the evidence does not support.
9. **Production readiness.** For which use is the release ready: one owner on
   one machine, a worker, or a shared team server? What is missing for the next
   step?

Also answer: is the evidence page reproducible (run
`npm run evidence:release -- --version <x.y.z>` and the `gh attestation verify`
commands it lists), and is anything on it wrong?

## Known gaps before the review starts

So the reviewer does not spend time finding what is already known (all from
the 3.48.10 evidence page and the scorecard status):

- The full pull-request checks (`verify-full.yml`) and the scorecard source
  checks did not run on the release commit; both are started by hand.
- The installer workflow has no code-signing step, so Windows will treat the
  installer as unsigned.
- The npm SBOM, `release-evidence.json` and `SHA256SUMS` were not attached to
  the 3.48.10 release page. They are signed and stored by GitHub; releases made
  after the #565 change reaches `main` attach them.
- 3 critical and 28 high code-scanning alerts were open when 3.48.10 shipped.
  Every alert open today has a fix or a written reason in
  [alert-triage.json](../security/alert-triage.json) on the cleanup branch.
- `main` accepts merges without passing checks or an approval
  ([main merge rules](../security/main-merge-rules.md) explains the choice).
- A fresh local install has no login on `localhost` and protects saved
  credentials with a public default password unless the owner sets one.
- Almost all commits come from Mario and the project's bots; there is no second
  human maintainer.

## The report

Ask for one report with:

- the reviewer's name or handle, date, and any ties to the project;
- the exact release and commit assessed, and how it was installed;
- per row: grade, reasons, evidence used, what would raise it;
- security findings with severity (sent privately first if high or critical);
- anything on the evidence page or in the docs that is wrong.

The project publishes the report unchanged, as a comment on
[#578](https://github.com/mario-andreschak/FLUJO/issues/578), including grades
below A− and disagreements. Then the scorecard status page is updated from it.
Any row below A−, or any open disagreement, keeps #563 open.

## Checklist for Mario

Automation cannot do these steps:

- [ ] Pick the release to assess (recommended: the first release after the
      cleanup bundle is on `main`). Before collecting its evidence, start
      `verify-full.yml`, `scorecard-source.yml`, `persona-soak.yml`
      (`commit_sha` = the release commit) and the clean-Windows installer job
      (`installer.yml` with `clean_windows`) on that commit.
- [ ] Collect and commit its evidence page:
      `npm run evidence:release -- --version <x.y.z> --out docs/quality/release-evidence`.
- [ ] Find a reviewer who meets "Who can review" and agree scope, time and any
      fee. A fee is your decision; nothing here commits money.
- [ ] Send them the link to this page and the release evidence page.
- [ ] Post their report unchanged on #578 and ask an agent to update the
      scorecard status from it.
