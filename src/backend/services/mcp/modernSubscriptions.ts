import type { Client, McpSubscription } from '@modelcontextprotocol/client';

const subscriptions = new WeakMap<object, Map<string, Promise<McpSubscription>>>();

/** Modern resource updates use acknowledged, correlated listen streams. */
export async function subscribeModernResource(clientObject: object, uri: string): Promise<boolean> {
  const client = clientObject as Client;
  if (client.getProtocolEra?.() !== 'modern') return false;
  let byUri = subscriptions.get(client);
  if (!byUri) { byUri = new Map(); subscriptions.set(client, byUri); }
  if (!byUri.has(uri)) {
    const current = byUri;
    const pending = client.listen({ resourceSubscriptions: [uri] });
    current.set(uri, pending);
    void pending.then(subscription => {
      if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) {
        void subscription.close().catch(() => {});
      }
      void subscription.closed.then(() => { if (current.get(uri) === pending) current.delete(uri); });
    }, () => { if (current.get(uri) === pending) current.delete(uri); });
  }
  await byUri.get(uri);
  return true;
}

export function retireModernSubscriptions(client: object): void {
  const current = subscriptions.get(client);
  subscriptions.delete(client);
  for (const pending of current?.values() ?? []) void pending.then(subscription => subscription.close()).catch(() => {});
  current?.clear();
}
