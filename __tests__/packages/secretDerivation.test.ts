/**
 * Unit tests for the content-driven secret DERIVATION feature (issue #195):
 * the content extractor, the offline heuristic detector, the (mocked)
 * model-driven detector's defensive parsing, and the merge/substitution/backstop
 * orchestration — plus its wiring into the #194 build path.
 *
 * All pure logic: no model I/O (the model pass takes an injected completion fn).
 */
import {
  extractScanTargets,
  extractModelTargets,
  type ScanTarget,
} from '@/backend/services/packages/secretScanTargets';
import {
  detectHeuristicSecrets,
  shannonEntropy,
  suggestSecretName,
} from '@/backend/services/packages/secretHeuristics';
import {
  detectModelSecrets,
  extractJsonArray,
  validateModelEntry,
  type ChatCompletionFn,
} from '@/backend/services/packages/secretModelPass';
import {
  applySecretSubstitutions,
  backstopScan,
  deriveSecretProposals,
  mergeProposals,
  proposalsToSubstitutions,
} from '@/backend/services/packages/deriveSecrets';
import { buildManifestFromEntities } from '@/backend/services/packages/buildPackage';
import {
  secretProposalId,
  toProposalSecretName,
  type SecretProposal,
} from '@/shared/types/package/secretProposal';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

// --- fixtures ---------------------------------------------------------------

function promptNode(id: string, prompt: string): FlowNode {
  return {
    id,
    type: 'process',
    position: { x: 0, y: 0 },
    data: { label: 'P', type: 'process', properties: { prompt } },
  } as unknown as FlowNode;
}

function flow(id: string, nodes: FlowNode[]): Flow {
  return { id, name: id, nodes, edges: [] } as unknown as Flow;
}

function model(id: string, extra: Partial<Model> = {}): Model {
  return { id, name: id, displayName: id, provider: 'openai', ...extra } as unknown as Model;
}

function pe(id: string, prompt: string): PlannedExecution {
  return { id, name: id, enabled: true, flowId: 'f', prompt } as unknown as PlannedExecution;
}

const T = (location: string, text: string): ScanTarget => ({ location, text });

// --- extractor --------------------------------------------------------------

describe('secretScanTargets', () => {
  it('extracts node prompts, model config and planned-exec prompts', () => {
    const targets = extractScanTargets({
      flows: [flow('f1', [promptNode('n1', 'Read C:\\Users\\alice\\notes.txt')])],
      models: [model('m1', { baseUrl: 'https://api.example.com', promptTemplate: 'hi' })],
      plannedExecutions: [pe('p1', 'do the thing')],
    });
    const locs = targets.map((t) => t.location);
    expect(locs).toContain('flow:f1.node:n1.properties.prompt');
    expect(locs).toContain('model:m1.baseUrl');
    expect(locs).toContain('plannedExecution:p1.prompt');
  });

  it('NEVER emits a model ApiKey as a scan target', () => {
    const targets = extractModelTargets(
      model('m1', { ApiKey: 'sk-supersecretkey-1234567890', baseUrl: 'https://x' } as Partial<Model>),
    );
    const joined = JSON.stringify(targets);
    expect(joined).not.toContain('sk-supersecretkey');
    expect(targets.some((t) => t.location.endsWith('.baseUrl'))).toBe(true);
  });

  it('skips empty / whitespace-only strings', () => {
    const targets = extractScanTargets({
      flows: [flow('f', [promptNode('n', '   ')])],
      models: [],
      plannedExecutions: [],
    });
    expect(targets).toHaveLength(0);
  });
});

// --- heuristics -------------------------------------------------------------

