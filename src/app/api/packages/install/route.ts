/**
 * POST /api/packages/install (issue #198).
 *
 * Local-only REST entry point that lets brain online / headless automation
 * provision a tenant without a browser: install a registry package (a bundle of
 * flows, models, MCP-server references and planned executions) in one call.
 *
 * For headless callers the request itself IS the consent (`consentGranted`
 * defaults to `true`) — this route is fail-closed behind `assertLocalRequest`
 * and is deliberately NOT on the public API allow-list. Hosted tenants opt in
 * only by choosing Local Network or Public in Settings.
 *
 * The Packages page "Install from registry" UI instead calls this route twice:
 * once with `consentGranted: false` to fetch a dry-run preview (manifest
 * contents + required secrets, no mutations), then again with
 * `consentGranted: true` plus the collected secret values to actually install.
 *
 * Body: { source: 'registry', packageId: string, version?: string,
 *         secrets?: Record<string,string>, modelMappings?: Record<string,string>,
 *         renames?: { flows?: Record<string,string>,
 *                     plannedExecutions?: Record<string,string> },
 *         consentGranted?: boolean }
 *
 * `renames` (issue #407) carries the wizard's bulk DISPLAY-NAME rename map —
 * flow entries keyed by manifest-local flow id, planned-execution entries keyed
 * by manifest execution name. It is validated here for shape/size and again in
 * the installer for blanks, duplicates and host collisions.
 * Response: the install summary (created / updated / skipped / disabled / errors),
 * or `{ dryRun: true, preview }` when consentGranted is false.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { installPackage } from '@/backend/services/packages/installPackage';
import { MAX_RENAME_ENTRIES, MAX_RENAME_LENGTH } from '@/utils/shared/packageRename';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/packages/install/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { source, packageId, version, secrets, modelMappings, renames, consentGranted } = (body ?? {}) as {
    source?: unknown;
    packageId?: unknown;
    version?: unknown;
    secrets?: unknown;
    modelMappings?: unknown;
    renames?: unknown;
    consentGranted?: unknown;
  };

  if (source !== 'registry') {
    return NextResponse.json({ error: "The only supported source is 'registry'" }, { status: 400 });
  }
  if (typeof packageId !== 'string' || packageId.trim() === '') {
    return NextResponse.json({ error: 'packageId is required' }, { status: 400 });
  }
  if (version !== undefined && typeof version !== 'string') {
    return NextResponse.json({ error: 'version must be a string' }, { status: 400 });
  }
  if (secrets !== undefined && (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets))) {
    return NextResponse.json({ error: 'secrets must be an object of string values' }, { status: 400 });
  }
  if (modelMappings !== undefined && (typeof modelMappings !== 'object' || modelMappings === null || Array.isArray(modelMappings))) {
    return NextResponse.json({ error: 'modelMappings must be an object of string values' }, { status: 400 });
  }
  const modelMappingRecord = (modelMappings ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(modelMappingRecord)) {
    if (typeof v !== 'string') {
      return NextResponse.json({ error: `model mapping "${k}" must be a string value` }, { status: 400 });
    }
  }
  if (renames !== undefined && (typeof renames !== 'object' || renames === null || Array.isArray(renames))) {
    return NextResponse.json({ error: 'renames must be an object' }, { status: 400 });
  }
  const renameGroups = (renames ?? {}) as Record<string, unknown>;
  for (const group of Object.keys(renameGroups)) {
    if (group !== 'flows' && group !== 'plannedExecutions') {
      return NextResponse.json({ error: `renames.${group} is not a supported rename group` }, { status: 400 });
    }
    const entries = renameGroups[group];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      return NextResponse.json({ error: `renames.${group} must be an object of string values` }, { status: 400 });
    }
    const record = entries as Record<string, unknown>;
    if (Object.keys(record).length > MAX_RENAME_ENTRIES) {
      return NextResponse.json(
        { error: `renames.${group} may not contain more than ${MAX_RENAME_ENTRIES} entries` },
        { status: 400 },
      );
    }
    for (const [k, v] of Object.entries(record)) {
      if (typeof v !== 'string') {
        return NextResponse.json({ error: `rename "${k}" must be a string value` }, { status: 400 });
      }
      if (v.length > MAX_RENAME_LENGTH) {
        return NextResponse.json(
          { error: `rename "${k}" must be ${MAX_RENAME_LENGTH} characters or fewer` },
          { status: 400 },
        );
      }
    }
  }
  if (consentGranted !== undefined && typeof consentGranted !== 'boolean') {
    return NextResponse.json({ error: 'consentGranted must be a boolean' }, { status: 400 });
  }
  const secretRecord = (secrets ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(secretRecord)) {
    if (typeof v !== 'string') {
      return NextResponse.json({ error: `secret "${k}" must be a string value` }, { status: 400 });
    }
  }

  log.info(`Installing package "${packageId}"${version ? `@${version}` : ''}`);

  const summary = await installPackage({
    source: 'registry',
    packageId,
    ...(version ? { version } : {}),
    secrets: secretRecord as Record<string, string>,
    modelMappings: modelMappingRecord as Record<string, string>,
    renames: {
      flows: (renameGroups.flows ?? {}) as Record<string, string>,
      plannedExecutions: (renameGroups.plannedExecutions ?? {}) as Record<string, string>,
    },
    consentGranted: consentGranted === undefined ? true : (consentGranted as boolean),
  });

  return NextResponse.json(summary, { status: summary.ok ? 200 : 400 });
}
