import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// A protocol-level model double: FLUJO still executes its real adapter, Core,
// Behavior, MCP client, dispatcher and stores. Never use this as AI-quality proof.
export function planCompletion(body) {
  const messages = body.messages ?? [];
  const tools = (body.tools ?? []).map(tool => tool.function);
  const specialist = messages.some(message => message.role === 'system'
    && String(message.content).includes('JOURNEY_SPECIALIST_ONLY'));
  const maintenance = messages.some(message => String(message.content).includes('restricted post-Activity memory maintenance'));
  const userText = messages.filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  const token = /JOURNEY_(CHAT|BUSY|TASK)/.exec(userText)?.[0];
  const results = messages.filter(message => message.role === 'tool').map(message => String(message.content));
  const call = (tool, args, content = null) => ({ role: 'assistant', content,
    tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(args) } }] });
  const finish = tools.find(tool => tool.name.startsWith('handoff_to_') && /finish/i.test(tool.name));
  if (maintenance) {
    if (!finish) throw new Error('Memory maintenance has no Finish handoff.');
    return call(finish, {}, 'No durable memories to propose from this synthetic acceptance task.');
  }
  if (specialist) {
    if (!finish) throw new Error('Specialist has no Finish handoff.');
    return call(finish, {}, 'JOURNEY-BEHAVIOR-RECEIPT:verified');
  }
  if (!token) throw new Error('This fixture accepts only explicit JOURNEY_CHAT/BUSY/TASK requests.');
  if (token === 'JOURNEY_CHAT' && !results.some(result => result.includes('JOURNEY-BEHAVIOR-RECEIPT:verified'))) {
    const behavior = tools.find(tool => /Run the Persona Behavior "Journey receipt specialist/.test(tool.description));
    if (!behavior) throw new Error('The Persona has no callable Journey receipt specialist.');
    return call(behavior, { task: 'Return the deterministic Behavior receipt.' });
  }
  if (!results.some(result => result.includes(`JOURNEY-APP-RECEIPT:${token}`))) {
    const app = tools.find(tool => tool.name.endsWith('journey_receipt'));
    if (!app) throw new Error('The granted receipt App is not callable.');
    return call(app, { token });
  }
  if (!finish) throw new Error('Core has no Finish handoff.');
  const summary = `${token}: complete; verified JOURNEY-APP-RECEIPT:${token}`
    + (token === 'JOURNEY_CHAT' ? ' and JOURNEY-BEHAVIOR-RECEIPT:verified.' : '.');
  const report = tools.find(tool => tool.name === 'report_activity_outcome');
  if (report) {
    const reports = messages.flatMap(message => (message.tool_calls ?? [])
      .filter(call => call.function?.name === report.name));
    if (!reports.length) return call(report, { resolution: 'succeeded', summary, goal_achieved: false });
    const result = messages.find(message => message.role === 'tool' && message.tool_call_id === reports.at(-1).id);
    let accepted;
    try { accepted = JSON.parse(result?.content ?? 'null'); } catch { /* Native failures are Error: text. */ }
    // ModelHandler serializes the native tool's data, not its outer service
    // success wrapper. Require the actual persisted-outcome acknowledgement.
    if (accepted?.reported !== true || accepted.outcome?.resolution !== 'succeeded'
      || accepted.outcome?.summary !== summary) throw new Error('Outcome report was not accepted.');
    return call(finish, {}, summary);
  }
  // Historical custom Cores may lack this native ability. The documented legacy
  // report is still explicit; prose saying "complete" alone is never sufficient.
  return call(finish, {}, `${summary}\n<persona_activity_outcome>${JSON.stringify({
    resolution: 'succeeded', summary, goalAchieved: false,
  })}</persona_activity_outcome>`);
}

export async function startFixtureServer({ onEvent = () => {} } = {}) {
  const events = [];
  const held = new Set();
  const record = event => {
    const entry = { at: new Date().toISOString(), ...event };
    events.push(entry);
    onEvent(entry);
  };
  let released = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Fixture request exceeds 2 MiB.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/telemetry') {
        // Exercise the first-use notice without sending fixture telemetry out
        // of the machine. Do not persist its rotating identifier.
        response.writeHead(204).end();
        return;
      }
      if (request.url === '/receipt') {
        if (!['JOURNEY_CHAT', 'JOURNEY_BUSY', 'JOURNEY_TASK'].includes(body.token)) {
          throw new Error('Unknown fixture token.');
        }
        record({ kind: 'app_started', token: body.token });
        if (body.token === 'JOURNEY_BUSY' && !released) {
          await new Promise(resolve => {
            held.add(resolve);
            response.once('close', () => { held.delete(resolve); resolve(); });
          });
        }
        if (response.destroyed) return;
        const receipt = `JOURNEY-APP-RECEIPT:${body.token}`;
        record({ kind: 'app_completed', token: body.token, receipt });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ receipt }));
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const message = planCompletion(body);
      record({ kind: 'model_completion', model: body.model,
        tools: message.tool_calls?.map(call => call.function.name) ?? [], content: message.content });
      const identity = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model };
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      const finishReason = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const emit = chunk => response.write(`data: ${JSON.stringify({ ...identity, object: 'chat.completion.chunk', ...chunk })}\n\n`);
        emit({ choices: [{ index: 0, delta: { ...message,
          ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}),
        }, finish_reason: null }] });
        emit({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
        if (body.stream_options?.include_usage) emit({ choices: [], usage });
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ...identity, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], usage,
        }));
      }
    } catch (error) {
      record({ kind: 'fixture_error', message: String(error) });
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, events,
    releaseBusy() { released = true; for (const resolve of held) resolve(); held.clear(); },
    async close() {
      for (const resolve of held) resolve();
      held.clear();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
