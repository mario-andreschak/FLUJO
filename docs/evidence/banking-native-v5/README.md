# Banking native v5 evidence

This bundle records a **manual run against one existing FLUJO worker**, using its existing Sol subscription model and the banking MCP over **stdio inside that worker**. It is separate from the mocked Jest load test in CI.

## What ran

| Submitted customers | Completed owner/tool/model/reply matches | Response p50 | Response p95 | Burst elapsed |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 18.054 s | 18.054 s | 18.055 s |
| 10 | 10 | 13.067 s | 17.458 s | 17.460 s |
| 50 | 50 | 23.804 s | 25.688 s | 45.761 s |
| 500 | 500 | 147.363 s | 237.784 s | 257.693 s |

The 500 phase submitted 500 distinct approved customer requests together. Admission was configured for **128 active jobs and 512 queued jobs**. The resource sampler observed a peak of **88 private native CLI processes** and **4,798,410,752 bytes** of worker cgroup memory, across 510 samples. These are not measurements of 500 simultaneously executing native processes.

The audited 500 conversations each contained a completed bound model attempt with positive input/output usage, an approved successful MCP call, and a delivered transaction reference matching both the persisted reply and that customer's independent reference oracle. No Static tool nodes were used. All exported tool results have `synthetic: false` and `operator_test: false`.

The configured budgets were 300 seconds in the queue, 110 seconds active, and 410 seconds total, bounded by the authenticated session. Request JWTs lasted at most 120 seconds; the HTTP client timeout was 450 seconds. In 293 requests, both the recorded model terminal event and client completion occurred after the ingress JWT expired. This is evidence from the native run. Raising a Jest timeout to 450 seconds does not test that lease behavior.

## What CI proves

[`normalProcessLoad.test.ts`](../../../__tests__/executionExtensions/normalProcessLoad.test.ts) exercises normal completion, Process execution, admission, and request/result correlation using a **mocked provider**, in-memory storage, mocked workspace mutation gating, and mocked logging/statistics. Its fixture admits at most four active requests. It performs no actual Sol requests or MCP dispatch.

Its 500 case is a deterministic correlation regression. CI passing that case does **not** corroborate the native latency table above. The two sets of evidence must be read separately.

## Provenance and files

The native worker ran FLUJO revision `153a039185b1d303fb0853f1d4935980388a1903`. The historical successful source CI ran revision `0afeaf0b4168eb775eab2974b43f2b74872da8f2`. Those revisions share production `src` tree `0d89cb75a201e5a233036885c10317eda9f5c2d4`; their difference was the test timeout/comment correction. This publication adds evidence files and does not represent another native run. Any CI for the publication commit is a separate run.

[`manifest.json`](manifest.json) records the worker image, CLI version and digest, model catalog, graph and policy digests, dataset snapshot, limits, original private input digests, and public file digests.

| File | Purpose |
| --- | --- |
| [`requests-500.ndjson`](requests-500.ndjson) | All 500 request/owner/conversation/run/tool/model/reply associations and relative timings |
| [`resources-500.ndjson`](resources-500.ndjson) | All 510 numeric process and memory samples |
| [`phases.json`](phases.json) | Saved execution-time audits, counts and timings for 1/10/50/500 |
| [`checks.json`](checks.json) | Saved HTTP, completed-conversation lifecycle, revocation, protected-policy and privacy checks |
| [`verify.py`](verify.py) | Offline public digest, association, timing and aggregate verifier |
| [`capture_native.py`](capture_native.py) | Private correlation capture around the committed real HTTP client |
| [`audit_private_runtime.mjs`](audit_private_runtime.mjs) | Read-only owner/tool/model/reply audit against private worker stores |
| [`sample_resources.mjs`](sample_resources.mjs) | Worker process and cgroup sampler |
| [`export_runtime.mjs`](export_runtime.mjs) | Read-only validation and privacy-filtered export of the 500 records |
| [`prepare_bundle.py`](prepare_bundle.py) | Allowlisted projection of the historical private v5 receipts |
| [`replay.md`](replay.md) | Prerequisites and commands for an explicitly requested new native run |

Verify this publication without credentials, Docker, network access, or model calls:

```sh
python docs/evidence/banking-native-v5/verify.py
```

The phase audits were saved when the workload ran. The 500 rows were also revalidated against the retained owner files, conversation states, and statistics during publication at `2026-09-29T15:06:14.237Z`; `fresh_store_export_utc` records that export. The single-customer conversation was subsequently deleted/revoked for lifecycle checks, so its saved audit is not a fresh audit of a retained conversation.

## Privacy and interpretation

Private raw evidence contains customer identifiers, session identifiers, conversation identifiers, masked transaction handles, and private configuration. It remains private. Public rows use globally consistent, separate ordinal namespaces such as `owner-0001` and `reference-0001`. Expected values and observed stored values are exported separately. No identifier mapping, prompt, response text, tool argument, signing key, JWT, or execution token is published.

Request times are relative to the first recorded client header creation. Resource times are relative to the first resource sample. Header creation is a client observation, not a server acceptance timestamp. The sampler filters native executable paths and private CLI homes; its count is not admission telemetry or a direct count of active model requests. The manifest lists the two absolute time origins so the series can be aligned.

The privacy check scanned audited states for the configured execution token and known assertion marker. Zero matches means those checked markers were absent; it is not a universal proof that no possible secret can exist. Saved lifecycle checks concern completed conversations and restart durability; they do not establish live native cancellation under load.

This is **operator-captured evidence**, not provider-side cryptographic attestation or a third-party certification. The public verifier can check file integrity, correlations and reported arithmetic. It cannot independently authenticate the origin of private runtime stores or establish provider billing. Original private file digests bind the retained inputs but do not expose them for public inspection.

This run supports one worker handling this burst on this machine and dataset snapshot. It does not establish sustained or multi-worker capacity, a queue/provider/MCP/S3 latency breakdown, current S3 freshness, provider retry/rate-limit behavior, or live Slack throughput. Slack checks elsewhere are mocked/offline. Ticket actions remain local demo actions, not bank mutations. Publishing these artifacts also does not resolve the separate review findings about the optional integration boundary or route wiring.
