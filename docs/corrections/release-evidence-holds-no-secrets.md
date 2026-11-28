# Release evidence never holds a key, token, password or e-mail address

The collector refuses to write a page whose page, JSON or saved answers contain
one, and the committed pages are scanned on every run.

Enforced by:
- `scripts/collect-release-evidence.test.mjs`
- `findSecrets` in `scripts/collect-release-evidence.mjs`
