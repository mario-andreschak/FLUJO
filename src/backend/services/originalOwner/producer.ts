import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { bindOriginalOwnerAuthority, type OriginalOwnerCaptureInput } from './authority';

/** Installed beside native Original capture at the genuine dispatcher claim.
 * Enrollment is saved administrative intent; only this live capture joins it
 * with the actual Activity, goal round, immutable plan and Persona lease. */
export function captureOriginalOwnerAuthority(authority: FlowExecutionAuthority,
  input: OriginalOwnerCaptureInput): Promise<void> {
  return bindOriginalOwnerAuthority(authority, input);
}
