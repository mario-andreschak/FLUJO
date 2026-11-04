# Decision rules

A flow can decide what is allowed next by itself. A model can still run the conversation, but it cannot approve an action on its own.

A Static node holds an ordered list of rules, read after its entries. The first rule that applies is the decision. No model takes part.

```json
{
  "key": "decide",
  "type": "static",
  "entries": [
    { "kind": "humanGate", "text": "May we save this order?", "captureVariable": "consent", "onReject": "continue" }
  ],
  "rules": [
    {
      "id": "person_said_yes",
      "when": { "kind": "equals", "value": "approved", "variable": "consent", "from": "person" },
      "outcome": "proceed",
      "reason": "consent_given",
      "allowTools": ["save_order"]
    },
    { "id": "default", "outcome": "ask_first", "reason": "no_consent", "allowTools": [] }
  ]
}
```

Then branch on the result, on the outgoing edges:

```json
{ "from": "decide", "to": "save", "condition": { "kind": "equals", "value": "proceed", "target": "variable", "variable": "decision.outcome" } }
```

## A rule

| Field | What it does |
|---|---|
| `id` | Names the rule in the record. Must be unique in the node. |
| `when` | When the rule applies. With no `when`, it always applies. |
| `outcome` | The result, which edges read through the decision variable. |
| `reason` | A short code that says why, for the record. |
| `set` | Run variables to set, as literal text. Templates are not filled in, so a rule cannot pass a model's text off as its own value. |
| `allowTools` | The connected tools model steps may use from here on. |

The result goes into the run variable `decision` as JSON, with `ruleId`, `outcome` and `reason`. `decisionVariable` on the node picks another name.

If no rule applies, the run stops with the error `decision_no_rule`, because carrying on would allow whatever comes next without anyone having decided. The check warns when a list has no last rule without a condition.

## Conditions

`when` is a condition as on an edge, or combines them with `all`, `any` and `not`. A condition that names a `variable` tests it, and a dotted path reads into its JSON, such as `check.result.code`. An empty `all` or `any` never applies.

A variable that is missing, or that fails `from`, never matches, even with `negate`. Only `exists` asks about absence.

## Where a value came from

FLUJO notes who wrote each run variable, and `from` can demand it. It takes one value or a list.

| `from` | Written by |
|---|---|
| `person` | A human gate with `captureVariable`. |
| `tool` | A real tool call in a Static node with `captureVariable`. |
| `rule` | A decision rule, through `set` or the decision variable. |
| `input` | The caller, through `variables` when the run starts. |
| `model` | A Process step or subflow with `captureVariable`, or a mock tool call, whose text can repeat a model's words. |

The note is tied to the value. If anything changes the variable afterwards, the old source no longer counts. A variable with no note matches no `from`.

A tool result is only as trustworthy as what went in. A tool that repeats a model's text back gives you that text, marked `tool`.

## Limiting tools

`allowTools` limits what later model steps are offered, and FLUJO refuses a call to anything else. An empty list means no connected tools. Each decision replaces the list from the one before, and a rule with no list sets no limit. The limit stays across turns until another decision replaces it, and a subflow stays inside its parent's limit.

It limits connected tools only. Handoffs follow edges the flow drew, and FLUJO's own helpers such as `todo` act on nothing outside the run. `read_resource` can still read resources. The tool calls a Static node makes itself are written by the flow, so they are not limited. Give those a condition or an approval.

## Checking a flow

A rule protects only the paths that go through it. If an edge leads from a model step straight to a step with the tool, the rule never runs, so put the limit before the model step, or the decision node before the action.

Decision rules before the first model step run on every user turn, as a condition there does.

In a Harness Lab run a human gate does not wait and saves no answer, so a rule that demands `from: "person"` does not apply there.

## The record

`/v1/chat/completions` returns the decisions of this stretch of the run in `flujo_decisions`, and the flow run result has them in `decisions`. Each has `nodeId`, `ruleId`, `outcome`, `reason`, `allowTools` and `at`. FLUJO keeps the last 200 per conversation in the saved run.
