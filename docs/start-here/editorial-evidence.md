# Public-story documentation review

Documentation review record, October 11, 2026. This page records the source checks, editorial decisions and limits behind the public guides.

## Ownership and source

- Branch: `codex/readme-website-journeys-20261011` in the dedicated `readme-website-journeys/FLUJO` worktree.
- Source baseline: `569079d632a19f100c3bb194e7036aaba5cdc283`, package version `3.46.3`. A source version is not a published-release acceptance result.
- Owned files: repository README, the documentation index, `docs/start-here/`, and the `first-agent.md`, `persona.md` and `website-builder.md` journey guides. Capture evidence and screenshots belong to the capture lane; the parent owns final checks, PR and publication.
- Initial audit used primary revision `ff2e289c9e711424a75029c746626482cc4d2e14` read-only. A diff against the implementation baseline found no changes in the audited README, docs, Persona UI/catalog, statistics or feature configuration paths.

## Documentation decisions

The front door promotes installation and a reusable Website Builder, followed by a real coffee-workshop site brief, review and revision. Capabilities and comparisons stay on separate pages. It preserves the version badge pattern consumed by `scripts/sync-version.mjs` and the old `#-getting-started` / `#network-exposure` anchors referenced by existing docs. The guided walkthrough replaces the film at `film/`, with no promised runtime; the unrelated original `short/` studio remains separately linked. The recorded coffee-reading helper and Maya guides remain additional examples with their original evidence and limits.

| Previous README material | New home |
| --- | --- |
| Install choices and first run | [Install](install.md), [Windows](windows.md), [Linux/macOS](unix.md), [npm](npm.md), [source](source.md) |
| Docker persistence, update, CA, CLI, file watches and Apps ports | [Docker](docker.md) |
| Exposure modes, owner-policy limits and hosted Apps sandbox | [Network](network.md) |
| Proxy/CA variables, browser installation repair, TLS requirements | [Proxy help](proxy.md) |
| Uninstaller ownership, manifest and data deletion | [Uninstall](uninstall.md) |
| Model/app/agent/chat/automation usage and recovery | [Everyday use](using-flujo.md) |
| Local storage, provider requests, encryption, backups and telemetry | [Privacy](privacy.md) |
| Feature inventory and roadmap maturity | [Capabilities](capabilities.md), linked existing [project status](../project-status.md) |
| API/proxy integration, formatter/debug flags, attribution, project/contact/release links | [Developers](developers.md) |

Important distinctions: a saved connection is not a successful test; a running schedule is not proof of a successful outcome; workspace separation is not multi-user authorization; browser Apps isolation is not a host-process sandbox; provider fallback does not replay work after output/tool activity; Persona demonstrations do not establish unattended reliability.

Persona UI source checks: navigation requires **Enable experimental features**. Creation is **About → Role → Apps → Supplemental behaviors → Review**; there is no direct model picker or memory-entry step. The Role's flow supplies its model; **Configure models** / **Open Role** are readiness actions. Add facts after creation through **Memory → Add memory**. Current sidebar labels include **Overview, Setup, Behaviors, Apps, Memory, Conversations, Tasks, Activity history, Improvements, Settings**. Older Now/Talk/Work/Activity translation strings are not the current sidebar. The goal form uses **Give this Persona a goal → Goal / Helpful context / Keep working on this goal / Start working**. Live capture may still expose runtime-specific differences.

Independent editorial review corrected three practical issues: Docker now explicitly obtains the checkout; the Persona guide supplies the source URL and reviewed checklist rather than implying chat transfer; and ongoing work now has explicit success criteria and cadence review before **Start working**. The goal dialog defaults to ongoing work, and blank success criteria mean work continues until stopped. The Apps dashboard wording was also narrowed to discovered interfaces, avoiding an unsupported saved-instance claim.