describe('detectHeuristicSecrets', () => {
  it('detects Windows and POSIX absolute paths', () => {
    const win = detectHeuristicSecrets([T('a', 'file at C:\\Users\\alice\\secret.txt here')]);
    expect(win[0]).toMatchObject({ kind: 'path', source: 'heuristic' });
    expect(win[0].excerpt).toBe('C:\\Users\\alice\\secret.txt');

    const posix = detectHeuristicSecrets([T('b', 'lives in /home/alice/project/data')]);
    expect(posix[0].kind).toBe('path');
    expect(posix[0].excerpt).toBe('/home/alice/project/data');
  });

  it('detects owner/repo slugs', () => {
    const out = detectHeuristicSecrets([T('a', 'clone mario-andreschak/FLUJO now')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'repo', excerpt: 'mario-andreschak/FLUJO' });
  });

  it('detects credential-bearing URLs and prefers them over inner spans', () => {
    const out = detectHeuristicSecrets([T('a', 'db at https://user:p4ss@db.example.com/app')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('url-cred');
    expect(out[0].excerpt).toBe('https://user:p4ss@db.example.com/app');
  });

  it('detects emails and bearer tokens', () => {
    const email = detectHeuristicSecrets([T('a', 'contact alice@example.com please')]);
    expect(email[0]).toMatchObject({ kind: 'email', excerpt: 'alice@example.com' });

    const bearer = detectHeuristicSecrets([T('b', 'Authorization: Bearer abc123DEF456ghi789xyz')]);
    expect(bearer.some((p) => p.kind === 'token' && p.excerpt === 'abc123DEF456ghi789xyz')).toBe(true);
  });

  it('detects high-entropy tokens but ignores plain words', () => {
    const out = detectHeuristicSecrets([T('a', 'token=A1b2C3d4E5f6G7h8I9j0K1l2 and word helloworldhelloworld')]);
    expect(out.some((p) => p.excerpt === 'A1b2C3d4E5f6G7h8I9j0K1l2')).toBe(true);
    // A long pure-alpha word (no digits) is not a token.
    expect(out.some((p) => p.excerpt === 'helloworldhelloworld')).toBe(false);
  });

  it('skips spans that already contain a {{secret.NAME}} placeholder', () => {
    const out = detectHeuristicSecrets([T('a', 'path {{secret.MY_PATH}} here')]);
    expect(out).toHaveLength(0);
  });

  it('dedupes identical location+excerpt spans and respects entropy toggle', () => {
    const dup = detectHeuristicSecrets([T('a', 'a@b.com a@b.com')]);
    expect(dup).toHaveLength(1);
    const noEntropy = detectHeuristicSecrets([T('a', 'x=A1b2C3d4E5f6G7h8I9j0K1l2')], { enableEntropy: false });
    expect(noEntropy).toHaveLength(0);
  });

  it('shannonEntropy is 0 for empty and higher for mixed strings', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeGreaterThan(1);
  });

  it('suggestSecretName produces valid identifiers per kind', () => {
    expect(suggestSecretName('path', 'C:\\Users\\alice\\notes.txt')).toMatch(/^PATH_/);
    expect(suggestSecretName('email', 'alice@example.com')).toMatch(/^EMAIL_/);
    expect(suggestSecretName('repo', 'owner/repo')).toMatch(/^REPO_/);
  });
});

// --- model pass -------------------------------------------------------------

describe('secretModelPass parsing', () => {
  it('extractJsonArray handles fenced, chatty and plain output', () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('Here you go: [{"a":1}] done')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('not json at all')).toBeNull();
    expect(extractJsonArray('{"not":"array"}')).toBeNull();
  });

  it('validateModelEntry rejects hallucinated excerpts and unknown locations', () => {
    const targets = new Map<string, ScanTarget>([['loc1', T('loc1', 'contains SECRET_VALUE_123 inside')]]);
    // valid
    expect(
      validateModelEntry({ location: 'loc1', excerpt: 'SECRET_VALUE_123', kind: 'token' }, targets),
    ).toMatchObject({ excerpt: 'SECRET_VALUE_123', source: 'model' });
    // excerpt not present in target text
    expect(validateModelEntry({ location: 'loc1', excerpt: 'NOT_THERE', kind: 'token' }, targets)).toBeNull();
    // unknown location
    expect(validateModelEntry({ location: 'nope', excerpt: 'SECRET_VALUE_123' }, targets)).toBeNull();
    // garbage
    expect(validateModelEntry(null, targets)).toBeNull();
  });

  it('coerces an unknown kind to "other"', () => {
    const targets = new Map<string, ScanTarget>([['l', T('l', 'abc def')]]);
    const out = validateModelEntry({ location: 'l', excerpt: 'abc', kind: 'weird' }, targets);
    expect(out?.kind).toBe('other');
  });

  it('detectModelSecrets never throws on provider failure', async () => {
    const failing: ChatCompletionFn = async () => {
      throw new Error('boom');
    };
    const res = await detectModelSecrets([T('l', 'x')], { modelIdentifier: 'm', completion: failing });
    expect(res.proposals).toHaveLength(0);
    expect(res.warnings[0]).toContain('boom');
  });

  it('detectModelSecrets returns validated proposals from good output', async () => {
    const completion: ChatCompletionFn = async () => ({
      success: true,
      completion: {
        choices: [
          {
            message: {
              content: JSON.stringify([
                { location: 'l', excerpt: '/etc/app/config', kind: 'path', suggestedSecretName: 'cfg' },
                { location: 'l', excerpt: 'HALLUCINATED', kind: 'token' },
              ]),
            },
          },
        ],
      },
    });
    const res = await detectModelSecrets([T('l', 'config at /etc/app/config')], {
      modelIdentifier: 'm',
      completion,
    });
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ excerpt: '/etc/app/config', source: 'model' });
  });

  it('detectModelSecrets warns on unparseable output', async () => {
    const completion: ChatCompletionFn = async () => ({
      success: true,
      completion: { choices: [{ message: { content: 'sorry, no json' } }] },
    });
    const res = await detectModelSecrets([T('l', 'x')], { modelIdentifier: 'm', completion });
    expect(res.proposals).toHaveLength(0);
    expect(res.warnings.join(' ')).toMatch(/parseable JSON/i);
  });
});

