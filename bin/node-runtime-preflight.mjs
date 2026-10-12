import { assertSupportedNodeRuntime } from './node-runtime.mjs';

// Entry points import this before dependencies can initialize private state.
try {
  assertSupportedNodeRuntime();
} catch (error) {
  if (error.code !== 'UNSUPPORTED_NODE_RUNTIME') throw error;
  // MCP stdout belongs to the protocol. Never prompt or emit a stack trace here.
  console.error(`[FLUJO] ${error.code}: ${error.message}`);
  process.exit(1);
}
