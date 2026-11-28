import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT, EDITED, STAGES, main, reviewFlow, reviewPlan, verdict } from './run.mjs';

test('the stand-in model drafts, then sends exactly the text the person left', () => {
  assert.equal(reviewPlan({ messages: [{ role: 'system', content: 'WRITE-THE-DRAFT: write a short email' }, { role: 'user', content: 'Go.' }] }).content, DRAFT);
  assert.equal(reviewPlan({ messages: [
    { role: 'system', content: `SEND-THIS: ${EDITED}` },
    { role: 'assistant', content: 'earlier WRITE-THE-DRAFT note' },
  ] }).content, `Sent: ${EDITED}`);
  assert.equal(reviewPlan({ messages: [{ role: 'user', content: 'Hello' }] }).content, 'Hello from the local stub model.');
});

test('the checked flow is Draft, Human step, Send, wired on the builder\'s own handles', () => {
  const flow = reviewFlow('f', 'Flow', 'model-1', { mode: 'edit', prompt: 'Check.' });
  assert.deepEqual(flow.nodes.map((node) => node.type), ['start', 'process', 'human', 'process', 'finish']);
  assert.ok(flow.nodes.filter((node) => node.type === 'process').every((node) => node.data.properties.boundModel === 'model-1'));
  assert.ok(flow.edges.some((edge) => edge.source === 'human-review' && edge.sourceHandle === 'human-bottom' && edge.targetHandle === 'process-top'));
});

test('covers the four checks that used to be done by hand, after setting up the stand-in model', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), ['home', 'connect-ai', 'easy-view', 'expert-canvas', 'chat-review', 'phone']);
  assert.deepEqual(STAGES.find((stage) => stage.id === 'phone').viewport, { width: 360, height: 800 });
});

test('fails on a missing stage or a crash on the page', () => {
  const stages = STAGES.map((stage) => ({ id: stage.id, ok: true }));
  assert.equal(verdict({ stages, problems: [] }).passed, true);
  assert.equal(verdict({ stages: stages.slice(1), problems: [] }).passed, false);
  assert.equal(verdict({ stages, problems: ['page error: boom'] }).passed, false);
  assert.equal(verdict({ stages, problems: ['console error: noise'] }).passed, true);
});

test('never drives the everyday FLUJO on port 4200', async () => {
  await assert.rejects(main(['--base-url', 'http://127.0.0.1:4200/'], () => undefined), /port 4200/);
});
