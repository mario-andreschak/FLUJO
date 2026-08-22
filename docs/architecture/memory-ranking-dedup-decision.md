# Memory ranking and near-duplicate defaults

Status: **Accepted provisionally**

Approval date: **2026-08-21**

Decision owner: issue [#467](https://github.com/mario-andreschak/FLUJO/issues/467), following the implementation from issue [#450](https://github.com/mario-andreschak/FLUJO/issues/450).

## Decision

The production memory kernel retains these code-level defaults:

- Generic near-duplicates use **reinforce-in-place**. The existing item keeps its stable ID, receives normalized and deduplicated provenance, and increments confidence and importance within their caps.
- `MEMORY_RANKING_WEIGHTS.recencyHalfLifeDays` remains **90 days**. Non-core memory recency decays exponentially and respects the configured floor; core memories remain exempt.
- `MEMORY_DEDUP_SETTINGS.nearDuplicateThreshold` remains **0.82** using trigram Jaccard similarity.
- `MEMORY_DEDUP_SETTINGS.comparisonWindow` remains **200** newest eligible active items, and `MEMORY_DEDUP_SETTINGS.maxSourceRefsPerItem` remains **64**.

The defaults live in `src/backend/services/enduringAgents/memoryRanking.ts`. Experiments fork the complete settings explicitly; they do not create persisted workspace settings.

## Rationale

Reinforcing the existing memory preserves stable IDs, prevents generic sibling proliferation, and combines provenance without weakening the activation policy. The selector is restricted to active memories owned by the same Persona with the same kind and scope, then chooses the highest qualifying similarity deterministically.

Explicit `supersedes` and `conflictsWith` relationships represent corrections or known disagreement, not generic duplication. Those writes, and internal writes using `skipNearDuplicateMerge`, bypass reinforcement so the intentional relationship remains visible.

A 90-day half-life balances freshness with continuity. The conservative 0.82 threshold favors avoiding false merges until labeled evaluation demonstrates that a different precision/recall tradeoff is safer.

## Alternatives considered

- **Implicit supersession for every near-duplicate:** rejected because it changes record IDs, retrieval multiplicity, provenance, and compatibility expectations without evidence that the incoming wording is a correction.
- **Lower similarity threshold:** may recover more duplicates but increases false-merge risk.
- **Higher similarity threshold:** reduces false merges but permits more duplicate siblings.
- **Runtime or workspace settings:** deferred because validation, persistence, API/UI exposure, versioning, and compatibility behavior need a separate design.

## Safety and compatibility

This decision changes no public API shape and requires no migration. Reinforcement retains the survivor's ownership, lifecycle, and stable ID. Confidence and importance remain capped at 1, source references are normalized, deduplicated, and capped, and a trust upgrade is accepted only when the active-memory activation policy permits the incoming trust and provenance.

Ranking changes can reorder recall results even when storage is unchanged. Any future tuning must therefore update the constants, decision record, exact-value tests, boundary tests, and ranking regression fixtures together.

## Rollback and tuning

`MEMORY_DEDUP_SETTINGS.enabled = false` is the rollback switch for write-time near-duplicate merging. It is a **code-level kill switch**, not a runtime operator control; changing it requires a build and deployment. Disabling it saves new siblings and does not split memories already reinforced.

Before changing the merge strategy, 90-day half-life, or 0.82 threshold, require:

1. labeled samples or privacy-safe aggregate evidence;
2. explicit precision, recall, and ranking success criteria;
3. deterministic persistence and ranking regression tests; and
4. a compatibility review for IDs, provenance, retrieval, and existing callers.

Network telemetry and dashboards are outside this decision. Memory content, source references, memory IDs, workspace IDs, tenant identifiers, and record-linked similarity samples must never be emitted. Any observability follow-up requires a separately approved aggregate-only, retention-bounded design.
