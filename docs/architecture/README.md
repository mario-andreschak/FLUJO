# Flujo Architecture

This section provides technical architecture and design documentation for Flujo.

## System Architecture

- **Overview**: High-level system architecture
- **Components**: Major system components and their interactions
- **Data Flow**: How data flows through the system

## Backend Architecture

- **Server Architecture**: Backend server architecture
- **Database Design**: Database schema and design
- **API Design**: API architecture and design

## Frontend Architecture

- **Component Structure**: Frontend component structure
- **State Management**: State management approach
- **UI/UX Design**: UI/UX design principles

## Integration Architecture

- **Model Integration**: How Flujo integrates with AI models
- **MCP Integration**: Model Context Protocol integration
- **External Service Integration**: Integration with external services

## Decision Records

- [Single-gate tool approval proposal](./tool-approval-single-gate-proposal.md):
  Proposed conversation-scoped approval contract, workflow evidence, state and API
  requirements, verification matrix, and required stakeholder sign-off for issue #469.
- [Memory ranking and near-duplicate defaults](./memory-ranking-dedup-decision.md):
  The accepted reinforce-in-place strategy, 90-day recency half-life, 0.82
  trigram-Jaccard threshold, rollback switch, and privacy-gated tuning rules
  for issue #467.
- [Enduring-agent foundation contracts](./enduring-agent-foundation-contracts.md):
  Phase 0 domain ownership, immutable revision, Persona lease/fencing, memory
  trust, Flow tool-authority, compatibility, workspace, privacy, and threat-model
  contracts for issue #415.
- [Persona runtime retention policy](./persona-runtime-retention.md):
  Final mailbox, activity, dispatch, and lease-history windows and rank caps,
  compaction/deletion boundaries, and default-off rollout contract for issue #479.
- [FlowSpec node-type inclusion policy](./flowspec-node-inclusion-policy.md): which
  ReactFlow node types belong in the FlowSpec authoring contract, why, and the
  checklist for classifying future node types (issue #380).
- [Static node re-entry semantics](./static-node-reentry-semantics.md): the
  append-by-default and per-run `injectOnce` contract (issue #381).
