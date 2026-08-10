import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { withWorkspaceRoute } from '@/app/api/_workspace';

const log = createLogger('app/api/storage/route');

// These files are authoritative state machines, not generic preferences. Raw
// replacement would bypass scheduler target validation, Persona admission,
// run-history invariants, approval lifecycle checks, and Persona conversation
// ownership. They are accessible only through their dedicated typed
// services/routes (or the preflighted backup/restore workflow).
const RESERVED_INTERNAL_KEYS = new Set<StorageKey>([
  StorageKey.PLANNED_EXECUTIONS,
  StorageKey.PENDING_APPROVALS,
  StorageKey.PACKAGE_INSTALLS,
  StorageKey.CHAT_HISTORY,
]);

function isGenericStorageKey(key: string | null | undefined): key is StorageKey {
  return Boolean(
    key
    && Object.values(StorageKey).includes(key as StorageKey)
    && !RESERVED_INTERNAL_KEYS.has(key as StorageKey),
  );
}

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const requestId = uuidv4();
  log.info(`Handling GET request [RequestID: ${requestId}]`);
  
  const searchParams = request.nextUrl.searchParams;
  const key = searchParams.get('key');
  const defaultValue = searchParams.get('defaultValue');
  
  log.debug(`Request parameters [${requestId}]`, { key, defaultValue });

  if (!isGenericStorageKey(key)) {
    log.error(`Invalid storage key: ${key} [${requestId}]`);
    return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
  }

  try {
    log.debug(`Loading item with key: ${key} [${requestId}]`);
    const value = await loadItem(key as StorageKey, defaultValue ? JSON.parse(defaultValue) : null);
    log.info(`Successfully loaded item with key: ${key} [${requestId}]`);
    return NextResponse.json({ value });
  } catch (error) {
    log.error(`Failed to load data [${requestId}]`, error);
    return NextResponse.json({ error: 'Failed to load data' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const requestId = uuidv4();
  log.info(`Handling POST request [RequestID: ${requestId}]`);
  
  try {
    const { key, value } = await request.json();
    log.debug(`Request body [${requestId}]`, { key });

    if (!isGenericStorageKey(key)) {
      log.error(`Invalid storage key: ${key} [${requestId}]`);
      return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
    }

    log.debug(`Saving item with key: ${key} [${requestId}]`);
    await saveItem(key as StorageKey, value);
    log.info(`Successfully saved item with key: ${key} [${requestId}]`);
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error(`Failed to save data [${requestId}]`, error);
    return NextResponse.json({ error: 'Failed to save data' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const requestId = uuidv4();
  log.info(`Handling DELETE request [RequestID: ${requestId}]`);
  
  const searchParams = request.nextUrl.searchParams;
  const key = searchParams.get('key');
  
  log.debug(`Request parameters [${requestId}]`, { key });

  if (!isGenericStorageKey(key)) {
    log.error(`Invalid storage key: ${key} [${requestId}]`);
    return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
  }

  try {
    log.debug(`Clearing item with key: ${key} [${requestId}]`);
    await clearItem(key as StorageKey);
    log.info(`Successfully cleared item with key: ${key} [${requestId}]`);
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error(`Failed to clear data [${requestId}]`, error);
    return NextResponse.json({ error: 'Failed to clear data' }, { status: 500 });
  }
}



// Workspaces (#406): generic storage reads/writes target the selected
// workspace's db/ directory.
export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
