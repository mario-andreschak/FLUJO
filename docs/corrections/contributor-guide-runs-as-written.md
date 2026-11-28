# The contributor guide works as written on Linux and macOS

A machine follows `docs/contributing/README.md` in a fresh clone (#1441): every
`sh` block in order, then every command in a table's "Run" column. Put a setup
command in an `sh` block or a "Run" column, never only in prose, so the
walkthrough runs it too. A block followed by "stop with Ctrl+C" and a local
address must start a server that answers there and stops on Ctrl+C. A word the
reader fills in (such as `YOUR-NAME`) needs a stand-in in `STAND_INS`.

Enforced by:
- `scripts/contributor-guide.test.mjs` (in `npm run test:checks`)
- `assertContributorGuideJob` in `scripts/workflow-contract.mjs`

Verified by:
- `node scripts/contributor-guide.mjs` (the contributor-guide job of `.github/workflows/verify-full.yml`, on Ubuntu and macOS)
