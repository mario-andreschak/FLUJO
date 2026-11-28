// Inspecting MCP transports: the innermost transport behind wrappers, and stdout lines that are not MCP messages.

/** The innermost transport behind FLUJO's wrappers, which host checks inspect. */
export function transportForHostInspection(transport: unknown): unknown {
  let current = transport;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const inner = (current as { __flujoInnerTransport?: unknown })
      .__flujoInnerTransport;
    if (!inner) break;
    current = inner;
  }
  return current;
}


/**
 * Whether a stdio transport error means "this stdout line was not an MCP message". The
 * SDK reports a line it cannot parse this way and keeps reading the stream.
 */
export function isUnparsableStdioLine(error: Error): boolean {
  return error instanceof SyntaxError || error?.name === "ZodError" || error?.name === "$ZodError";
}
