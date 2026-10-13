# Maturity CodeQL boundary review

This source correction is based on integration head
`a9a974a10c543dafdcc5683f57b3c747514ee5a4`. The inspected JavaScript SARIF
analysis is **1887302950**, uploaded 2026-10-04 00:24:05 UTC for PR #611 merge
commit `43834c8fd22898070fce6b54babcae36bb8a10c2`, with 136 results. The earlier
coordinator snapshot used merge commit `d29fbd24355c741bbc5b9064d990fe03fbb2b993`;
it is not evidence of a scan of this correction. Alert numbers below identify
the original findings. No alert was dismissed and no scanning policy changed.

## Source corrections awaiting integration and rescan

| Finding | Original location | Correction and boundary evidence |
| --- | --- | --- |
| [#178](https://github.com/mario-andreschak/FLUJO/security/code-scanning/178), `js/file-system-race` | `conversationSummaryStore.ts:321` | Open the snapshot once, inspect that handle, read that handle, and close it in `finally`, including the cached and malformed branches. A real pathname replacement after `stat` keeps the original contents paired with the original fingerprint; the next listing rebuilds for the replacement. Collection ID validation and the existing derived-index semantics remain. |
| [#187](https://github.com/mario-andreschak/FLUJO/security/code-scanning/187), `js/file-system-race` | `subflowTasks/ownership.ts:23` | Open the identity once; check its descriptor is a regular, singly linked file at most 4096 bytes; compare the opened file with post-open `lstat` and the parent with its original identity; reject parent links/replacement. Read at most 4097 bytes through that handle, rejecting growth past 4096. Close on success and failure. |

The identity reader uses `O_NOFOLLOW` and `O_NONBLOCK` where Node exposes them.
Windows does not expose `O_NOFOLLOW`; the post-open link, device/inode and
directory checks are necessary there. Fixtures use actual file replacements,
parent replacements, a directory symlink/junction, a hard link, file growth,
invalid JSON/UUID and oversized files. The reference data root remains a
trusted installation setting. These checks do not claim protection against an
attacker who can mutate every ancestor of that root or rewrite an authorized
identity file in place. Summary files retain their existing trusted-workspace
path policy; this correction pins their fingerprint and bytes and adds a
regular-file check, rather than inventing a new workspace containment policy.

Tracing the resource-reference findings also found three **ProcessNode** calls
that omitted `sharedState` when calling `resolveRunResourceRefs`: system prompt,
chat message projection, and isolated prompt. StaticNode and SubflowNode already
passed their durable context. The correction passes the current context through
all three ProcessNode calls. Revoking a Persona Activity while lookup is pending
now prevents the subsequent resource bytes/readBy mutation and `resource:read`
event. These are specific necessary corrections in `nodes/ProcessNode.ts`; no
provider, model-attempt adapter, archive receipt or inference policy is changed.

## Findings proposed for independent false-positive review

These assessments are **proposals**, not accepted dismissals or a clean gate.
The complete seven selected SARIF results and their flows are retained in the
topic evidence bundle as `triage-input.json`, alongside the full original SARIF.

| Findings | Exact scan condition | Dataflow assessment |
| --- | --- | --- |
| [#237](https://github.com/mario-andreschak/FLUJO/security/code-scanning/237), [#238](https://github.com/mario-andreschak/FLUJO/security/code-scanning/238) | `executionAuthority.ts:69`, `personaAttribution && !executionAuthority` | The reported path starts at `resolveGlobalVars.ts:47` (`value`), passes through StaticNode's `lastResponse`, then `staticNode.test.ts:388` serializes the **entire** state with `JSON.stringify`/`JSON.parse`, before passing the restored state back to StaticNode. SARIF then treats separate attribution/authority properties as tainted. Prompt strings are escaped by JSON serialization; their contents do not install/delete those properties. This condition rejects missing authority for attributed work. An installed authority is checked even when attribution is absent. |
| [#239](https://github.com/mario-andreschak/FLUJO/security/code-scanning/239), [#240](https://github.com/mario-andreschak/FLUJO/security/code-scanning/240) | `executionAuthority.ts:97`, `personaAttribution && !executionAuthority?.commitWhileCurrent` | The same complete-state test serialization joins prompt data to the authority fields in the reported flow. This rejects attributed durable writes without a lock-capable authority. Ordinary runs retain their existing unfenced path; authority-bearing meeting runs still check the installed authority. HTTP completion code constructs the run input explicitly in `chatCompletionService.ts:81` and does not forward request-supplied authority or attribution fields. `runFlow` checks persisted Persona ownership independently of request omission. |
| [#241](https://github.com/mario-andreschak/FLUJO/security/code-scanning/241) | `resolveRunResourceRefs.ts:63`, the regex-match loop condition `m` | User-authored prompt text determines which resource names are requested. The loop collects those names; it grants no permission. A successful lookup performs the read/event under `commitFlowDurableMutation(durableContext, ...)`. No reference/no conversation returns perform no lookup/read. Loss of an installed authority fails the read closed. The missing ProcessNode context described above was a real adjacent defect and is repaired independently of the proposed classification of this loop condition. |

The tests include an ordinary success control, missing and assertion-only
Persona authorities, revoked authority without attribution, copied JSON private
context rejection, and both hot-cache and cold-storage Persona resume attempts
with omitted request attribution. Caller omission is not a proof that stored
ownership disappeared. `executionAuthority.ts` and `resolveRunResourceRefs.ts`
are unchanged; no condition was weakened or moved to conceal these findings.

The descriptor design follows the [CodeQL filesystem-race recommendation](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/)
and the [Node 22 file-handle API](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle).
The independent review should use the actual paths against the [CodeQL bypass query](https://codeql.github.com/codeql-query-help/javascript/js-user-controlled-bypass/),
including the exact conditions and test serialization edges above.

## Qualification limits

Local focused tests run on Windows, Node 22, the exact installed integration
lockfile and the ordinary test runner. A Windows direct overwrite rename of an
open file returned `EPERM` in the first fixture. The portable fixture therefore
moves the original file aside, then publishes the replacement, retaining the
open descriptor throughout. The failed fixture logs are retained. Linux behavior,
the integrated release checks and a fresh scan still need their actual CI
receipts. This slice does not qualify all 136 application findings, change the
Maturity runtime budgets, replace the elapsed soak/original workload, or award A-.
