import net from 'node:net';
import { randomUUID } from 'node:crypto';

export type BridgeOperation = 'listTools' | 'callTool' | 'listResources' | 'listResourceTemplates' | 'readResource';

export async function bridgeRequest<T>(
  operation: BridgeOperation,
  payload: { name?: string; args?: Record<string, unknown>; uri?: string } = {},
): Promise<T> {
  const endpoint = process.env.FLUJO_MCP_BRIDGE_ENDPOINT?.trim();
  const token = process.env.FLUJO_MCP_BRIDGE_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Error('The FLUJO backend bridge is not configured. Launch this server through FLUJO.');
  }
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let pending = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`FLUJO backend bridge timed out during ${operation}`));
    }, 30_000);
    timeout.unref?.();
    const finish = (error?: Error, result?: T) => {
      clearTimeout(timeout);
      socket.destroy();
      error ? reject(error) : resolve(result as T);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, token, operation, ...payload })}\n`);
    });
    socket.on('data', (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline)) as { id?: string; result?: T; error?: string };
        if (response.id !== id) return finish(new Error('Mismatched FLUJO backend bridge response'));
        if (response.error) return finish(new Error(response.error));
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!socket.destroyed) finish(new Error('FLUJO backend bridge closed without a response'));
    });
  });
}
