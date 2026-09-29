# Replaying the native workload

The commands below run the existing Process flow through `/v1/chat/completions`, then inspect its private persisted evidence. **They make real model requests only when `--allow-model-requests` is supplied.** Publishing this bundle did not run them again.

Offline verification is simply:

```sh
python docs/evidence/banking-native-v5/verify.py
```

## Prerequisites for a new run

Use the existing worker and model. Do not create another FLUJO instance, flow, or remote MCP container for this replay.

- The banking adapter, protected runtime policy, approved existing Process graph, and banking MCP must already be deployed. MCP runs over local stdio inside that worker.
- The private gold snapshot, validated customer mappings, and approved frontend signing configuration must be available. Build each customer's reference oracle independently of the response being tested.
- Prepare a private manifest with 500 distinct approved subjects and disjoint nonempty reference oracles. Use fresh valid sessions. The client supplies a new session identifier and one-hour expiry when those fields are omitted; this must fit the environment's approved session policy.
- Set `provider_scope` to `configured-codex-restricted` for the recorded Sol path and `oracle_scope` to `response`. The public response intentionally omits private tool history, which is audited separately. Use the ordinary model-tools workload; do not select `static-prefetch-model-summary`.
- Record the actual deployment revision, production source tree, image, CLI/catalog, policy, graph, dataset and configured limits before a new run. Compare them with [`manifest.json`](manifest.json) if trying to reproduce v5. A changed environment is a new benchmark, with new provenance.
- Use Python with the banking repo's `requirements-mcp.txt` dependencies and Node inside the worker. Keep all raw inputs and captures outside public source control. Use an access-controlled private directory; the capture file requests POSIX mode `0600`, which does not replace Windows directory ACLs.

Use the committed HTTP runner and placeholder manifest from banking repo revision `c526014841597d42e845c439e5e600a3f9b80205`:

