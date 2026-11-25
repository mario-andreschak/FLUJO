// Fake Claude Code process for the installed Agent SDK that keeps sessions
// between processes (#1096). Each session is one transcript file under
// <state>/projects/, `--resume <id>` continues it, and the system prompt follows
// the documented recording rule: with `systemPromptSnapshot` true or unset, the
// first request's prompt is recorded and every later request of the session
// reuses that record; with false, each request uses this launch's prompt.
// For every user message it records the model request Claude Code would make.
// Nothing here reaches a model or the network.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const [recordFile, stateDir, ...argv] = process.argv.slice(2);
const flag = name => {
  const index = argv.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  return argv[index].startsWith(`${name}=`) ? argv[index].slice(name.length + 1) : argv[index + 1];
};
const resume = flag('--resume');
const sessionId = resume ?? crypto.randomUUID();
const transcriptFile = path.join(stateDir, 'projects', 'workspace', `${sessionId}.jsonl`);
const record = { argv, resume, sessionId, controlRequests: [], userMessages: [], requests: [] };
const save = () => fs.writeFileSync(recordFile, JSON.stringify(record));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const readTranscript = () => fs.existsSync(transcriptFile)
  ? fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const append = entries => {
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.appendFileSync(transcriptFile, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''));
};
const result = (message, fields) => ({ type: 'result', duration_ms: 1, duration_api_ms: 1, num_turns: 1,
  session_id: sessionId, total_cost_usd: 0, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: { sonnet: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 8192 } },
  permission_denials: [], uuid: crypto.randomUUID(), user_message_uuid: message.uuid, ...fields });

let initialize;
save();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    record.controlRequests.push(message.request);
    if (message.request.subtype === 'initialize') initialize = message.request;
    save();
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { commands: [], output_style: 'default', available_output_styles: ['default'], models: [] } } });
    return;
  }
  if (message.type !== 'user') return;
  record.userMessages.push(message);
  if (resume && !fs.existsSync(transcriptFile)) {
    save();
    send(result(message, { subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${resume}`] }));
    return;
  }
  const transcript = readTranscript();
  const recorded = transcript.find(entry => entry.type === 'system_prompt');
  const launched = (initialize?.systemPrompt ?? []).join('\n\n');
  const recording = initialize?.systemPromptSnapshot !== false;
  const system = recording && recorded ? recorded.prompt : launched;
  const history = transcript.filter(entry => entry.type === 'user' || entry.type === 'assistant')
    .map(entry => ({ role: entry.type, content: entry.content }));
  const content = message.message.content;
  record.requests.push({ system, messages: [...history, { role: 'user', content }] });
  const reply = `reply ${history.length / 2 + 1}`;
  append([...(recording && !recorded ? [{ type: 'system_prompt', prompt: launched }] : []),
    { type: 'user', content }, { type: 'assistant', content: reply }]);
  save();
  send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: crypto.randomUUID(), cwd: process.cwd(),
    tools: [], mcp_servers: [], model: 'sonnet', permissionMode: 'default', apiKeySource: 'none',
    slash_commands: [], output_style: 'default', claude_code_version: 'fake' });
  send(result(message, { subtype: 'success', is_error: false, result: reply }));
});
lines.on('close', () => process.exit(0));
