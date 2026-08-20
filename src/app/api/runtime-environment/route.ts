import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { RUNTIME_ENVIRONMENT_DEFINITIONS } from '@/shared/runtimeEnvironment';
import {
  readRuntimeEnvironmentFile,
  writeRuntimeEnvironmentFile,
} from '@/backend/services/runtimeEnvironment';

// FLUJO_INSTALLATION_WIDE_ROUTE: edits launcher environment for the whole process.

export async function GET(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;

  const state = await readRuntimeEnvironmentFile();
  const active = Object.fromEntries(RUNTIME_ENVIRONMENT_DEFINITIONS.flatMap((definition) => {
    const value = process.env[definition.name];
    if (value === undefined) return [];
    return [[definition.name, definition.sensitive ? '********' : value]];
  }));
  return NextResponse.json({
    definitions: RUNTIME_ENVIRONMENT_DEFINITIONS,
    configured: Object.fromEntries(Object.entries(state.configured).map(([name, value]) => [
      name,
      RUNTIME_ENVIRONMENT_DEFINITIONS.find((definition) => definition.name === name)?.sensitive
        ? '********'
        : value,
    ])),
    active,
    file: state.path,
    restartRequired: Object.entries(state.configured).some(([name, value]) => process.env[name] !== value),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;

  try {
    const body = await request.json() as { values?: Record<string, unknown> };
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return NextResponse.json({ error: 'values must be an object' }, { status: 400 });
    }
    // A masked secret means "leave it unchanged", never persist the placeholder.
    const current = (await readRuntimeEnvironmentFile()).configured;
    const values = { ...body.values };
    for (const definition of RUNTIME_ENVIRONMENT_DEFINITIONS) {
      if (definition.sensitive && values[definition.name] === '********') {
        if (current[definition.name] !== undefined) values[definition.name] = current[definition.name];
        else delete values[definition.name];
      }
    }
    await writeRuntimeEnvironmentFile(values);
    return NextResponse.json({ success: true, restartRequired: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not save runtime environment' },
      { status: 400 },
    );
  }
}
