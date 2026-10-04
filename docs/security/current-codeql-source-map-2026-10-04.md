# Current CodeQL source map — 2026-10-04

This is a source-change inventory requested by the epic coordinator, not scanner disposition or independent reassessment. The stopped disposition/false-positive-review lane remains stopped. No alerts were dismissed, retried for disposition, or assigned a grading allowance.

Authoritative read: `GET /repos/mario-andreschak/FLUJO/code-scanning/alerts?ref=refs/pull/611/merge&state=open&per_page=100`. All 87 returned instances pin merge commit `d2380e5c43293db433f8ce82c643c62a0ce66c20`: 48 high and 39 medium. This differs from the repository-default alert listing, whose most-recent instance can refer to main. Root head `b8cf905ff263559d8591f7dd839c2c75cf29f79f` and that tested merge both have verified tree `d4eba4ed7aec6e41fb272a64bea86b4bc2dbc883`. Captured JSON SHA-256: `1bd29d9535f540ef8464d02f5abfec2ecd548a445b24744491890feb5f9d8abc`. Scanner execution success is not a finding-free result.

The requested future-source comparison uses these immutable PR heads:

| Slice | Frozen head | Source relation and remaining limits |
| --- | --- | --- |
| #672 browser descriptors | `c5f347c41cc356e79a1a7a17dc11b4638e17bcf5` | Replaces separate path stat/read with a checked opened regular descriptor, bounded chunks and a limit+1 growth control. The helper opens with `r`; it does not establish a private before-open path witness or add NOFOLLOW/NONBLOCK. No complete race/admission or installed closure is asserted. |
| #673 resource copies | `e0fdedbf8b5e80db3f5ccf62da2f4070eb303659` | Bounds copy admission and streams an opened snapshot into an exclusive new payload, checking final size/mtime. SHA-256 content hashing remains; the slice does not remove the reported low-entropy digest sink. |
| #677 private-profile reads | `812cf4202e975d20de744bf505c6ce2afb822206` | Changes `readStableFile`, operator passphrase and key/credential JSON readers, including before/after BigInt FD/path witnesses and nonblocking no-follow flags. The 87-instance catalogue contains no finding at those changed readers; #258/#259 are different `readPlainFile` sites. |
| #678 public package identities | `a489b56e8d6acc973968fd37d481c75554ab7a4a` | Rejects secret references in public manifest identity/reference fields before resolving credential placeholders or writing a ledger. It retains SHA-1/32-bit suffixes for address compatibility; historical ledgers and algorithm replacement remain work. |
| #664 transport admission | `6cfe93961452bd54d9fdb66ab58a94047fabcc18` | Explicit supported transport admission covers the reported MCP dispatch branches. These six scanner instances are still open on the actual root; controlled source behavior is not scanner or independent authorization closure. |
| #717 opaque request tags | `c017a9d44a461ff9a475a9ca78b455db40cfd810` | Removes new arbitrary request-argument digests. #150 is absent from this exact 87-instance catalogue; connection identity digests and historical records are unchanged. This provides no closure for #149/#151/#152/#120. |

Original provider/model blobs remain unchanged by this inventory and the OAuth at-rest slice. #260/#261 at `provider.ts`, #214, #217–#219 and #151 are not repaired or dispositioned here. Semantics-changing provider fixes require coordinator integration review against its preservation baseline.

Every finding below remains open in this exact scanner read. A source relation identifies relevant work, not a fixed state. Findings outside this owner’s changed files require the corresponding owner’s concrete source evidence; absence of that evidence is not a false-positive judgment.

