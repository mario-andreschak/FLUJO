# Dedicated hackathon worker source and deployment

Use [`codex/hackathon-banking`](https://github.com/mario-andreschak/FLUJO/tree/codex/hackathon-banking) for the banking hackathon integration. FLUJO `main` remains general-purpose and retains the generic secure execution/MCP hooks. Banking routes, assertions, policy and receipts stay on this separate branch.

## Preserved source

The branch starts at the complete source immediately before the restoration in [PR #534](https://github.com/mario-andreschak/FLUJO/pull/534):

- Combined commit: `51ff39fc5bac84cbbb49bbd2b21b5ab89de8b14b`.
- Combined tree: `b754c1cae7def51ab9a1343c1726a63c30d2c53a`.
- [PR #530](https://github.com/mario-andreschak/FLUJO/pull/530): ingress/runtime integration; final head `805be7e0086714a551db804bbf9c82714dc3a746`.
- [PR #532](https://github.com/mario-andreschak/FLUJO/pull/532): protected sandbox action route; final head `029d89b7a2afb49d7a90ca24ea12c1735f79828c`.
- [PR #533](https://github.com/mario-andreschak/FLUJO/pull/533): event-date windows and durable case/handoff receipts; final head `3037c1423f7d39ede4d4a9b50afae038e4dd7baa`.

All three final heads are ancestors of the combined commit. This preserves their actual integrated source and supporting build changes, rather than assembling older individual branch tips. The follow-up commit adds documentation only. Do not merge the domain integration back into `main`.

The project's draft PRs #31/#32 describe a different host/transport arrangement. They are not part of this preserved snapshot. Future source corrections for this arrangement belong on the dedicated branch and must be checked against its matching frontend/MCP contracts.

## Building the selected worker

The following is a build recipe for a separately authorized worker rollout; these instructions do not imply that a new image has been built or deployed. Use a clean checkout and an immutable commit. The original preserved commit below contains the same executable source as the branch's documentation follow-up.

```powershell
git clone --single-branch --branch codex/hackathon-banking https://github.com/mario-andreschak/FLUJO.git FLUJO-hackathon
Set-Location FLUJO-hackathon
$HackathonRevision = '51ff39fc5bac84cbbb49bbd2b21b5ab89de8b14b'
git checkout --detach $HackathonRevision
if ($LASTEXITCODE -ne 0) { throw 'Cannot check out the pinned hackathon source.' }
if ((git rev-parse HEAD).Trim() -ne $HackathonRevision) { throw 'Unexpected source revision.' }
if (git status --porcelain) { throw 'Use a clean source checkout.' }
$HackathonVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
$HackathonImage = "flujo-hackathon-banking:$HackathonRevision"
docker build --tag $HackathonImage --build-arg "FLUJO_APPLICATION_VERSION=$HackathonVersion" --build-arg "FLUJO_BUILD_REVISION=$HackathonRevision" --build-arg 'FLUJO_EXECUTION_ADAPTER_MODULE=/app/src/integrations/hackathon-banking/configuredAdapter.ts' .
if ($LASTEXITCODE -ne 0) { throw 'Hackathon image build failed.' }
docker image inspect $HackathonImage --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

`FLUJO_EXECUTION_ADAPTER_MODULE` is an absolute **build-time** module path inside the Docker builder. The default build leaves it empty. Setting `FLUJO_BANKING_CONFIG` at runtime alone cannot select a banking adapter that was not compiled into the image.

Keep the image local/private and record its image ID, exact source revision and selected adapter with the rollout receipt. Do not use generic `latest`, `cloud-worker`, npm releases or `npm run dockerbuild`: those are generic FLUJO channels, and `dockerbuild` dispatches the publisher on `main`. Branch pushes do not publish an image or constitute fresh build/test evidence.

## Rollout into the existing deployment

The selected image requires the matching private configuration described in [banking ingress](banking-ingress.md) and the matching [sandbox action contract](BANKING_ACTION_V0.md). `FLUJO_BANKING_CONFIG` points to an absolute private policy file. Keep credentials/signers outside source and the image; retain the existing durable authority and bank state volumes, private mounts, owner/session/conversation mapping and approved graph/model/catalog identity.

Use one existing FLUJO worker and its existing stdio MCP child. Do not add a second FLUJO/MCP instance. Stop admission and reconcile unfinished jobs before replacing that worker. Do not copy authority caches or in-flight action state across incompatible identities. An older ledger restore requires explicit reconciliation/rotation and host adoption; a matching generation value alone does not prove continuity. This frozen snapshot does not incorporate the later project draft continuity corrections.

The deployed Slack gateway shares the worker's network namespace and uses `http://127.0.0.1:4200`. Recreate that gateway alongside a replaced worker so it joins the new namespace, preserving its existing gateway data volume and bindings. Keep frontend `action_enabled=false` until owner binding, explicit UI consent, durable request UUID, receipt-only recovery, revocation, ledger continuity and the joined pinned frontend/worker/MCP flow are verified.

## Observed deployment status, September 30, 2026

Creating this branch and updating documentation changes source only. The existing Docker worker was observed running `flujo-slack-worker:banking-integration`, image `sha256:f99c1998c60a69ea6572685b77ef80a74cb4834486b0fcd2455ff6dc7c9be2b8`, source `153a039185b1d303fb0853f1d4935980388a1903`. It has not been upgraded to this branch by this source-preservation task.

Historical tests and native evidence in this branch retain their original source/image qualifications. They do not establish acceptance of a newly built branch image, current joined customer behavior or independently adjudicated ES/PT model performance.
