import { NextRequest, NextResponse } from 'next/server';
import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/storage/route');

export async function GET(request: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling GET request [RequestID: ${requestId}]`);
  
  const searchParams = request.nextUrl.searchParams;
  const key = searchParams.get('key');
  const defaultValue = searchParams.get('defaultValue');
  
  log.debug(`Request parameters [${requestId}]`, { key, defaultValue });

  if (!key || !Object.values(StorageKey).includes(key as StorageKey)) {
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

export async function POST(request: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling POST request [RequestID: ${requestId}]`);
  
  try {
    const { key, value } = await request.json();
    log.debug(`Request body [${requestId}]`, { key });

    if (!key || !Object.values(StorageKey).includes(key as StorageKey)) {
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

export async function DELETE(request: NextRequest) {
  const requestId = uuidv4();
  log.info(`Handling DELETE request [RequestID: ${requestId}]`);
  
  const searchParams = request.nextUrl.searchParams;
  const key = searchParams.get('key');
  
  log.debug(`Request parameters [${requestId}]`, { key });

  if (!key || !Object.values(StorageKey).includes(key as StorageKey)) {
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

