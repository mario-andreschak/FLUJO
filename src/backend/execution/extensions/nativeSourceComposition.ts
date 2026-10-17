import { createControllerNativeWorkerSourceAdapter } from './controllerNativeAdapter';
import { createControllerNativeClient, type NativeSourceParent } from './controllerNativeClient';
import { ExecutionExtensionError } from './index';

/** Production entry: actual Parent authority, private requester, pinned profile.
 * No caller-supplied gateway callbacks or HTTP admission DTO selects the port. */
export function createNativeSourceComposition(parent: NativeSourceParent) {
  if (!parent?.requester) throw new ExecutionExtensionError('controller_native_requester_required');
  const client = createControllerNativeClient(parent);
  const source = createControllerNativeWorkerSourceAdapter(client,parent.requester);
  return Object.freeze({ adapter: source.adapter, withWorkerRun: source.withWorkerRun,
    async close() {
      const results = await Promise.allSettled([source.close(),client.close()]);
      if (parent.close) results.push(...await Promise.allSettled([parent.close()]));
      const failures = results.filter(result=>result.status==='rejected').map(result=>result.reason);
      if (failures.length) throw new AggregateError(failures,'Native Source composition cleanup failed.');
    },
  });
}