// --- orchestration ----------------------------------------------------------

function proposal(location: string, excerpt: string, source: SecretProposal['source']): SecretProposal {
  return {
    id: secretProposalId(location, excerpt),
    location,
    excerpt,
    kind: 'other',
    source,
    suggestedSecretName: toProposalSecretName('SECRET', excerpt.slice(0, 8)),
  };
}

describe('mergeProposals', () => {
  it('dedupes by location+excerpt with heuristic winning', () => {
    const merged = mergeProposals(
      [proposal('l', 'dup', 'heuristic')],
      [proposal('l', 'dup', 'model'), proposal('l', 'unique', 'model')],
    );
    expect(merged).toHaveLength(2);
    const dup = merged.find((p) => p.excerpt === 'dup');
    expect(dup?.source).toBe('heuristic');
  });
});

describe('applySecretSubstitutions', () => {
  it('replaces every occurrence and declares one secret per name', () => {
    const flows = [flow('f', [promptNode('n', 'path /srv/data and again /srv/data end')])];
    const result = applySecretSubstitutions(
      { flows, models: [], plannedExecutions: [] },
      [{ excerpt: '/srv/data', secretName: 'DATA_DIR' }],
    );
    const json = JSON.stringify(result.entities.flows);
    expect(json).not.toContain('/srv/data');
    expect(json.match(/\{\{secret\.DATA_DIR\}\}/g)).toHaveLength(2);
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0]).toMatchObject({ name: 'DATA_DIR', required: true });
    // input untouched (deep clone)
    expect(JSON.stringify(flows)).toContain('/srv/data');
  });

  it('skips invalid secret names with a warning', () => {
    const result = applySecretSubstitutions(
      { flows: [flow('f', [promptNode('n', 'x')])], models: [], plannedExecutions: [] },
      [{ excerpt: 'x', secretName: 'bad name!' }],
    );
    expect(result.secrets).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/invalid secret name/i);
  });

  it('applies longer excerpts before shorter ones', () => {
    const flows = [flow('f', [promptNode('n', 'AB and ABCD')])];
    const result = applySecretSubstitutions(
      { flows, models: [], plannedExecutions: [] },
      [
        { excerpt: 'AB', secretName: 'SHORT' },
        { excerpt: 'ABCD', secretName: 'LONG' },
      ],
    );
    const json = JSON.stringify(result.entities.flows);
    expect(json).toContain('{{secret.LONG}}');
  });
});

