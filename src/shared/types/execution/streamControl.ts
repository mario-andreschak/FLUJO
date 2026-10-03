export const EXECUTION_STREAM_CONTROL_EVENT = 'flujo-stream-control';

/** Additive SSE control frame; never an execution event or execution ACK. */
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
  if (control.version !== 1 || control.recovery !== 'reload-snapshot' ||
      !['replay-gap', 'cursor-reset', 'slow-consumer', 'event-too-large'].includes(control.reason ?? '') ||
      !Number.isSafeInteger(control.nextSeq) || control.nextSeq! < 0 ||
      (control.epoch !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(control.epoch))) return undefined;
  return control as ExecutionStreamControl;
}
