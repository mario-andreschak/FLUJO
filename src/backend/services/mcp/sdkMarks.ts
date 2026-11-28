import type { PendingBundledFlujoWorkload } from '../security/bundledFlujoWorkload';

/**
 * Facts FLUJO records on an MCP SDK client or transport when it creates one.
 * They live on the object itself, so they hold for either SDK generation and
 * for a second copy of these modules (a dev reload or another route bundle).
 * Write them with markClient/markTransport; read them with the readers below,
 * which treat a value of the wrong type as absent.
 */
export type TransportKind = 'stdio' | 'streamable' | 'sse' | 'websocket';

/**
 * The RAW config key lets shouldRecreateClient compare config to config (see
 * stdioConfigKey / httpConfigKey in connection.ts). __flujoKind names the
 * transport type without instanceof, so the check also covers the newer SDK's
 * transport classes.
 */
export interface TransportWithConfigKey {
  __flujoStdioKey?: string;
  __flujoHttpKey?: string;
  __flujoKind?: TransportKind;
  /** Capability lease for one managed MCP Apps stdio process generation. */
  __flujoRuntimeBrokerLeaseId?: string;
  /** Opaque pending capability for this bundled FLUJO process generation. */
  __flujoBundledWorkload?: PendingBundledFlujoWorkload;
  /** Retires only the authority captured by this transport constructor. */
  __flujoRetireRuntimeAuthority?: () => Promise<void>;
  /** Inner SDK transport when FLUJO applies a protocol decorator. */
  __flujoInnerTransport?: unknown;
}

export interface ClientMarks {
  /** Built by the negotiating SDK (betaClient.ts). */
  __flujoBeta?: true;
  /** capabilityKey() of the config the client was built for. */
  __flujoCapKey?: string;
}

export function markTransport(transport: object, marks: TransportWithConfigKey): void {
  Object.assign(transport, marks);
}

export function markClient(client: object, marks: ClientMarks): void {
  Object.assign(client, marks);
}

function mark(target: unknown, name: keyof TransportWithConfigKey | keyof ClientMarks): unknown {
  return typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function transportStdioKey(transport: unknown): string | undefined {
  return text(mark(transport, '__flujoStdioKey'));
}

export function transportHttpKey(transport: unknown): string | undefined {
  return text(mark(transport, '__flujoHttpKey'));
}

export function transportKind(transport: unknown): TransportKind | undefined {
  const kind = mark(transport, '__flujoKind');
  return kind === 'stdio' || kind === 'streamable' || kind === 'sse' || kind === 'websocket' ? kind : undefined;
}

/** Whether a client (as stored in the connection map) was built by the negotiating SDK. */
export function isBetaClient(client: unknown): boolean {
  return mark(client, '__flujoBeta') === true;
}

export function clientCapabilityKey(client: unknown): string | undefined {
  return text(mark(client, '__flujoCapKey'));
}
