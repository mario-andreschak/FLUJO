# Pilot task protocol: connect once, inspect, run and reuse

These are task cards for an authorized pilot, not evidence that the tasks have passed. Use the same card and candidate version for a novice comparison. A facilitator can read the card and record observations but cannot demonstrate clicks, supply missing answers, code, repair configuration or coach without recording an intervention. Participants can use the supplied written guides independently.

## Prepare a candidate packet

The operator supplies an exact accepted npm package, image or installer with version, SHA-256, full source commit and provenance receipt. Do not silently use `latest`, development `main`, an existing personal workspace or an unknown installer. Record installation/upgrade acceptance separately; publishing and release integration belong to their owners.

Use a disposable local workspace and a folder containing only [sample-notes.txt](fixtures/sample-notes.txt). It is synthetic, public practice content. Review the chosen filesystem server's command, version, root configuration and tool list on that candidate. The bundled server advertises `read_file`; other servers may use a different name. Record the verified tool name in the participant's task card, and scope the agent to that read-only operation. Do not grant home-directory, shell or unrelated tool access for this practice task. Local MCP processes still run as the operating-system user.

Choose either an already-provisioned local model or a provider the participant independently authorizes. Retain the provider prerequisites, expected charges/limits, consent and any external effects in the private packet. Account creation, administrative model access approval and login provisioning are prerequisites; no account is created and no paid call is authorized by this protocol itself. Do not preconfigure the model, MCP connection or agent for the timed first attempt.

## Card 1: first model-plus-MCP agent run

**Your task:** get an assistant to read the practice note through a connected app and tell you its receipt phrase.

1. Install/open the identified FLUJO candidate on localhost. Follow the [first conversation guide](../../getting-started/README.md) for the chosen installation path. Use the provided disposable workspace.
2. Open **AI Setup → Connect AI**. Save and test one connection. Continue after its model test succeeds; a saved card alone is not success.
3. Open **Connected Apps → Connect App** and use the filesystem option specified in your task card. Limit its root to the practice folder, connect it, and inspect the discovered tools. Follow the [MCP guide](../../features/mcp/overview.md) if needed.
4. In the tool tester, choose the card's read-only tool. Provide the practice file path, press **Test**, and check that a result appears. Opening a parameter form is not a tool invocation.
5. Open **Agents → Start simple**. Create an AI step with the goal: `Use the connected read-only tool to read the practice note and report its receipt phrase. Do not answer from memory.` Bind the tested AI and the connected app/tool to the step. Save the agent and choose **Try it**. The [run/debug guide](../../features/flows/running-flows.md) describes the editor and Talk page.
6. Ask: `Read the practice note using the connected tool. What is its receipt phrase?` Observe a real completed MCP call, a model reply using that result, and a completed agent run.

**Completion:** the execution trace contains the selected MCP tool result, the actual model reply contains the fixture's phrase, and the run completes. A fabricated answer, saved configuration, direct tool test alone, spinner, permission failure or AI-only reply does not count.

**Clock:** start at the participant's first attempt to install/open the candidate; finish at that completed model-plus-MCP agent result or the recorded stopping boundary. Record total wall time. Pause product time only for separately logged external account provisioning/admin access approval. Runtime installation/downloads, discovery delays, form corrections, retries, quota errors and troubleshooting count as product friction. Do not discard a failed attempt and restart the clock for a better one. The agreement under #564 must accept this definition before enrollment.

Record start/end UTC timestamps, the provisioning intervals and reason, coaching/coding, artifact identity, last successful boundary and failure/drop-off code. Store total provisioning seconds in the structured record; its receipt must permit checking the original intervals, their non-overlap and why they qualify for exclusion. Record account-provisioning blocks and missing observations even when no run finishes.

## Card 2: control the same agent

This extension follows Card 1 and is measured separately from its 15-minute first-run target.

