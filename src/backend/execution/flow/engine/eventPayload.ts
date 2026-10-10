import { boundedEventSnapshot } from './boundedEventSnapshot';

export const MAX_EXECUTION_EVENT_WIRE_BYTES = 256 * 1024;

/** Uses the current proxy/accessor-safe serializer; retains no publisher object. */
export function snapshotEventPayload(event: object, maxWireBytes = MAX_EXECUTION_EVENT_WIRE_BYTES) {
  return boundedEventSnapshot(event, maxWireBytes);
}
