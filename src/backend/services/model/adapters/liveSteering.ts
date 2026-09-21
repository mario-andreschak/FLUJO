import type { CompletionInput, ModelSteering, SteeringDelivery } from './types';

/** Keep the old direct-adapter seam usable; production supplies the fenced source. */
export function steeringSource(input: CompletionInput): ModelSteering | undefined {
  if (input.steering) return input.steering;
  if (!input.consumeSteeringMessages) return undefined;
  return {
    async take() {
      const messages = input.consumeSteeringMessages!();
      if (!messages.length) return undefined;
      return { messages, beforeSend: async () => {}, acknowledge: async () => {}, requeue() {} };
    },
    subscribe: () => () => {},
  };
}

/** Notifications handle quiet SDK turns; polling also discovers durable Persona mail. */
export function watchSteering({ source, canDeliver, deliver, onError }: {
  source: ModelSteering | undefined;
  canDeliver: () => boolean;
  deliver: (batch: SteeringDelivery) => Promise<void>;
  onError: (error: unknown) => void;
}): { poll(): Promise<void>; stop(): Promise<void> } {
  let active = true;
  let pending: Promise<void> | undefined;
  const poll = (): Promise<void> => {
    if (!active || !source || !canDeliver()) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      let batch: SteeringDelivery | undefined;
      try {
        batch = await source.take();
        if (!batch) return;
        if (!active || !canDeliver()) { batch.requeue(); return; }
        await deliver(batch);
      } catch (error) {
        batch?.requeue();
        active = false;
        onError(error);
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  const unsubscribe = source?.subscribe(() => { void poll(); });
  const timer = source ? setInterval(() => { void poll(); }, 250) : undefined;
  timer?.unref?.();
  return {
    poll,
    async stop() {
      active = false;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}