1. Enable **Require Tool Approval** in Talk. Ask the same harmless file question. Inspect the tool and arguments in the pending approval panel before choosing **Approve**. Confirm that it ran only after that choice.
2. Repeat and choose **Reject**. Confirm a denied result, no file operation and useful continuation. Record whether the participant can explain what was permitted or denied.
3. Open the visual/debugger view for the saved agent. Set a breakpoint on the AI/tool path, rerun, inspect the paused node and tool result, and resume/step to completion. Record whether the participant locates the cause of a deliberately incorrect **practice-only** filename and repairs it without losing unrelated configuration. Do not mutate a real workflow to create a failure.

Retain approved redacted receipts privately for approval-before-execution, rejection, paused-node inspection and completion. Do not assume those capabilities from Card 1 or from unit tests. Record any failed boundary as feedback with an exact candidate pin. Feature surface owns their frontend implementation and browser acceptance.

Enter actual Card 2 observations as `approval` and `debugger` control records using the [format reference](evidence-format.md). Record all failed attempts and any explicit decision not to attempt the task. A missing record is a missing observation; it cannot be inferred from a completed Card 1.

## Card 3: reuse a connection

Choose an external MCP client already available and approved by the participant. Follow its current supported setup and the candidate's [API documentation](../../api-reference/README.md). Connect to the **same configured server** through FLUJO's MCP proxy and perform the harmless read without duplicating the underlying server's credentials or installation. Alternatively call the saved agent through its OpenAI-compatible endpoint and verify the model/tool trace.

Keep the listener on localhost. Use the exact client/transport version and candidate authentication contract from the release owners. Never carry a historical “any API key” instruction into a candidate that requires scoped access. External-client installation/login time and failure are separate from Card 1. Record discovery and real invocation separately; a connected status without an actual result does not prove reuse.

Record the outcome in a `proxy-reuse` control record with same-connection, discovery and actual invocation checks. A result on a source checkout remains source evidence; a successful installed-client receipt must identify the accepted artifact.

## Weekly normal-workflow cards

For technical rehearsal and richer onboarding, use the [three read-only reference
workflows](reference-workflows.md). Their fresh MCP receipts and result checker
exercise triage, cross-document comparison and captured-page checks without
private data or external effects. They are practice fixtures and cannot count
as recurring independent-user benefit. Keep the timed Card 1 comparison unchanged.

Before the cohort freezes, each participant chooses a real recurring problem and records a private task definition, expected result, MCP server/tools and success check. Hash that definition into a workflow record with `purpose: normal-workflow`. The assessor checks that three counted protocols represent distinct problems, not renamed duplicates. Rehearsal of the supplied practice file uses `purpose: practice-fixture` and cannot count as recurring benefit.

Candidate templates to adapt to actual user needs:

| Problem | Minimal MCP-first journey | Benefit to ask about | Receipt |
| --- | --- | --- | --- |
| Triage new knowledge | Query an approved source; inspect its returned items; have an agent draft a shortlist; review the result | Time saved on retrieval/triage, useful omitted/incorrect results | Redacted result check and user assessment, not source text |
| Check project documents | Read an approved project folder; have an agent check a declared consistency rule; inspect/debug the cited tool result | Better control over mistakes or faster checking | Declared rule, redacted pass/fail result and interventions |
| Verify a web task | Inspect an approved page through MCP; compare it with a declared expectation; approve any proposed action; reuse the connection from a client | Connection reuse, reduced duplicate setup or easier diagnosis | Read-only result and approved control/reuse receipt |

At the end of each seven-day window, the participant reports all attempted tasks on the accepted candidate: success/failure, MCP use, practical benefit or `unmeasured`, and interventions. No completed task means an explicit empty task list. No returned report means a missing observation. Keep failures when a later attempt succeeds. A weekly source-only test cannot fill the installed-artifact target.

Use these same questions each week: Did you return to the workflow? Did it accomplish the declared task? What practical benefit did you observe? Where did you need to intervene or stop? Keep any answers that need prose in the consented private receipt; the structured export contains only codes. Do not encourage users to repeat an artificial task to fill a week.
