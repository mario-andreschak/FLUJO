// Fake Claude Code process for the installed Agent SDK. It records the
// arguments and messages the SDK sends and answers with one successful result.
// Nothing here reaches a model or the network.
const fs = require('node:fs');
const readline = require('node:readline');

const [recordFile, ...argv] = process.argv.slice(2);
const record = { argv, controlRequests: [], userMessages: [] };
const save = () => fs.writeFileSync(recordFile, JSON.stringify(record));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
save();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    record.controlRequests.push(message.request);
    save();
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { commands: [], output_style: 'default', available_output_styles: ['default'], models: [] } } });
  } else if (message.type === 'user') {
    record.userMessages.push(message);
    save();
    send({ type: 'result', subtype: 'success', is_error: false, result: 'done',
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: 'offline-session',
      total_cost_usd: 0, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000002' });
  }
});
lines.on('close', () => process.exit(0));
