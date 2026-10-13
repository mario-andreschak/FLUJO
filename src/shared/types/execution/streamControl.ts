export const EXECUTION_STREAM_CONTROL_EVENT = 'flujo-stream-control';

/** Projection recovery only. Never an execution event, acknowledgement or owner change. */
export interface ExecutionStreamControl {
  version: 1;
  reason: 'replay-gap' | 'cursor-reset' | 'slow-consumer' | 'event-too-large';
  recovery: 'reload-snapshot';
  nextSeq: number;
  epoch?: string;
}

export function parseExecutionStreamControl(value: unknown): ExecutionStreamControl | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const control = value as Partial<ExecutionStreamControl>;
  if (control.version !== 1 || control.recovery !== 'reload-snapshot'
    || !['replay-gap', 'cursor-reset', 'slow-consumer', 'event-too-large'].includes(control.reason ?? '')
    || !Number.isSafeInteger(control.nextSeq) || control.nextSeq! < 0
    || (control.epoch !== undefined && (typeof control.epoch !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(control.epoch)))) return undefined;
  return control as ExecutionStreamControl;
}
