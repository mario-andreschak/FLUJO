import type { FlowRunInput } from './runFlow';
import type { FlowExecutionAuthority, SharedState } from './types';
import { combineAbortSignals } from './combineAbortSignals';
import { FlowExecutionAuthorityError } from './executionAuthority';
import { isTeamFlow } from '@/shared/types/flow/team';
import { validateFlow } from '@/utils/shared/flowValidation';
import { assertTeamFlowCurrent, assertTeamFlowSnapshot, projectTeamFlow, resolveTeamFlowBundle, TeamFlowUnavailableError } from '@/backend/services/flow/teamCatalogue';
import { teamFlowId } from '../../../../packages/shared-controller/src/shared-flow';

/** Restore capability from the fixed owner pipe, never from persisted metadata.
 * Invoked before the first shared snapshot write and on every resumed turn. */
export async function bindTeamFlowExecution(input: FlowRunInput, state: SharedState): Promise<(() => void) | undefined> {
  const snapshot = state.flowSnapshot;
  if (!snapshot || !isTeamFlow(snapshot)) {
    if (state.flowId?.startsWith('team-flow:')) throw new TeamFlowUnavailableError();
    return;
  }
  if (!snapshot.teamFlow || !snapshot.teamFlowBundle || snapshot.id !== state.flowId) throw new TeamFlowUnavailableError();
  const bundle = await resolveTeamFlowBundle(teamFlowId(snapshot.teamFlow));
  assertTeamFlowSnapshot(snapshot, bundle);
  for (const entry of bundle.flows) {
    const validation = validateFlow(projectTeamFlow(bundle, entry.resourceId, { includeBundle: false }));
    if (!validation.isRunnable) throw new Error(validation.issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('\n'));
  }
  const prior = input.executionAuthority; const abort = new AbortController();
  let pending: Promise<void> | undefined; let failed = false;
  const assertCurrent = async () => {
    if (failed || abort.signal.aborted) throw new FlowExecutionAuthorityError('Team Flow permission ended. Start a new run from the current revision.');
    if (!pending) {
      pending = (async () => { await prior?.assertCurrent(); await assertTeamFlowCurrent(bundle.reference, abort.signal); })()
        .catch(cause => { failed = true; abort.abort(); throw new FlowExecutionAuthorityError('Team Flow permission ended.', { cause }); })
        .finally(() => { pending = undefined; });
    }
    await pending;
  };
  // Preserve any enclosing Persona/meeting capability. Team authority adds a
  // check; it never substitutes for an existing owner fence or mutation lock.
  const authority: FlowExecutionAuthority = {
    ...prior, signal: combineAbortSignals(abort.signal, prior?.signal)!, assertCurrent,
    commitWhileCurrent: async task => {
      const guarded = async () => { await assertCurrent(); const result = await task(); await assertCurrent(); return result; };
      return prior?.commitWhileCurrent ? prior.commitWhileCurrent(guarded) : guarded();
    },
  };
  input.executionAuthority = authority;
  Object.defineProperty(state, 'executionAuthority', { value: authority, configurable: true, writable: true, enumerable: false });
  const watch = setInterval(() => { void assertCurrent().catch(() => clearInterval(watch)); }, 1000); watch.unref();
  return () => { clearInterval(watch); abort.abort(); };
}
