# MCP package CodeQL review

This slice addresses findings in the JavaScript CodeQL analysis **1887239452**,
at PR #611 merge commit `d29fbd24355c741bbc5b9064d990fe03fbb2b993`.
It does not claim that a newer integration head has been scanned or accepted.
The eight baseline source blobs in the accompanying evidence match that
analysis exactly, although this change is based on main commit
`3511ba49514fe8cf525f5a22c16c3806bf3886ba`.

## Source changes

| Alerts | Change | Boundary evidence |
| --- | --- | --- |
| 133, 134 (`js/polynomial-redos`) | Replace the two Bash quote-matching regexes with one forward scan. Complete spans are masked for advisory detection; incomplete spans remain visible. Commands are never rewritten. | Escaped quotes, operators inside/outside spans, unfinished quotes, and a compiled-package child containing 200,000 escaped quotes. |
| 135 (`js/polynomial-redos`) | Trim trailing URL slashes with a backward scan, preserving existing trimming and worker loopback validation. | Path/query preservation, credentials rejection, and compiled-package children with 500,000 trailing and internal slashes. |
| 147, 148 (`js/insecure-randomness`) | Use `node:crypto.randomUUID()` for background and PTY session IDs, retaining the existing prefixes/timestamp. | Both tool handlers retain two distinct sessions under a frozen clock and constant `Math.random`; another owner still cannot control them. Child/PTY execution is mocked for this test. |
| 12, 13 (test fixture URL matching) | Route mocked npm responses by parsed HTTPS hostname rather than a substring. | Reject lookalike hostnames, userinfo, paths/query strings containing the hostname, and HTTP. This changes a test fixture, not production authentication. |

The compiled regression cases both timed out at five seconds against the
unfixed baseline. After recompilation they passed. The child deadline prevents
a synchronous regex regression from stalling Jest's own event loop.

## Proposed false positives — independent review required

No alert was dismissed, and no query, scan scope or severity threshold changed.
The classifications below are proposals for the gate owner and independent
reviewer. They do not themselves clear the required findings gate.

### Filesystem: alerts 156–162

The original SARIF contains four paths for **each** reported sink. Every path
starts in an outside-root rejection test:

| Original source | Call | Required outcome |
| --- | --- | --- |
| `filesystemRoots.test.ts:47` | `write_file`, persisted root is a different directory | Error before disk access |
| `filesystemRoots.test.ts:55` | `write_file`, no root includes the absolute temp path | Error before disk access |
| `filesystemNodeRoots.test.ts:90` | `write_file`, selected node root is a different directory | Error before disk access |
| `filesystemTools.test.ts:625` | `write_file`, configured root is a different directory | Error before disk access |

The taint paths reach `resolvePath` and then the reported sinks at lines 725,
940, 967, 981, 993, 1054 and 1121 of `mcp-servers/filesystem/src/tools.ts`.
The analyzed `resolvePath` resolves the path and throws at lines 255–256 when
the roots do not contain it; that path cannot return at line 258. These test
inputs are deliberately outside the configured roots. Some reported paths also
select an infeasible tool branch: all four source calls are `write_file`, while
the sinks include `read_file` and `edit_file`. Line 725 is an `fs.open` with
read-only flag `'r'`, which cannot create a temporary file.

The added parameterized check covers read, whole-file write, append, insert,
range overwrite, literal edit and diff edit. It asserts both the outside-root
error and zero calls to `open`, `readFile`, `writeFile` and `mkdir`. Existing
root/node-root tests and all 80 filesystem tool checks also passed. These direct
handler tests use the documented Jest shared-module adapter; this evidence does
not establish installed filesystem behavior or broader filesystem security.

### Script extraction: alerts 139–142

The reported regexes extract generated inline JavaScript for test execution:

| Original location | Input producer | Use of extracted string |
| --- | --- | --- |
| `browserServer.test.ts:138` | `browserReadResource(BROWSER_APP_URI)` | `new Function` syntax check |
| `browserServer.test.ts:159` | `renderBrowserViewHtml()` | `new Function` syntax check |
| `filesystemApp.test.ts:89` | `devcanvasHtml()` | `new Script` syntax check |
| `sandboxRelay.test.ts:31` | `buildSandboxProxyHtml(...)` with controlled fixtures | Execute proxy script in a minimal test VM |

They neither remove tags from incoming HTML nor return sanitized HTML to a
browser. The producers emit lowercase `<script>` tags. Matching uppercase tags
would broaden the extractors without proving any XSS boundary. The existing
test consumers passed (17 browser, 6 filesystem App and 5 relay checks); their
regexes remain unchanged for independent review. Tests are excluded from the
published npm payload. This is a claim about these test consumers only.

## Validation and retained evidence

202 checks have passing results across 11 scoped suites: 47 fast checks, 111
filesystem/App regression checks, and the corrected 44-check Bash suite. An
initial broader run failed seven Bash checks because the new PTY test left
unused child mocks queued; the test was corrected and the entire affected suite
rerun. Its initial failure report is retained. Both MCP package builds and
package typechecks passed; changed-file ESLint with `--no-ignore` and
`git diff --check` passed. Full application typecheck/build and the updated
integration CodeQL gate remain separate CI work.

Portable source/dataflow bindings are in
[`mcp-package-codeql-d29-review.json`](evidence/mcp-package-codeql-d29-review.json).
The full downloaded SARIF, extracted original dataflows, build logs, negative
control and all test reports are retained in the task evidence directory:
`C:/Users/Moe/.codex/visualizations/2026/10/03/01a103ab-4561-7400-95ca-4be7249284cd`.
The JSON records their hashes. The original SARIF can also be retrieved from
GitHub's `repos/mario-andreschak/FLUJO/code-scanning/analyses/1887239452`
endpoint with `Accept: application/sarif+json`.

The interpretation follows the specific scope of CodeQL's
[temporary-file query](https://codeql.github.com/codeql-query-help/javascript/js-insecure-temporary-file/)
and [polynomial-regex query](https://codeql.github.com/codeql-query-help/javascript/js-polynomial-redos/).
Fresh source checks, an independent classification decision, and a scan of the
chosen integration merge are required before making a gate acceptance claim.
