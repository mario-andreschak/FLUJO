// Synthetic CLI protocol peer used ONLY by the actual installed Agent SDK.
// HTTP is loopback-only; no production Claude CLI or paid provider is started.
const readline = require('node:readline');
const url = new URL(process.argv[2]);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fixture');
const lines = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let task = Promise.resolve();
lines.on('line', line => {
  task = task.then(async () => {
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
        response: { commands: [], output_style: 'default', available_output_styles: ['default'], models: [] } } });
    } else if (message.type === 'user') {
      const reply = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdkUserMessage: message }) });
      if (!reply.ok) throw new Error(`Loopback HTTP ${reply.status}`);
      const result = await reply.json();
      send({ type: 'result', subtype: 'success', is_error: false, result: result.text,
        duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: 'offline-session',
        total_cost_usd: 0, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000001' });
    }
  });
  task.catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; lines.close(); });
});
lines.on('close', () => task.finally(() => { process.exit(process.exitCode ?? 0); }));
