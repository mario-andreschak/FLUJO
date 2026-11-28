export interface LazyBrowserService<T extends object> {
  /** Returns the one instance, creating it on the first call. Throws outside the browser. */
  get: () => T;
  /** Stands in for the instance and creates it when a property is first read. */
  service: T;
}

/**
 * One browser-only service, created on first use. Client components that import a
 * service are also evaluated during server rendering, so importing must never throw:
 * only reading a property of `service` (or calling `get`) needs the browser.
 */
export function lazyBrowserService<T extends object>(name: string, create: () => T): LazyBrowserService<T> {
  let instance: T | null = null;
  const get = (): T => {
    if (typeof window === 'undefined') {
      throw new Error(`${name} can only be used in browser environment`);
    }
    instance ??= create();
    return instance;
  };
  const service = new Proxy({} as T, {
    get(_target, prop) {
      const current = get();
      const value: unknown = Reflect.get(current, prop, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  return { get, service };
}
