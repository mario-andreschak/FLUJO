/**
 * Settles like `work`, or with what `onDeadline` returns (or throws) once `ms`
 * have passed, whichever comes first. The deadline timer is always cleared.
 *
 * For protocol deadlines that must hold whatever React does (a View's
 * handshake, its teardown, an event stream connecting), so it is not tied to
 * a component's lifetime the way the hooks in src/frontend/hooks/timing.ts are.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onDeadline: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onDeadline());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
