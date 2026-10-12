# Publishing a release

From a clean, synchronized official `main` checkout, run `npm run release -- patch` (or `minor`, `major`, an exact version). Authenticate GitHub CLI once with `gh auth login`; local npm login is unnecessary. `npm run release -- --dry-run` builds and validates without authentication or publication.

The command synchronizes package versions, commits and pushes `main` without a release tag, then dispatches `publish-npm.yml` with the exact commit and version. The workflow verifies that revision, consumer-smokes the exact tarballs it will publish, and separately requires successful main-push CI. It publishes the four standalone MCP packages before `flujo-ai`. Only after all five npm integrity values match does it create the version tag, explicitly dispatch the image and tagged installer workflows, and wait for both.

If publication or finalization fails, run `npm run release -- --resume RUN_ID`, using the run ID printed by the command. This verifies the workflow, repository, main revision, package version and local checkout, then reruns **failed jobs only**. Successful preparation retains the original tested artifact for 30 days. Published versions are skipped only when their integrity matches those exact bytes. Do not rerun the entire workflow or create a fresh version to repair a partial publication. If main moves, the artifact expires, or immutable published bytes differ, the release stops for inspection. Before a run exists, repeating the command reuses its pending version record in Git's worktree metadata.

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
