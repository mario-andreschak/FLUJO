import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { bindOriginalOwnerAuthority, type OriginalOwnerCaptureInput } from './authority';
import { getNativeOriginalOwnerAuthority } from './authority';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';

/** Installed beside native Original capture at the genuine dispatcher claim.
 * Enrollment is saved administrative intent; only this live capture joins it
 * with the actual Activity, goal round, immutable plan and Persona lease. */
export function captureOriginalOwnerAuthority(authority: FlowExecutionAuthority,
  input: OriginalOwnerCaptureInput): Promise<void> {
  return bindOriginalOwnerAuthority(authority, input);
}

export async function runOriginalOwnerNativeFlow<T>(input: FlowRunInput,
  task: (input: FlowRunInput) => Promise<T>): Promise<T> {
  if (!await getNativeOriginalOwnerAuthority(input.executionAuthority)) return task(input);
  const native = await import('./nativeParent');
  return native.runOriginalOwnerNativeFlow(input,task);
}
