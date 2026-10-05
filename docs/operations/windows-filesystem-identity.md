# Windows filesystem identity qualification

The snapshot reader and lease compare exact bigint device/inode values and
nanosecond timestamps. A production refusal is an admission failure. Preserve
the guard and the failed run while qualifying the runtime.

Hosted Windows Server 2025 with Node 22.13.1 reached `closed-owner:dev` in PR #692
run `37173927778`, job `111352467928`, merge
`d8c0e9e7e6dbb92b41e6a411fae4fd5b2eac3d0f`. The packaged app built and its payload
checks passed; installed startup failed. Exact device values were not logged.
This does not establish that timestamps caused the earlier admission failures.

Node 22.13.1 bundles libuv 1.49.2. Its [Windows implementation](https://github.com/nodejs/node/blob/v22.13.1/deps/uv/src/win/fs.c)
uses `GetFileInformationByName` for pathname stats when available and obtains a
32-bit volume serial number for descriptor stats. The [upstream libuv fix](https://github.com/libuv/libuv/commit/82cdfb75ff9bbd0dc65820ca418b7c5d412ff4d7)
corrects inconsistent volume serial number representations. Node 22.16.0 still
has the old assignment; [Node 22.17.0](https://github.com/nodejs/node/blob/v22.17.0/deps/uv/src/win/fs.c)
contains the fix and [updates libuv to 1.51.0](https://nodejs.org/en/blog/release/v22.17.0).
This source evidence explains a plausible runtime incompatibility; the hosted
temporary-file comparison and installed app must still confirm its effect.

Run the bounded native probe with each runtime on the same operating-system
image:

```powershell
node scripts/probe-filesystem-identity.mjs > filesystem-identity.json
```

The probe creates six regular files in its own fresh temporary directory. It
records bigint metadata from the writable descriptor, pathname before and
after writer close, and a read-only descriptor/path pair. Both descriptors
open before pathname observations, and exact descriptor identity is checked
before collecting them. The read-only descriptor is measured again after the
writer closes; it never reads bytes. It prints Node,
libuv and OS versions without a hostname, path, environment or file contents.
It exits nonzero when exact device/inode or other required metadata differs.
The lower-32-bit relation is diagnostic metadata only and never admits a file or
changes a comparison. Unexpected descriptor replacements refuse before samples
are collected. The probe checks its directory identity again after sampling.

The probe retains its temporary directory and at most six constant-content files.
It reports `cleanupPolicy: "retain-probe-files"`, `cleanupAttempted: false` and
`cleanupCompleted: false`, including after a successful identity comparison.
Separate pathname checks cannot make a later unlink or directory removal atomic
with the checked identity, so the probe performs no namespace deletion. Use a
caller-owned disposable temporary location and retain it with the diagnostic
evidence; its owning environment handles disposal under its own authority.
No existing workspace read occurs. Descriptor checks and retained files do not
establish isolation from an actor who can change the temporary namespace.

Exit 0 means all six identity samples and directory observations passed. Exit 1
means an identity or IO refusal. Neither outcome reports cleanup as completed or
qualifies installed startup.

The local Windows 10 Pro 10.0.19045 probe with Node 22.13.1/libuv 1.49.2 passed
all six samples. That does not qualify Windows Server 2025. Retain both runtime
probe outputs and exact image/source identities; then run the ordinary default
heap production build, payload validation and installed app/MCP process smoke
with the proposed runtime. A passed probe alone does not qualify installation,
change the supported Node requirement or satisfy the production scorecard.
