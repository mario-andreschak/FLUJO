"use client";

import {
  listPersonaSummaries,
  type PersonaSummaryPage,
} from '@/frontend/services/personas/summary';
import {
  getSelectedWorkspace,
} from '@/frontend/utils/workspaceSelection';

const SUMMARY_FRESHNESS_MS = 15_000;

interface SummaryCacheEntry {
  data: PersonaSummaryPage;
  freshUntil: number;
}

const summaryCache = new Map<string, SummaryCacheEntry>();

function summaryCacheKey(options: {
  workspace: string;
  cursor?: string | null;
  pageSize: number;
}): string {
  return JSON.stringify([
    options.workspace,
    options.cursor ?? null,
    options.pageSize,
  ]);
}

export async function loadPersonaSummaryPage(options: {
  cursor?: string | null;
  pageSize: number;
  signal?: AbortSignal;
  force?: boolean;
}): Promise<PersonaSummaryPage> {
  const workspace = getSelectedWorkspace();
  const key = summaryCacheKey({
    workspace,
    cursor: options.cursor,
    pageSize: options.pageSize,
  });
  const cached = summaryCache.get(key);
  if (!options.force && cached && cached.freshUntil > Date.now()) {
    return cached.data;
  }

  const data = await listPersonaSummaries({
    cursor: options.cursor,
    pageSize: options.pageSize,
    signal: options.signal,
  });
  if (workspace === getSelectedWorkspace() && !options.signal?.aborted) {
    summaryCache.set(key, {
      data,
      freshUntil: Date.now() + SUMMARY_FRESHNESS_MS,
    });
  }
  return data;
}

export function invalidatePersonaSummaryCache(
  workspace = getSelectedWorkspace(),
): void {
  for (const key of summaryCache.keys()) {
    const parsed = JSON.parse(key) as [string, string | null, number];
    if (parsed[0] === workspace) summaryCache.delete(key);
  }
}
