# Every open security alert is fixed or has a written reason that expires

Enforced by:
- `scripts/security-response-check.test.mjs` checks the rules and that `docs/security/alert-triage.json` gives a valid reason for every listed alert

Verified by:
- `npm run check:security-response` reads the live alerts from GitHub (needs GitHub access)
