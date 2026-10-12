# Optional MCP source review

Marketplace server details and the GitHub tab offer **Review source**. Review runs only after that click. It does not install or start the server, call a model, check the trust checkbox, or grant execution capabilities. Closing the dialog, changing repositories or workspaces, or selecting Cancel discards the pending result.

The report names the captured public GitHub commit, content digest, file count and source bytes. Inspect its findings and coverage limits before deciding whether to trust a server. A low score is not an installation approval. Registry packages, their downloaded dependencies, hosted endpoints and later revisions may contain different bytes.

## Operator setup

The optional engine requires Docker with Linux containers. FLUJO's application Python 3.11 cannot run SkillSpector 2.12.0, which requires Python 3.12–3.14. A separate scanner image leaves the application dependency graph unchanged.

From this checkout, build the pinned engine once:

```sh
docker build --file docker/skillspector.Dockerfile --tag flujo-skillspector:2.12.0 .
docker image inspect --format '{{.Id}}' flujo-skillspector:2.12.0
```

Set `FLUJO_SKILLSPECTOR_IMAGE` to that **full local `sha256:…` configuration ID** and restart FLUJO. Mutable image tags and missing/mismatched images are refused. Review never pulls images or installs software. The build fetches NVIDIA's immutable source archive and release wheel, checks both SHA256 hashes, uses the upstream frozen `uv.lock` graph, and refuses source-distribution dependency builds. Python and uv builder images are digest-pinned. Keep the local image until all reviews using it have finished.

Run the local engine acceptance separately from CI (supported Node 22.17+ or 24.2+):

```sh
node --experimental-strip-types scripts/smoke-skillspector.mjs sha256:YOUR_FULL_LOCAL_IMAGE_ID
```

This exercises the actual NVIDIA clean/poisoned fixtures, a threat outside the README, ordinary MCP source without a skill manifest, offline dependency lookup, live container restrictions, cancellation and cleanup. It makes no model calls. Qualification downloads the fixed upstream test fixtures; application scans fetch only the requested public GitHub source.

The FLUJO process must be able to reach the operator's Docker daemon. A standard application container without Docker access reports review unavailable. This feature does not mount or expose a Docker socket automatically; Docker access is an operator trust decision. Do not expose an unauthenticated remote daemon to enable it.

## What is inspected

FLUJO resolves HEAD once, or accepts a complete commit SHA, and fetches that commit's complete Git tree and blobs through the public GitHub API without credentials or redirects. It checks every blob's Git content hash and records a deterministic SHA256 digest of paths, sizes and bytes. It never uses Git hooks, filters, lifecycle scripts, dependency installers, or candidate entry points. It does not synthesize a `SKILL.md` for an ordinary MCP repository.

Limits are 256 files, 1 MiB per file and 8 MiB in total, plus bounded API responses and a 120-second review deadline. Truncated trees, links, submodules, Git LFS pointers, ambiguous paths and oversized complete repositories are unsupported instead of silently becoming README-only scans. Private repositories and arbitrary hosted URLs/runners are unsupported. GitHub's unauthenticated quota may make a source lookup unavailable; no owner or GitHub token is sent as a fallback.

The source is copied into a fresh, labeled Docker volume through a never-started staging container. Only that volume is mounted in the actual scanner, read-only at `/input`. There are no host bind mounts, application data mounts, provider credentials, public ports or network access. The scanner runs as UID/GID 1000 with a read-only root, init, dropped capabilities, no new privileges, 64 PIDs, 512 MiB memory, one CPU and a 64 MiB temporary filesystem. Its CLI uses `--no-llm --format json --fail-on-incomplete`; it has a 90-second process bound and bounded output. All workspaces share one scan slot without a background queue. Cancellation retains that slot until owned cleanup settles.

Only newly created containers/volumes matching the fresh ownership label and configured image are removed. Lost create replies trigger guarded lookup. Cleanup failure makes the review unavailable; it is not converted into a successful report. If the application or Docker daemon dies, an operator may need to inspect residual `flujo-security-review-*` resources and their `org.flujo.security-review.owner` labels before removing them. Never bulk-remove foreign resources based only on a name prefix.

## Interpreting results

This integration uses static analysis only. Semantic model passes are disabled. OSV live dependency queries cannot run with the scanner network disabled; fallback findings and coverage warnings remain visible. Missing `SKILL.md` metadata prevents some manifest-based MCP checks. Excluded files, analyzer states, inspection exceptions and suppressed findings remain explicit. This does not establish complete CVE coverage or discover a running server's tools and permissions.

Valid CLI exit 1 may contain important findings or incomplete coverage and is retained. Execution failure, timeout, incompatible version, malformed/oversized report and cleanup failure produce unavailable/cancelled results. The UI displays findings as text, never executable HTML or instructions. Reports are not saved or reused across sources, workspaces or scanner configurations, and no report is accepted as installation consent.

The current engine is NVIDIA SkillSpector v2.12.0, revision `c7958a3268d9498644b22edb75d0f051bbc8cbfc`: [upstream release](https://github.com/NVIDIA/SkillSpector/releases/tag/v2.12.0). The broader configured-model reputation assessment tracked by #101 remains separate work.
