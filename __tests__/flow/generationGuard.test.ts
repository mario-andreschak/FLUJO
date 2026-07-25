/**
 * Unit tests for the generation-side scratchpad-variable guard (issue #217).
 *
 * The guard rewrites unsafe `${var:NAME}` usage out of an auto-generated FlowSpec BEFORE it
 * is compiled, so a dangling or empty-baked variable can never reach execution:
 *   - HISTORY  — valid earlier producer + non-isolated consumer → strip the token, force the
 *                consumer to full-history, drop the now-unused capture.
 *   - RESOURCE — valid earlier producer + an isolated consumer → convert the pair to a tracked
 *                run resource (captureResource / ${res:NAME}).
 *   - DANGLING — no provably-earlier producer → remove the dangling reference.
 * It is pure, deterministic and idempotent, and recurses into inline subflow children.
 */
import { guardGeneratedFlowSpec } from '@/backend/services/flow/generationGuard';
import { FlowSpec } from '@/utils/shared/flowSpecCompiler';

function baseSpec(nodes: unknown[], edges: unknown[]): FlowSpec {
  return { name: 'f', description: 'd', nodes: nodes as never, edges: edges as never };
}

describe('guardGeneratedFlowSpec — issue #217', () => {
  it('removes a dangling ${var:NAME} with no producer', () => {
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'Do work.' },
        { key: 'b', type: 'process', model: 'm', prompt: 'Use this: ${var:missing} now.' },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'f' },
      ]
    );
    const { changes } = guardGeneratedFlowSpec(spec);
    const b = spec.nodes.find((n) => n.key === 'b')!;
    expect(b.prompt).not.toMatch(/\$\{var:/);
    expect(JSON.stringify(spec)).not.toContain('${var:');
    expect(changes.some((c) => c.code === 'var-dangling')).toBe(true);
  });

  it('strips a var whose value survives via history and forces the consumer to full-history', () => {
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'Summarize the doc.', captureVariable: 'summary' },
        { key: 'b', type: 'process', model: 'm', prompt: 'Critique this: ${var:summary}', inputMode: 'latest-message' },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'f' },
      ]
    );
    const { changes } = guardGeneratedFlowSpec(spec);
    const a = spec.nodes.find((n) => n.key === 'a')!;
    const b = spec.nodes.find((n) => n.key === 'b')!;
    expect(b.prompt).not.toMatch(/\$\{var:/);
    expect(b.inputMode).toBe('full-history');
    expect(a.captureVariable).toBeUndefined(); // no longer referenced
    expect(changes.some((c) => c.code === 'var-history')).toBe(true);
  });

  it('converts a var to a run resource when the consumer is isolated', () => {
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'Draft the report.', captureVariable: 'report' },
        {
          key: 'b',
          type: 'process',
          model: 'm',
          inputMode: 'isolated',
          isolatedPrompt: 'Critique this report:\n\n${var:report}',
        },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'f' },
      ]
    );
    const { changes } = guardGeneratedFlowSpec(spec);
    const a = spec.nodes.find((n) => n.key === 'a')!;
    const b = spec.nodes.find((n) => n.key === 'b')!;
    expect(a.captureVariable).toBeUndefined();
    expect(a.captureResource).toBe('report');
    expect(b.isolatedPrompt).toContain('${res:report}');
    expect(b.isolatedPrompt).not.toContain('${var:report}');
    expect(changes.some((c) => c.code === 'var-resource')).toBe(true);
  });

  it('treats a producer that is not an ancestor as no producer (dangling)', () => {
    // a and b are parallel siblings under s; b reads a var a captures, but a is NOT on b's path.
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'A', captureVariable: 'x' },
        { key: 'b', type: 'process', model: 'm', prompt: 'B reads ${var:x}' },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 's', to: 'b' },
        { from: 'a', to: 'f' },
        { from: 'b', to: 'f' },
      ]
    );
    const { changes } = guardGeneratedFlowSpec(spec);
    const b = spec.nodes.find((n) => n.key === 'b')!;
    expect(b.prompt).not.toMatch(/\$\{var:/);
    expect(changes.some((c) => c.code === 'var-dangling')).toBe(true);
  });

  it('is idempotent — a second pass makes no changes', () => {
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'Draft.', captureVariable: 'r' },
        { key: 'b', type: 'process', model: 'm', inputMode: 'isolated', isolatedPrompt: 'Use ${var:r}' },
        { key: 'c', type: 'process', model: 'm', prompt: 'Ref ${var:none}' },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'f' },
      ]
    );
    const first = guardGeneratedFlowSpec(spec);
    expect(first.changes.length).toBeGreaterThan(0);
    const second = guardGeneratedFlowSpec(spec);
    expect(second.changes).toHaveLength(0);
    expect(JSON.stringify(spec)).not.toContain('${var:');
  });

  it('recurses into inline subflow children (own variable scope)', () => {
    const child: FlowSpec = baseSpec(
      [
        { key: 'cs', type: 'start', prompt: 'child sys' },
        { key: 'cp', type: 'process', model: 'm', prompt: 'child uses ${var:ghost}' },
        { key: 'cf', type: 'finish' },
      ],
      [
        { from: 'cs', to: 'cp' },
        { from: 'cp', to: 'cf' },
      ]
    );
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'sub', type: 'subflow', label: 'child', subflowSpec: child },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ]
    );
    const { changes } = guardGeneratedFlowSpec(spec);
    expect(JSON.stringify(spec)).not.toContain('${var:');
    expect(changes.some((c) => c.code === 'var-dangling')).toBe(true);
  });

  it('does not touch a spec that uses no scratchpad variables', () => {
    const spec = baseSpec(
      [
        { key: 's', type: 'start', prompt: 'sys' },
        { key: 'a', type: 'process', model: 'm', prompt: 'Just do it.' },
        { key: 'f', type: 'finish' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'f' },
      ]
    );
    const before = JSON.stringify(spec);
    const { changes } = guardGeneratedFlowSpec(spec);
    expect(changes).toHaveLength(0);
    expect(JSON.stringify(spec)).toBe(before);
  });
});
