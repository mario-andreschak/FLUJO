# Scoreboard row: Elicitation

Part of [#1448](https://github.com/mario-andreschak/FLUJO/issues/1448).
Checked on 2026-11-27 against [Is MCP good yet?](https://ismcpgoodyet.com/) and
the [2026-07-28 elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).

**Assessment: Yes.** A server can pause a tool call and ask the person for a
form or for an out-of-band link. Both modes are on by default for every server,
show up in chat by themselves, and also work in background runs.

## What the scoreboard asks

The row reads "A server can pause a tool call and ask the user for a form or an
out-of-band URL". Clients rated Yes handle both form and URL mode without an
opt-in; clients rated Partial document only one mode, or need a switch.
("Partial means opt-in, a subset, or experimental.")

## Criteria and evidence

| Criterion | FLUJO | Proof |
| --- | --- | --- |
| Declares `elicitation` with `form` and `url` | Both, for every server unless the user turns elicitation off. A local server keeps `url` for its account sign-in. Servers under an isolation or host-trust policy keep the switch as approved. | `elicitationCapability` in `src/backend/services/mcp/elicitation.ts`, `src/shared/utils/mcpClientFeatures.ts`; `__tests__/mcp/elicitation.test.ts` |
| Not opt-in | On unless turned off (Edit server → "Allow this tool to ask you questions"). | `mcpElicitationEnabled`; lint rule `flujo/mcp-feature-defaults` |
| Form mode: every allowed field type | Text, email, uri, date, date-time, number, integer, boolean, single choice (`enum`, titled `oneOf`, older `enumNames`) and multi choice (`array` of `enum`/`anyOf`), with defaults, required marks, min/max and length limits. | `src/frontend/components/Chat/elicitationForm.ts`, `ElicitationCard.tsx`; `__tests__/frontend/components/elicitationForm.test.ts` |
| Review before sending, checked against the schema | The card checks every field before "Submit"; the server side checks again with the JSON Schema validator. | `elicitationErrors`; `resolveConversationElicitation` in `elicitationRegistry.ts`; `__tests__/chat/pendingInputRegistry.test.ts` |
| Clear accept, decline and cancel | "Submit" / "I’ve finished", "Decline" and "Cancel" are separate answers. | respond route actions `elicitation-submit`, `-done`, `-decline`, `-cancel`; `__tests__/mcp/elicitationModes.test.ts` |
| Shows which server asks | "Asked by <server>" on both cards. | `run:awaiting_elicitation.serverName` |
| URL mode: full URL and host shown, consent first, never opened by itself, no prefetch | The card shows the website and the whole address; the page opens in a new tab (`noopener,noreferrer`) only on "Open link". FLUJO never fetches it. | `UrlRequest` in `ElicitationCard.tsx` |
| URL mode: unsafe links refused, look-alike hosts flagged | Only `https`, or `http` to this computer; no user name in the address. Punycode hosts get a warning. Refused links answer `-32602`. | `src/shared/utils/elicitationUrl.ts`; `__tests__/mcp/elicitation.test.ts`, `elicitationForm.test.ts` |
| URL mode: accept means the person consented; manual "done" | "I’ve finished" sends `accept`; this also avoids repeat prompts under the 2026-07-28 retry flow. | `elicitation-done` |
| `notifications/elicitation/complete` | Finishes the matching link request; unknown or finished ids are ignored. | `createElicitationCompleteHandler`; `elicitationModes.test.ts` |
| `URLElicitationRequiredError` (-32042) | FLUJO asks for each link in the calling run, then tries the tool call again (at most two rounds). A declined link stops the retry. | `requiredUrlElicitationsOf`, `completeRequiredUrlElicitations`, `MCPService.callTool`; `elicitationModes.test.ts` |
| 2026-07-28 `input_required` (MRTR) | The v2 client answers embedded `elicitation/create` requests through the same handler and retries with `inputResponses`. | `createNewBetaClient` in `betaClient.ts` (SDK `@modelcontextprotocol/client` 2.4.0 driver) |
| Undeclared mode refused | A form request while forms are off, or an unknown mode, answers `-32602`. | `elicitation.test.ts` |
| Chat and background runs | Chat shows the card at once. Background runs (schedules, triggers, sub-flows) wait with the same bound (5 minutes for forms, 10 for links), show the card in their chat and list it in `GET /api/approvals` → `elicitations`; nobody answering cancels it. | `askPerson` in `elicitation.ts`; `listAllPendingElicitations` |
| MCP Tasks input | Task-related elicitations keep their task link. | `taskInputRegistry.ts`; `__tests__/mcp/taskInputHandlers.test.ts` |

## Remaining scope

- A request that arrives outside any run (for example a tool test on the
  Connected Apps page) is cancelled, because no chat can show it.
- The wait limits are fixed (5 and 10 minutes). They heal by themselves: the
  request cancels and the run goes on.
- Browser proof for the end-of-day run: see "Server input" in
  `docs/feature-map/talk.md`.
