import type { ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { assertOriginalOwnerAuthority, type OriginalOwnerAuthority } from './authority';
import { assertOriginalOwnerModelStepCurrent, originalOwnerModelStepAuthority,
  issueOriginalOwnerModelStep, dispatchOriginalOwnerModelRequest, originalOwnerModelStepRouting } from './sender';
import { refuse } from './types';

function authority(value: object): OriginalOwnerAuthority {
  try { assertOriginalOwnerAuthority(value); return value; }
  catch {
    const owner = originalOwnerModelStepAuthority(value);
    if (!owner) refuse('original_owner_runtime_authority_required');
    return owner;
  }
}
function assertIdentity(owner: OriginalOwnerAuthority,
  expected?: { conversationId?: string; runId?: string; graphHash?: string }) {
  if ((expected?.conversationId !== undefined && expected.conversationId !== owner.binding.conversationId)
    || (expected?.runId !== undefined && expected.runId !== owner.binding.runId)
    || (expected?.graphHash !== undefined && expected.graphHash !== owner.binding.planDigest)) {
    refuse('original_owner_run_changed');
  }
}
const scope = globalThis as typeof globalThis & { __flujoOriginalOwnerAdapter?: ExecutionExtensionAdapter };
/** This adapter is recognized only through runtime capabilities captured by the
 * genuine dispatcher. It never becomes the ordinary Source transport. */
export const originalOwnerAdapter: ExecutionExtensionAdapter = scope.__flujoOriginalOwnerAdapter ??= {
  isProtectedServer: () => false,
  assertServerConfig: () => {},
  async assertRun(value, expected) {
    const owner = authority(value);
    assertIdentity(owner, expected);
    if (owner !== value) await assertOriginalOwnerModelStepCurrent(value);
    else await owner.assertCurrent();
  },
  async validateRun(input, value) {
    await authority(value).assertRunPlan({ flowId: input.flowId, flowSnapshot: input.flowDefinition,
      conversationId: input.conversationId, runId: input.runId });
  },
  async validateLoadedState(value, state) {
    const owner = authority(value);
    if (!state || typeof state !== 'object') refuse('original_owner_state_invalid');
    const saved = state as { conversationId?: string; logicalRunId?: string };
    assertIdentity(owner, { conversationId: saved.conversationId, runId: saved.logicalRunId });
  },
  async bindRun(value, conversationId, runId) {
    const owner = authority(value); assertIdentity(owner, { conversationId, runId }); await owner.assertCurrent();
  },
  signal: value => authority(value).signal,
  commit: (value, task) => authority(value).commitWhileCurrent(task),
  // Remote Worker tools, Native handoffs and descendants retain their separate
  // Parent qualification. This root model transport cannot grant those effects.
  protectedServer: () => 'original-owner-model-only',
  authorizeHandoffs(_value, names) { if (names.length) refuse('original_owner_handoff_unavailable'); },
  async assertModelTool() { refuse('original_owner_tool_unavailable'); },
  async assertDispatch() { refuse('original_owner_tool_unavailable'); },
  normalizeArguments() { return refuse('original_owner_tool_unavailable'); },
  async requestMeta() { return refuse('original_owner_tool_unavailable'); },
  validateResult() { return refuse('original_owner_tool_unavailable'); },
  issueModelStep: (value, model, slot) => issueOriginalOwnerModelStep(authority(value), model, slot),
  ownerModelRouting: originalOwnerModelStepRouting,
  dispatchModelRequest: dispatchOriginalOwnerModelRequest,
};
