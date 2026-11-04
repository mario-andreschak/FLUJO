# Model decisions

A word list cannot tell what a message means. A model decision has a model judge it instead, with a fixed set of possible answers, and the flow decides what follows from the answer.

Put a `modelDecision` entry in a Static node. It works before the main model, on the question, and after it, on the answer.

```json
{
  "key": "check",
  "type": "static",
  "entries": [
    {
      "kind": "modelDecision",
      "model": "small-open-model",
      "captureVariable": "check",
      "target": "last-user",
      "question": {
        "type": "choice",
        "instructions": "Does this message ask for advice a qualified person must give?",
        "criteria": "Questions about opening hours or stock do not count.",
        "options": {
          "needs_person": "Asks for advice a qualified person must give",
          "fine": "Anything else"
        }
      },
      "onFailure": "continue",
      "failureValue": "needs_person"
    }
  ],
  "rules": [
    { "id": "unsure", "when": { "kind": "lt", "value": "0.8", "variable": "check.probability" }, "outcome": "person" },
    { "id": "needs_person", "when": { "kind": "equals", "value": "needs_person", "variable": "check.value" }, "outcome": "person" },
    { "id": "fine", "outcome": "answer" }
  ]
}
```

The main model does not see the question, the answer or the reason. Nothing is added to the conversation.

## The question

| `type` | Answers | `options` |
|---|---|---|
| `choice` | One of several | An object: each answer with what it means. |
| `noul` | `yes` or `no` | None. |
| `score` | A level on a scale | A list, lowest first. |

`instructions` says what to decide, and `criteria` says what counts. `target` picks the text to judge: `last-user` by default, `last-assistant` for the main model's answer, `last-message`, or `variable` with `variable` naming it. Only the first 20,000 characters are sent.

## The answer

`captureVariable` receives JSON, marked as coming from a model:

```json
{ "value": "fine", "probability": 0.93, "reason": "Asks about opening hours.", "model": "model-id" }
```

Rules and edges read it with a path, such as `check.value` or `check.probability`. Each answer is also listed in `flujo_decisions`, with its probability and reason.

A chat model reports its probability about itself, so it is not a measured value. Try a threshold on your own examples before relying on it, for instance with [Harness Lab comparisons](../harness-lab.md).

## When the model gives no usable answer

Set this with `onFailure`. A connection error, a reply that is not one of the answers and an empty text all count.

- `fail`, the default, ends the run with the error `decision_model_failed`, so an unchecked message cannot pass as a checked one.
- `continue` carries on. The variable then holds `failed: true`, the cause in `reason`, and `failureValue` as `value` if you set one. A rule can test `check.failed` with `exists`, and route to a word list, to a person or to a fixed reply.

To try another model first, bind a model with a [fallback policy](../model-fallback-policies.md).

## Which models

Any chat model works, and a small one is usually enough. The model counts as a model of the flow: `allowedModels` applies to it, breaking that list always ends the run, and `GET /api/flow/{id}/models` and `flujo_models` include it.

The question and answer have the shape decision models such as Jev and Kev use, including `confidence` and `probabilities` for every answer. Such a model is not connected yet. It would be one more provider behind the same entry, with no change to a flow.

## Limits

- The text is sent as data, with an instruction not to follow it. A cleverly worded message can still sway a model, so use this as one check among others, and use [decision rules](./decision-rules.md) for what must hold regardless.
- A model decision does not run in a protected execution extension run.
- It costs one model call each time the node runs. On a [resume after an approval](./static-node.md#wait-for-a-person) the entries before the wait do not run again.
