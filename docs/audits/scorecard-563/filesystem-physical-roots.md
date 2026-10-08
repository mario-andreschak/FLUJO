# Filesystem physical-root correction

The independent Windows review found that a junction inside an allowed root
could read and change an owned marker outside that root. The existing lexical
outside-path tests still passed. This is a separate physical-boundary defect;
the eleven original CodeQL false-positive proposals remain proposals and no
finding is dismissed by this correction.

The standalone filesystem package now checks logical root membership, resolves
the existing destination or nearest existing parent, and checks physical root
membership before every tool operation. The environment ceiling is checked
independently, so a client-provided root alias cannot widen it. An existing
dangling link is rejected instead of being projected as a missing directory.
Tracked-file resource reads repeat the same check, including when a recorded
parent changes to a junction between requests. Directory listings do not follow
links merely to return target sizes.

Requested pathnames remain intact so moving or deleting an allowed link still
acts on that link. Links into a second explicitly allowed root, a configured
root that itself is a link, ordinary reads/writes and missing-root creation
remain supported. Physical roots/destinations are resolved afresh on each
operation. This is a pre-operation check; it does **not** establish atomic
isolation against concurrent host directory/link replacement or broader host
filesystem isolation.

The new targeted suite exercises fifteen tool-operation variants against an
escaping junction and verifies rejection before open/read/write/mkdir/rename/
delete/list/stat operations. It also covers missing parents, the client-root
ceiling, allowed links, link move/delete behavior, dangling links, listing
metadata and tracked resources. The existing cancellation test observes the
mocked ripgrep spawn before cancelling rather than assuming that confinement
I/O completes in one event-loop turn. Early cancellation still requires no
spawn.

Retained raw baseline and fixed compiled-handler probes, build/typecheck/lint
logs and scoped Jest reports are in the task evidence directory:
`C:/Users/Moe/.codex/visualizations/2026/10/03/01a103ab-4561-7400-95ca-4be7249284cd`.
The baseline has compiled-module SHA-256
`76825a2ca043ff3b06ee3b7d946b5989338552837785915647b258f37352effb`;
it both reads and changes the outside marker through the owned junction.
The fixed direct compiled probe uses no Jest adapter and checks zero content
operations for rejected junction calls. Every file/link belongs to a verified
temporary fixture, removed after the observations.

The corrected scoped run passes all 130 checks across six suites, with no
skips. The direct compiled probe passes 25 checks. The standalone filesystem
build and package typecheck, changed-file ESLint with `--no-ignore`, and
`git diff --check` pass. These results are source checks on Windows; they do
not establish installed-package or cross-platform acceptance.

The first local Jest invocations collected no tests because the Windows
worktree path was rendered with mixed separators in the configured glob. The
retained passing commands use the same declared collection glob without an
absolute-root prefix and explicitly select the six filesystem suites:

```text
node scripts/run-local-jest.cjs --selectProjects=node --runInBand --testMatch='**/__tests__/**/*.test.{ts,tsx}' --runTestsByPath __tests__/mcp/filesystemPhysicalRoots.test.ts __tests__/mcp/filesystemTools.test.ts __tests__/mcp/filesystemRoots.test.ts __tests__/mcp/filesystemNodeRoots.test.ts __tests__/mcp/filesystemApp.test.ts __tests__/mcp/filesystemMediaDetection.test.ts
```

The first broader run's two failures are retained: cancellation occurred before
the mocked child spawned, leaving its unused mock queued and stalling a later
search test. The affected test now waits for the actual spawn boundary. No
assertion, scan scope or CI configuration was relaxed. Full combined-candidate
CI, updated scanning, independent gate disposition and published/installed
artifact acceptance remain separate requirements.
