# Windows production build repair

GitHub `main` was restored to `cb891f54792dd59aa807a8f95ea3cab7da0315c6`
at the owner's request after the ordinary Windows build exhausted its heap.
The Persona changes from `91bc97d3114f1d6dfcae9827fac2b0079c3a8001` remain on
`codex/fix-windows-production-build` with this repair. The earlier Linux CI and
isolated local build results did not establish that a populated Windows checkout
could build. Issues #489 and #448 were reopened and the delivery comments corrected.

## Cause and correction

The failure reproduced with `npm run build` in
`C:\Users\Moe\Documents\GitHub\FLUJO`, using the installed Node **22.13.1**
and its default **4,144 MiB** V8 heap limit. The Next server compiler exited
with code **134**, reporting heap exhaustion after approximately 185 seconds.

A diagnostic run recorded **444,261 directory reads beneath `workspaces`**
and **55,919 traced files**. Runtime paths expanded into project-wide globs
such as `**/*/mcp-servers/**/*`. Next 16.3.5 bundles its current glob inside
`@vercel/nft`; the existing preload only patched the separate, older
`next/dist/compiled/glob` implementation. Final `outputFileTracingExcludes`
filtering happens too late to prevent that traversal and allocation.

The preload now supplies a filesystem view that prunes `workspaces` before
enumeration, scoped to those two Next tracing bundles. Application filesystem
access stays unchanged. Dependencies and deployable application assets remain
traceable. No heap increase, cache deletion, runtime-data removal, or skipped
build/type checks are required.

## Local verification

All checks below used Node **22.13.1** in the actual populated checkout:

- Ordinary **`npm run build`: exit 0**, build ID `U9Ig05FLp1DYTwT7eAwVW`.
  Compilation completed in 56 seconds, TypeScript in 36.9 seconds, and all
  116 static pages generated. All five MCP packages also built.
- **226 server dependency manifests** inspected; **zero runtime workspace files**.
- **Two real Next tracer regression cases**: project-wide dynamic glob and
  direct workspace glob. Both failed before the repair and pass afterward.
  Assertions cover zero workspace enumeration, retained application assets
  and dependencies, prefix collisions, and ordinary filesystem access.
- **Seven local Jest suites, 46 tests passed**, covering Persona recovery across
  process death, private Flow ownership, gallery pagination, bounded storage
  reads, workspace path safety/process locking, and backend initialization.
- **Production HTTP smoke passed** with fresh disposable data on port 4287:
  Persona/Role pages, Role and Persona creation, gallery summary, workspace
  isolation, and persistence across a real production server restart. Both
  owned server processes were stopped after the check.
- ESLint passed for the changed build script and regression tests.

Local logs and machine-readable results are retained under
`.tmp/windows-build-repair/`. CI now runs the ordinary production build and the
tracer regression on both Windows and Linux with Node 22.13.1. The preload
depends on Next's bundled tracing module paths; those integration tests must
continue to run when upgrading Next.

The production HTTP smoke is not a repeat of the complete browser journey or
the multi-week Persona acceptance workload. Earlier acceptance artifacts remain
historical evidence for their recorded commits; they do not describe the
restored `main` or imply that the complete Persona goal is closed.
