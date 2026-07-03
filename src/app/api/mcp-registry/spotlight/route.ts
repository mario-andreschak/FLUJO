import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadSpotlightCache, refreshSpotlightServers } from '@/backend/services/spotlight';

const log = createLogger('app/api/mcp-registry/spotlight/route');

/**
 * GET /api/mcp-registry/spotlight — return the cached curated-server list.
 * Never contacts the registry: the cache is written at FLUJO startup and by
 * POST below. `cache` is null when no refresh has completed yet.
 */
export async function GET() {
  try {
    const cache = await loadSpotlightCache();
    return NextResponse.json({ success: true, cache });
  } catch (error) {
    log.error('Failed to load spotlight cache', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/mcp-registry/spotlight — manually refresh the curated list from
 * the registry (the UI's Refresh button) and return the updated cache.
 */
export async function POST() {
  try {
    const cache = await refreshSpotlightServers();
    return NextResponse.json({ success: true, cache });
  } catch (error) {
    log.error('Spotlight refresh failed', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 }
    );
  }
}