| Alert | Severity | Rule | Exact merge-tree location | Source relation / remaining work |
| --- | --- | --- | --- | --- |
| 3 | medium | `js/stack-trace-exposure` | `src/app/api/mcp/_helpers.ts:15` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 11 | medium | `js/shell-command-injection-from-environment` | `src/app/api/update/route.ts:270` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 111 | high | `js/weak-cryptographic-algorithm` | `src/backend/services/packages/installPackage.ts:208` | Future #678: reject credential-bearing public identities before placeholder resolution; SHA-1/32-bit address suffix and legacy ledger migration remain. |
| 113 | medium | `js/stack-trace-exposure` | `src/app/api/flow/_helpers.ts:12` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 120 | high | `js/insufficient-password-hash` | `src/backend/services/statistics/index.ts:314` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 136 | medium | `js/identity-replacement` | `src/backend/services/runtimeEnvironment.ts:30` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 137 | medium | `js/identity-replacement` | `src/backend/services/runtimeEnvironment.ts:30` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 139 | high | `js/bad-tag-filter` | `__tests__/mcp/browserServer.test.ts:138` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 140 | high | `js/bad-tag-filter` | `__tests__/mcp/browserServer.test.ts:159` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 141 | high | `js/bad-tag-filter` | `__tests__/mcp/filesystemApp.test.ts:89` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 142 | high | `js/bad-tag-filter` | `__tests__/mcp/sandboxRelay.test.ts:31` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 143 | high | `js/incomplete-multi-character-sanitization` | `src/backend/services/mcp/assistedInstall.ts:271` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 145 | medium | `js/stack-trace-exposure` | `scripts/persona-goal-acceptance/public-fixture-server.mjs:110` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 146 | medium | `js/stack-trace-exposure` | `src/app/api/mcp/assistant/route.ts:18` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 149 | high | `js/insufficient-password-hash` | `src/backend/services/mcp/connection.ts:652` | Runtime-home server-name digest is unchanged. Source semantics and credential-home compatibility need further evidence; no disposition. |
| 151 | high | `js/insufficient-password-hash` | `src/backend/services/model/index.ts:484` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 152 | high | `js/insufficient-password-hash` | `src/backend/services/runResources/index.ts:288` | Future #673: copy allocation/streaming changes; unkeyed content digest remains. No cryptographic closure claimed. |
| 156 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:722` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 157 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:937` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 158 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:964` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 159 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:978` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 160 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:990` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 161 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:1051` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 162 | high | `js/insecure-temporary-file` | `mcp-servers/filesystem/src/tools.ts:1118` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 164 | high | `js/file-system-race` | `__tests__/enduringAgents/runtimeEventsIncremental.test.ts:227` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 165 | high | `js/file-system-race` | `__tests__/executionExtensions/restrictedCodexEnvironment.test.ts:176` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 166 | high | `js/file-system-race` | `__tests__/workspace/migration.test.ts:72` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 167 | high | `js/file-system-race` | `mcp-servers/browser/src/tools.ts:436` | Future #672: opened regular descriptor and limit+1 read replace stat/read by path; pre-open admission and installed integration remain unqualified. |
| 168 | high | `js/file-system-race` | `mcp-servers/browser/src/runtime.ts:1140` | Future #672: opened regular descriptor and limit+1 read replace stat/read by path; pre-open admission and installed integration remain unqualified. |
| 174 | high | `js/file-system-race` | `src/app/api/git/route.ts:743` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 175 | high | `js/file-system-race` | `src/app/v1/chat/conversation-chains/route.ts:202` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 176 | high | `js/file-system-race` | `src/app/v1/chat/conversations/route.ts:391` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 177 | high | `js/file-system-race` | `src/app/v1/chat/conversations/route.ts:392` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 180 | high | `js/file-system-race` | `src/backend/services/mcp/shippedWorkspacePackages.ts:58` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 183 | high | `js/file-system-race` | `src/backend/services/model/adapters/codexModelCatalog.ts:75` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 185 | high | `js/file-system-race` | `src/backend/services/packages/workspaceMcpTransfer.ts:333` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 194 | high | `js/remote-property-injection` | `src/backend/services/mcp/connection.ts:173` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 195 | high | `js/remote-property-injection` | `src/backend/services/mcp/connection.ts:197` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 196 | high | `js/remote-property-injection` | `src/backend/services/mcp/connection.ts:221` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 197 | high | `js/remote-property-injection` | `src/backend/services/mcp/connection.ts:232` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 198 | high | `js/remote-property-injection` | `src/backend/services/mcp/connection.ts:234` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 212 | medium | `js/file-access-to-http` | `scripts/persona-goal-acceptance/terminal-fixture.test.mjs:18` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 213 | medium | `js/file-access-to-http` | `scripts/persona-goal-acceptance/terminal-fixture.test.mjs:20` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 214 | medium | `js/file-access-to-http` | `src/backend/services/model/adapters/openrouterMediaAdapter.ts:163` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 217 | medium | `js/file-access-to-http` | `src/backend/services/model/testConnection.ts:158` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 218 | medium | `js/file-access-to-http` | `src/backend/services/model/testConnection.ts:286` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 219 | medium | `js/file-access-to-http` | `src/backend/services/model/testConnection.ts:308` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 220 | medium | `js/file-access-to-http` | `src/backend/services/ollama/index.ts:124` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 221 | medium | `js/file-access-to-http` | `src/backend/services/ollama/index.ts:127` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 222 | medium | `js/file-access-to-http` | `src/backend/services/telemetry/index.ts:159` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 223 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:88` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 224 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:90` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 225 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:91` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 226 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:123` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 227 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:157` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 228 | medium | `js/file-access-to-http` | `src/backend/utils/packageRegistryClient.ts:159` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 230 | medium | `js/indirect-command-line-injection` | `bin/flujo.mjs:177` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 231 | medium | `js/log-injection` | `src/utils/logger/logger.ts:94` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 232 | medium | `js/log-injection` | `src/utils/logger/logger.ts:97` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 233 | medium | `js/log-injection` | `src/utils/logger/logger.ts:100` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 234 | medium | `js/log-injection` | `src/utils/logger/logger.ts:103` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 235 | medium | `js/log-injection` | `src/utils/logger/logger.ts:106` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 236 | medium | `js/log-injection` | `src/utils/logger/logger.ts:109` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 237 | high | `js/user-controlled-bypass` | `src/backend/execution/flow/executionAuthority.ts:69` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 238 | high | `js/user-controlled-bypass` | `src/backend/execution/flow/executionAuthority.ts:69` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 239 | high | `js/user-controlled-bypass` | `src/backend/execution/flow/executionAuthority.ts:97` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 240 | high | `js/user-controlled-bypass` | `src/backend/execution/flow/executionAuthority.ts:97` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 241 | high | `js/user-controlled-bypass` | `src/backend/execution/flow/resolveRunResourceRefs.ts:63` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 242 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/betaClient.ts:228` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 243 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/connection.ts:462` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 244 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/index.ts:1059` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 245 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/index.ts:1295` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 246 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/index.ts:1295` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 247 | high | `js/user-controlled-bypass` | `src/backend/services/mcp/index.ts:1375` | Frozen #664 explicitly admits transports before dispatch; these instances remain open on the tested root. No authorization-bypass closure claimed. |
| 248 | medium | `js/http-to-file-access` | `__tests__/enduringAgents/goalEnduranceAcceptance.test.ts:1084` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 249 | medium | `js/http-to-file-access` | `scripts/maintainer-installed-baseline.mjs:139` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 250 | medium | `js/http-to-file-access` | `scripts/persona-goal-acceptance/public-fixture-server.test.mjs:44` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 251 | medium | `js/http-to-file-access` | `scripts/persona-goal-acceptance/public-fixture-server.test.mjs:45` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 252 | medium | `js/http-to-file-access` | `scripts/persona-goal-acceptance/public-fixture-server.test.mjs:46` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 253 | medium | `js/http-to-file-access` | `scripts/persona-goal-acceptance/terminal-fixture.cjs:45` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 256 | medium | `js/missing-origin-check` | `public/workers/tool-result-worker.js:35` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 257 | high | `js/bad-tag-filter` | `__tests__/frontend/components/GithubPagesLightbox.test.ts:5` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 258 | high | `js/insecure-temporary-file` | `src/utils/readPlainFile.ts:44` | #677 targets private-profile readStableFile consumers, not this readPlainFile site. No closure claimed. |
| 259 | high | `js/file-system-race` | `__tests__/utils/readPlainFile.test.ts:27` | #677 targets private-profile readStableFile consumers, not this readPlainFile site. No closure claimed. |
| 260 | medium | `js/file-access-to-http` | `src/backend/services/model/provider.ts:281` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 261 | medium | `js/file-access-to-http` | `src/backend/services/model/provider.ts:281` | No closure established by the mapped frozen Security slices; remains open on this source. |
| 267 | medium | `js/http-to-file-access` | `scripts/maintainer-installed-recovery.mjs:111` | No closure established by the mapped frozen Security slices; remains open on this source. |

The full #566–#568 scope still includes browser pairing/revocation, resumable credential re-encryption and recovery, credential-free ordinary exports plus intentional recipient-encrypted worker transfer, and executable/installation isolation defaults. Installed cross-platform and independent human/external acceptance are separate gates. This inventory awards none of those gates.
