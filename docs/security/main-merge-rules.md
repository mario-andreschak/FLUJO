# Merge rules for `main` (#565)

This page is for the repository owner. Only an administrator can change merge
rules; nothing in the source code turns them on.

## What `main` has today

Checked on 2026-11-25 with `gh api repos/mario-andreschak/FLUJO/rules/branches/main`.
The active ruleset `24434701` ("main branch safeguards") blocks deleting `main`,
blocks force pushes and requires a pull request with zero approvals and resolved
review threads. It requires **no passing checks**. A pull request with a red
build or a new critical scanner alert can still be merged.

## The prepared ruleset

[`.github/rulesets/main-verification.json`](../../.github/rulesets/main-verification.json)
keeps everything above and adds:

- the twelve checks from `verify.yml` (build, release safety on Linux and
  Windows, types, lint, both test stages, workflow rules, dependency audit, both
  CodeQL scans and the final `verification` check), each bound to GitHub
  Actions (app 15368) so nobody can fake them with a status from another tool;
- "branch must be up to date with `main`" before merging (strict checks);
- a CodeQL rule that blocks a pull request adding a new high or critical alert;
- an empty bypass list, so no account, bot or admin skips the rules silently.

`scripts/verify-repository-rules.test.mjs` checks that this file matches the
read-only auditor, so the template and the audit cannot drift apart.

## The one command

Run as a repository administrator from a checkout of `main`:

```sh
gh api --method PUT repos/mario-andreschak/FLUJO/rulesets/24434701 --input .github/rulesets/main-verification.json
```

This updates the existing active ruleset in place, so there is no second ruleset
to keep in step. Then check it:

```sh
node scripts/verify-repository-rules.mjs main
```

To go back to today's rules, run the same `PUT` with a copy of the file that
leaves out the `required_status_checks` and `code_scanning` rules.

## The trade-off, in plain words

Today agents push and merge without waiting for checks. With these rules:

- **A merge waits for the checks.** On recent pull requests `verify.yml` took
  about 15 to 20 minutes. Agents do not have to sit and wait: they can run
  `gh pr merge <number> --auto --squash` (auto-merge is already allowed in the
  repository settings) and move on. GitHub merges by itself when the checks pass
  and leaves the pull request open when one fails.
- **Up-to-date branches cost re-runs.** The strict rule means that after one
  pull request merges, every other open pull request must take in the new `main`
  and run its checks again before it can merge. With many agents merging in
  parallel this adds re-runs and delay. GitHub's merge queue would remove this
  cost, but it is only offered to organisation-owned repositories.
- **Lighter option:** set `strict_required_status_checks_policy` to `false` in
  the file before running the command. Each pull request then needs its own
  checks to pass once, and auto-merge never waits for a rebase. The risk is that
  two pull requests that each pass can break `main` together. Releases already
  refuse to publish unless the exact `main` commit passed `verify.yml`, so such a
  break cannot reach users, but `main` can be red for a while. The audit script
  and the scorecard's engineering row expect the strict setting.
- **Scanner alerts can block a merge.** A pull request that adds a new high or
  critical CodeQL alert cannot merge until it is fixed, or someone dismisses it
  with a written reason on GitHub.
- **No silent bypass.** Admins can no longer merge around the rules either. To
  merge an emergency fix with a failing check, the administrator first changes
  the ruleset, which leaves a visible record.

What stays the same: no human approvals are required, and pull request stacks
that merge into other branches are not affected, because the rules apply to
`main` only.

## After applying it

The issue's last acceptance step is a drill: open a disposable pull request with
a deliberately failing test against a disposable branch that carries the same
rules, and show that `gh pr merge` is refused. The steps are in
[engineering verification](../engineering-verification.md#disposable-merge-denial-drill).
