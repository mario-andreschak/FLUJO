import { getCurrentWorkspace } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { decideBackgroundAccess } from './access';
import { loadAccountsState } from './store';

const log = createLogger('backend/services/accounts/background');

/**
 * Background work (schedules, triggers, personas) in multi-user mode (#574,
 * step 574-5). Nobody is signed in for it, so it acts for the workspace owner.
 * When that owner is turned off (or the workspace has no active owner), the
 * work pauses: each run is skipped and retried on its next tick, so it resumes
 * by itself as soon as the owner is turned on again, also after a restart,
 * because nothing about the pause is stored. While multi-user mode is off
 * nothing ever pauses.
 */

/** How long paused persona work waits before it looks again. */
export const BACKGROUND_PAUSE_RETRY_MS = 30_000;

export type BackgroundPause = { readonly paused: false } | { readonly paused: true; readonly reason: string };

const RUNS: BackgroundPause = Object.freeze({ paused: false });
const paused = new Map<string, string>();

function note(workspace: string, reason: string | null): void {
  const previous = paused.get(workspace);
  if (reason === null) {
    if (previous !== undefined) {
      paused.delete(workspace);
      log.info(`Background work in workspace ${workspace} runs again: its owner is active.`);
    }
    return;
  }
  if (previous !== reason) {
    paused.set(workspace, reason);
    log.warn(`Background work in workspace ${workspace} is paused: ${reason}`);
  }
}

/**
 * May background work run in this workspace now? Never throws: an unreadable
 * accounts file pauses. `startedBy` is the person who set the work up (#575):
 * it also pauses while that person may not run things in the workspace.
 */
export async function backgroundWorkPause(workspace: string = getCurrentWorkspace(), now = Date.now(),
  startedBy?: string): Promise<BackgroundPause> {
  if (isWorkerMode()) return RUNS;
  let state;
  try {
    state = await loadAccountsState();
  } catch (error) {
    log.warn('Could not read the accounts file; background work waits and tries again.', error);
    state = { mode: 'damaged' as const, accounts: null };
  }
  if (state.mode === 'off') {
    note(workspace, null);
    return RUNS;
  }
  if (state.mode === 'damaged') {
    const reason = 'the accounts file is damaged. It runs again once an admin fixes it.';
    note(workspace, reason);
    return { paused: true, reason: `Paused: ${reason}` };
  }
  const decision = decideBackgroundAccess(state.accounts, workspace,
    { kind: 'background', ...(startedBy ? { startedBy } : {}) }, now);
  if (decision.allowed) {
    if (!startedBy) note(workspace, null);
    return RUNS;
  }
  if (decision.denial === 'starter-lost-access') {
    // About one automation, not the whole workspace: not noted per workspace.
    return {
      paused: true,
      reason: 'Paused: the person who set this up can no longer run things in this workspace. It runs again by itself once they can, or after someone who can changes it.',
    };
  }
  const reason = 'the owner of this workspace is turned off or missing. It runs again by itself once an admin turns the owner on or gives the workspace to an active person.';
  note(workspace, reason);
  return { paused: true, reason: `Paused: ${reason}` };
}
