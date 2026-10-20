# SAP AI meeting supervision

- Owner: this chat; branch `codex/sap-meeting-reliability`, based on `bad73cf8`.
  Draft [PR 1222](https://github.com/mario-andreschak/FLUJO/pull/1222) is stacked
  on PR 1221. Pre-existing `AGENTS.md` and `packages/antigravity-cli/bin.cjs`
  changes remain untouched.
- [Meeting](http://localhost:4200/meetings?meeting=39921fc5-ea18-4746-892e-de554c5fdfcf):
  `39921fc5-ea18-4746-892e-de554c5fdfcf`, default-workspace. Managed through the
  meetings API, with public supervisor interventions and preserved conversations.
- Exact requested flows: `d7a4107e-e06a-447e-9035-0de7fe5f6de1` uses Gemini 4
  Argon/high, conversation `bb8e4bc5-0d74-4150-8634-ac99a4f1aa1d`;
  `882923d4-7bca-4f88-bc24-b681108bd7d6` uses GPT-6 Astra/xhigh over the Codex
  subscription, conversation `7ea5f59d-272c-4055-a956-27eb533abd73`.
  The human explicitly authorized these models in this chat only. This record
  grants no model exception to future chats. Configurations/routes are unchanged.
- Delivered code: composed Gemini tool-schema compatibility; streamed citations;
  bounded/coalesced Codex text and diagnostic filtering; immediate participant
  errors; all-seat failures reported as errors; explicit seat error labels and
  expandable brief; shared event-log cursors/locks across Next route bundles.
- Latest recovery repair: explicit resume acknowledges an interrupted previous
  segment without replaying its round. Repeated participant Stop after the meeting
  revoked its authority returns an owner-controlled acknowledgement, with no
  unfenced writes or fabricated terminal success.
- Research: recovered assessments committed in events 26–27, corrected critiques
  in 42–43. They recommend authorized-export/RAG, bounded outbound ABAP inference,
  and conditional external MCP. Contract, extraction, training, identity, and
  support qualifications remain explicit. Earlier broad matrix claims are
  superseded by the critiques. Final mutual acceptance is still pending.
- Live defects/evidence: event cursor froze at 22 across rounds 3–5; supervisor
  relayed peer evidence in 39–41. Checkpoint cancellation preserved round 5;
  interrupted round 6 exposed the continuation bug at event 50. No model calls
  were replayed. Original Codex closure cause was not exposed by its old adapter;
  buffering weakness was addressed without claiming a proven upstream diagnosis.
- Validation: local typecheck/lint and prior production builds passed. Latest
  source repair is undergoing the same checks and non-container build. Added
  regressions cover schema scope, citations, long streams, early failures,
  cross-bundle cursors, explicit recovery and revoked-owner cancellation.
  Broader suites, remote CI, and container builds remain deferred to release.
- Live service: stopped for the final repair build (unified exec session 79369).
  Resume the SAME meeting using the saved final-convergence direction, verify
  advancing snapshot cursors and peer delivery, and obtain both participants'
  final agreement. Do not treat checkpoint events as research completion.
- Evidence lives in this chat's visualization folder under
  `C:/Users/Moe/.codex/visualizations/2026/10/20/01a156c5-c536-7260-92b3-7b438bdd9e41`.
  Agents reported no remaining research scratch. Final cleanup/free-space check
  must run through flujo-bash; retain the production outputs needed by the service.
