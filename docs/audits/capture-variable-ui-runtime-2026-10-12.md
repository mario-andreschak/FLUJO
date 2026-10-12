# Capture variable: UI-to-runtime acceptance

[Issue #203](https://github.com/mario-andreschak/FLUJO/issues/203) passes its remaining acceptance on source revision `ecac4ba4dc5799d16c903bf1bffeb7b2814641d0`, tree `80be9bed509a3c49dc977933f440b561354ba3b4`. This verifies the shipped editor and runtime; no product implementation changed.

The source-built production app ran in a disposable, password-protected workspace with an existing GPT-6 Luna model using the operator's Codex subscription login. Only the existing model configuration was provisioned before startup. The flow, its prompts, model bindings, capture field, and routing were created and saved through the UI. Read-only APIs retrieved the saved flow and model-turn evidence afterward.

## Reproduce the UI steps

1. Open **Agents → Start simple → No, I'll build it myself**. Name the agent **Capture Variable Acceptance 203**.
2. Create the goal step, choose **GPT-6 Luna**, and save. Add a second AI step, **Verify captured value**, and choose the same model.
3. In **Expert** view, open the first step's full settings. Name it **Produce capture**. Under **Advanced → Data-flow capture**, set **Capture as run variable** to `captured203`, then **Save changes**.
4. Set the first step's task to the following. The explicit handoff makes the later step run after the first step produces its text:

   ```text
   Write exactly CAPTURE_203_READY as your assistant message. Then call ${tool:handoff__handoff_to_verify_captured_value} to continue to the next workflow step. The handoff task must be Run the saved downstream step instructions. Do not finish the workflow in this step.
   ```

5. Set the later step's task to:

   ```text
   Read this value: ${var:captured203}. Reply with exactly VERIFIED: followed immediately by that value. No spaces, explanation, or punctuation.
   ```

6. **Save**, reload the editor, and reopen the first step's capture field. It still contains `captured203`. The later step still contains the literal `${var:captured203}` reference in the saved flow.
7. Open **Talk**, select this agent, and send **Run the two steps and verify the captured value.** Capture fields use Expert settings; the documented Talk entry point supports running the saved flow.

## Observed result

The live run completed on October 12, 2026, from `14:26:22.444Z` to `14:26:38.960Z`: **16.516 seconds**, measured from the UI send to the completion response timestamp. Both model dispatches completed. The transcript contains `CAPTURE_203_READY`, the handoff to **Verify captured value**, and the final answer `VERIFIED:CAPTURE_203_READY`.

The downstream model-turn archive records this operational instruction in the actual Codex SDK request:

```text
Read this value: CAPTURE_203_READY. Reply with exactly VERIFIED: followed immediately by that value. No spaces, explanation, or punctuation.
```

The saved flow retains the variable reference while the dispatched instruction contains its value. This proves runtime substitution in addition to the model's answer.

The two completed dispatches reported **26,508 prompt tokens and 49 completion tokens** in total. The completion endpoint reports only the final dispatch; the receipt sums both dispatches. The provider returned no dollar charge. This measures acceptance usage, not subflow-session savings.

At **390 × 844**, the reloaded capture value and final chat answer were visible, with no page or dialog horizontal overflow. The **1280 × 900** desktop journey also completed. No uncaught browser errors were observed.

## Recoverable evidence

- [Run receipt](evidence/capture-variable-203-2026-10-12/receipt.json): source/build identity, timestamps, dispatch IDs, saved and rendered prompts, usage, and UI steps.
- [UI-created saved flow](evidence/capture-variable-203-2026-10-12/flow.json): the graph retrieved after the UI save. Its model ID belongs to the acceptance workspace; bind your own available model when replaying it.
- [Phone capture editor](evidence/capture-variable-203-2026-10-12/editor-phone.png) and [phone runtime result](evidence/capture-variable-203-2026-10-12/runtime-phone.png).

These artifacts contain controlled acceptance text and identifiers, without credentials or private task content. This receipt completes #203's process-node capture criterion. It makes no published-installer, full-provider, novice-cohort, subflow-session, or release acceptance claim.
