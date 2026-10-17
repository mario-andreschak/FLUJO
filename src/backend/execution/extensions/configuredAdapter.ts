import type { ExecutionExtensionAdapter } from './index';

/** Replaced at build time only when a trusted server integration is selected. */
if (process.env.FLUJO_NATIVE_PARENT_MODULE) {
  throw new Error('Native Parent composition was selected but its server build hook was not applied.');
}
export const configuredExecutionAdapter: ExecutionExtensionAdapter | undefined = undefined;
