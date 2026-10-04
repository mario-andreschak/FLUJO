/** Process-wide admission must also be shared by independently loaded route bundles. */
const MAX_ACTIVE = 4;
const MAX_QUEUED = 8;
interface CopyAdmissionState {
  active: number;
  queued: Array<() => void>;
  rejected: number;
}
declare global {
  var __flujo_run_resource_copy_admission: CopyAdmissionState | undefined;
}
const state = global.__flujo_run_resource_copy_admission
  ?? (global.__flujo_run_resource_copy_admission = { active: 0, queued: [], rejected: 0 });

export function getRunResourceCopyPressure() {
  return { active: state.active, queued: state.queued.length, rejected: state.rejected,
    maxActive: MAX_ACTIVE, maxQueued: MAX_QUEUED };
}

/** Reserve before opening files/loading indexes; queued requests retain no payload. */
export async function withRunResourceCopyAdmission<T>(task: () => Promise<T>): Promise<T | { skipped: 'copy-pressure' }> {
  if (state.active < MAX_ACTIVE) {
    state.active++;
  } else {
    if (state.queued.length >= MAX_QUEUED) {
      state.rejected = Math.min(Number.MAX_SAFE_INTEGER, state.rejected + 1);
      return { skipped: 'copy-pressure' };
    }
    await new Promise<void>(resolve => state.queued.push(resolve));
    // The predecessor transfers its active reservation directly to this waiter.
    // A new caller cannot take the slot between release and the resumed waiter.
  }
  try {
    return await task();
  } finally {
    const next = state.queued.shift();
    if (next) next();
    else state.active--;
  }
}
