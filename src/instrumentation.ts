/**
 * Next.js instrumentation hook.
 *
 * register() runs once when the server process boots, before any request is
 * handled - the right place to kick off backend initialization (verify storage
 * + start enabled MCP servers) so the servers are already connecting (or
 * connected) by the time the UI loads, instead of relying on the frontend to
 * trigger /api/init.
 *
 * IMPORTANT: register() is compiled for BOTH the Node.js and Edge runtimes. The
 * backend startup code pulls in Node-only modules (child_process via the MCP
 * stdio transport, fs, …) which do not exist on Edge. We therefore keep the
 * actual work in a separate module and only import() it inside the
 * `=== 'nodejs'` branch - Next.js excludes that dynamic import from the Edge
 * bundle, so Edge never tries (and fails) to resolve `child_process`.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
