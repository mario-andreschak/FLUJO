import fs from 'node:fs';
import path from 'node:path';
import { FILE_RECORD_ID_RULE, RECORD_ID_RULE, newRecordId } from '@/shared/recordId';

/**
 * #1350: POST /api/model stored a model without an id when the body had none,
 * and `/api/model/{id}` could never reach it again. Every create route (a
 * `route.ts` with POST next to a `[param]` folder) must say here where its new
 * records get their id. Routes that take an id from the caller go through
 * `newRecordId` (src/shared/recordId.ts), which makes one when it is missing.
 */
type IdSource =
  | { newRecordId: string; test: string }
  | { reason: string };

const CREATE_ROUTES: Record<string, IdSource> = {
  'api/model': { newRecordId: 'src/backend/services/model/index.ts', test: '__tests__/api/modelCreateId.test.ts' },
  'api/flow': { newRecordId: 'src/app/api/flow/route.ts', test: '__tests__/flow/flowRestApi.test.ts' },
  'api/planned-executions': { newRecordId: 'src/backend/services/scheduler/index.ts', test: '__tests__/scheduler/schedulerService.test.ts' },
  'api/mcp/servers': { reason: 'A server is addressed by its checked name, not an id.' },
  'api/tickets': { reason: 'The ticket service always makes the id.' },
  'api/harness': { reason: 'The caller must send a UUID; it is also the retry key, so a missing one is refused.' },
  'api/harness/comparisons': { reason: 'The caller must send a UUID; it is also the retry key, so a missing one is refused.' },
  'v1/chat/conversations': { reason: 'The caller must send a safe id; a missing one is refused with 400.' },
  'v1/meetings': { reason: 'createMeetingRecord makes the id when the caller sends none.' },
  'v1/personas': { reason: 'The Persona schema checks a sent id; otherwise one is made from the retry key or at random.' },
  'v1/persona-drafts': { reason: 'The draft schema checks a sent id; otherwise randomEnduringAgentId makes one.' },
  'v1/roles': { reason: 'The Role schema checks a sent id; otherwise randomEnduringAgentId makes one.' },
  'v1/personas/[personaId]/app-grants': { reason: 'The grant id is made from the Persona and the app server name.' },
  'v1/personas/[personaId]/memories': { reason: 'The memory schema checks a sent id; otherwise randomEnduringAgentId makes one.' },
  'v1/personas/[personaId]/work-items': { reason: 'The WorkItem schema checks a sent id; otherwise randomEnduringAgentId makes one.' },
};

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const POST_EXPORT = /export\s+(?:const|async\s+function|function)\s+POST\b/;

function createRoutes(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const here = entries.some(entry => entry.isFile() && entry.name === 'route.ts')
    && POST_EXPORT.test(fs.readFileSync(path.join(dir, 'route.ts'), 'utf8'))
    && entries.some(entry => entry.isDirectory() && /^\[[^.\]][^\]]*\]$/.test(entry.name));
  const nested = entries.filter(entry => entry.isDirectory()).flatMap(entry => createRoutes(path.join(dir, entry.name)));
  return here ? [path.relative(APP_ROOT, dir).split(path.sep).join('/'), ...nested] : nested;
}

describe('every create route gives its records an id', () => {
  it('lists each create route with the place its ids come from', () => {
    const found = createRoutes(APP_ROOT).sort();
    const unlisted = found.filter(route => !(route in CREATE_ROUTES));
    const gone = Object.keys(CREATE_ROUTES).filter(route => !found.includes(route));
    if (unlisted.length > 0) {
      throw new Error(`New create route(s): ${unlisted.join(', ')}. Add each to CREATE_ROUTES in this test. `
        + 'If the caller may send an id, resolve it with newRecordId (src/shared/recordId.ts) so a record '
        + 'without one gets a fresh id, and name the test that proves it.');
    }
    expect(gone).toEqual([]);
  });

  it.each(Object.entries(CREATE_ROUTES).filter(
    (entry): entry is [string, { newRecordId: string; test: string }] => 'newRecordId' in entry[1],
  ))('%s resolves new ids with newRecordId and has a test', (_route, source) => {
    expect(fs.readFileSync(path.join(process.cwd(), source.newRecordId), 'utf8')).toMatch(/\bnewRecordId\(/);
    expect(fs.readFileSync(path.join(process.cwd(), source.test), 'utf8')).toMatch(/#1350/);
  });
});

describe('newRecordId', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it.each([undefined, null])('makes a fresh UUID for %p', (requested) => {
    const first = newRecordId(requested);
    const second = newRecordId(requested);
    expect(first).toEqual({ ok: true, id: expect.stringMatching(UUID) });
    expect(second.ok && first.ok && second.id !== first.id).toBe(true);
  });

  it('keeps an id that follows the rule', () => {
    expect(newRecordId('pkg--demo:v1.2')).toEqual({ ok: true, id: 'pkg--demo:v1.2' });
    expect(newRecordId('flow_1', FILE_RECORD_ID_RULE)).toEqual({ ok: true, id: 'flow_1' });
  });

  it.each(['', ' ', '.', '..', '../x', 'a/b', 'a\\b', 'a b', 'a'.repeat(129), 42, {}, true])(
    'refuses %p in plain words', (requested) => {
      expect(newRecordId(requested)).toEqual({
        ok: false,
        error: `The id must be ${RECORD_ID_RULE.description}. Leave it out and FLUJO makes one.`,
      });
    },
  );

  it('uses the stricter rule for ids that become file names', () => {
    expect(newRecordId('a:b', FILE_RECORD_ID_RULE).ok).toBe(false);
    expect(newRecordId('a.b', FILE_RECORD_ID_RULE).ok).toBe(false);
    expect(newRecordId('a'.repeat(65), FILE_RECORD_ID_RULE).ok).toBe(false);
  });
});
