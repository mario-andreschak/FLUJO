import { assertSupportedNodeRuntime } from './node-runtime.mjs';

// Entry points import this before dependencies can initialize private state.
assertSupportedNodeRuntime();
