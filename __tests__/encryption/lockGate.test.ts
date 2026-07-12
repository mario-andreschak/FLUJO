/**
 * Tests for issue #77 (Stage 2/4 of the #16 custom-encryption fix): the full
 * API lockdown. While the store is in USER encryption mode and the server has
 * not been unlocked, every gated /api/* and /v1/* route must return HTTP 423
 * `encryption_locked` (OpenAI-shaped for /v1), SSE endpoints must 423 without
 * opening a stream, and DEFAULT mode must never be gated.
 *
 * These drive the REAL encryption/storage backend against a throwaway temp data
 * dir (via FLUJO_DATA_DIR), and enumerate the on-disk route tree to guarantee
 * deny-by-default coverage (a new route fails the guard test until it either
 * calls `assertUnlocked` or is consciously added to the allowlist).
 */
import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

function clearGlobalEncryptionState(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_server_dek = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_encryption_sessions = undefined;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-lockgate-'));
  process.env.FLUJO_DATA_DIR = tmpDir;
  clearGlobalEncryptionState();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  clearGlobalEncryptionState();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Fresh module registry so route + gate + secure share one instance per test. */
async function load() {
  jest.resetModules();
  const secure = await import('@/utils/encryption/secure');
  const gate = await import('@/utils/encryption/lockGate');
  return { secure, gate };
}

describe('assertUnlocked / isLocked', () => {
  it('returns a 423 while USER-mode + locked, and null once unlocked', async () => {
    const { secure, gate } = await load();
    await secure.initializeEncryption('pw');

    expect(await gate.isLocked()).toBe(true);
    const locked = await gate.assertUnlocked();
    expect(locked).not.toBeNull();
    expect(locked!.status).toBe(423);
    await expect(locked!.json()).resolves.toEqual({ error: 'encryption_locked' });

    await secure.authenticate('pw');
    expect(await gate.isLocked()).toBe(false);
    expect(await gate.assertUnlocked()).toBeNull();
  });

  it('never gates DEFAULT mode', async () => {
    const { secure, gate } = await load();
    await secure.initializeDefaultEncryption();
    expect(await gate.isLocked()).toBe(false);
    expect(await gate.assertUnlocked()).toBeNull();
  });

  it('emits the OpenAI error shape for /v1 with openai:true', async () => {
    const { secure, gate } = await load();
    await secure.initializeEncryption('pw');
    const locked = await gate.assertUnlocked({ openai: true });
    expect(locked!.status).toBe(423);
    await expect(locked!.json()).resolves.toEqual({
      error: {
        message: expect.any(String),
        type: 'encryption_locked',
        code: 'encryption_locked',
        param: null,
      },
    });
  });
});

describe('a representative gated /api route (env)', () => {
  const req = () => ({ url: 'http://localhost/api/env?includeSecrets=false' }) as any;

  it('returns 423 while locked and succeeds after unlock', async () => {
    const { secure } = await load();
    await secure.initializeEncryption('pw');

    const { GET } = await import('@/app/api/env/route');

    const lockedRes = await GET(req());
    expect(lockedRes.status).toBe(423);
    await expect(lockedRes.json()).resolves.toEqual({ error: 'encryption_locked' });

    await secure.authenticate('pw');
    const okRes = await GET(req());
    expect(okRes.status).toBe(200);
    await expect(okRes.json()).resolves.toHaveProperty('variables');
  });

  it('is never gated in DEFAULT mode', async () => {
    const { secure } = await load();
    await secure.initializeDefaultEncryption();
    const { GET } = await import('@/app/api/env/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});

describe('OpenAI-compatible /v1 route (models)', () => {
  it('returns an OpenAI-shaped 423 while locked', async () => {
    const { secure } = await load();
    await secure.initializeEncryption('pw');
    const { GET } = await import('@/app/v1/models/route');
    const res = await GET();
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.error.code).toBe('encryption_locked');
    expect(body.error.type).toBe('encryption_locked');
  });
});

describe('SSE endpoint returns 423 immediately (no open stream)', () => {
  it('gates the conversation events stream while locked', async () => {
    const { secure } = await load();
    await secure.initializeEncryption('pw');
    const { GET } = await import(
      '@/app/v1/chat/conversations/[conversationId]/events/route'
    );
    const res = await GET({} as any, {
      params: Promise.resolve({ conversationId: 'abc' }),
    });
    expect(res.status).toBe(423);
    // A 423 must NOT be an event-stream (i.e. the stream was never opened).
    expect(res.headers.get('content-type') || '').not.toContain('text/event-stream');
  });
});

describe('deny-by-default coverage guard', () => {
  // Routes consciously kept reachable while locked so the UI can render the lock
  // screen and the external unlock route stays callable. Adding a route here is a
  // deliberate, reviewed decision.
  const ALLOWLIST = new Set(
    [
      'src/app/api/encryption/secure/route.ts',
      'src/app/api/init/route.ts',
      // Local-models (Ollama) onboarding: capability probe, model pull, and model
      // suggestion are secret-free and must work on FIRST LAUNCH, before encryption
      // is even configured. Registering the pulled model (POST /api/model) is what
      // carries the unlock requirement — see the comments in each route.
      'src/app/api/local-models/capability/route.ts',
      'src/app/api/local-models/pull/route.ts',
      'src/app/api/local-models/suggest/route.ts',
    ].map((p) => p.replace(/\\/g, '/'))
  );

  function findRouteFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findRouteFiles(full, acc);
      else if (entry.name === 'route.ts') acc.push(full);
    }
    return acc;
  }

  it('every /api and /v1 route calls assertUnlocked or is allowlisted', () => {
    const root = process.cwd();
    const roots = ['src/app/api', 'src/app/v1'].map((d) => path.join(root, d));
    const files = roots.flatMap((d) => findRouteFiles(d));

    // Sanity: the tree must actually be discovered.
    expect(files.length).toBeGreaterThan(40);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      const src = fsSync.readFileSync(file, 'utf8');
      if (!src.includes('assertUnlocked')) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
