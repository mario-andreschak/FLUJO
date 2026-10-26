# Publishing a release

From a clean, synchronized official `main` checkout, run `npm run release -- patch` (or `minor`, `major`, an exact version). Authenticate GitHub CLI once with `gh auth login`; local npm login is unnecessary. `npm run release -- --dry-run` builds and validates without authentication or publication.

When main verification is administratively paused, enable `verify.yml` for the release commit push and pause it again after that exact push run exists. Publication still requires its successful current attempt and every required job; pausing future triggers does not invalidate that run.

For conversation recovery changes, run `npm run qualify:conversation-recovery` with `FLUJO_RECOVERY_SOURCE_ROOT` pointing to the existing configured installation and `FLUJO_RECOVERY_ACCEPTANCE_ROOT` set to a fresh private directory outside the checkout. It executes the original oversized-result cases with real subscription Luna and OpenRouter Free, validates both receipts and the dedicated execution baseline, and rejects skipped assertions. Hosted CI records these private-credential cases as intentional opt-ins; it does not substitute a model fixture.

The command synchronizes package versions and commits them. Because `main` accepts changes only through pull requests, it pushes that commit to `release/x.y.z`, opens and squash-merges a pull request (falling back to auto-merge when requirements are pending), and confirms the resulting `main` commit introduces exactly the same change. It then dispatches `publish-npm.yml` with the exact commit and version. The workflow verifies that revision, consumer-smokes the exact tarballs it will publish, and separately requires successful main-push CI. Preparation does not repeat the Jest suites; that required CI run supplies their evidence. The four standalone MCP packages are written back to back and confirmed together; `flujo-ai`, which pins their exact versions, is published only after all four are visible. Only after all five npm integrity values match does it create the version tag, explicitly dispatch the image and tagged installer workflows, and wait for both.

If publication or finalization fails, run `npm run release -- --resume RUN_ID`, using the run ID printed by the command. This verifies the workflow, repository, main revision, package version and local checkout, then reruns **failed jobs only**. Successful preparation retains the original tested artifact for 30 days. Published versions are skipped only when their integrity matches those exact bytes. Do not rerun the entire workflow or create a fresh version to repair a partial publication. If main moves, the artifact expires, or immutable published bytes differ, the release stops for inspection. Before a run exists, repeating the command reuses its pending version record in Git's worktree metadata.

The required Windows release-safety check runs the complete pinned Pester installer suite before npm publication. Its signed checksum fixture is read from the immutable historical Git revision, so both verification and installer decision jobs require full history. If an already published release requires a source fix, preserve its packages and tag and release the corrected source as a new patch; rerunning the old revision cannot apply that fix.

## One-time npm settings

In each package's npm **Settings → Trusted publishing**, add a GitHub Actions publisher for `flujo-ai`, `@mario.andreschak/mcp-flujo`, `@mario.andreschak/mcp-filesystem`, `@mario.andreschak/mcp-bash`, and `@mario.andreschak/mcp-browser`:

| Field | Value |
| --- | --- |
| Organization or user | `mario-andreschak` |
| Repository | `FLUJO` |
| Workflow filename | `publish-npm.yml` |
| Environment | Leave empty (the workflow uses no environment) |
| Allowed actions | Enable **Allow npm publish** |

These fields are case-sensitive. New connections allow staged publishing by default; direct publishing needs its own checkbox. This workflow uses neither staged approval nor separate dist-tag commands. It uses GitHub-hosted Ubuntu, pinned Node 24.21.0 with an immediate official binary check, and npm 11.21.0; publishing has only repository read access and `id-token: write`. The separate finalization job has GitHub write permissions. No npm write secret or credential fallback is used. All public manifests identify the canonical repository, enabling automatic npm provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

After the first successful publish, package owners can disable traditional token publishing and revoke old automation tokens in npm settings. GitHub tags created with `GITHUB_TOKEN` do not start push workflows, so this release explicitly dispatches the existing installer at its version tag. See [GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
