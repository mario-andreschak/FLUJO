#!/usr/bin/env node
// Record what the bundled Codex CLI really sends over its app-server stdio
// connection, so tests can replay it after every Codex update.
//
// Safe to run anywhere: it uses empty temporary Codex homes, no login and no
// account. Model calls go to the local stand-in in scripts/codex-stand-in.mjs.
// Nothing leaves this machine.
//
// Usage: node scripts/record-codex-protocol.mjs
// Writes __tests__/model/fixtures/codexAppServerProtocol.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledCodex, HANG_PROMPT, prepareStandInHome, STAND_IN_MODEL, startAppServer, startStandInModel, USAGE_LIMIT_PROMPT,
} from './codex-stand-in.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(repo, '__tests__', 'model', 'fixtures', 'codexAppServerProtocol.json');
/** The text FLUJO sends instead of an input Codex already has. Same as
 * CODEX_CONTINUE_AFTER_DROP in codexAppServerThread.ts. */
const CONTINUE_AFTER_DROP = 'Continue the interrupted response from exactly where it stopped. Do not repeat content or tool calls already completed.';
/** Stand-in for FLUJO's compaction carry (standing instructions and receipts). */
const CARRY_TEXT = '[FLUJO context kept after compaction]\nRecorded carry: never delete files.';
const OUTPUT_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

const initialize = { clientInfo: { name: 'flujo_conversation', title: 'FLUJO', version: '1' } };
const turnDone = threadId => message => message.method === 'turn/completed' && message.params?.threadId === threadId;
// Same newest-turn page FLUJO reads after resume and fork (codexAppServerThread.ts).
const listTurns = (server, threadId, itemsView) => server.request('thread/turns/list', { threadId, limit: 4, sortDirection: 'desc', itemsView });

