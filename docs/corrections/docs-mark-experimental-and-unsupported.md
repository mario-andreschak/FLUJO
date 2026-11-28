# README, project status and SECURITY.md mark every experimental capability and unsupported profile, and make no claim the release evidence does not back

The #578 reassessment found that the project status page never marked Meetings
and Waves as experimental, and the README never said that shared or team use is
not supported. The check also stops "production-ready" style claims and a
silent drop of a feature the external audit graded.

Enforced by:
- `scripts/check-docs-claims.test.mjs`
- `checkDocsClaims` in `scripts/check-docs-claims.mjs`
