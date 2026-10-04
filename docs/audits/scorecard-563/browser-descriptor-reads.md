# Browser MCP descriptor reads

JavaScript CodeQL analysis `1887460260` scanned PR #611 merge commit
`99700a26e0b954de1abc221c856e9f373af55dc1` and reports 86 findings.
The browser package still has two `js/file-system-race` findings:

| Alert | Checked pathname | Later pathname read |
| --- | --- | --- |
| 167 | `mcp-servers/browser/src/tools.ts:424` | Recording inlining at line 436 |
| 168 | `mcp-servers/browser/src/runtime.ts:1138` | Extension preferences at line 1140 |

The analyzed source blobs are respectively
`49b351d03719f0777c5a8542edc4067f73660646` and
`509f94b98b2752250989916a5a9999e775daada4`; both match the main-based
correction's baseline. These are problem-query related locations, not
invented taint/dataflow paths. The full downloaded SARIF is retained as
`integration-99700a26-codeql.sarif.json` in the task evidence directory.

Both consumers now open a file once, check regular-file type/size through
that handle, and read through the same handle. Reads stop at the configured
limit plus one byte even if the opened file grows after its size check.
An oversized recording retains its output-path warning without inline bytes;
oversized/unavailable preferences remain unavailable. The handle closes in
`finally` on normal, early-return and error paths. Preferences retain their
50,000,000-byte bound, and recording inlining retains its configured bound
and default 16 MiB. The correction follows CodeQL's
[descriptor recommendation](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/).

Two deterministic baseline cases replace an entirely owned pathname after
its size check. The old recording consumer inlines the larger replacement,
and the old extension consumer lists the replacement preferences. Both fail
the retained negative-control expectations. The corrected cases read the
original descriptor. Recording completion is mocked in that test so it
does not claim an actual encoder or browser session.

All 26 checks across the new file-read suite and the existing browser server
and recording-fallback suites pass. The eight new cases cover both real
pathname replacements, actual growth after descriptor stat with nine bytes
read for an eight-byte limit, exact/oversized bounds, missing/empty/directory
inputs and closing on read failure. The Windows worktree command explicitly
selects those three suites with the declared relative collection glob;
CI configuration is unchanged.

A direct compiled-package probe, without a Jest adapter, passes five checks:
the helper retains the original pathname-replaced file, the actual extension
consumer retains original preferences, growth reads stop at limit+1, all
three intercepted descriptors close, and malformed preferences stay unavailable.
All files are owned temporary synthetic data; no browser launches or personal
profiles are involved. Browser package build/typecheck, changed-file ESLint
with `--no-ignore`, and `git diff --check` pass.

Raw reports, source/compiled hashes, the probe and command logs are retained in:
`C:/Users/Moe/.codex/visualizations/2026/10/03/01a103ab-4561-7400-95ca-4be7249284cd`.
This is source evidence. The correction does not establish initial-path
admission, parent-directory isolation, an immutable snapshot under in-place
modification, installed-artifact behavior or real recording acceptance.
The eleven original false-positive proposals remain open and unaccepted.
Fresh combined scanning and independent findings disposition remain required.