The incoming README change from `origin/main` at `ca309930` (PR #1082) is preserved in Everyday use's schedule section: retained schedules with stale-status wording, **Try again**, confirmed pause changes, retryable deletion dialogs and recovery after a 30-second stalled request. The source merge remains separate from this documentation edit.

## Source-backed capability review

Review included the [first-conversation guide](../getting-started/README.md), [model connection adapters](../features/models/connecting.md), [fallback boundaries](../features/model-fallback-policies.md), [MCP setup](../features/mcp/overview.md), [Apps support](../features/mcp/apps.md), [workspaces](../features/workspaces.md), [portable workers](../features/hot-clone-workspace.md), [scheduled occurrence accounting](../features/scheduled-occurrences.md), [project status](../project-status.md), and [Persona endurance acceptance](../performance/persona-goal-endurance-acceptance.md), plus current Persona component/catalog source. This is a documentation/source audit, not new full-product acceptance.

## Comparison provenance

[The comparison page](compare.md) cites official sources opened on October 11, 2026. Independent research covered Claude/Claude Code, Goose, Dify, n8n, OpenClaw and Nous Research Hermes Agent. No competitor installations or performance tests were run. Fit statements are editorial judgments. Do not turn them into absence claims or rankings.

Current details that changed the copy: Goose's current docs domain is `goose-docs.ai`; Claude's overview describes Cowork integration and its scheduling surfaces differ; OpenClaw and Hermes document GUI access as well as terminal/messaging use. All three document overlapping memory/MCP/scheduling ideas.

## Journey and validation status

The [capture manifest](../journeys/evidence/capture-manifest.json), [provenance](../journeys/evidence/capture-provenance.md) and [runtime evidence](../journeys/evidence/journey-runtime-evidence.json) own the live date, model, calls, exact prompts, results and image provenance. The manifest is final: all 18 screenshot hashes match the repository files. The supplemental second installation uses a new package prefix and fresh app data with an existing download cache; its receipt and first-launch images are linked and were visually reviewed. The documentation uses published `flujo-ai@3.46.2` evidence, distinct from the `3.46.3` source baseline.

The coffee-reading guide matches the live GitHub connection path and explains the manual correction from a global npm install to `npm install --include=dev`, the Bun build prerequisite, Standard IO `node` / `dist/index.js`, and **Update server**. Workshop AI uses OpenRouter `google/gemini-3-flash-preview`; an earlier provider failed on quota. Coffee workshop helper has the entire fetch-mcp app with six tools. Its initial 5,000-character source read omitted brewing steps; a follow-up with `max_length: 20000` corrected the ratio and bloom guidance.

All linked screenshots were visually inspected. Assets 04b and 09 are labeled as later UI views canceled without changing the server or creating a duplicate goal. The replacement 09 shows the filled goal and enabled Start working. The replacement 12 shows the real shopping draft and its quantities. Asset 10 shows memory review in progress; asset 11 shows the initial plan and beginning of the invitation. Captions distinguish draft quantities, chat completion and saved goal completion.

The Persona guide links the [reconciled workshop pack](../journeys/evidence/workshop-pack.md) and records the actual outcome: one completed goal and four completed child tasks after four controller sessions across three compressed demonstration sessions. Day 2 and initial Day 3 were user messages in the original goal chat; Continue goal only resumes background work. Approval did not carry to a later controller chat, so the operator asked to remember it, corrected and marked the memory Important, and continued. A further request reconciled the shopping task with final quantities. The old root description and next-action wording remained stale, and the earlier six-person plan remains active memory; these limits are disclosed. This was agent-operated real software with operator review, not independent human acceptance or elapsed-day reliability evidence.

Asset 07 retains a temperature wording error: its one-minute rest follows the target temperature, while the NCA source applies that rest after full boiling. The coffee-reading guide explicitly corrects it beside the real screenshot. No image was altered to hide it.

The Website Builder guide adds a separate recorded journey in the existing 3.46.2 workspace: tested Website Builder AI, the GitHub-installed DesktopCommanderMCP 0.2.52, a saved generic agent with one AI step and all 26 app tools, and the First Pour brief in chat. The Act 1–3 still manifests and approved clip records establish setup. The agent clip record is final and reviewed; its three named MP4s match their recorded hashes and sizes.

The final Act 4 still manifest records acceptance after repair. The original 6,473-byte site and a failed intermediate revision remain distinct from the accepted 6,793-byte source, SHA-256 `086f8071cbcb097461fec8d15cd6c342131f35a1ab47ceb01a9a4b14a4986121`. The capture operator verified the served source; the parent independently checked its identity and original-to-final diff. The agent performed the repair through a read/write/read sequence in the same chat. Final desktop and 400 × 913 responsive-browser submission and reload checks passed; the final screenshots show linked labels and a 2026 footer. Required-field validation was tested on the original draft, with unchanged signup JavaScript reported in the final source. Browser checks were performed by the capture operator, not Website Builder, and did not use a physical phone. No-network/no-storage claims come from source inspection, not screenshots alone.

Model HTTP 401 recovery, the missed tool-save click, corrected folder entry and website revision repair stay in expandable guide notes. The README now shows the accepted revised page. The four-feature ending describes Meetings, Automations, Personas and Waves from current UI/source evidence; it does not claim new execution acceptance for those features.

Final read-only documentation checks passed for 21 owned Markdown files and 275 local references, including image paths and heading anchors. The 3.46.3 README badge, three legacy anchors, exact recorded agent goal and site brief, balanced details sections, whitespace and conflict-marker checks passed. The original 18 screenshot hashes, new Act 1–3 screenshots, 29 reviewed Act 4 screenshots and approved setup/final-site clips match their evidence records. This covers the completed documentation batch, including uncommitted changes after `0e136b4c`; the parent owns the combined revision, incoming source merge and broader checks. These checks do not establish remote URL health or acceptance beyond the stated runtime evidence.

The documentation work added no dependencies or application changes. Combined publication checks are recorded in the pull request.