- [banking_acceptance_load.py](https://github.com/mario-andreschak/factored-hackathon-2026-mcg/blob/c526014841597d42e845c439e5e600a3f9b80205/scripts/banking_acceptance_load.py)
- [banking_acceptance_manifest.example.json](https://github.com/mario-andreschak/factored-hackathon-2026-mcg/blob/c526014841597d42e845c439e5e600a3f9b80205/scripts/banking_acceptance_manifest.example.json)

The manifest contains credentials and private file paths. Fill it locally; do not publish it. The runner only accepts the existing local HTTP worker. Its `provider_scope` text alone is operator-supplied provenance, not a provider attestation.

## Capture one phase

These commands require **PowerShell 7.4 or later**, run from the FLUJO checkout. Its native-command redirection preserves UTF-8 output bytes; Windows PowerShell 5 can instead write UTF-16 files that the JSON readers reject. Replace the placeholder values with private local paths and the existing worker name. Use a new output directory and stop-marker name for every run. The capture refuses to overwrite a raw correlation file.

```powershell
$worker = 'EXISTING_WORKER_NAME'
$privateDir = 'PRIVATE_DIRECTORY_OUTSIDE_CHECKOUT'
$bankRepo = 'BANKING_REPO_CHECKOUT'
$evidence = Join-Path (Get-Location) 'docs/evidence/banking-native-v5'
$count = 500
$stop = '/tmp/native-replay-UNIQUE_RUN.stop'

docker cp "$evidence/sample_resources.mjs" "${worker}:/tmp/sample_resources.mjs"
docker cp "$evidence/audit_private_runtime.mjs" "${worker}:/tmp/audit_private_runtime.mjs"
docker cp "$evidence/export_runtime.mjs" "${worker}:/tmp/export_runtime.mjs"
docker cp "$privateDir/approved-process-graph.json" "${worker}:/tmp/native-replay-graph.json"
docker exec "$worker" test ! -e "$stop"
```

The worker must already have `FLUJO_BANKING_CONFIG` pointing to its protected policy. Do not pass its contents through shell arguments. The resource sampler's private-home filter targets `default-workspace`; adapt that filter for a different workspace and record the change. It samples roughly every 500 ms; v5 used a maximum 480-second window.

In a second terminal, with the same variables, start the resource sampler before the capture:

```powershell
docker exec "$worker" node /tmp/sample_resources.mjs "$stop" 480 > "$privateDir/replay-resources.jsonl"
```

In the first terminal, run the real capture. It delegates to the committed client's HTTP requests; it does not replace the provider or tool result:

```powershell
try {
    python "$evidence/capture_native.py" --runner "$bankRepo/scripts/banking_acceptance_load.py" --private-correlation "$privateDir/replay-correlation.json" --allow-model-requests --manifest "$privateDir/replay-manifest.json" --phases "$count" --timeout-seconds 450 > "$privateDir/replay-proof.json"
    $loadExit = $LASTEXITCODE
} finally {
    docker exec "$worker" touch "$stop"
}
if ($loadExit -ne 0) { throw 'Native capture failed; inspect private receipts.' }
```

Stop the sampler even if the client fails. Check the capture exit code and proof before continuing. For the 1/10/50/500 ladder, run each phase separately with fresh correlation/proof/sample filenames and stop markers, audit it, and stop at the first failed gate. Do not merge phases into a 500-record export.

## Audit retained runtime stores

After the phase completes, copy its private correlation file into the existing worker and perform the read-only audit. This reads owners, conversation states and statistics. It makes no model requests or tool calls.

```powershell
docker cp "$privateDir/replay-correlation.json" "${worker}:/tmp/native-replay-correlation.json"
docker exec "$worker" node /tmp/audit_private_runtime.mjs /tmp/native-replay-correlation.json "$count" /tmp/native-replay-graph.json > "$privateDir/replay-audit.json"
```

Require `passed: true` and all owner/tool/model/reply counts to match the phase size. A successful HTTP answer alone is insufficient. Keep any raw error output private: the original auditor's startup read errors can contain private paths.

The 500-only exporter then validates actual stored tool results, strict `synthetic: false` / `operator_test: false`, ownership, graph/model bindings, reference associations and JWT/session timing before emitting privacy-filtered rows:

```powershell
docker exec "$worker" node /tmp/export_runtime.mjs /tmp/native-replay-correlation.json /tmp/native-replay-graph.json 500 > "$privateDir/replay-export.json"
```

This output has a `requests` array plus export metadata. Split it into NDJSON and metadata using a private local script or the following command; write into a **new** publication directory, not over this historical bundle:

```powershell
python -c 'import json,pathlib,sys; d=json.loads(pathlib.Path(sys.argv[1]).read_text()); rows=d.pop("requests"); pathlib.Path(sys.argv[2]).write_text("".join(json.dumps(r,separators=(",",":"))+"\n" for r in rows),encoding="utf-8"); pathlib.Path(sys.argv[3]).write_text(json.dumps(d,indent=2)+"\n",encoding="utf-8")' "$privateDir/replay-export.json" "$privateDir/replay-requests.ndjson" "$privateDir/replay-export-metadata.json"
```

Review all outputs for privacy before publishing. Keep the raw correlation, graph, manifest, identifier mappings, credentials, states and diagnostic stderr private. A later deleted conversation cannot be re-audited from current stores; preserve the execution-time audit and describe that limitation.

## Regenerating this historical publication

`prepare_bundle.py` is specific to the original v5 receipts. It requires the original `process-load-v5-{1,10,50,500}-{proof,audit,lifetime,correlation}.json` files, phase start files, 500 resource/privacy receipts, security/lifecycle/revocation/policy receipts, and the original helper sources. It writes the **historical v5 provenance**, not the provenance of an arbitrary new run.

With those private retained inputs and metadata from the read-only export of the original 500 phase, the publication step is:

```powershell
python "$evidence/prepare_bundle.py" --private-input-dir "$privateDir/original-v5-inputs" --export-metadata "$privateDir/original-v5-export-metadata.json" --output-dir "$evidence"
python "$evidence/verify.py"
```

Run preparation only after all public scripts and documentation are final, because it hashes every public file except the manifest itself. The preparer rejects a 500 correlation, policy or graph digest that differs from the original v5 run. The copied original audit and sampler have normalized line endings; the capture wrapper adds path parameters, explicit model-run authorization and exclusive private output creation. Original helper digests are retained in the manifest. The bundle's `.gitattributes` preserves LF endings so Git checkouts retain the hashed file bytes on Windows.

A new replay needs its own provenance manifest and independently collected lifecycle/security receipts. The supplied commands reproduce the native workload and its owner/tool/model/reply audit; they do not automatically regenerate the historical lifecycle checks or certify a changed deployment. Do not relabel the old v5 receipts as results from a new run.
