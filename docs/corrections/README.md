# Corrections become checks

One file per rule that an agent or reviewer had to correct more than once. The
rule and the order for fixing a repeat mistake (code, check, verification,
prose) are in `AGENTS.md`; the recipe is `.claude/skills/correct/SKILL.md`.

Each file holds one rule:

```
# <the rule in one sentence>

<optional: why, with an example of the mistake>

Enforced by:
- `<lint rule, test file or npm run script that CI runs>`
- `<symbol>` in `<path/from/the/repository/root>`

Verified by:
- `<a check run by hand, such as npm run journey:first-use>`

Prose: <why it needs judgment, for rules no program can check>
```

Use at least one of "Enforced by", "Verified by" or "Prose". Name the file
after the rule in a few lower-case words joined by `-`.

`npm run check:corrections` fails when a file names a lint rule, file, test,
script or symbol that does not exist, a test that CI never runs, or an
"Enforced by" list with nothing CI runs. `npm run check:corrections -- --list`
prints all rules as one table.