describe('backstopScan', () => {
  it('warns about a residual secret and stays quiet once substituted', () => {
    const withSecret = backstopScan({
      flows: [flow('f', [promptNode('n', 'email bob@example.com')])],
      models: [],
      plannedExecutions: [],
    });
    expect(withSecret.length).toBeGreaterThan(0);

    const clean = backstopScan({
      flows: [flow('f', [promptNode('n', 'email {{secret.BOB}}')])],
      models: [],
      plannedExecutions: [],
    });
    expect(clean).toHaveLength(0);
  });
});

describe('deriveSecretProposals (heuristic + optional model)', () => {
  it('merges heuristic and model proposals over the extracted content', async () => {
    const entities = {
      flows: [flow('f', [promptNode('n', 'repo mario-andreschak/FLUJO')])],
      models: [],
      plannedExecutions: [pe('p', 'email carol@example.com')],
    };
    const completion: ChatCompletionFn = async () => ({
      success: true,
      completion: {
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  location: 'plannedExecution:p.prompt',
                  excerpt: 'carol@example.com',
                  kind: 'email',
                  suggestedSecretName: 'CAROL',
                },
              ]),
            },
          },
        ],
      },
    });
    const res = await deriveSecretProposals(entities, {
      model: { modelIdentifier: 'm', completion },
    });
    expect(res.proposals.some((p) => p.excerpt === 'mario-andreschak/FLUJO')).toBe(true);
    // heuristic already found the email, so the model duplicate is deduped away.
    expect(res.proposals.filter((p) => p.excerpt === 'carol@example.com')).toHaveLength(1);
  });

  it('proposalsToSubstitutions maps accepted proposals', () => {
    const subs = proposalsToSubstitutions([proposal('l', 'x', 'heuristic')]);
    expect(subs[0]).toMatchObject({ excerpt: 'x' });
    expect(subs[0].secretName).toMatch(/^SECRET_/);
  });
});

// --- build wiring -----------------------------------------------------------

describe('buildManifestFromEntities with #195 substitutions', () => {
  const entities = {
    flows: [flow('f1', [promptNode('n1', 'read C:\\Users\\alice\\data.json now')])],
    models: [],
    mcpServers: [],
    plannedExecutions: [],
  };
  const resolved = {
    flowIds: ['f1'],
    modelIds: [],
    mcpServerNames: [],
    plannedExecutionIds: [],
    autoAdded: [],
    warnings: [],
  };
  const metadata = { id: 'pkg-1', name: 'Test', version: '1.0.0' };

  it('substitutes accepted excerpts and declares the secret in the manifest', () => {
    const accepted: SecretProposal = {
      id: 'x',
      location: 'flow:f1.node:n1.properties.prompt',
      excerpt: 'C:\\Users\\alice\\data.json',
      kind: 'path',
      source: 'heuristic',
      suggestedSecretName: 'DATA_PATH',
      accepted: true,
    };
    const result = buildManifestFromEntities(
      resolved,
      entities,
      metadata,
      proposalsToSubstitutions([accepted]),
    );
    expect(result.ok).toBe(true);
    expect(result.json).toBeDefined();
    expect(result.json).not.toContain('C:\\\\Users\\\\alice\\\\data.json'); // JSON-escaped form
    expect(result.json).toContain('{{secret.DATA_PATH}}');
    expect(result.package?.secrets.some((s) => s.name === 'DATA_PATH')).toBe(true);
  });

  it('leaves the manifest unchanged when no substitutions are given', () => {
    const result = buildManifestFromEntities(resolved, entities, metadata);
    expect(result.ok).toBe(true);
    expect(result.json).toContain('data.json');
    expect(result.package?.secrets ?? []).toHaveLength(0);
  });
});