export async function recordCodexProtocol({ output = FIXTURE } = {}) {
  const { executable, cliVersion, sdkVersion } = bundledCodex();
  const model = await startStandInModel();
  const place = await prepareStandInHome(model.port);
  // Compaction needs large token counts, so it gets its own stand-in and home.
  const bigModel = await startStandInModel({ inputTokens: () => 5000 });
  const bigPlace = await prepareStandInHome(bigModel.port, { config: ['model_context_window = 100000'] });
  const replacements = [];
  try {
    const { workspace: cwd } = place;
    const threadParams = { model: STAND_IN_MODEL, cwd, approvalPolicy: 'never', sandbox: 'read-only',
      config: { service_tier: 'default', web_search: 'disabled', features: { shell_tool: false } },
      developerInstructions: 'You are the FLUJO protocol recording fixture.', serviceTier: 'default' };
    let sends = 0;
    // Recorded client ids are placeholders; the replay maps them to FLUJO's own.
    const turn = (threadId, text, extra = {}) => ({ threadId, model: STAND_IN_MODEL, effort: 'low',
      input: [{ type: 'text', text }], clientUserMessageId: `flujo-send-${++sends}`, ...extra });
    const sessions = [];
    const session = (name) => { const entry = { name, frames: [] }; sessions.push(entry); return entry.frames; };
    const connect = (frames, at = place) => startAppServer({ executable, env: at.env, cwd: at.workspace, frames });
    const handshake = async server => { await server.request('initialize', initialize); server.notify('initialized'); };
    const resume = async (server, threadId, itemsView = 'summary') => {
      await server.request('thread/resume', { ...threadParams, threadId, excludeTurns: true });
      return (await listTurns(server, threadId, itemsView)).data;
    };

    // 1. A new conversation with one ordinary turn.
    let server = connect(session('start'));
    await handshake(server);
    const thread = await server.request('thread/start', { ...threadParams, ephemeral: false });
    const threadId = thread.thread.id;
    let done = server.waitFor(turnDone(threadId), 'first turn');
    const firstTurn = await server.request('turn/start', turn(threadId, 'Say the fixture reply.'));
    await done;
    await server.stop();

    // 2. A fresh process resumes the saved conversation (FLUJO restart).
    // Steps 2-4 share one process; its frames are split once it has exited,
    // so late notifications stay with the step that caused them.
    const frames = [];
    server = connect(frames);
    await handshake(server);
    await resume(server, threadId);
    done = server.waitFor(turnDone(threadId), 'resumed turn');
    await server.request('turn/start', turn(threadId, 'Say the next fixture reply.'));
    await done;

    // 3. The provider refuses because the plan's usage limit is used up.
    const limitStart = frames.length;
    done = server.waitFor(turnDone(threadId), 'usage-limit turn');
    await server.request('turn/start', turn(threadId, USAGE_LIMIT_PROMPT));
    await done;

    // 4. Fork after the first completed turn, as FLUJO does when history is restored.
    const forkStart = frames.length;
    const forkStarted = server.waitFor(message => message.method === 'thread/started'
      && message.params?.thread?.forkedFromId === threadId, 'fork start');
    const forked = await server.request('thread/fork', { ...threadParams, threadId, lastTurnId: firstTurn.turn.id, ephemeral: false, excludeTurns: true });
    await listTurns(server, forked.thread.id, 'summary');
    await forkStarted;
    await server.stop();
    sessions.push({ name: 'resume', frames: frames.slice(0, limitStart) },
      { name: 'usage-limit', frames: frames.slice(limitStart, forkStart) },
      { name: 'fork', frames: frames.slice(forkStart) });

    // 5. Structured output: FLUJO's output schema must reach the model request.
    server = connect(session('structured'));
    await handshake(server);
    await resume(server, threadId);
    done = server.waitFor(turnDone(threadId), 'structured turn');
    const schemaRequest = model.nextRequest();
    await server.request('turn/start', turn(threadId, 'Answer as JSON.', { outputSchema: OUTPUT_SCHEMA }));
    const format = (await schemaRequest).text?.format;
    if (format?.type !== 'json_schema' || JSON.stringify(format.schema) !== JSON.stringify(OUTPUT_SCHEMA)) {
      throw new Error(`Codex did not pass the output schema to the model: ${JSON.stringify(format)}`);
    }
    await done;
    await server.stop();

    // 6. The connection drops right after FLUJO wrote an input, before Codex
    // saved it. A reconnect finds no turn with FLUJO's client id, so FLUJO
    // sends the same input once more.
    for (let attempt = 1; ; attempt++) {
      const dropped = { name: 'drop-before-record', frames: [] };
      server = connect(dropped.frames);
      await handshake(server);
      await resume(server, threadId);
      const send = turn(threadId, 'Input lost with the connection.');
      server.write('turn/start', send);
      await server.kill();
      const reconnected = { name: 'drop-before-record-reconnect', frames: [] };
      server = connect(reconnected.frames);
      await handshake(server);
      const turns = await resume(server, threadId, 'full');
      const recorded = turns.some(entry => entry.items.some(item => item.clientId === send.clientUserMessageId));
      if (recorded) {
        // Codex saved it before the stop; that is the next case, so try again.
        await server.stop();
        if (attempt === 5) throw new Error('Codex kept saving the input before the stop; cannot record a lost input.');
        continue;
      }
      done = server.waitFor(turnDone(threadId), 'resent turn');
      await server.request('turn/start', send);
      await done;
      await server.stop();
      sessions.push(dropped, reconnected);
      break;
    }

    // 7. The connection drops mid-answer, after Codex saved the input. The
    // reconnect finds the interrupted turn by FLUJO's client id, so FLUJO asks
    // Codex to continue instead of sending the input again.
    server = connect(session('drop-mid-answer'));
    await handshake(server);
    await resume(server, threadId);
    const hanging = turn(threadId, HANG_PROMPT);
    const hangRequest = model.nextRequest(body => JSON.stringify(body.input).includes(HANG_PROMPT));
    await server.request('turn/start', hanging);
    await hangRequest;
    await server.kill();
    server = connect(session('drop-mid-answer-reconnect'));
    await handshake(server);
    const afterDrop = await resume(server, threadId, 'full');
    const interrupted = afterDrop.find(entry => entry.items.some(item => item.clientId === hanging.clientUserMessageId));
    if (interrupted?.status !== 'interrupted') throw new Error(`Expected an interrupted turn after the stop, got ${interrupted?.status}.`);
    done = server.waitFor(turnDone(threadId), 'continuation turn');
    await server.request('turn/start', turn(threadId, CONTINUE_AFTER_DROP));
    await done;
    await server.stop();

    // 8. Codex compacts the conversation on its own. FLUJO steers its carry in
    // when the compaction starts; Codex adds it right after the summary.
    const bigParams = { ...threadParams, cwd: bigPlace.workspace, config: { ...threadParams.config, model_auto_compact_token_limit: 3000 } };
    server = connect(session('compaction'), bigPlace);
    await handshake(server);
    const big = await server.request('thread/start', { ...bigParams, ephemeral: false });
    const bigId = big.thread.id;
    done = server.waitFor(turnDone(bigId), 'turn before compaction');
    await server.request('turn/start', turn(bigId, 'Never delete files.'));
    await done;
    done = server.waitFor(turnDone(bigId), 'compacted turn');
    const compacting = server.waitFor(message => message.method === 'item/started' && message.params?.item?.type === 'contextCompaction', 'compaction');
    const compactedTurn = await server.request('turn/start', turn(bigId, 'Keep going.'));
    await compacting;
    await server.request('turn/steer', { threadId: bigId, expectedTurnId: compactedTurn.turn.id,
      input: [{ type: 'text', text: CARRY_TEXT }], clientUserMessageId: `flujo-send-${++sends}` });
    await done;
    await server.stop();
    const finalRequest = bigModel.requests.at(-1);
    if (!JSON.stringify(finalRequest.input).includes('Recorded carry: never delete files.')) {
      throw new Error('The compaction carry did not reach the model request after compaction.');
    }

    // Remove the machine name and install id the CLI reports for remote control.
    for (const { message } of sessions.flatMap(entry => entry.frames)) {
      if (message.method === 'remoteControl/status/changed' && message.params) {
        if ('serverName' in message.params) message.params.serverName = '<HOST>';
        if ('installationId' in message.params) message.params.installationId = '<INSTALLATION_ID>';
      }
    }
    replacements.push([bigPlace.workspace, '<WORKSPACE>'], [bigPlace.codexHome, '<CODEX_HOME>'], [bigPlace.home, '<HOME>'],
      [place.workspace, '<WORKSPACE>'], [place.codexHome, '<CODEX_HOME>'], [place.home, '<HOME>'],
      [`127.0.0.1:${model.port}`, '127.0.0.1:<PORT>'], [`127.0.0.1:${bigModel.port}`, '127.0.0.1:<PORT>']);
    const escape = value => JSON.stringify(value).slice(1, -1);
    let text = JSON.stringify({
      recordedWith: { cliVersion, sdkVersion, recordedAt: new Date().toISOString().slice(0, 10),
        provider: 'Local stand-in Responses server on 127.0.0.1. No login, no account and no real model call.' },
      sessions,
    }, null, 1);
    for (const [value, placeholder] of replacements) {
      for (const spelling of new Set([escape(value), escape(value.replaceAll('\\', '/'))])) text = text.split(spelling).join(placeholder);
    }
    await fs.writeFile(output, text + '\n');
    return { output, cliVersion, sessions: sessions.map(entry => [entry.name, entry.frames.length]) };
  } finally {
    await Promise.allSettled([model.close(), bigModel.close()]);
    await Promise.allSettled([place.remove(), bigPlace.remove()]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recordCodexProtocol().then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
