# PR #726 hosted runtime evidence

[Verification run 37181494470](https://github.com/mario-andreschak/FLUJO/actions/runs/37181494470) completed with **failure**: 11 required jobs passed; ordinary test and final verification failed. Both production jobs passed all four supported installed/packed profiles. The complete logs, API responses, uploaded ZIPs and actual runtime measurements are retained unchanged.

| OS | Production job | Supported profiles | Artifact ID | ZIP SHA-256 |
| --- | --- | --- | --- | --- |
| Ubuntu | 111374822169 | 22.17.0, 22.23.3, 24.2.0, 24.21.0: all passed | 11294649782 | 21185204a81c5b6e1c553861b34d0555c1970de080a43a588f36818dc3d0d834 |
| Windows | 111374822245 | 22.17.0, 22.23.3, 24.2.0, 24.21.0: all passed | 11295913435 | 8af2b4f2624055325ea919f42398f4f6472486caf5dcfd77523240940302e343 |

The selected head is `9c7b567bc96fbe34dc970e4a18b34ffe178f2323`, based on `1486796b411351a3ade9291b85d195df6b7b41ad`. The actual Actions PR merge checkout is `a5d11370e7a52d6ac92c82accb91fbce87784dd6`; its tree and the selected head tree both equal `3d6a1605de3beffd1075b250f44974acc640920d`. Each OS recorded the actual Node/libuv/executable hash, source SHA, clean-tree state and verifier/manifest/guard file hashes for five selected binaries. These match the [signed upstream packet](../official-node-integrity-2026-10-04/) and selected manifest. Windows file hashes match Git's exact CRLF checkout transform; Ubuntu hashes match the committed LF bytes.

Every supported profile ran npm ci, the ordinary default-heap build, MCP typecheck, payload validation and isolated packed app/MCP/proxy checks with mandatory shell failure propagation. The historical Node 22.13.1 build passed separately; it provides no installed-runtime acceptance.

The retained ordinary failure is the first `executionAuthority.assertCurrent()` rejection expectation at MeetingPersonaIntegration.test.ts:387, which resolved undefined. The commit callback was not reached. Jest recorded 8,322 passed, one failed and 11 skipped assertions; the explicit baseline and final verification failed. [PR #733](https://github.com/mario-andreschak/FLUJO/pull/733) prepares a writer-lock fixture correction; this packet does not establish that correction's cause or acceptance.

`member-sha256.json` pins every other packet member's exact byte length and SHA-256. The per-OS source-bound receipts keep their original hashes: Ubuntu `098480fcdc582355b6b3db1902b5525c231887ef934819e5ee55693667b6539b`, Windows `0a99d809a0261789b089e7da1c04443898f937392edb2edab1a821a8f9c8d2dd`. SHA-256 inventory checks preserve retained bytes; GitHub artifact/API identity and signed upstream binary checks provide the separate source and binary evidence.

This component result cannot qualify the later combined source, a main release, actual selected distributions, native CodeQL findings acceptance, or independent human review/tabletop/A- acceptance.
