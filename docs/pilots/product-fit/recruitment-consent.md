# Recruitment and consent packet — drafts for a human owner

No invitations have been sent and no enrollment is authorized by this packet. The coordinator must identify an accountable human study owner, authorize recruitment, agree the rubric with the maintainer/reviewer, select accepted candidate artifacts and set the private storage/deletion/contact procedures before using these drafts. Community owns the separate contributor/maintainer program under #576; participating here does not commit someone to contributing or maintaining FLUJO.

## Invitation draft

> We are preparing an eight-week opt-in evaluation of FLUJO as a local MCP hub with agents, a debugger and tool approvals. We want to understand whether it helps with a normal recurring task, where setup fails, and whether new users can complete a first model-plus-MCP run using written guidance. You may participate without recommending FLUJO or writing a public review. Failures and withdrawal are valid results.
>
> If you join, you will try an identified candidate release on your own computer, choose a workflow you already need, and provide a short weekly report. We will ask about successful and failed tasks, time, practical benefit and interventions. FLUJO keeps workspace data locally; cloud models and connected services receive the inputs required for calls you choose. Local MCP software runs with your operating-system permissions. We will agree any provider spend/effect limits with you before use. This invitation does not require buying an account or enabling unattended activity.
>
> We collect consented pseudonymous observations; we do not collect your workspace, credentials, prompts, raw tool arguments or private files. Publication of aggregate statistics is optional. Quotation, screenshots or an identifiable use case require separate permission. Contact [named owner/contact, to be filled locally] for the protocol, privacy details or withdrawal. Please do not send keys or workspace exports in your reply.

Human owner: replace the bracketed contact before sending; provide the exact supported installation, prerequisites, expected time burden and any compensation. Do not imply that a “free” account can be provisioned, a particular provider will work, or a release is accepted until verified. Identify promotional/paid relationships; those participants cannot fill the independent-user target.

## Eligibility and cohort selection

Recruit people with an existing MCP/agent use case outside the author/automated-development accounts. Keep the selection method and exclusions before the first measurement. A target novice has not previously completed a model-plus-MCP FLUJO agent run; familiarity with MCP elsewhere is recorded privately rather than changing that definition afterward. Confirm each participant represents a distinct human, not another account of a participant, bot, maintainer or promotional test.

The owner records eligibility attestations and contact information separately from the observation dataset. The dataset contains only `p001`-style random assignment IDs. Freeze the cohort at the declared pilot start and preserve its denominator; replacements/late joiners may provide feedback but cannot erase earlier failures or missing weeks. No roster or contact-to-ID mapping enters Git, a public issue, an app workspace snapshot, or another stream's handoff.

## Consent form draft

Before enrollment, the owner fills in their name/contact, accepted artifact identity, exact tasks, spend/effect limits, private storage location/access, retention deadline and withdrawal method. Provide the participant a copy with protocol version `pilot-v1` and retain its evidence checksum privately.

Offer separate choices, without prechecked boxes:

- **Collection:** I voluntarily agree to the described first-use task and weekly structured reports. I understand that failed attempts, account provisioning, time, interventions and missing reports are part of the observation. I may stop at any time. Without affirmative collection consent, do not enroll or create observation records.
- **Aggregate publication:** I allow my observations to contribute to reviewed aggregate statistics, with no participant IDs and suppressed small groups. Or: keep my observations private to the pilot owner and authorized independent reviewer. The latter must not silently exclude me from the denominator.
- **Optional media:** Separately approve specific redacted screenshots or recordings for private review, if any. Refusal does not exclude me. Raw captures are not a default collection requirement.
- **Optional public story:** Separately approve the exact proposed quotation, screenshot or named/anonymous use case before publication. General collection/aggregate consent does not authorize public prose, media, attribution or contact details. This schema cannot record that permission; keep the signed scope separately.

Explain that the app's separate daily-active sharing setting is not consent to this pilot and can be reviewed in Settings. Publication approval is not permission to share private prompts or secrets. Source tests or pilot consent are not permission for live spending, external mutations, controller activation or use of another stream's credentials.

## Private handling and withdrawal

Use an access-controlled folder outside Git and outside FLUJO's workspace/snapshot tree. Store contact/consent records separately from pseudonymous metrics and separately from redacted execution receipts. Give reviewer access only within the consented scope. Set the retention deadline before recruitment; choose enough time for the agreed observation and independent review, and explain when contact mappings, receipts and metrics will be deleted.

When a participant withdraws, stop collection. Delete their journey/week/feedback records and their private receipts according to the agreed policy; the validator refuses observations associated with a withdrawal. Destroy the contact-to-ID mapping. Retain only an unlinkable enrollment/withdrawal tombstone needed to avoid an improved denominator, if this was disclosed and consented. It keeps the original independent/novice denominator and counts as missing evidence. If full erasure is required, the owner must preserve only permitted anonymous aggregate denominator counts and discuss the resulting evidence limit with the assessor; the current tool's participant tombstone workflow cannot implement that alternative automatically.

Previously published reviewed aggregates may persist; explain that before enrollment and honor any feasible removal procedure. Do not promise that deleting local metrics recalls a published screenshot or public issue. Any publication is a separately authorized, human-reviewed action.
