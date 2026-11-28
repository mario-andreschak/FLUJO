// A local stand-in for FLUJO's anonymous daily usage collector, so throwaway pilot instances never
// count as real installations, and the pilot can check what the pulse holds.
import { createServer } from 'node:http';

/** The only fields the notice on screen says the pulse holds. */
export const PULSE_FIELDS = Object.freeze(['anonymousDailyId', 'date', 'version', 'platform', 'installMethod']);

/** What is wrong with one pulse: unexpected fields, or a private value inside it. */
export function checkPulse(pulse, privateValues = []) {
  const problems = [];
  const keys = Object.keys(pulse ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...PULSE_FIELDS].sort())) {
    problems.push(`The anonymous usage pulse holds ${keys.join(', ') || 'nothing'} instead of ${PULSE_FIELDS.join(', ')}.`);
  }
  const text = JSON.stringify(pulse ?? {}).toLowerCase();
  for (const value of privateValues.filter((entry) => typeof entry === 'string' && entry.length >= 4)) {
    if (text.includes(value.toLowerCase()) || text.includes(JSON.stringify(value).slice(1, -1).toLowerCase())) {
      problems.push(`The anonymous usage pulse contains a private value: "${value}".`);
    }
  }
  return problems;
}

export async function startPulseCollector() {
  const pulses = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) break;
      chunks.push(chunk);
    }
    if (request.method === 'POST') {
      try {
        pulses.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        pulses.push({ unreadable: true });
      }
      response.writeHead(204).end();
      return;
    }
    const date = new URL(request.url, 'http://collector.invalid').searchParams.get('date');
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ date, count: pulses.length }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/telemetry/daily-active`,
    pulses,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}
