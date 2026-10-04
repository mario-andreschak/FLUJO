# MCP connection input labels and first-use equipment

The normal connection flow displayed six field names beside inputs without
associating the text with the input: server name/root path, stdio run command,
WebSocket URL, HTTP/SSE URL and the remote setup URL. The existing placeholders
are examples, so a rendered control lookup by its visible field name failed.

The correction uses native labels and stable React IDs. Each label identifies
its input, including multiple mounted copies of a form. The six existing texts
and all seven translations are reused. Transport switching, connection test,
save behavior and prerequisite checks retain their existing handlers.

Six baseline DOM cases fail before the first five associations are corrected.
After that correction, a separate remote-URL negative control fails while the
other thirteen cases pass. With all six associations, fourteen new checks and
the four existing wizard checks pass: eighteen total, zero failures/skips.
They cover computed control names, native label association, unique IDs across
copies, normal editing callbacks, absence of connect/save/test callbacks while
editing and seven rendered translations. Unrelated environment/header/OAuth
editors are inert test doubles; the labeled inputs and MUI controls are real.
This is DOM evidence, not a screen-reader speech session or linguistic review.
An initial test-equipment attempt used an absent user-event package and did not
collect tests; that failure is retained separately and is not a negative control.

The first hosted typecheck rejected an unsupported `exact` option on five RTL
role queries. The follow-up removes that option; string role names already use
exact comparison in the installed DOM Testing Library implementation. The
visible-text queries retain their supported `exact` option. Assertions and
selected cases are unchanged. The first hosted lint job failed during npm
installation with `ECONNRESET`, before running lint; it is retained as an
installation failure. Fresh exact-head typecheck and lint remain required.

The first-use browser suite supplies the missing UI connection steps instead
of relying on seeded fixture entries. A new `initialConnections: 'ui'` mode
joins initialization, disables defaults using the existing typed updates and
adds no selected fixture configuration. Planned HTTP/SSE cases enter and test
connection details, save through the actual UI, reload, inspect all 128 tools,
reach tool128 by keyboard and dispatch one explicit synthetic echo with an
argument digest. Each transport has desktop and 360px cases, with one worker
and zero retries. Local endpoints use the supported **Configure manually**
route; the public-only automatic OAuth preview boundary is preserved.

The native environment suite passes sixteen checks with zero failures/skips.
Playwright collection finds all four cases and starts no browser. Those
browser cases have not run and do not provide source or installed-runtime
acceptance. Their candidate must include this label correction, the manual
setup route and the required feature/security/runtime dependencies. The
source declaration and compiled directory metadata do not establish artifact
provenance; retain separate immutable package/install receipts.

Raw controls, fixed results, collection, lint and source hashes are retained in
`C:/Users/Moe/.codex/visualizations/2026/10/03/01a103ab-4561-7400-95ca-4be7249284cd`.
The existing four-case retention matrix and public Firecrawl observations stay
separate. Genuine model/agent, approvals/debugger, external client, full
provider/transport/profile matrix, 200% zoom, screen reader, upgrade, consenting
novice and independent A- reassessment requirements remain incomplete.
