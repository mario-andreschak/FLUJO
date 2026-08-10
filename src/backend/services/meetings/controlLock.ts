import { createHash } from 'crypto';

import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { workspaceCacheKey } from '@/utils/workspace';

declare global {
  // Next development bundles can instantiate this module more than once. A
  // process-global promise chain complements the cross-process workspace lock.
  var __flujo_meeting_control_locks: Map<string, Promise<void>> | undefined;
}

const controlLocks = global.__flujo_meeting_control_locks
  ?? (global.__flujo_meeting_control_locks = new Map());

function meetingControlLockId(meetingId: string): string {
  const digest = createHash('sha256').update(meetingId).digest('hex').slice(0, 40);
  return `meeting_control_${digest}`;
}

/** Serialize all authoritative snapshot/event mutations for one meeting. */
export async function withMeetingControlLock<T>(
  meetingId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = workspaceCacheKey('meeting-runtime', meetingId);
  const predecessor = controlLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => current);
  controlLocks.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await withWorkspaceRuntimeLock(meetingControlLockId(meetingId), async (lock) => {
      await lock.assertOwned();
      return task();
    });
  } finally {
    release();
    if (controlLocks.get(key) === tail) controlLocks.delete(key);
  }
}
