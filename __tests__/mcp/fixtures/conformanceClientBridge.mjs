// The official MCP conformance tool starts this file as "the client under test". It hands
// the scenario to the Jest test that started the tool (FLUJO_CONFORMANCE_DRIVER), where
// FLUJO's real client code runs it, and exits with that result.
const serverUrl = process.argv.at(-1);
const context = process.env.MCP_CONFORMANCE_CONTEXT;
const response = await fetch(process.env.FLUJO_CONFORMANCE_DRIVER, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    serverUrl,
    scenario: process.env.MCP_CONFORMANCE_SCENARIO,
    protocolVersion: process.env.MCP_CONFORMANCE_PROTOCOL_VERSION,
    context: context ? JSON.parse(context) : undefined,
  }),
});
const result = await response.json();
if (result.error) console.error(result.error);
process.exit(result.exitCode ?? 1);
