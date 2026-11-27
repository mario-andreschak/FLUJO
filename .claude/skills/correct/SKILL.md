---
name: correct
description: Turn a repeated mistake into a check so it cannot come back. Use when the user or a reviewer corrects an agent, when the same fix shows up a second time, or when asked to "make this a rule", "stop agents doing X" or "/correct".
---

# Correct: turn a repeated mistake into a check

Adapted from the `correct` skill in Lauren Tan's pstack (MIT,
https://github.com/cursor/plugins/tree/main/pstack). FLUJO's rule lives in
AGENTS.md under "Corrections become checks".

## 1. Name the mistake

Write one sentence: what keeps happening, and why it is wrong for FLUJO.

Find at least two real cases. Look in `git log -S '<code>'`, `git log --grep`,
reverts, PR review comments (`gh api repos/mario-andreschak/FLUJO/pulls/<n>/comments`)
and `eslint-suppressions.json`. One case is a bug, not a pattern: fix it and stop.

## 2. Pick the highest layer that works

1. Code. Can an API, a type or the folder layout make the wrong code impossible?
   Give each piece of state one owner, hide internals, and delete the old path
   once its callers have moved.
2. A check. Can a program tell right from wrong? Add a lint rule, a type or a test.
   For behavior over time (waits, retries, ordering, fences that must heal), use
   a fast-check property test or extend the TLA+ model in `docs/formal/`.
3. Verification. Does it only show in the running app? Add the journey to the
   matching `docs/feature-map/` entry and check it with the `verify-flujo` skill.
4. Prose. Only when it needs judgment. Add one short line to AGENTS.md with an
   example of the failure.

## 3. Write the check

- A lint rule goes in `tooling/eslint-plugin-flujo/rules/<name>.mjs`, is
  registered in `index.mjs`, and is switched on in `eslint.config.mjs` for the
  narrowest set of files that needs it.
- The message says what to do instead and why, in one or two plain sentences.
  It never suggests turning the rule off.
- Add cases to `tooling/eslint-plugin-flujo/rules.test.mjs`, taken from the real
  code you found in step 1: at least one that passes and one that fails.
- Prove it catches the real mistake: lint the old version of the file
  (`git show <sha>:<file> | npx eslint --stdin --stdin-filename <file>`) and see
  it fail.

## 4. Deal with existing code

- A handful of hits: fix them in the same pull request.
- Many hits: record them once with
  `npx eslint src __tests__ scripts --suppress-rule <rule>`, commit
  `eslint-suppressions.json`, and open an issue to work the list down.
  Never use `--suppress-all`.

## 5. Record it

Add one file to `docs/corrections/` (the format is in its README.md): the rule
as the heading, then "Enforced by:" with the lint rule, test or `npm run` script
from step 3, each in backticks with its path from the repository root. Never add
a table row to AGENTS.md; parallel branches all append there and conflict. If
the check replaces a line of prose, delete that line.

`npm run check:corrections` fails when the file names something that does not
exist or a test CI never runs. A new `node --test` file goes into the
`test:checks` script; a Jest test under `__tests__/` runs in CI by itself,
except `__tests__/enduringAgents/`.

## 6. Verify

```
npm run lint:all
npm run lint:ratchet
npm run test:checks
```

## Shared folders

Other agents work on this machine at the same time. Delete only files you
created, by their exact path; never clean temp, scratchpad or worktree folders
with a wildcard or name pattern.
