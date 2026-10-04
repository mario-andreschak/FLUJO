# Private-profile test fixture correction

## Problem and correction

The main CI test gate for frozen #632 (`c2a37fffb4ce4c4d27ddcb6b42b44f790c8437a9`, run 37164249011) executed 843 suites and 7,725 assertions. It failed with 28 failed suites / 239 failed assertions, plus two unapproved opt-in container skips. Several route and scheduler fixtures expected an implicitly unlocked, unconfigured workspace. The new profile deliberately denies that state, so their unrelated business assertions received `423 encryption_locked` or did not dispatch work.

Twenty-five affected unit suites now explicitly model an already unlocked workspace through a local mock of `isEncryptionLocked`. The rest of the real encryption module remains available. This mock is scoped to those test files; no global setup, production function, denial assertion, test baseline, quarantine or CI configuration changes.

The two suites that exercise real credential encryption and persistence instead enroll USER metadata and authenticate through the actual APIs before using credentials. Their random fixture password is confined to their Jest environment. The helper refuses any installation root except the ordinary Jest-owned temporary-root pattern. The unchanged private-profile suite still checks fresh setup denial, public-password rejection, operator-file loss/mismatch, restart and concurrent initialization.

The recovery route fixture also needed its independently introduced worker bearer admission modeled correctly: an explicit synthetic control token and bearer pass the real route wrapper, then the actual handler returns its expected worker refusal. The token and mode are restored in `finally`; the existing locked-response assertion remains.

## Validation

This follow-up stacks the exact frozen #632 head, with its unchanged Next 16.3.5 lockfile and Windows Node 22.13.1. Dependencies were installed for that lockfile without changing either manifest or lockfile. The installed Next route guide was read. Root's dependency-remediated integration uses Next 16.3.8 and requires its own aggregate checks.

- 283 assertions passed in 24 affected unit suites.
- Nine assertions passed in the final two-suite recovery/Bash run, completing all 292 assertions across the 26 affected unit suites.
- 34 assertions passed across the real MCP credential persistence, manual OAuth client and unchanged private-profile suites. One POSIX permission assertion is explicitly skipped on Windows; Linux CI must execute it.
- All changed files passed ESLint and `git diff --check`.
- Only the shared and Bash standalone packages were built as prerequisites for the existing harmless-process Bash fixture. No full application graph or Next production build ran in the owner checkout. The Bash suite starts its real local MCP process; the manual OAuth SDK test uses a synthetic fetch fixture, not a live provider.

The initial owner unit run is retained: 24 suites passed; the Bash suite lacked its compiled prerequisite and the recovery assertion hit the worker wrapper's `503` before its handler. After building those two small packages and correcting worker admission, both suites passed. The earlier CI artifact and failure receipt are retained as well.

## Remaining gates

This is a test-only follow-up. Production source bytes and #632's frozen source evidence are unchanged. Full aggregate CI and integrated source/build receipts remain coordinator work. The #615/#619 opt-in container tests still require their controlled local-image qualification and a reviewed CI disposition; this patch does not approve or hide their two skips. The baseline says: “Do not approve a new skip solely to silence a regression.”

Private-profile product acceptance, resumable migration, credential-free export/recipient transfer, worker restore, installed artifacts, human acceptance and independent reassessment remain open. This fixture correction does not establish an A- outcome or a fully green #632 test gate.
